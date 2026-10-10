import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Writable } from 'node:stream';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore,uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';
import { diskStatus,DISK_SAFETY_BYTES,PAID_AUDIO_DISK_BYTES } from '../server/disk-space.mjs';

function wav() {
  const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);
  b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);
  for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}
function setup(t,options={}) {
  const dir=fs.mkdtempSync(join(tmpdir(),'dubbing-worker-space-')),store=openStore(dir),d=createDomain(store);
  const project=d.mutate('project.create',{name:'自拟空间夹具'}),c=d.mutate('chapter.create',{projectId:project.id,title:'自拟',source:'一句。二句。',segment:true});
  const voice={id:uid(),path:'reference.wav',state:'active'};fs.writeFileSync(join(dir,voice.path),wav());store.put('voices',voice);
  const role=store.all('roles',project.id)[0];d.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id,chapterId:c.id,revision:1});
  for(const s of d.list(c.id))d.mutate('segment.update',{id:s.id,chapterId:c.id,revision:store.get('chapters',c.id).revision,roleConfirmed:true});
  const scope=uid(),worker=createWorker(store,d,{key:'fixture',model:'seed-audio-1.0',audioUrl:'https://example.invalid',callLimit:10,usageScope:scope,...options});
  t.after(async()=>{await worker.drain();worker.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const enqueue=()=>worker.enqueue({kind:'generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,ids:d.list(c.id).map(s=>s.id),commandId:uid()});
  return{dir,store,d,c,worker,enqueue,scope};
}
function freeSpace(t,bytes) {
  const state={bytes},mock=t.mock.method(fs,'statfsSync',()=>({bavail:state.bytes,bsize:1}));
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});return state;
}
const response=()=>new Response(wav(),{headers:{'Content-Type':'audio/wav'}});

test('低空间0次dispatch且quota不消耗，queued原任务在容量恢复后继续',async t=>{
  const {dir,store,worker,enqueue,scope}=setup(t),free=freeSpace(t,DISK_SAFETY_BYTES+PAID_AUDIO_DISK_BYTES-1);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response();});
  const job=enqueue();await worker.tick();
  assert.equal(calls,0);assert.equal(worker.storagePressure,true);assert.equal(worker.getActivity().storageBlocked,false);
  assert.equal(store.get('jobs',job.id).status,'queued');assert.ok(store.all('attempts',job.id).every(a=>a.status==='queued'&&!a.ownerToken&&!a.createdAt));
  assert.deepEqual([store.get('settings','audio-usage:'+scope).reserved,store.get('settings','audio-usage:'+scope).used],[2,0]);
  assert.equal(diskStatus(dir).reservedBytes,0);
  free.bytes=1024*1024*1024;await worker.tick();assert.equal(calls,2);assert.equal(worker.storagePressure,false);
  assert.equal(store.get('jobs',job.id).status,'success');assert.deepEqual([store.get('settings','audio-usage:'+scope).reserved,store.get('settings','audio-usage:'+scope).used],[0,2]);
  assert.equal(diskStatus(dir).reservedBytes,0);
});

test('并发付费写盘按同卷预留，200MiB只够一条时第二条不抢发',async t=>{
  const {dir,store,worker,enqueue}=setup(t,{audioConcurrency:2,routeConcurrencyCap:2,audioStartIntervalMs:0});
  freeSpace(t,DISK_SAFETY_BYTES+PAID_AUDIO_DISK_BYTES+1024*1024);
  let release,called,calls=0;const admitted=new Promise(r=>called=r),held=new Promise(r=>release=r);
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1){called();await held;}return response();});
  const job=enqueue(),finished=worker.tick();await admitted;
  assert.equal(calls,1);assert.equal(worker.storagePressure,true);assert.equal(diskStatus(dir).reservedBytes,PAID_AUDIO_DISK_BYTES);
  assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['sending','queued']);
  release();await finished;assert.equal(calls,2);assert.equal(store.get('jobs',job.id).status,'success');assert.equal(diskStatus(dir).reservedBytes,0);
});

test('已有一条成功后容量不足，暂停为queued可交给闲时回收，恢复只发送剩余条',async t=>{
  const {store,worker,enqueue}=setup(t),free=freeSpace(t,1024*1024*1024);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(calls===1)free.bytes=DISK_SAFETY_BYTES+PAID_AUDIO_DISK_BYTES-1;return response();});
  const job=enqueue();await worker.tick();
  assert.equal(calls,1);assert.equal(worker.storagePressure,true);assert.equal(worker.getActivity().active,false);
  assert.equal(store.get('jobs',job.id).status,'queued');assert.equal(store.get('jobs',job.id).done,1);
  assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['success','queued']);
  free.bytes=1024*1024*1024;await worker.tick();assert.equal(calls,2);assert.equal(store.get('jobs',job.id).status,'success');
});

test('真实ENOSPC接收失败保留unknown与.partial，增加空间不自动重发未知',async t=>{
  const {dir,store,worker,enqueue}=setup(t),free=freeSpace(t,1024*1024*1024);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return response();});
  const native=fs.createWriteStream,mock=t.mock.method(fs,'createWriteStream',(file,...args)=>String(file).endsWith('.wav.part')?new Writable({write(chunk,_encoding,done){fs.writeFileSync(file,chunk.subarray(0,64));done(Object.assign(new Error('no space'),{code:'ENOSPC'}));}}):native(file,...args));
  syncBuiltinESMExports();
  const job=enqueue();
  try{await worker.tick();}finally{mock.mock.restore();syncBuiltinESMExports();}
  const attempt=store.all('attempts',job.id)[0],part=join(dir,attempt.path+'.part');
  assert.equal(calls,1);assert.equal(attempt.status,'unknown');assert.equal(worker.getActivity().storageBlocked,true);assert.equal(worker.storagePressure,false);
  assert.ok(fs.statSync(part).size>0);assert.equal(store.all('audios').length,0);assert.equal(diskStatus(dir).reservedBytes,0);
  free.bytes=4*1024*1024*1024;await worker.tick();assert.equal(calls,1);assert.equal(store.get('attempts',attempt.id).status,'unknown');assert.ok(fs.existsSync(part));
});

test('pump与新command查重只解析活动jobs，不将9MiB历史renderRows带入JS堆',async t=>{
  const {store,worker,enqueue}=setup(t);freeSpace(t,1024*1024*1024);
  store.put('jobs',{id:uid(),status:'success',kind:'master',commandId:'retired-fixture',renderRows:[{text:'history-no-parse:'+ 'x'.repeat(9*1024*1024)}]});
  const native=JSON.parse,mock=t.mock.method(JSON,'parse',(value,...args)=>{assert.ok(!String(value).includes('history-no-parse:'),'历史大对象不应由poll/pump或新command解析');return native(value,...args);});
  t.mock.method(globalThis,'fetch',async()=>response());
  try{await worker.tick();const job=enqueue();await worker.tick();assert.equal(store.get('jobs',job.id).status,'success');}
  finally{mock.mock.restore();}
});
