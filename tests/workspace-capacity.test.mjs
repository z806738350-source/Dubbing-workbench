import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { copyWorkspace } from '../server/workspace.mjs';
import { fileTreeBytes, diskStatus, DISK_SAFETY_BYTES } from '../server/disk-space.mjs';

test('迁移在复制前检查目标卷，空间不足不创建目录、不改原件，恢复后可迁移',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'workspace-space-')),store=openStore(join(root,'source'));
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  fs.mkdirSync(join(store.directory,'audio'));fs.writeFileSync(join(store.directory,'audio/original.bin'),Buffer.alloc(1024,7));
  const database=fs.readFileSync(join(store.directory,'workbench.sqlite')),before=fs.readFileSync(join(store.directory,'audio/original.bin'));
  let free=DISK_SAFETY_BYTES+512;
  const mocked=t.mock.method(fs,'statfsSync',()=>({bavail:free,bsize:1}));syncBuiltinESMExports();
  t.after(()=>{mocked.mock.restore();syncBuiltinESMExports();});
  const target=join(root,'moved');
  await assert.rejects(copyWorkspace(store,target),e=>e.status===507&&e.code==='disk-space-low');
  assert.equal(fs.existsSync(target),false);assert.deepEqual(fs.readdirSync(root),['source']);assert.deepEqual(fs.readFileSync(join(store.directory,'workbench.sqlite')),database);
  assert.deepEqual(fs.readFileSync(join(store.directory,'audio/original.bin')),before);assert.equal(diskStatus(root).reservedBytes,0);
  free=1024*1024*1024;assert.equal(await copyWorkspace(store,target),join(fs.realpathSync(root),'moved'));
  assert.deepEqual(fs.readFileSync(join(target,'audio/original.bin')),before);assert.deepEqual(fs.readFileSync(join(store.directory,'audio/original.bin')),before);
  assert.equal(diskStatus(root).reservedBytes,0);
});

test('备份按实际文件树估算，低空间在写盘前退出且原库不变',async t=>{
  const root=fs.mkdtempSync(join(tmpdir(),'backup-space-')),source=join(root,'source'),store=openStore(source);store.close();
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(join(source,'nested'));fs.writeFileSync(join(source,'nested/file'),Buffer.alloc(2048,3));
  fs.symlinkSync(join(source,'nested/file'),join(source,'link'));
  const expected=fs.statSync(join(source,'workbench.sqlite')).size+2048+fs.lstatSync(join(source,'link')).size;
  assert.equal(await fileTreeBytes(source),expected);
  const before=fs.readFileSync(join(source,'workbench.sqlite')),preload=join(root,'space.mjs'),target=join(root,'backup');
  fs.writeFileSync(preload,`import fs from 'node:fs';import{syncBuiltinESMExports}from'node:module';fs.statfsSync=()=>({bavail:${DISK_SAFETY_BYTES+1},bsize:1});syncBuiltinESMExports();`);
  await assert.rejects(promisify(execFile)(process.execPath,['--import',preload,'scripts/backup.mjs','create',source,target]),e=>/空间不足/.test(e.stderr));
  assert.equal(fs.existsSync(target),false);assert.deepEqual(fs.readFileSync(join(source,'workbench.sqlite')),before);
  const nested=join(root,'new-parent','backup');
  await promisify(execFile)(process.execPath,['scripts/backup.mjs','create',source,nested]);
  assert.deepEqual(fs.readFileSync(join(nested,'workbench.sqlite')),before);assert.equal(fs.existsSync(join(nested,'backup-info.json')),true);
});

test('空间暂停的未发送配音队列可迁移，旧位置保留、新库按原job/attempt编号继续',async t=>{
  const { startServer }=await import('../server/index.mjs'),{ uid }=await import('../server/store.mjs'),{ PAID_AUDIO_DISK_BYTES }=await import('../server/disk-space.mjs');
  const root=fs.mkdtempSync(join(tmpdir(),'workspace-pressure-move-')),source=join(root,'source'),target=join(root,'moved'),canonicalTarget=join(fs.realpathSync(root),'moved');
  const config={key:'fixture',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio',callLimit:2,usageScope:uid()};
  let calls=0,targetReady=false;
  const nativeFetch=globalThis.fetch,fetchMock=t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(String(url)!==config.audioUrl)return nativeFetch(url,options);
    calls++;return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});
  });
  const app=await startServer({port:0,directory:source,config,workspaceConfig:join(root,'workspace-selection.json')});
  const sourcePath=app.store.directory;
  const mocked=t.mock.method(fs,'statfsSync',path=>({bsize:1,bavail:String(path)===sourcePath || String(path)===canonicalTarget&&!targetReady ? DISK_SAFETY_BYTES+PAID_AUDIO_DISK_BYTES-1 : 1024*1024*1024}));syncBuiltinESMExports();
  t.after(async()=>{await app.close();mocked.mock.restore();fetchMock.mock.restore();syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});});
  const bytes=Buffer.alloc(44+9600);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);
  bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);
  for(let i=0;i<4800;i++)bytes.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);
  const d=app.domain,project=d.mutate('project.create',{name:'自拟迁移夹具'}),chapter=d.mutate('chapter.create',{projectId:project.id,title:'自拟',source:'一句。二句。',segment:true}),voiceId=uid(),voice={id:voiceId,path:`voices/${voiceId}.wav`,state:'active'};
  fs.mkdirSync(join(sourcePath,'voices'),{recursive:true});fs.writeFileSync(join(sourcePath,voice.path),bytes);app.store.put('voices',voice);
  const role=app.store.all('roles',project.id)[0];d.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id,chapterId:chapter.id,revision:1});
  for(const s of d.list(chapter.id))d.mutate('segment.update',{id:s.id,chapterId:chapter.id,revision:app.store.get('chapters',chapter.id).revision,roleConfirmed:true});
  const job=app.worker.enqueue({kind:'generate',chapterId:chapter.id,revision:app.store.get('chapters',chapter.id).revision,ids:d.list(chapter.id).map(s=>s.id),commandId:uid()});await app.worker.tick();
  const attemptIds=app.store.all('attempts',job.id).map(a=>a.id),base=`http://127.0.0.1:${app.server.address().port}`;
  assert.equal(calls,0);assert.equal(app.worker.storagePressure,true);assert.equal(app.worker.running,false);assert.equal(app.store.get('jobs',job.id).status,'queued');
  const move=()=>fetch(base+'/api/workspace/move',{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify({source:sourcePath,directory:target})});
  const runId=uid();app.store.put('assistantRuns',{id:runId,state:'waitingJobs'});
  const blocked=await move();assert.equal(blocked.status,409);assert.match((await blocked.json()).error,/任务/);assert.equal(fs.existsSync(target),false);assert.equal(calls,0);
  app.store.remove('assistantRuns',runId);
  const result=await move();assert.equal(result.status,200,JSON.stringify(await result.clone().json()));await result.json();
  assert.equal(app.store.directory,canonicalTarget);assert.equal(app.store.get('jobs',job.id).status,'queued');assert.deepEqual(app.store.all('attempts',job.id).map(a=>a.id),attemptIds);assert.equal(calls,0);
  assert.ok(app.store.all('attempts',job.id).every(a=>a.status==='queued'&&!a.createdAt));assert.deepEqual(fs.readFileSync(join(sourcePath,voice.path)),bytes);assert.deepEqual(fs.readFileSync(join(canonicalTarget,voice.path)),bytes);
  const old=openStore(sourcePath);try{assert.equal(old.get('jobs',job.id).status,'stopped');assert.deepEqual(old.all('attempts',job.id).map(a=>a.id),attemptIds);}finally{old.close();}
  targetReady=true;await app.worker.tick();assert.equal(calls,2);assert.equal(app.store.get('jobs',job.id).status,'success');assert.equal(app.store.get('jobs',job.id).error,undefined);assert.deepEqual(app.store.all('attempts',job.id).map(a=>a.id),attemptIds);assert.equal(app.store.all('audios').length,2);
  assert.deepEqual(fs.readFileSync(join(sourcePath,voice.path)),bytes);assert.equal(diskStatus(canonicalTarget).reservedBytes,0);
});
