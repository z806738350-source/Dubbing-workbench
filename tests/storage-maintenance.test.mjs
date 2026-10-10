import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain, inputOf, basisOf } from '../server/domain.mjs';
import { buildMaster, validateStoredAudio, mediaProcessActivity } from '../server/audio.mjs';
import { pcmWave } from '../server/tail-audio.mjs';
import { audioDigest } from '../server/audio-delivery.mjs';
import { updateAudioRange, savedAudioRange, renderIdentity, prepareAudioSource, renderRangeResource, audioRangeActivity, DEFAULT_RENDER_PROFILE, LEGACY_RENDER_PROFILE } from '../server/audio-range.mjs';
import { diskStatus, DISK_SAFETY_BYTES } from '../server/disk-space.mjs';
import { createStorageMaintenance } from '../server/storage-maintenance.mjs';
import { workspaceDiagnostics, copyWorkspace } from '../server/workspace.mjs';

function wav(frames,channels) {
  const bytes=Buffer.alloc(44+frames*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(48000*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*2,40);
  for(let frame=0;frame<frames;frame++)for(let ch=0;ch<channels;ch++)bytes.writeInt16LE((frame*997+ch*7919)%50001-25000,44+(frame*channels+ch)*2);return bytes;
}
async function fixture(t,{frames=4800,segments=2}={}) {
  const directory=mkdtempSync(join(tmpdir(),'dubbing-storage-')),store=openStore(directory),domain=createDomain(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  t.mock.method(globalThis,'fetch',()=>{throw Error('隔离存储测试不得调用模型');});
  const source=segments===2?'第一句。第二句。':Array.from({length:segments},(_,index)=>`这是第${index+1}句测试。`).join('\n');
  const project=domain.mutate('project.create',{name:'历史恢复副本'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟短章',source,segment:true});
  const audios=[];mkdirSync(join(directory,'audio'),{recursive:true});
  for(const [index,s]of domain.list(chapter.id).entries()) {
    const a={id:uid(),path:'audio/'+uid()+'.wav',chapterId:chapter.id,input:inputOf(s),basis:basisOf(s)};
    writeFileSync(join(directory,a.path),wav(frames,index?1:2));a.delivery={rawSha256:(await audioDigest(join(directory,a.path))).sha256,rawPath:a.path,manifestPath:a.path+'.delivery.json'};writeFileSync(join(directory,a.delivery.manifestPath),JSON.stringify({fixture:true,rawSha256:a.delivery.rawSha256}));
    store.put('audios',a,chapter.id);s.current=a.id;s.latest='success';store.put('segments',s,chapter.id);domain.enhancement.syncLegacySegment(s);audios.push(a);
  }
  const maintenance=createStorageMaintenance(store,{currentRows:id=>domain.enhancement.resolve(id)});
  let ordinal=0;
  const master=async({profile=DEFAULT_RENDER_PROFILE,frozen=true}={})=>{
    const c=store.get('chapters',chapter.id);c.arrangement++;store.put('chapters',c,c.projectId);
    const rows=domain.enhancement.resolve(c.id).map(({s,a})=>({s,a,range:savedAudioRange(store,s.unitId||s.id,s.mode||'dry',a.id)}));
    const id=uid(),jobId=uid(),info=await buildMaster(store,rows,c.gap,id,profile),record={id,jobId,chapterId:c.id,arrangement:c.arrangement,...renderIdentity(store,c.id,rows,profile),...info,createdAt:new Date(2020,0,++ordinal).toISOString()};
    delete record.items;store.put('masters',record,c.id);store.put('jobs',{id:jobId,chapterId:c.id,kind:'master',status:'success',masterId:id,...(frozen?{renderRows:rows}:{}),renderGap:c.gap,renderProfile:profile},c.id);
    return record;
  };
  const crop=async(startFrame,endFrame)=>updateAudioRange(store,{operationId:uid(),unitId:domain.list(chapter.id)[0].id,mode:'dry',audioId:audios[0].id,expectedRevision:savedAudioRange(store,domain.list(chapter.id)[0].id,'dry',audios[0].id)?.revision||0,startFrame,endFrame});
  return {directory,store,domain,chapter,audios,maintenance,master,crop};
}

test('历史回收保留最近版本、导出、助手、未知恢复及读取，旧ID并发恢复精确立体声与裁剪',async t=>{
  const f=await fixture(t);await f.crop(100,4500);const old=await f.master(),oldBytes=readFileSync(join(f.directory,old.path)),oldJob=f.store.get('jobs',old.jobId);
  const exported=await f.master(),assistant=await f.master(),unknown=await f.master(),reading=await f.master();
  f.store.put('exports',{id:uid(),chapterId:f.chapter.id,masterId:exported.id,path:'output/finished.wav'},f.chapter.id);
  f.store.put('assistantSteps',{id:uid(),resultRefs:{outputs:[{kind:'master',id:assistant.id}]}},'synthetic-run');
  f.store.put('jobs',{id:uid(),chapterId:f.chapter.id,kind:'export',status:'unknown',masterId:unknown.id},f.chapter.id);
  const release=f.maintenance.acquireRead(join(f.directory,reading.path));
  await f.crop(300,4200);const recent=await f.master(),current=await f.master();
  const settingsBefore=JSON.stringify(f.store.all('settings').filter(s=>s.id.startsWith('audio-range:'))),audioBefore=f.audios.map(a=>readFileSync(join(f.directory,a.path)));
  assert.deepEqual(f.maintenance.planMasterCleanup().candidates.map(m=>m.id),[old.id]);
  const reclaimed=await f.maintenance.cleanupMasters();assert.deepEqual(reclaimed.reclaimed.map(m=>m.id),[old.id]);assert.equal(existsSync(join(f.directory,old.path)),false);
  for(const record of [exported,assistant,unknown,reading,recent,current])assert.ok(existsSync(join(f.directory,record.path)));
  const historical=f.store.get('masters',old.id);assert.ok(historical.fileReclaimedAt);assert.deepEqual(f.store.get('jobs',old.jobId),oldJob);assert.equal(f.store.all('masters').length,7);
  const diagnostic=workspaceDiagnostics(f.store);assert.equal(diagnostic.counts.reclaimedMasters,1);assert.equal(diagnostic.missing.filter(item=>item.kind==='masters').length,0);assert.equal(diagnostic.reclaimedMasters[0].id,old.id);
  const results=await Promise.all([f.maintenance.ensureMasterFile(old.id),f.maintenance.ensureMasterFile(old.id),f.maintenance.ensureMasterFile(old.id)]);
  assert.ok(results.every(m=>m.id===old.id));assert.deepEqual(readFileSync(join(f.directory,old.path)),oldBytes);assert.deepEqual(f.store.get('masters',old.id),historical,'恢复不改变历史编排和元数据');
  assert.equal(await pcmWave(join(f.directory,old.path),wave=>wave.channels),2);assert.equal(JSON.stringify(f.store.all('settings').filter(s=>s.id.startsWith('audio-range:'))),settingsBefore);
  f.audios.forEach((a,i)=>assert.deepEqual(readFileSync(join(f.directory,a.path)),audioBefore[i]));assert.equal(f.store.all('attempts').length,0);assert.equal(f.maintenance.restoringCount,0);
  release();release();assert.equal(f.maintenance.readPaths.length,0);
});

test('旧全长mono映射可回收重建，缺凭据、缺源及同帧篡改源保留',async t=>{
  const f=await fixture(t),legacy=await f.master({profile:LEGACY_RENDER_PROFILE,frozen:false}),bytes=readFileSync(join(f.directory,legacy.path));
  const noProof=await f.master({frozen:false});for(const a of f.audios){const current=f.store.get('audios',a.id);delete current.delivery;f.store.put('audios',current,f.chapter.id);}
  await f.master();await f.master();assert.ok(f.maintenance.planMasterCleanup().skipped.some(s=>s.id===legacy.id&&/凭据/.test(s.reason)));assert.ok(f.maintenance.planMasterCleanup().skipped.some(s=>s.id===noProof.id));
  for(const a of f.audios)f.store.put('audios',a,f.chapter.id);
  const changed=readFileSync(join(f.directory,f.audios[0].path));changed.writeInt16LE(123,44+200*4);writeFileSync(join(f.directory,f.audios[0].path),changed);
  const rejected=await f.maintenance.cleanupMasters();assert.ok(rejected.skipped.some(s=>s.id===legacy.id&&/字节已变化/.test(s.reason)));assert.ok(existsSync(join(f.directory,legacy.path)));
  writeFileSync(join(f.directory,f.audios[0].path),wav(4800,2));const reclaimed=await f.maintenance.cleanupMasters({limit:1});assert.equal(reclaimed.reclaimed.length,1);assert.equal(reclaimed.reclaimed[0].id,legacy.id);
  await f.maintenance.ensureMasterFile(legacy.id);assert.deepEqual(readFileSync(join(f.directory,legacy.path)),bytes);assert.equal(await pcmWave(join(f.directory,legacy.path),wave=>wave.channels),1);assert.deepEqual(f.store.get('masters',legacy.id).mapping,legacy.mapping);
  rmSync(join(f.directory,f.audios[1].path));assert.ok(f.maintenance.planMasterCleanup().skipped.some(s=>s.id===noProof.id&&/缺失/.test(s.reason)));assert.ok(existsSync(join(f.directory,noProof.path)));
});

test('回收前新增读取阻止删除，字节比对失败及损坏配方不破坏旧文件',async t=>{
  const f=await fixture(t),old=await f.master(),bad=await f.master();await f.master();await f.master();
  const wrong=readFileSync(join(f.directory,bad.path));wrong[wrong.length-1]^=1;writeFileSync(join(f.directory,bad.path),wrong);
  let release;const original=f.store.get.bind(f.store),mock=t.mock.method(f.store,'get',(table,id)=>{const row=original(table,id);if(table==='audios'&&f.maintenance.restoringCount&&!release)release=f.maintenance.acquireRead(old.path);return row;});
  const result=await f.maintenance.cleanupMasters();assert.equal(result.reclaimed.length,0);assert.ok(result.skipped.some(s=>s.id===old.id&&/使用/.test(s.reason)));assert.ok(result.skipped.some(s=>s.id===bad.id&&/字节不一致/.test(s.reason)));assert.ok(existsSync(join(f.directory,old.path)));assert.ok(existsSync(join(f.directory,bad.path)));release();mock.mock.restore();
  const damaged={...old,frames:old.frames+1};f.store.put('masters',damaged,f.chapter.id);assert.ok(f.maintenance.planMasterCleanup().skipped.some(s=>s.id===old.id&&/不完整/.test(s.reason)));const invalid=await f.maintenance.cleanupMasters({limit:1});assert.equal(invalid.skipped.length,1,'limit限制验证尝试，失败也不能继续大量重建');
  assert.deepEqual(readFileSync(join(f.directory,bad.path)),wrong);assert.equal(readdirSync(join(f.directory,'masters')).filter(name=>name.endsWith('.part')).length,0);assert.equal(f.maintenance.restoringCount,0);
});

test('回收回执登记失败时不删除母版，持久标记先于文件回收',async t=>{
  const f=await fixture(t),old=await f.master(),before=readFileSync(join(f.directory,old.path));await f.master();await f.master();
  const original=f.store.put.bind(f.store),mock=t.mock.method(f.store,'put',(table,row,parent)=>{if(table==='masters'&&row.id===old.id&&row.fileReclaimedAt)throw Error('模拟只读或数据库登记失败');return original(table,row,parent);});
  const rejected=await f.maintenance.cleanupMasters({limit:1});assert.equal(rejected.reclaimed.length,0);assert.match(rejected.skipped[0].reason,/数据库登记失败/);assert.deepEqual(readFileSync(join(f.directory,old.path)),before);assert.deepEqual(f.store.get('masters',old.id),old);mock.mock.restore();
  const observe=t.mock.method(f.store,'put',(table,row,parent)=>{if(table==='masters'&&row.id===old.id&&row.fileReclaimedAt)assert.ok(existsSync(join(f.directory,old.path)),'回收回执必须在WAV删除前保存');return original(table,row,parent);});
  assert.equal((await f.maintenance.cleanupMasters({limit:1})).reclaimed.length,1);assert.equal(existsSync(join(f.directory,old.path)),false);assert.ok(f.store.get('masters',old.id).fileReclaimedAt);observe.mock.restore();
});

test('迁移保留冷母版冻结配方、不暖缓存，缺失原件不能被回收标记掩盖',async t=>{
  const f=await fixture(t);await f.crop(100,4500);const old=await f.master(),before=readFileSync(join(f.directory,old.path));await f.crop(300,4200);await f.master();await f.master();
  assert.equal((await f.maintenance.cleanupMasters()).reclaimed.length,1);
  const destination=f.directory+'-moved';t.after(()=>rmSync(destination,{recursive:true,force:true}));await copyWorkspace(f.store,destination);
  const copied=openStore(destination);t.after(()=>copied.close());const cold=copied.get('masters',old.id);
  assert.ok(cold.fileReclaimedAt);assert.equal(existsSync(join(destination,cold.path)),false);assert.equal(existsSync(join(destination,'.audio-range-cache')),false,'迁移不为冷历史预热解码缓存');
  assert.deepEqual(cold.mapping,old.mapping);assert.equal(workspaceDiagnostics(copied).counts.reclaimedMasters,1);
  await createStorageMaintenance(copied).ensureMasterFile(old.id);assert.deepEqual(readFileSync(join(destination,cold.path)),before);
  const rejected=f.directory+'-missing-source';t.after(()=>rmSync(rejected,{recursive:true,force:true}));rmSync(join(f.directory,f.audios[0].path));await assert.rejects(copyWorkspace(f.store,rejected),/原始素材|原件|缺失/);assert.equal(existsSync(rejected),false);
});

test('limit=1连续闲时回收不会被首份失败饿死，修复文件后下一轮仍可重新验证',async t=>{
  const f=await fixture(t),old=[];for(let index=0;index<4;index++)old.push(await f.master());await f.master();await f.master();
  const original=readFileSync(join(f.directory,old[0].path)),wrong=Buffer.from(original);wrong[wrong.length-1]^=1;writeFileSync(join(f.directory,old[0].path),wrong);
  const rounds=[];
  for(let index=0;index<4;index++){const started=performance.now(),result=await f.maintenance.cleanupMasters({limit:1});rounds.push({ms:Number((performance.now()-started).toFixed(2)),attempts:result.reclaimed.length+result.skipped.length,reclaimed:result.reclaimed.map(m=>old.findIndex(x=>x.id===m.id)),skipped:result.skipped.map(m=>old.findIndex(x=>x.id===m.id)),bytes:result.bytes});}
  t.diagnostic(JSON.stringify({fixture:'4历史+2保留、2段各4800帧',rounds}));
  assert.ok(rounds.every(round=>round.attempts===1),'每轮包括失败在内最多一个实际验证');assert.deepEqual(rounds.map(round=>round.reclaimed),[[],[1],[2],[3]],'失败首项不能阻止其后3份历史回收');
  assert.deepEqual(readFileSync(join(f.directory,old[0].path)),wrong);writeFileSync(join(f.directory,old[0].path),original);
  const repaired=await f.maintenance.cleanupMasters({limit:1});assert.deepEqual(repaired.reclaimed.map(m=>m.id),[old[0].id],'轮转不能永久拉黑失败历史');assert.equal(f.store.all('attempts').length,0);assert.equal(f.maintenance.restoringCount,0);
});

test('取消原音证明或临时PCM写入会关闭流、移除自己的临时文件并保留全部历史',async t=>{
  for(const phase of ['source-proof','master-pcm'])await t.test(phase,async t=>{
    const f=await fixture(t,{frames:1024*1024}),old=await f.master();await f.master();await f.master();const before=readFileSync(join(f.directory,old.path)),controller=new AbortController(),native=fs.createReadStream;let interrupted;
    const mock=t.mock.method(fs,'createReadStream',(file,options)=>{
      const stream=native(file,options);
      if(String(file)===join(f.directory,f.audios[0].path)&&(phase==='source-proof'?!options?.start:options?.start!==undefined)) {
        interrupted=stream;stream.once('data',()=>controller.abort(new Error('用户开始操作，停止后台证明')));
      }
      return stream;
    });syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
    const started=performance.now(),result=await f.maintenance.cleanupMasters({limit:1,signal:controller.signal});
    assert.ok(interrupted,'实际媒体流应触发取消');assert.equal(controller.signal.aborted,true);assert.equal(result.aborted,true);assert.equal(result.reclaimed.length,0);assert.equal(result.skipped.length,0,'用户取消不标成损坏或回收失败');assert.equal(interrupted.closed,true);assert.ok(interrupted.bytesRead<4*1024*1024,'取消后不能继续读完大文件');assert.equal(f.maintenance.restoringCount,0);
    assert.deepEqual(readFileSync(join(f.directory,old.path)),before);assert.equal(f.store.get('masters',old.id).fileReclaimedAt,undefined);assert.deepEqual(readdirSync(join(f.directory,'masters')).sort(),f.store.all('masters').map(m=>m.id+'.wav').sort(),'只清除本次临时文件，历史均保留');
    t.diagnostic(JSON.stringify({phase,cancelMs:Number((performance.now()-started).toFixed(2))}));mock.mock.restore();syncBuiltinESMExports();assert.equal((await f.maintenance.cleanupMasters({limit:1})).reclaimed.length,1,'取消后仍可以重新验证并回收');
  });
});

test('123段长章闲时只证明一份历史，输出实测耗时和事件循环间隔',async t=>{
  const f=await fixture(t,{frames:48000*8,segments:123});assert.equal(f.audios.length,123);const old=await f.master();await f.master();await f.master();
  const started=performance.now();let tick=started,maxTickMs=0;
  const timer=setInterval(()=>{const now=performance.now();maxTickMs=Math.max(maxTickMs,now-tick);tick=now;},10);
  let result;try{result=await f.maintenance.cleanupMasters({limit:1});}finally{clearInterval(timer);maxTickMs=Math.max(maxTickMs,performance.now()-tick);}
  assert.deepEqual(result.reclaimed.map(m=>m.id),[old.id]);assert.equal(result.skipped.length,0);assert.equal(f.store.all('masters').filter(m=>existsSync(join(f.directory,m.path))).length,2);assert.equal(f.store.all('attempts').length,0);
  t.diagnostic(JSON.stringify({segments:123,secondsPerSource:8,sourceBytes:f.audios.reduce((sum,a)=>sum+fs.statSync(join(f.directory,a.path)).size,0),reclaimedBytes:result.bytes,proofMs:Number((performance.now()-started).toFixed(2)),maxEventLoopTickMs:Number(maxTickMs.toFixed(2))}));
});

test('冷源原生进程取消快速收尾，共享等待者取消保留owner缓存，区间PCM取消关闭句柄',async t=>{
  const f=await fixture(t,{frames:1024*1024}),audio=f.audios[0],cache=join(f.directory,'.audio-range-cache');await validateStoredAudio(f.store,audio);
  const waitFor=async condition=>{const deadline=performance.now()+2000;while(!condition()){assert.ok(performance.now()<deadline,'隔离任务应进入指定实际处理阶段');await new Promise(resolve=>setTimeout(resolve,1));}};
  const controller=new AbortController(),pending=prepareAudioSource(f.store,audio.id,{signal:controller.signal});pending.catch(()=>{});
  await waitFor(()=>audioRangeActivity().preparing>0&&mediaProcessActivity().active>0);const stopped=performance.now();controller.abort();await assert.rejects(pending,error=>error.name==='AbortError');
  assert.equal(audioRangeActivity().preparing,0);assert.equal(mediaProcessActivity().active,0);assert.equal(f.store.get('audios',audio.id).invalid,undefined);assert.equal(diskStatus(f.directory).reservedBytes,0);assert.equal(readdirSync(cache).filter(name=>name.endsWith('.part')).length,0);
  t.diagnostic(JSON.stringify({phase:'cold-native-process',cancelMs:Number((performance.now()-stopped).toFixed(2))}));
  const owner=prepareAudioSource(f.store,audio.id);await waitFor(()=>audioRangeActivity().preparing>0);const waiterController=new AbortController(),waiter=prepareAudioSource(f.store,audio.id,{signal:waiterController.signal});waiter.catch(()=>{});await new Promise(resolve=>setTimeout(resolve,2));waiterController.abort();
  const source=await owner;await assert.rejects(waiter,error=>error.name==='AbortError');assert.ok(existsSync(source.pcmPath));assert.equal(audioRangeActivity().preparing,0);assert.deepEqual(await prepareAudioSource(f.store,audio.id),source,'共享owner完成的canonical源不得被等待者取消删除');
  const clipController=new AbortController(),nativeOpen=fsp.open;let input,bytesRead=0;
  const mock=t.mock.method(fsp,'open',async(...args)=>{const handle=await nativeOpen(...args);if(args[0]===source.pcmPath&&args[1]==='r'){input=handle;const nativeRead=handle.read.bind(handle);t.mock.method(handle,'read',async(...readArgs)=>{const result=await nativeRead(...readArgs);bytesRead+=result.bytesRead;clipController.abort();return result;});}return handle;});syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const started=performance.now();await assert.rejects(renderRangeResource(f.store,f.domain.list(f.chapter.id)[0].id,'dry',audio.id,100,source.sourceFrames-100,null,{signal:clipController.signal}),error=>error.name==='AbortError');
  assert.ok(input);assert.equal(input.fd,-1);assert.equal(bytesRead,65536);assert.equal(audioRangeActivity().clips,0);assert.equal(diskStatus(f.directory).reservedBytes,0);assert.equal(readdirSync(cache).filter(name=>name.endsWith('.part')||name.endsWith('.wav')).length,0);assert.ok(existsSync(source.pcmPath));assert.equal(f.store.all('attempts').length,0);
  t.diagnostic(JSON.stringify({phase:'clip-pcm',cancelMs:Number((performance.now()-started).toFixed(2)),bytesRead}));mock.mock.restore();syncBuiltinESMExports();
});

test('低空间在源PCM和区间WAV写入前拒绝，原音、已完成缓存及范围保持完整',async t=>{
  const f=await fixture(t),audio=f.audios[0],before=readFileSync(join(f.directory,audio.path));await validateStoredAudio(f.store,audio);let freeBytes=DISK_SAFETY_BYTES+512;
  const mock=t.mock.method(fs,'statfsSync',()=>({bavail:freeBytes,bsize:1}));syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  await assert.rejects(prepareAudioSource(f.store,audio.id),error=>error.status===507&&error.code==='disk-space-low');const cache=join(f.directory,'.audio-range-cache');assert.deepEqual(readdirSync(cache),[]);assert.equal(audioRangeActivity().preparing,0);assert.equal(diskStatus(f.directory).reservedBytes,0);
  freeBytes=DISK_SAFETY_BYTES+64*1024*1024;const source=await prepareAudioSource(f.store,audio.id),pcm=readFileSync(source.pcmPath);freeBytes=DISK_SAFETY_BYTES+512;
  await assert.rejects(renderRangeResource(f.store,f.domain.list(f.chapter.id)[0].id,'dry',audio.id,1,source.sourceFrames-1),error=>error.status===507&&error.code==='disk-space-low');
  assert.equal(audioRangeActivity().clips,0);assert.equal(diskStatus(f.directory).reservedBytes,0);assert.equal(readdirSync(cache).filter(name=>name.endsWith('.wav')||name.endsWith('.part')).length,0);assert.deepEqual(readFileSync(join(f.directory,audio.path)),before);assert.deepEqual(readFileSync(source.pcmPath),pcm);assert.equal(savedAudioRange(f.store,f.domain.list(f.chapter.id)[0].id,'dry',audio.id),null);assert.equal(f.store.get('audios',audio.id).invalid,undefined);assert.equal(f.store.all('attempts').length,0);
});
