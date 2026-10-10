import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain, inputOf, basisOf } from '../server/domain.mjs';
import { compile } from '../server/templates.mjs';
import { resolveAudioRange, prepareAudioSource, audioWaveform, updateAudioRange, undoAudioRange, getRangeOperation, renderRangeResource, renderIdentity, renderMatches, renderProfileOf, savedAudioRange, audioRangeActivity, DEFAULT_RENDER_PROFILE, LEGACY_RENDER_PROFILE, BOUNDARY_POLICY } from '../server/audio-range.mjs';
import { buildMaster, exportMaster, inspect, ffmpeg } from '../server/audio.mjs';
import { execFileSync } from 'node:child_process';
import { createWorker } from '../server/worker.mjs';
import { startServer } from '../server/index.mjs';
import { copyWorkspace } from '../server/workspace.mjs';

function wav(frames=4800,channels=2,rate=48000) {
  const b=Buffer.alloc(44+frames*channels*2);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(rate,24);b.writeUInt32LE(rate*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*channels*2,40);
  for(let i=0;i<frames;i++)for(let ch=0;ch<channels;ch++)b.writeInt16LE(i===0||i===frames-1?30000:i===1023&&ch===channels-1?-31000:1200+ch*600,44+(i*channels+ch)*2);return b;
}
const mono=file=>execFileSync(ffmpeg,['-v','error','-i',file,'-ar','48000','-ac','1','-f','s16le','pipe:1']);
function fixture(t) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-range-')),store=openStore(dir),domain=createDomain(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const project=domain.mutate('project.create',{name:'合成波形'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'测试',source:'第一句。第二句。',segment:true}),role=store.all('roles',project.id)[0];
  const voice={id:uid(),name:'合成参考',state:'active',path:'voices/reference.wav'};mkdirSync(join(dir,'voices'));writeFileSync(join(dir,voice.path),wav());store.put('voices',voice);
  domain.mutate('role.update',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,id:role.id,entityRevision:1,voiceId:voice.id});
  domain.mutate('segment.confirm',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id)});
  const audios=domain.list(chapter.id).map(s=>{const a={id:uid(),path:'audio/'+uid()+'.wav',input:inputOf(s),basis:basisOf(s),prompt:compile(s),model:s.model};mkdirSync(join(dir,'audio'),{recursive:true});writeFileSync(join(dir,a.path),wav());s.current=a.id;s.latest='success';s.review={audioId:a.id,basis:basisOf(s),state:'passed'};s.approved=a.id;a.review=s.review;store.put('audios',a,chapter.id);store.put('segments',s,chapter.id);domain.enhancement.syncLegacySegment(s);return a;});
  const units=domain.list(chapter.id).map(s=>s.id),payload=(index,extra={})=>({operationId:uid(),unitId:units[index],mode:'dry',audioId:audios[index].id,expectedRevision:savedAudioRange(store,units[index],'dry',audios[index].id)?.revision || 0,startFrame:100,endFrame:4600,...extra});
  return {dir,store,domain,project,chapter,audios,units,payload};
}

test('真实PCM frame域、右声道尖峰、原件不变及共享范围WAV精确边缘',async t=>{
  const f=fixture(t),before=readFileSync(join(f.dir,f.audios[0].path));
  const source=await prepareAudioSource(f.store,f.audios[0].id);assert.equal(source.sourceFrames,4800);assert.equal(source.channels,2);
  const wave=await audioWaveform(f.store,f.audios[0].id,{level:1024});assert.ok(wave.buckets.some(b=>b.min[1]<-.94));assert.ok(wave.buckets.some(b=>b.max[0]>.91));
  const response=await updateAudioRange(f.store,f.payload(0));
  const clip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,undefined,undefined,response.range),bytes=readFileSync(clip.path),raw=readFileSync(source.pcmPath);
  assert.equal(bytes.length,44+4500*4);assert.equal(bytes.readInt16LE(44),0);assert.equal(bytes.readInt16LE(bytes.length-2),0);assert.deepEqual(bytes.subarray(44+200*4,44+201*4),raw.subarray(300*4,301*4));assert.deepEqual(before,readFileSync(join(f.dir,f.audios[0].path)));
  for(let pos=44;pos<bytes.length;pos+=4)assert.ok(Math.abs(bytes.readInt16LE(pos))<=1200,'裁掉的源首尾脉冲不得泄露');
  const full=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,0,4800);assert.deepEqual(readFileSync(full.path).subarray(44),raw);
});

test('历史任务再大也只查询活动目标的小字段，原mode优先和未知生成编辑锁不变',async t=>{
  const f=fixture(t);
  for(let index=0;index<40;index++)f.store.put('jobs',{id:uid(),chapterId:f.chapter.id,status:'success',renderRows:[{payload:'历史正文'.repeat(5000)}]},f.chapter.id);
  const original=f.store.all.bind(f.store);t.mock.method(f.store,'all',(table,parent)=>{assert.notEqual(table,'jobs','范围读取不得解析全章历史任务');return original(table,parent);});
  assert.equal((await resolveAudioRange(f.store,f.units[0],'dry',f.audios[0].id)).editable,true);
  const job={id:uid(),chapterId:f.chapter.id,status:'running'},attempt={id:uid(),status:'unknown',input:{unitId:f.units[0],mode:'scene'},targetId:f.units[1]};f.store.put('jobs',job,f.chapter.id);f.store.put('attempts',attempt,job.id);
  assert.equal((await resolveAudioRange(f.store,f.units[0],'dry',f.audios[0].id)).editable,true,'scene不能锁住dry');
  f.store.put('attempts',{...attempt,mode:'dry'},job.id);assert.equal((await resolveAudioRange(f.store,f.units[0],'dry',f.audios[0].id)).editable,false,'显式mode仍优先且unknown仍锁当前单元');
  assert.equal((await resolveAudioRange(f.store,f.units[1],'dry',f.audios[1].id)).editable,true,'input.unitId仍优先于targetId');
  f.store.put('jobs',{...job,status:'stopped'},f.chapter.id);assert.equal((await resolveAudioRange(f.store,f.units[0],'dry',f.audios[0].id)).editable,true);
});

test('native48k已裁剪WAV命中不依赖被回收PCM，损坏头及删除cache安全重建，变化源不复用',async t=>{
  const f=fixture(t),saved=await updateAudioRange(f.store,f.payload(0)),source=await prepareAudioSource(f.store,f.audios[0].id),clip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,100,4600,saved.range),before=readFileSync(clip.path);
  const removePcm=()=>{rmSync(source.pcmPath,{force:true});rmSync(source.pcmPath.replace(/\.pcm$/,'.json'),{force:true});};
  removePcm();const hit=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,100,4600,saved.range);assert.equal(hit.path,clip.path);assert.deepEqual(readFileSync(hit.path),before);assert.equal(existsSync(source.pcmPath),false,'已有clip不得为了试听恢复源PCM');
  const damaged=Buffer.from(before);damaged.writeUInt16LE(1,22);writeFileSync(clip.path,damaged);const repaired=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,100,4600,saved.range);assert.deepEqual(readFileSync(repaired.path),before,'同大小错误声道头不能命中');
  removePcm();rmSync(clip.path);assert.deepEqual(readFileSync((await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,100,4600,saved.range)).path),before,'被删除的cache仍可从原音重建');
  const raw=readFileSync(join(f.dir,f.audios[0].path));raw.writeInt16LE(12345,44+700*4);writeFileSync(join(f.dir,f.audios[0].path),raw);
  await assert.rejects(renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,100,4600,saved.range),error=>error.status===409&&/身份/.test(error.message));assert.deepEqual(readFileSync(clip.path),before);assert.equal(f.store.all('attempts').length,0);
});

test('波形放大窗口和不同试听同时准备仍仅一笔有界PCM扫描，缓存丢失可免费重建',async t=>{
  const f=fixture(t),source=await prepareAudioSource(f.store,f.audios[0].id),pcm=readFileSync(source.pcmPath);
  const tasks=Array.from({length:12},(_,i)=>i%2?audioWaveform(f.store,f.audios[0].id,{level:4096,startFrame:i,endFrame:4800-i}):renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,i,4800-i));
  const results=await Promise.all(tasks);assert.ok(results.every(r=>r.path || r.buckets.length<=4096));assert.equal(audioRangeActivity().peak,1);assert.equal(audioRangeActivity().chunkBytes,65536);assert.equal(audioRangeActivity().active,0);
  rmSync(join(f.dir,'.audio-range-cache'),{recursive:true});const restored=await prepareAudioSource(f.store,f.audios[0].id);assert.deepEqual(readFileSync(restored.pcmPath),pcm);assert.equal(restored.sourceHash,source.sourceHash);assert.equal(f.store.all('attempts').length,0);
});

test('CAS、同值幂等、操作回执、异段不丢写、仅目标生成锁、撤销保护原review',async t=>{
  const f=fixture(t),chapterBefore=f.store.get('chapters',f.chapter.id),audioBefore=f.store.get('audios',f.audios[0].id),segmentBefore=f.store.get('segments',f.units[0]);
  const p=f.payload(0),one=await updateAudioRange(f.store,p);assert.equal(one.range.revision,1);assert.equal(one.renderRevision,1);assert.deepEqual(await updateAudioRange(f.store,p),one);assert.equal(getRangeOperation(f.store,p.operationId).status,'completed');
  await assert.rejects(updateAudioRange(f.store,{...p,startFrame:200}),/同一范围操作/);
  await assert.rejects(updateAudioRange(f.store,f.payload(0,{expectedRevision:0})),e=>e.status===409&&e.conflict&&e.range.revision===1);
  const noop=await updateAudioRange(f.store,f.payload(0));assert.equal(noop.changed,false);assert.equal(noop.renderRevision,1);
  const job={id:uid(),chapterId:f.chapter.id,status:'running',kind:'generate'};f.store.put('jobs',job,f.chapter.id);f.store.put('attempts',{id:uid(),segmentId:f.units[1],status:'sending'},job.id);
  await updateAudioRange(f.store,f.payload(0,{startFrame:200}));await assert.rejects(updateAudioRange(f.store,f.payload(1)),/正在重新生成/);
  f.store.put('jobs',{...job,status:'success'},f.chapter.id);await updateAudioRange(f.store,f.payload(1,{startFrame:400}));assert.equal(savedAudioRange(f.store,f.units[0],'dry',f.audios[0].id).startFrame,200);
  const rendered=f.domain.chapter(f.chapter.id);assert.equal(rendered.playbackItems[0].validity,'matched');assert.equal(rendered.playbackItems[0].review,'pending');assert.notEqual(rendered.renderSignature,null);assert.equal(f.store.get('chapters',f.chapter.id).revision,chapterBefore.revision);assert.equal(f.store.get('chapters',f.chapter.id).arrangement,chapterBefore.arrangement);assert.deepEqual(f.store.get('audios',f.audios[0].id),audioBefore);assert.deepEqual(f.store.get('segments',f.units[0]).review,segmentBefore.review);
  const current=savedAudioRange(f.store,f.units[0],'dry',f.audios[0].id),undo={operationId:uid(),unitId:f.units[0],mode:'dry',audioId:f.audios[0].id,expectedRevision:current.revision};const back=await undoAudioRange(f.store,undo);assert.equal(back.range.startFrame,100);assert.deepEqual(await undoAudioRange(f.store,undo),back);
  const earliest=await undoAudioRange(f.store,{...undo,operationId:uid(),expectedRevision:back.range.revision});assert.equal(earliest.range.startFrame,0);assert.equal(earliest.range.endFrame,4800);await assert.rejects(undoAudioRange(f.store,{...undo,operationId:uid(),expectedRevision:earliest.range.revision}),/没有更早/);
});

test('非法范围及源profile无部分写入；新版本不继承；恢复全长复用原听评',async t=>{
  const f=fixture(t),rows=f.domain.enhancement.resolve(f.chapter.id),original=renderIdentity(f.store,f.chapter.id,rows);assert.equal(renderIdentity(f.store,f.chapter.id,rows,LEGACY_RENDER_PROFILE).renderSignature,null);assert.equal(original.renderProfile,DEFAULT_RENDER_PROFILE);
  for(const extra of [{startFrame:-1},{endFrame:4801},{startFrame:100,endFrame:100},{startFrame:NaN},{endFrame:1.5},{decodeProfile:'wrong'},{sourceHash:'wrong'}])await assert.rejects(updateAudioRange(f.store,f.payload(0,extra)));
  assert.equal(savedAudioRange(f.store,f.units[0],'dry',f.audios[0].id),null);
  await updateAudioRange(f.store,f.payload(0));const current=f.domain.chapter(f.chapter.id),s=f.store.get('segments',f.units[0]);
  assert.throws(()=>f.domain.mutate('segment.review',{chapterId:f.chapter.id,revision:current.revision,id:s.id,audioId:s.current,basis:basisOf(s),state:'passed'}),/试听范围/);
  f.domain.mutate('segment.review',{chapterId:f.chapter.id,revision:current.revision,id:s.id,audioId:s.current,basis:basisOf(s),rangeContentKey:current.playbackItems[0].rangeContentKey,state:'passed'});assert.equal(f.domain.chapter(f.chapter.id).playbackItems[0].review,'passed');assert.deepEqual(f.store.get('segments',s.id).review,s.review);
  await updateAudioRange(f.store,f.payload(0,{startFrame:110}));assert.throws(()=>f.domain.mutate('segment.review',{chapterId:f.chapter.id,revision:current.revision,id:s.id,audioId:s.current,basis:basisOf(s),rangeContentKey:current.playbackItems[0].rangeContentKey,state:'passed'}),/试听范围/);
  await updateAudioRange(f.store,f.payload(0,{startFrame:0,endFrame:4800}));assert.equal(f.domain.chapter(f.chapter.id).playbackItems[0].review,'passed');assert.equal(f.domain.chapter(f.chapter.id).renderSignature,original.renderSignature);
  const next={...f.audios[0],id:uid()};f.store.put('audios',next,f.chapter.id);s.current=next.id;f.store.put('segments',s,f.chapter.id);f.domain.enhancement.syncLegacySegment(s);const result=await resolveAudioRange(f.store,s.id,'dry',next.id);assert.equal(result.range.revision,0);assert.equal(result.range.startFrame,0);
  await assert.rejects(updateAudioRange(f.store,f.payload(0)),/当前声音版本/);
});

test('44.1kHz/MP3依实际解码帧；mono与stereo独立保持源声道',async t=>{
  const f=fixture(t);
  for(const [channels,format]of[[1,'wav'],[2,'wav'],[2,'mp3']]){const path=join(f.dir,'test-'+channels+'.'+format),input=join(f.dir,'input-'+channels+'.wav');writeFileSync(input,wav(4410,channels,44100));if(format==='mp3')execFileSync(ffmpeg,['-v','error','-i',input,'-y',path]);else writeFileSync(path,readFileSync(input));const a={...f.audios[0],id:uid(),path:'test-'+channels+'.'+format};f.store.put('audios',a,f.chapter.id);const source=await prepareAudioSource(f.store,a.id);assert.equal(source.channels,channels);const decoded=execFileSync(ffmpeg,['-v','error','-i',path,'-ar','48000','-c:a','pcm_s16le','-f','s16le','pipe:1']);assert.equal(source.sourceFrames,decoded.length/(channels*2));assert.deepEqual(readFileSync(source.pcmPath),decoded);
    const master=await buildMaster(f.store,[{s:f.domain.enhancement.resolve(f.chapter.id)[0].s,a}],0,uid(),LEGACY_RENDER_PROFILE),expected=mono(path);assert.equal(master.frames,expected.length/2);assert.equal(master.channels,1);assert.equal(master.sampleRate,48000);assert.deepEqual(mono(join(f.dir,master.path)),expected,'非规范源仍应按原FFmpeg合同转换');
  }
});

test('规范mono含奇数JUNK和非44字节data偏移，裁剪fade母版PCM与FFmpeg参考逐字节相同',async t=>{
  const f=fixture(t),metadata=Buffer.alloc(12);metadata.write('JUNK');metadata.writeUInt32LE(3,4);metadata.set([42,99,7],8);
  for(const audio of f.audios){const bytes=wav(4800,1);for(let frame=0;frame<4800;frame++)bytes.writeInt16LE((frame*7919)%60001-30000,44+frame*2);const source=Buffer.concat([bytes.subarray(0,36),metadata,bytes.subarray(36)]);source.writeUInt32LE(source.length-8,4);writeFileSync(join(f.dir,audio.path),source);}
  const saved=await updateAudioRange(f.store,f.payload(0,{startFrame:143,endFrame:4679})),rows=f.domain.enhancement.resolve(f.chapter.id).map(r=>({...r,range:savedAudioRange(f.store,r.s.id,r.s.mode,r.a.id)})),clip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,143,4679,saved.range);
  const clipped=mono(clip.path),expected=Buffer.concat([clipped,Buffer.alloc(480*2),mono(join(f.dir,f.audios[1].path))]),master=await buildMaster(f.store,rows,.01,uid(),LEGACY_RENDER_PROFILE);
  assert.equal(clipped.readInt16LE(0),0);assert.equal(clipped.readInt16LE(clipped.length-2),0);assert.equal(master.frames,4536+480+4800);assert.equal(master.mapping[0].clipStartFrame,143);assert.equal(master.mapping[0].clipEndFrame,4679);assert.equal(master.mapping[1].startFrame,4536+480);assert.deepEqual(mono(join(f.dir,master.path)),expected);
});

test('母版冻结范围不读取后续手势，全stereo含奇数JUNK和fade按原逐段mono合同逐字节相同',async t=>{
  const f=fixture(t),metadata=Buffer.alloc(12);metadata.write('JUNK');metadata.writeUInt32LE(3,4);metadata.set([42,99,7],8);
  for(const audio of f.audios){const bytes=wav();for(let frame=0;frame<4800;frame++)for(let channel=0;channel<2;channel++)bytes.writeInt16LE((frame*(channel?6271:7919)+channel*127)%60001-30000,44+(frame*2+channel)*2);const source=Buffer.concat([bytes.subarray(0,36),metadata,bytes.subarray(36)]);source.writeUInt32LE(source.length-8,4);writeFileSync(join(f.dir,audio.path),source);}
  const saved=await updateAudioRange(f.store,f.payload(0,{startFrame:143,endFrame:4679})),rows=f.domain.enhancement.resolve(f.chapter.id).map(r=>({...r,range:savedAudioRange(f.store,r.s.id,r.s.mode,r.a.id)})),clip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,143,4679,saved.range);
  await updateAudioRange(f.store,f.payload(0,{startFrame:600,endFrame:3700}));
  const result=await buildMaster(f.store,rows,.01,uid(),LEGACY_RENDER_PROFILE);assert.equal(result.frames,4536+480+4800);assert.equal(result.mapping[0].clipStartFrame,143);assert.equal(result.mapping[0].clipEndFrame,4679);assert.equal(result.mapping[0].rangeRevision,1);assert.equal(result.mapping[1].startFrame,4536+480);assert.equal(result.mapping[1].endFrame,result.frames);
  const expected=Buffer.concat([mono(clip.path),Buffer.alloc(480*2),mono(join(f.dir,f.audios[1].path))]);assert.deepEqual(mono(join(f.dir,result.path)),expected);assert.equal(mono(clip.path).readInt16LE(0),0);assert.equal(mono(clip.path).readInt16LE(4536*2-2),0);
});

test('排队全长母版后裁剪再恢复全长，新准备不能复用旧renderRevision队列',async t=>{
  const f=fixture(t),worker=createWorker(f.store,f.domain,{key:''});
  try {
  const submit=()=>worker.submit({kind:'master',chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,commandId:uid()});
  const before=await submit();assert.equal(before.renderProfile,DEFAULT_RENDER_PROFILE);assert.equal(typeof before.renderSignature,'string');assert.equal(before.renderRevision,0);
  await updateAudioRange(f.store,f.payload(0));await updateAudioRange(f.store,f.payload(0,{startFrame:0,endFrame:4800}));
  const latest=await submit();assert.notEqual(latest.id,before.id);assert.equal(latest.renderSignature,before.renderSignature);assert.equal(latest.renderRevision,2);assert.equal(f.store.get('jobs',before.id).status,'stopped');
  await worker.tick();assert.equal(f.store.get('jobs',latest.id).status,'success',f.store.get('jobs',latest.id).error);assert.equal(f.domain.chapter(f.chapter.id).masters.find(m=>m.id===f.store.get('jobs',latest.id).masterId).current,true);
  }finally{worker.close();await worker.drain();}
});

test('真实HTTP范围冲突、稳定操作查询与字节区间试听，迁移保留用户范围并重建缓存',async t=>{
  const f=fixture(t),app=await startServer({port:0,directory:f.dir,config:{key:''}});
  const base='http://127.0.0.1:'+app.server.address().port,post=async(path,p)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
  try{
    assert.equal((await fetch(base+'/',{headers:{Origin:base}})).status,200,'随机监听端口的同源前端资源可以加载');
    assert.equal((await fetch(base+'/',{headers:{Origin:'https://example.com'}})).status,403,'外部来源仍被拒绝');
    const loaded=await(await fetch(base+'/api/units/'+f.units[0]+'/audio-range?mode=dry&audioId='+f.audios[0].id)).json();assert.equal(loaded.range.sourceFrames,4800);assert.equal(loaded.editable,true);
    const operation=f.payload(0),response=await post('/api/audio-ranges/update',operation);assert.equal(response.status,200);const saved=await response.json();
    const conflict=await post('/api/audio-ranges/update',f.payload(0,{expectedRevision:0,startFrame:200}));assert.equal(conflict.status,409);const error=await conflict.json();assert.equal(error.conflict,true);assert.equal(error.range.revision,1);
    const receipt=await(await fetch(base+'/api/audio-ranges/operations/'+operation.operationId)).json();assert.equal(receipt.status,'completed');assert.deepEqual(receipt.range,saved.range);
    const audio=await fetch(base+loaded.previewUrl,{headers:{Range:'bytes=0-43'}});assert.equal(audio.status,206);const header=Buffer.from(await audio.arrayBuffer());assert.equal(header.toString('ascii',0,4),'RIFF');
    const peaks=await(await fetch(base+'/api/audios/'+f.audios[0].id+'/waveform?level=4096')).json();assert.ok(peaks.buckets.some(b=>b.min[1]<-.94));
  }finally{await app.close();}
  const destination=mkdtempSync(join(tmpdir(),'dubbing-range-copy-'));rmSync(destination,{recursive:true});t.after(()=>rmSync(destination,{recursive:true,force:true}));
  await copyWorkspace(f.store,destination);assert.equal(existsSync(join(destination,'.audio-range-cache')),false);
  const copied=openStore(destination);try{const range=savedAudioRange(copied,f.units[0],'dry',f.audios[0].id);assert.equal(range.startFrame,100);assert.equal(range.endFrame,4600);assert.equal(getRangeOperation(copied,range.lastOperationId).status,'completed');const clip=await renderRangeResource(copied,f.units[0],'dry',f.audios[0].id);assert.equal(clip.frames,4500);assert.ok(existsSync(clip.path));}finally{copied.close();}
});

test('对戏共享单元只有一条范围，scene联合源两声道同步保留、dry隔离且组母版无成员间gap',async t=>{
  const f=fixture(t),e=f.domain.enhancement,created=f.domain.mutate('unit.create',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids:f.units,guidance:'两句连贯衔接。'}),group=e.getUnit(created.id),audioByMode={};
  assert.equal(group.state,'pending');
  for(const [mode,frames]of[['dry',6000],['scene',7200]]){
    const input=e.input(group,mode),audio={id:uid(),chapterId:f.chapter.id,path:'audio/group-'+mode+'.wav',input,basis:e.basis(group,mode),prompt:compile(input),model:input.model};
    const bytes=wav(frames,2);
    // Distinct signals stand in for dialogue and background in one joint source.
    if(mode==='scene')for(let frame=0;frame<frames;frame++){bytes.writeInt16LE(Math.round(8000*Math.sin(frame*.11)),44+frame*4);bytes.writeInt16LE(Math.round(5000*Math.sin(frame*.031)),44+frame*4+2);}
    writeFileSync(join(f.dir,audio.path),bytes);f.store.put('audios',audio,f.chapter.id);audioByMode[mode]=audio;
    group.variants[mode]={...group.variants[mode],current:audio.id,latest:'success',review:{audioId:audio.id,basis:audio.basis,state:'passed'}};
  }
  group.state='active';f.store.put('units',group,f.chapter.id);f.domain.touch(f.store.get('chapters',f.chapter.id),false,true);
  const current=f.domain.chapter(f.chapter.id);assert.equal(current.playbackItems.length,1);assert.deepEqual(current.playbackItems[0].members,f.units);
  const dry=await updateAudioRange(f.store,{operationId:uid(),unitId:group.id,mode:'dry',audioId:audioByMode.dry.id,expectedRevision:0,startFrame:100,endFrame:5000});assert.equal(f.store.all('settings').filter(s=>s.id.startsWith('audio-range:')).length,1);
  assert.equal((await resolveAudioRange(f.store,group.id,'scene',audioByMode.scene.id)).range.startFrame,0);
  await assert.rejects(updateAudioRange(f.store,{operationId:uid(),unitId:f.units[0],mode:'dry',audioId:audioByMode.dry.id,expectedRevision:0,startFrame:100,endFrame:5000}),/不属于/);
  f.domain.mutate('unit.switch',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,id:group.id,entityRevision:e.getUnit(group.id).revision,mode:'scene'});
  const scene=await updateAudioRange(f.store,{operationId:uid(),unitId:group.id,mode:'scene',audioId:audioByMode.scene.id,expectedRevision:0,startFrame:701,endFrame:6803});assert.equal(f.store.all('settings').filter(s=>s.id.startsWith('audio-range:')).length,2);assert.deepEqual(savedAudioRange(f.store,group.id,'dry',audioByMode.dry.id),dry.range);
  const resource=await renderRangeResource(f.store,group.id,'scene',audioByMode.scene.id,undefined,undefined,scene.range),raw=readFileSync((await prepareAudioSource(f.store,audioByMode.scene.id)).pcmPath),clipped=readFileSync(resource.path).subarray(44);assert.equal(resource.channels,2);assert.equal(resource.frames,6102);assert.equal(clipped.length,6102*4);assert.ok(clipped.subarray(500*4,5800*4).equals(raw.subarray((701+500)*4,(701+5800)*4)),'联合源两个声道的保留中部应逐帧相同');
  const rows=e.resolve(f.chapter.id).map(r=>({...r,range:savedAudioRange(f.store,r.s.id,r.s.mode,r.a.id)})),master=await buildMaster(f.store,rows,.12,uid());assert.equal(master.frames,6102);assert.equal(master.mapping.length,1);assert.deepEqual(master.mapping[0].memberIds,f.units);assert.equal(master.mapping[0].unitId,group.id);assert.equal(master.mapping[0].mode,'scene');assert.equal(master.mapping[0].audioId,audioByMode.scene.id);assert.equal(master.mapping[0].clipStartFrame,701);assert.equal(master.mapping[0].clipEndFrame,6803);assert.equal(master.mapping[0].segmentId,undefined);
  f.domain.mutate('unit.switch',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,id:group.id,entityRevision:e.getUnit(group.id).revision,mode:'dry'});assert.equal(f.domain.chapter(f.chapter.id).playbackItems[0].clipStartFrame,100);assert.equal(f.domain.chapter(f.chapter.id).playbackItems[0].clipEndFrame,5000);assert.equal(f.store.all('attempts').length,0);
});

test('S3版本化输出保留stereo侧声，mono等幅复制，legacy不误复用且WAV/MP3共享profile',async t=>{
  const pcm=file=>execFileSync(ffmpeg,['-v','error','-i',file,'-ar','48000','-f','s16le','pipe:1']);
  await t.test('stereo左右、范围fade、人工gap与旧profile',async t=>{
    const f=fixture(t),bytes=wav();for(let frame=0;frame<4800;frame++){const value=(frame*7919)%60001-30000;bytes.writeInt16LE(value,44+frame*4);bytes.writeInt16LE(-value,44+frame*4+2);}writeFileSync(join(f.dir,f.audios[0].path),bytes);
    const saved=await updateAudioRange(f.store,f.payload(0,{startFrame:143,endFrame:4679})),rows=f.domain.enhancement.resolve(f.chapter.id).map(r=>({...r,range:savedAudioRange(f.store,r.s.id,r.s.mode,r.a.id)})),clip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,143,4679,saved.range),id=uid(),result=await buildMaster(f.store,rows,.01,id),expected=Buffer.concat([pcm(clip.path),Buffer.alloc(480*4),pcm(join(f.dir,f.audios[1].path))]);
    assert.equal(result.renderProfile,DEFAULT_RENDER_PROFILE);assert.equal(result.boundaryPolicy,BOUNDARY_POLICY);assert.equal(result.channels,2);assert.equal(result.processing,'pcm_s16le-48000-stereo');assert.ok(pcm(join(f.dir,result.path)).equals(expected),'左右保留PCM及原gap应逐字节相同');assert.equal(result.mapping[0].renderProfile,DEFAULT_RENDER_PROFILE);assert.equal(result.mapping[1].startFrame,4536+480);assert.equal(result.frames,4536+480+4800);
    const identity=renderIdentity(f.store,f.chapter.id,rows),legacyIdentity=renderIdentity(f.store,f.chapter.id,rows,LEGACY_RENDER_PROFILE),legacy=await buildMaster(f.store,rows,.01,uid(),LEGACY_RENDER_PROFILE),oldBytes=readFileSync(join(f.dir,legacy.path));assert.equal(legacy.channels,1);assert.equal(legacy.mapping[0].renderProfile,undefined,'旧mapping对象形状保持');assert.equal(renderProfileOf({}),LEGACY_RENDER_PROFILE);assert.equal(renderMatches({...legacy,renderSignature:legacyIdentity.renderSignature},identity),false);assert.equal(renderMatches({renderSignature:legacyIdentity.renderSignature},legacyIdentity),true);
    const master={id,chapterId:f.chapter.id,arrangement:f.chapter.arrangement,...result,...identity};
    const wavPath=await exportMaster(f.store,master,uid(),'wav'),mp3Path=await exportMaster(f.store,master,uid(),'mp3');assert.ok(readFileSync(join(f.dir,wavPath)).equals(readFileSync(join(f.dir,result.path))));assert.equal((await inspect(join(f.dir,mp3Path))).channels,2);assert.equal((await inspect(join(f.dir,mp3Path))).sampleRate,48000);assert.ok(readFileSync(join(f.dir,legacy.path)).equals(oldBytes),'新成品不得覆写旧母版');assert.ok(readFileSync(join(f.dir,f.audios[0].path)).equals(bytes),'原件只读');
    const sameClip=await renderRangeResource(f.store,f.units[0],'dry',f.audios[0].id,143,4679,saved.range);assert.equal(sameClip.path,clip.path,'native范围缓存可共享，但母版profile不可混用');assert.equal(f.store.all('attempts').length,0);
  });
  for(const [rate,format]of[[48000,'wav'],[44100,'wav'],[44100,'mp3']])await t.test('mono/stereo混合 '+rate+' '+format,async t=>{
    const f=fixture(t),monoFile=join(f.dir,'mono-source.'+format),input=join(f.dir,'mono-input.wav'),frames=Math.round(rate*.1),bytes=wav(frames,1,rate);for(let frame=0;frame<frames;frame++)bytes.writeInt16LE((frame*7919)%60001-30000,44+frame*2);writeFileSync(input,bytes);if(format==='mp3')execFileSync(ffmpeg,['-v','error','-i',input,'-y',monoFile]);else writeFileSync(monoFile,bytes);
    const rows=f.domain.enhancement.resolve(f.chapter.id);rows[1]={...rows[1],a:{...rows[1].a,path:'mono-source.'+format}};const expected=mono(monoFile),master=await buildMaster(f.store,rows,.01,uid()),decoded=pcm(join(f.dir,master.path)),start=master.mapping[1].startFrame*4;
    assert.equal(master.channels,2);assert.equal(master.renderProfile,DEFAULT_RENDER_PROFILE);assert.equal(master.mapping[1].endFrame-master.mapping[1].startFrame,expected.length/2);assert.ok(decoded.subarray(4800*4,(4800+480)*4).every(value=>value===0));for(let frame=0;frame<expected.length/2;frame++){assert.equal(decoded.readInt16LE(start+frame*4),expected.readInt16LE(frame*2));assert.equal(decoded.readInt16LE(start+frame*4+2),expected.readInt16LE(frame*2),'mono按原幅度复制，不用默认upmix降低幅度');}
  });
});
