import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore,uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';

const marker='fixture-history-request-must-not-enter-v8:';
function storeFixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'worker-activity-')),store=openStore(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});return{directory,store};
}
function history(store,count=160) {
  store.put('jobs',{id:'retired',status:'success',request:{body:marker+'x'.repeat(1024*1024)}});
  for(let i=0;i<count;i++)store.put('attempts',{id:'retired-'+i,jobId:'retired',status:'success',request:{body:marker+'x'.repeat(65536)}},'retired');
}
function noHistoryParse(t) {
  const native=JSON.parse,mock=t.mock.method(JSON,'parse',(value,...args)=>{
    assert.ok(!String(value).includes(marker),'getActivity must not parse historical request objects');return native(value,...args);
  });return()=>mock.mock.restore();
}

test('getActivity按活动job统计queued，preparing排除、缺失phase和stop仍沿用原语义；大历史不解析',t=>{
  const {store}=storeFixture(t),worker=createWorker(store,{},{});history(store);
  const jobs=[{id:'queued',status:'queued',stop:true},{id:'running',status:'running'},{id:'done',status:'success'},{id:'unknown',status:'unknown'}];
  jobs.forEach(j=>store.put('jobs',j));
  const attempts=[
    {id:'undefined',jobId:'queued',status:'queued'},
    {id:'null',jobId:'running',status:'queued',phase:null},
    {id:'normal',jobId:'running',status:'queued',phase:'queued'},
    {id:'boolean',jobId:'running',status:'queued',phase:false},
    {id:'preparing',jobId:'running',status:'queued',phase:'preparing'},
    {id:'processing',jobId:'running',status:'sending',phase:'processing'},
    {id:'done-queued',jobId:'done',status:'queued'},
    {id:'unknown-queued',jobId:'unknown',status:'queued'},
    {id:'orphan',jobId:'absent',status:'queued'},
  ];
  attempts.forEach(a=>store.put('attempts',a,a.jobId));
  const restore=noHistoryParse(t),all=store.all.bind(store),mock=t.mock.method(store,'all',(table,...args)=>{assert.notEqual(table,'attempts');return all(table,...args);});
  try{const result=worker.getActivity();assert.equal(result.queuedAttempts,4);assert.deepEqual(result.phaseCounts,{});assert.equal(result.attemptsActive,0);assert.equal(result.networkActive,0);assert.equal(result.active,false);}
  finally{restore();mock.mock.restore();worker.close();}
});

function wav() {
  const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);
  for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}
async function until(check) {const end=Date.now()+5000;while(!check()){assert.ok(Date.now()<end,'mock request admission timed out');await new Promise(r=>setTimeout(r,5));}}

test('仅执行中IDs读取phase小字段，processing/undefined/null/boolean正确，未发送queued正确',async t=>{
  const {directory,store}=storeFixture(t),domain=createDomain(store),bytes=wav();
  const project=domain.mutate('project.create',{name:'自拟活动状态'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟',source:'一句。二句。三句。',segment:true}),voice={id:uid(),path:'reference.wav',state:'active'};
  writeFileSync(join(directory,voice.path),bytes);store.put('voices',voice);
  const role=store.all('roles',project.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id,chapterId:chapter.id,revision:1});
  domain.mutate('segment.confirm',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id)});
  const worker=createWorker(store,domain,{key:'fixture',model:'seed-audio-1.0',audioUrl:'https://example.invalid',audioConcurrency:2,routeConcurrencyCap:2,audioStartIntervalMs:0});
  let held=true;const releases=[];
  t.mock.method(globalThis,'fetch',async()=>{if(held)await new Promise(r=>releases.push(r));return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});});
  const job=worker.enqueue({kind:'generate',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id),commandId:uid()}),pending=worker.tick();
  let restore=()=>{};
  try{
    await until(()=>releases.length===2);history(store);
    const attempts=store.all('attempts',job.id),first=attempts[0],second=attempts[1];
    delete first.phase;second.phase='processing';store.put('attempts',first,job.id);store.put('attempts',second,job.id);
    const stopped=store.get('jobs',job.id);stopped.stop=true;store.put('jobs',stopped,chapter.id);
    restore=noHistoryParse(t);
    const activity=worker.getActivity();assert.equal(activity.queuedAttempts,1);assert.equal(activity.attemptsActive,2);assert.equal(activity.networkActive,2);assert.deepEqual(activity.phaseCounts,{undefined:1,processing:1});
    first.phase=null;store.put('attempts',first,job.id);assert.deepEqual(worker.getActivity().phaseCounts,{null:1,processing:1});
    first.phase=false;store.put('attempts',first,job.id);assert.deepEqual(worker.getActivity().phaseCounts,{false:1,processing:1});
    first.phase=0;store.put('attempts',first,job.id);assert.deepEqual(worker.getActivity().phaseCounts,{0:1,processing:1});
  } finally {restore();held=false;releases.forEach(r=>r());await pending;worker.close();await worker.drain();}
  assert.equal(worker.getActivity().queuedAttempts,0);assert.deepEqual(worker.getActivity().phaseCounts,{});
});
