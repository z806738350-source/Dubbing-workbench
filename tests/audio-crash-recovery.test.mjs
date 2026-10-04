import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';
const config={key:'fixture',model:'seed-audio-1.0',audioUrl:'https://example.invalid',audioStartIntervalMs:0};
function wave(){
  const b=Buffer.alloc(192044);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<28800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}
async function crashChild(directory,stage){
  const store=openStore(directory),domain=createDomain(store),project=domain.mutate('project.create',{name:'Crash fixture'});
  const chapter=domain.mutate('chapter.create',{projectId:project.id,title:'Fixture',source:'第一句。第二句。第三句。',segment:true});
  const voice={id:uid(),path:'reference.wav',state:'active'};writeFileSync(join(directory,voice.path),wave());store.put('voices',voice);
  const role=store.all('roles',project.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision||1,voiceId:voice.id,chapterId:chapter.id,revision:chapter.revision});
  const ids=domain.list(chapter.id).map(s=>s.id);domain.mutate('segment.confirm',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids});
  const worker=createWorker(store,domain,config),job=worker.enqueue({kind:'generate',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids,commandId:uid()});
  writeFileSync(join(directory,'fixture.json'),JSON.stringify({jobId:job.id,attemptId:store.all('attempts',job.id)[0].id}));
  const kill=()=>process.kill(process.pid,'SIGKILL');
  if(stage==='queued')kill();
  const rename=fs.rename;
  fs.rename=async(from,to)=>{
    let match=false;
    if(String(to).endsWith('.delivery.json')){
      const receipt=JSON.parse(readFileSync(from,'utf8'));
      match=stage==='recipe'&&receipt.evaluated&&!receipt.result||stage==='result'&&!!receipt.result;
    }
    if(stage==='raw-part'&&String(to).endsWith('.wav')&&!String(to).endsWith('.processed.wav'))kill();
    await rename(from,to);
    if(match||stage==='processed'&&String(to).endsWith('.processed.wav'))kill();
  };
  syncBuiltinESMExports();
  globalThis.fetch=async()=>{
    if(stage==='sending')kill();
    if(stage==='partial')return new Response(new ReadableStream({start(controller){controller.enqueue(wave().subarray(0,1000));setTimeout(kill,60);}}),{headers:{'content-type':'audio/wav'}});
    return new Response(wave(),{headers:{'content-type':'audio/wav'}});
  };
  await worker.tick();throw Error('crash boundary was not reached');
}
if(process.env.DUBBING_CRASH_FIXTURE==='1')await crashChild(process.argv[2],process.argv[3]);
else for(const stage of ['queued','sending','partial','raw-part','recipe','processed','result'])test(`VC25/VH03 real SIGKILL at ${stage}: no resend and no incomplete promotion`,async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-real-crash-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const child=spawnSync(process.execPath,[fileURLToPath(import.meta.url),directory,stage],{env:{...process.env,DUBBING_CRASH_FIXTURE:'1'},timeout:15000,encoding:'utf8'});
  assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.error,undefined);
  const {jobId,attemptId}=JSON.parse(readFileSync(join(directory,'fixture.json'),'utf8')),store=openStore(directory);t.after(()=>store.close());
  const worker=createWorker(store,createDomain(store),config);let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('restart must not send');});
  const interrupted=store.all('attempts',jobId);
  await worker.recover();await worker.tick();const attempts=store.all('attempts',jobId);
  assert.equal(calls,0);
  for(const before of interrupted.filter(a=>a.id!==attemptId)){
    const recovered=store.get('attempts',before.id);
    if(before.status==='queued')assert.equal(recovered.status,'stopped');
    else {assert.ok(before.createdAt);assert.ok(['unknown','success'].includes(recovered.status));}
  }assert.ok(!['queued','running'].includes(store.get('jobs',jobId).status));
  if(['queued','sending','partial'].includes(stage)){
    assert.equal(attempts[0].status,stage==='queued'?'stopped':'unknown');assert.equal(store.all('audios').length,0);
  }else{
    const audio=store.get('audios',attemptId),original=store.get('audios',audio.originalAudioId);
    assert.equal(attempts[0].status,'success');assert.deepEqual(readFileSync(join(directory,original.path)),wave());assert.ok(audio.processing.cutFrame>0);
    const records=store.all('audios');await worker.recover();assert.deepEqual(store.all('audios'),records);assert.equal(calls,0);
  }
});
