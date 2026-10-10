import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {startServer} from '../server/index.mjs';
import {uid,openStore} from '../server/store.mjs';
import {inputOf,basisOf} from '../server/domain.mjs';
import {audioDigest} from '../server/audio-delivery.mjs';

function wav(){const b=Buffer.alloc(44+9600*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let at=44;at<b.length;at+=2)b.writeInt16LE(at%10001-5000,at);return b;}

test('空闲回收后历史ID的GET/Range/HEAD自动免费恢复，回执和备份仍有效',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'storage-http-')),app=await startServer({directory,port:0,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  let closed=false;t.after(async()=>{if(!closed)await app.close();rmSync(directory,{recursive:true,force:true});});
  const native=globalThis.fetch;t.mock.method(globalThis,'fetch',(url,options)=>{assert.ok(String(url).startsWith(base+'/'),'不得调用真实模型');return native(url,options);});
  const {store,domain,worker}=app,project=domain.mutate('project.create',{name:'自拟存储验证'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'合成测试',source:'第一句。第二句。',segment:true});
  const voice={id:uid(),name:'合成参考',path:'reference.wav',state:'active'};writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);
  const role=store.all('roles',project.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id});domain.mutate('segment.confirm',{chapterId:chapter.id,revision:domain.chapter(chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id)});
  const proof=(await audioDigest(join(directory,voice.path))).sha256;
  for(const s of domain.list(chapter.id)){const a={id:uid(),chapterId:chapter.id,path:voice.path,input:inputOf(s),delivery:{rawSha256:proof}};store.put('audios',a,chapter.id);store.put('segments',{...s,current:a.id,latest:'success',review:{audioId:a.id,basis:basisOf(s),state:'passed'}},chapter.id);}
  const jobs=[];
  for(let index=0;index<4;index++){const before=domain.chapter(chapter.id);domain.mutate('chapter.update',{chapterId:chapter.id,revision:before.revision,gap:.1+index*.1});const c=domain.chapter(chapter.id),job=await worker.submit({kind:'master',chapterId:c.id,revision:c.revision,commandId:uid()});await worker.tick();assert.equal(store.get('jobs',job.id).status,'success');jobs.push(store.get('jobs',job.id));}
  const old=store.get('masters',jobs[0].masterId),path=join(directory,old.path),original=readFileSync(path),rawJobs=store.all('jobs'),rawAudios=store.all('audios');
  const busy=store.put('jobs',{id:uid(),kind:'generate',status:'queued',chapterId:chapter.id},chapter.id);assert.deepEqual(await app.maintainStorage(),{skipped:'workspace-busy'});store.remove('jobs',busy.id);
  const maintenance=await app.maintainStorage();assert.equal(maintenance.masters.reclaimed.length,1);assert.equal(existsSync(path),false);assert.ok(store.get('masters',old.id).fileReclaimedAt);assert.deepEqual(store.all('jobs'),rawJobs);assert.deepEqual(store.all('audios'),rawAudios);
  const output=domain.outputs({chapterId:chapter.id,jobId:jobs[0].id}).items.find(item=>item.id===old.id);assert.equal(output.available,true);assert.equal(output.cached,false);assert.equal(output.locallyRecoverable,true);assert.equal(output.current,false);
  const [full,range]=await Promise.all([fetch(base+'/api/media/masters/'+old.id),fetch(base+'/api/media/masters/'+old.id,{headers:{Range:'bytes=17-1033'}})]);assert.equal(full.status,200);assert.equal(range.status,206);assert.ok(Buffer.from(await full.arrayBuffer()).equals(original));assert.ok(Buffer.from(await range.arrayBuffer()).equals(original.subarray(17,1034)));assert.equal(app.storageMaintenance.restoringCount,0);
  const head=await fetch(base+'/api/media/masters/'+old.id,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),original.length);assert.equal((await head.arrayBuffer()).byteLength,0);
  const diagnostics=await fetch(base+'/api/workspace/diagnostics');assert.equal(diagnostics.status,200);assert.equal((await diagnostics.json()).primaryAvailable,true);assert.equal(store.all('attempts').length,0);
  await app.close();closed=true;
  // A reclaimed cache is a valid backup; genuine missing unmarked files still fail.
  rmSync(path);execFileSync(process.execPath,['scripts/backup.mjs','verify',directory],{cwd:new URL('..',import.meta.url),stdio:'pipe'});
  const check=openStore(directory),unmarked=check.get('masters',old.id);delete unmarked.fileReclaimedAt;check.put('masters',unmarked,chapter.id);check.close();
  assert.throws(()=>execFileSync(process.execPath,['scripts/backup.mjs','verify',directory],{cwd:new URL('..',import.meta.url),stdio:'pipe'}),/Command failed/);
});

test('回收时状态轮询可读取，新前台操作中止回收并等待临时文件收尾', {timeout:10000}, async t=>{
  const directory=mkdtempSync(join(tmpdir(),'storage-priority-')),app=await startServer({directory,port:0,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const project=app.domain.mutate('project.create',{name:'前台优先验证'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'合成章',source:'第一句。',segment:true});
  const job=app.store.put('jobs',{id:uid(),chapterId:chapter.id,kind:'master',status:'success'},chapter.id);
  let entered,aborted=false,cleaned=false;
  const started=new Promise(resolve=>entered=resolve);
  app.storageMaintenance.cleanupMasters=({signal})=>new Promise(resolve=>{
    entered();signal.addEventListener('abort',()=>{aborted=true;setImmediate(()=>{cleaned=true;resolve({reclaimed:[],skipped:[],bytes:0,aborted:true});});},{once:true});
  });
  const pending=app.maintainStorage();await started;
  const [state,detail,progress]=await Promise.all([fetch(base+'/api/state'),fetch(base+'/api/chapters/'+chapter.id),fetch(base+'/api/jobs/'+job.id+'/progress')]);
  assert.equal(state.status,200);assert.equal(detail.status,200);assert.equal(progress.status,200);assert.equal(aborted,false,'正常轮询不会反复取消同一后台证明');
  const response=await fetch(base+'/api/drafts/locate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids:[]})});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),[]);assert.equal(aborted,true);assert.equal(cleaned,true,'前台进入前后台写盘和临时文件均已退出');
  assert.equal((await pending).masters.aborted,true);assert.equal(app.storageMaintenance.restoringCount,0);
  assert.ok((await (await fetch(base+'/api/state')).json()).settings.storage.freeBytes>0);
});

test('低空间的暂停队列先清理未使用的小缓存，正常闲时仍保留它',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'storage-pressure-cache-')),app=await startServer({directory,port:0,config:{key:''}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const cache=join(directory,'.audio-range-cache'),pcm=join(cache,'a'.repeat(64)+'.pcm'),metadata=join(cache,'a'.repeat(64)+'.json'),original=join(directory,'original.wav');
  mkdirSync(cache);writeFileSync(pcm,Buffer.alloc(1024,7));writeFileSync(metadata,'{}');writeFileSync(original,wav());const before=readFileSync(original);
  const normal=await app.maintainStorage();assert.equal(normal.cache.removedBytes,0);assert.ok(existsSync(pcm));
  app.store.put('jobs',{id:uid(),kind:'generate',status:'queued'});t.mock.getter(app.worker,'storagePressure',()=>true);
  const pressure=await app.maintainStorage();assert.equal(pressure.cache.maxBytes,0);assert.equal(pressure.cache.removedBytes,1026);
  assert.equal(existsSync(pcm),false);assert.equal(existsSync(metadata),false);assert.deepEqual(readFileSync(original),before);
});
