import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDomain } from '../server/domain.mjs';
import { openStore, uid } from '../server/store.mjs';
import { diskStatus, reserveDiskSpace, DISK_SAFETY_BYTES, PAID_AUDIO_DISK_BYTES } from '../server/disk-space.mjs';
import { uploadVoice, buildMaster, exportMaster, inspect, runMediaProcess, validateStoredAudio } from '../server/audio.mjs';

function fixture(t) {
  const directory=fs.mkdtempSync(join(tmpdir(),'dubbing-disk-')),store=openStore(directory);
  t.after(()=>{store.close();fs.rmSync(directory,{recursive:true,force:true});});
  return {directory,store};
}
function freeSpace(t, bytes) {
  const value={bytes},mock=t.mock.method(fs,'statfsSync',()=>({bavail:value.bytes,bsize:1}));
  syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});return value;
}
function wav(frames=4800) {
  const b=Buffer.alloc(44+frames*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);
  b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);
  b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*2,40);
  for(let i=0;i<frames;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}

test('同卷在途写盘预留累计，保留256MiB，释放幂等且查不到余量时不默许',t=>{
  const {directory}=fixture(t),second=join(directory,'second');fs.mkdirSync(second);
  freeSpace(t,DISK_SAFETY_BYTES+PAID_AUDIO_DISK_BYTES+1024);
  const first=reserveDiskSpace(directory,PAID_AUDIO_DISK_BYTES);
  try {
    assert.equal(diskStatus(second).reservedBytes,PAID_AUDIO_DISK_BYTES);
    assert.throws(()=>reserveDiskSpace(second,1025),e=>e.status===507&&e.code==='disk-space-low');
    const edge=reserveDiskSpace(second,1024);edge.release();edge.release();
    assert.equal(diskStatus(directory).reservedBytes,PAID_AUDIO_DISK_BYTES);
  } finally { first.release(); }
  assert.equal(diskStatus(directory).reservedBytes,0);
  const failure=t.mock.method(fs,'statfsSync',()=>{throw Object.assign(new Error('denied'),{code:'EACCES'});});syncBuiltinESMExports();
  try{assert.throws(()=>reserveDiskSpace(directory,1),e=>e.status===503&&e.code==='disk-space-unavailable');}
  finally{failure.mock.restore();syncBuiltinESMExports();}
});

test('上传、母版和导出共用空间保护，足够后可继续，失败不漏预留或临时文件',async t=>{
  const {directory,store}=fixture(t),free=freeSpace(t,DISK_SAFETY_BYTES-1),bytes=wav(),uploadId=uid();
  const payload={uploadId,name:'自拟参考',filename:'reference.wav',data:bytes.toString('base64')};
  await assert.rejects(uploadVoice(store,payload),e=>e.status===507);assert.equal(store.all('voices').length,0);
  free.bytes=1024*1024*1024;
  const voice=await uploadVoice(store,payload);assert.equal(diskStatus(directory).reservedBytes,0);
  free.bytes=0;assert.equal((await uploadVoice(store,payload)).id,voice.id,'原上传回执重读不新增写盘');
  const d=createDomain(store),project=d.mutate('project.create',{name:'自拟空间测试'}),chapter=d.mutate('chapter.create',{projectId:project.id,title:'自拟',source:''});
  const audio={id:uid(),path:voice.path,duration:0.1},rows=[{s:{id:uid(),chapterId:chapter.id},a:audio}],id=uid();
  await assert.rejects(buildMaster(store,rows,0,id),e=>e.status===507);
  free.bytes=1024*1024*1024;
  const master={id,chapterId:chapter.id,arrangement:1,...await buildMaster(store,rows,0,id)};assert.equal((await inspect(join(directory,master.path))).channels,2);
  free.bytes=DISK_SAFETY_BYTES;
  const old=fs.readFileSync(join(directory,master.path));await assert.rejects(exportMaster(store,master,uid(),'wav'),e=>e.status===507);
  assert.deepEqual(fs.readFileSync(join(directory,master.path)),old);
  free.bytes=1024*1024*1024;const exported=await exportMaster(store,master,uid(),'wav');assert.deepEqual(fs.readFileSync(join(directory,exported)),old);
  await assert.rejects(uploadVoice(store,{name:'坏文件',filename:'bad.wav',data:Buffer.from('broken').toString('base64')}));
  assert.equal(diskStatus(directory).reservedBytes,0);assert.ok(fs.readdirSync(join(directory,'voices')).every(n=>!n.endsWith('.part')));
});

test('排队媒体任务取消后不启动自己的child；源校验取消不将原件标坏或取消他人的校验',async t=>{
  const {directory,store}=fixture(t),file=join(directory,'source.wav'),audio={id:uid(),path:'source.wav'};
  fs.writeFileSync(file,wav());store.put('audios',audio);
  const blocker=runMediaProcess(process.execPath,['-e','setTimeout(()=>{},100)']);
  const controller=new AbortController(),marker=join(directory,'unexpected');
  const queued=runMediaProcess(process.execPath,['-e',`require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`],{signal:controller.signal});
  const rejected=assert.rejects(queued,e=>e.name==='AbortError');controller.abort();await blocker;await rejected;assert.equal(fs.existsSync(marker),false);
  const hold=runMediaProcess(process.execPath,['-e','setTimeout(()=>{},100)']),own=new AbortController();
  const cancelled=validateStoredAudio(store,audio,{signal:own.signal}),rejection=assert.rejects(cancelled,e=>e.name==='AbortError');own.abort();await hold;await rejection;
  assert.equal(store.get('audios',audio.id).invalid,undefined);assert.equal(store.maybe('settings','audio-file-check:'+audio.id),null);
  const otherHold=runMediaProcess(process.execPath,['-e','setTimeout(()=>{},100)']);
  const owner=validateStoredAudio(store,audio),observer=new AbortController();
  const observed=validateStoredAudio(store,audio,{signal:observer.signal}),observerReject=assert.rejects(observed,e=>e.name==='AbortError');observer.abort();
  await otherHold;assert.equal(await owner,true);await observerReject;
  assert.equal(store.get('audios',audio.id).invalid,undefined);assert.equal(store.get('settings','audio-file-check:'+audio.id).valid,true);
});
