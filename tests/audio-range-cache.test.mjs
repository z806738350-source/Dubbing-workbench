import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf} from '../server/domain.mjs';
import {prepareAudioSource,audioWaveform,renderRangeResource,updateAudioRange,getRangeOperation,savedAudioRange,pruneAudioRangeCache,audioRangeActivity,renderIdentity,renderMatches,LEGACY_RENDER_PROFILE} from '../server/audio-range.mjs';
import {auditoryBoundaryPlan} from '../server/auditory.mjs';
import {buildMaster} from '../server/audio.mjs';
import {assertMasterRecipe,historicalMasterRows,verifyRebuiltMaster} from '../server/workspace.mjs';
import {createWorker} from '../server/worker.mjs';

const key=n=>n.toString(16).padStart(64,'0'),old=new Date('2020-01-01');
function directory(t){const dir=mkdtempSync(join(tmpdir(),'dubbing-range-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function cached(cache,name,size,date=old){const path=join(cache,name);writeFileSync(path,Buffer.alloc(size));utimesSync(path,date,date);return path;}
function wav(){const frames=4800,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);for(let i=0;i<frames;i++){bytes.writeInt16LE(Math.round(9000*Math.sin(i*.1)),44+i*4);bytes.writeInt16LE(Math.round(6000*Math.sin(i*.03)),46+i*4);}return bytes;}
function fixture(t){
  const dir=directory(t),store=openStore(dir),domain=createDomain(store);t.after(()=>store.close());
  const project=domain.mutate('project.create',{name:'缓存测试'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'合成声音',source:'这是一句合成测试。',segment:true});
  const segment=domain.list(chapter.id)[0],audio={id:uid(),chapterId:chapter.id,path:'audio/synthetic.wav',input:inputOf(segment),basis:basisOf(segment)};
  mkdirSync(join(dir,'audio'));writeFileSync(join(dir,audio.path),wav());store.put('audios',audio,chapter.id);segment.current=audio.id;segment.latest='success';store.put('segments',segment,chapter.id);domain.enhancement.syncLegacySegment(segment);
  return {dir,store,domain,audio,segment};
}

test('缓存按mtime LRU成对回收，keep保护整对；part、未知、目录和symlink保持',async t=>{
  const dir=directory(t),cache=join(dir,'.audio-range-cache');mkdirSync(cache);
  const pcm=cached(cache,key(1)+'.pcm',30),metadata=cached(cache,key(1)+'.json',10);
  const recent=cached(cache,key(2)+'.wav',20,new Date('2021-01-01'));
  const retained=cached(cache,key(3)+'.pcm',20),retainedMetadata=cached(cache,key(3)+'.json',10);
  const peaks=cached(cache,key(4)+'.peaks.json',15,new Date('2022-01-01'));
  const part=cached(cache,key(5)+'.pcm.pending.part',7),unknown=cached(cache,'notes.json',8);
  const nested=join(cache,'nested');mkdirSync(nested);writeFileSync(join(nested,key(6)+'.wav'),Buffer.alloc(13));
  const outside=join(dir,'outside.wav');writeFileSync(outside,Buffer.from('original'));
  const link=join(cache,key(7)+'.pcm');symlinkSync(outside,link);const linkedMetadata=cached(cache,key(7)+'.json',5);
  const result=await pruneAudioRangeCache({directory:dir},{maxBytes:75,keep:[retainedMetadata]});
  assert.deepEqual(result,{removedBytes:60,removedFiles:3,remainingBytes:65,remainingFiles:6,maxBytes:75});
  assert.equal(existsSync(pcm),false);assert.equal(existsSync(metadata),false);assert.equal(existsSync(recent),false);
  for(const path of [retained,retainedMetadata,peaks,part,unknown,nested,link,linkedMetadata,outside])assert.ok(existsSync(path),path);
  assert.equal(readFileSync(outside,'utf8'),'original');
  const again=await pruneAudioRangeCache({directory:dir},{maxBytes:0,keep:[retained]});
  assert.equal(again.removedBytes,15);assert.equal(again.remainingBytes,50);assert.ok(existsSync(retainedMetadata));
});

function cueFixture(cue='林青提醒道，',name='林青') {
  let cursor=0;
  const segments=['“前句。”',cue,'“后句。”'].map((text,i)=>{const start=cursor;cursor+=Array.from(text).length;return {id:String(i),chapterId:'chapter',text,order:i,type:i===1?'narration':'dialogue',roleId:i===1?'narrator':'speaker',voiceId:i===1?'narrator-voice':'speaker-voice',roleConfirmed:true,identityConfirmed:true,performance:'',source:{version:1,spans:[{start,end:cursor}]}};});
  const rows=segments.map(s=>({s:{id:s.id,unitId:s.id,members:[s.id],kind:'single',mode:'dry'},a:{id:'audio-'+s.id,input:{voiceId:s.voiceId}}}));
  return {chapter:{id:'chapter',gap:.5,sourceVersion:1,source:segments.map(s=>s.text).join(''),auditoryPolicy:{version:1,mode:'conservative'}},rows,segments,roles:[{id:'speaker',name}]};
}

test('保守短引述语完整白名单只缩同人物同实际声音两边；时间动作、身份、人工、scene/group和未知语义回退',()=>{
  for(const [cue,name]of[['苏婉宁低头嘟囔道，','苏婉宁'],['教练摸着自己的胡子，端起茶杯喜滋滋道，','教练'],['教练师父又惊又恐问道，','教练'],['林青躲开她师父喷出来的茶水，冷静道，','林青'],['林青提醒道，','林青']]){
    const f=cueFixture(cue,name),before=structuredClone(f);assert.deepEqual(auditoryBoundaryPlan(f.chapter,f.rows,f).gapFrames,[7200,7200]);assert.deepEqual(f,before);
  }
  for(const cue of ['林青顿了顿又道，','林青长叹后说道，','林青重新走进来道，','林青提醒道，心中却想起往事。','林青说道，“甲道：”','林青躲开暗箭，冷静道，','道路弯曲，','林青不知该如何回答道，']){
    const f=cueFixture(cue);assert.deepEqual(auditoryBoundaryPlan(f.chapter,f.rows,f).gapFrames,[24000,24000],cue);
  }
  for(const change of [f=>f.segments[2].roleId='other',f=>f.segments[2].voiceId='override',f=>f.rows[2].a.input.voiceId='old-voice',f=>delete f.rows[2].a.input.voiceId,f=>f.segments[0].roleConfirmed=false,f=>f.segments[0].decisions={role:{state:'needsDecision',values:['speaker','dialogue']}},f=>f.roles[0].identityPending=true,f=>f.segments[1].source.version=2,f=>f.segments[1].protectedFields=['text'],f=>f.segments[0].protectedFields=['performance'],f=>f.segments[0].performance='旧人工指导',f=>f.rows[0].s.mode='scene',f=>f.rows[0].s.kind='group',f=>f.chapter.source='改变过的原文',f=>f.roles[0].name='黑衣人']){
    const f=cueFixture();change(f);assert.deepEqual(auditoryBoundaryPlan(f.chapter,f.rows,f).gapFrames,[24000,24000]);
  }
  const f=cueFixture();f.chapter.gap=.1;assert.deepEqual(auditoryBoundaryPlan(f.chapter,f.rows,f).gapFrames,[4800,4800]);delete f.chapter.auditoryPolicy;assert.equal(auditoryBoundaryPlan(f.chapter,f.rows,f).mode,'legacy');f.chapter.auditoryPolicy={version:99,mode:'conservative'};assert.equal(auditoryBoundaryPlan(f.chapter,f.rows,f).mode,'legacy');
  const nested=cueFixture();nested.chapter.source='“复述：'+nested.chapter.source+'”';for(const s of nested.segments)for(const span of s.source.spans){span.start+=4;span.end+=4;}assert.deepEqual(auditoryBoundaryPlan(nested.chapter,nested.rows,nested).gapFrames,[24000,24000],'整段处在更外层引语内也不能缩短');
});

test('局部gap冻结后PCM与裁剪范围不变，legacy签名可区分；缓存导出和历史重建使用同一向量，Seed保持匹配',async t=>{
  const f=fixture(t),old=f.store.get('chapters',f.segment.chapterId),sample=cueFixture(),role=f.store.get('roles',f.segment.roleId);role.name='林青';role.narrator=false;role.voiceId='boundary-voice';f.store.put('roles',role,old.projectId);f.store.put('voices',{id:role.voiceId,name:'合成参考',state:'active',path:f.audio.path});
  const chapter={...old,source:sample.chapter.source,gap:.5,auditoryPolicy:sample.chapter.auditoryPolicy,renderProfile:LEGACY_RENDER_PROFILE};f.store.put('chapters',chapter,chapter.projectId);
  const ids=[];
  for(const [i,part]of sample.segments.entries()){
    const s={...f.segment,...part,id:i?uid():f.segment.id,chapterId:chapter.id,roleId:role.id,voiceId:role.voiceId,current:null};const a={...f.audio,id:uid(),input:inputOf(s),basis:basisOf(s)};s.current=a.id;s.review={audioId:a.id,basis:basisOf(s),state:'passed'};s.approved=a.id;f.store.put('audios',a,chapter.id);f.store.put('segments',s,chapter.id);f.domain.enhancement.syncLegacySegment(s);ids.push(s.id);
  }
  const before=ids.map(id=>f.store.get('segments',id)),rows=f.domain.enhancement.resolve(chapter.id),identity=renderIdentity(f.store,chapter.id,rows),plan=identity.auditoryBoundaryPlan;
  assert.deepEqual(plan.gapFrames,[7200,7200]);assert.notEqual(identity.renderSignature,null);assert.equal(plan.shortenedBoundaries,2);
  f.store.put('chapters',{...chapter,auditoryPolicy:undefined},chapter.projectId);const legacy=renderIdentity(f.store,chapter.id,rows);assert.equal(legacy.renderSignature,null);assert.equal(renderMatches(identity,legacy),false);f.store.put('chapters',chapter,chapter.projectId);
  const clipped=await updateAudioRange(f.store,{operationId:uid(),unitId:ids[0],mode:'dry',audioId:rows[0].a.id,expectedRevision:0,startFrame:120,endFrame:4600});rows[0].range=clipped.range;
  const master={id:uid(),chapterId:chapter.id,...await buildMaster(f.store,rows,.5,uid(),LEGACY_RENDER_PROFILE,{boundaryPlan:plan})};
  for(const invalid of [{version:2,mode:'conservative',gapFrames:[7200,7200]},{version:1,mode:'conservative',gapFrames:[7200]},{version:1,mode:'conservative',gapFrames:[-1,7200]},{version:1,mode:'conservative'}])await assert.rejects(buildMaster(f.store,rows,.5,uid(),LEGACY_RENDER_PROFILE,{boundaryPlan:invalid}),/边界/);
  assert.deepEqual(master.boundaryGapFrames,[7200,7200]);assert.deepEqual(master.mapping.map(m=>m.gapAfterFrames),[7200,7200,0]);assert.equal(master.frames,4480+4800*2+14400);assert.equal(master.mapping[1].startFrame,4480+7200);assert.equal(master.mapping[0].clipStartFrame,120);assert.equal(master.mapping[0].clipEndFrame,4600);assertMasterRecipe(master);
  const originalBytes=readFileSync(join(f.dir,f.audio.path));assert.deepEqual(originalBytes,wav());const restored=await historicalMasterRows(f.store,master);const rebuilt=await buildMaster(f.store,restored,.5,uid(),LEGACY_RENDER_PROFILE,{boundaryPlan:master.auditoryBoundaryPlan});verifyRebuiltMaster(master,rebuilt);assert.deepEqual(readFileSync(join(f.dir,rebuilt.path)),readFileSync(join(f.dir,master.path)));
  const current=f.domain.chapter(chapter.id);assert.ok(current.playbackItems.every(row=>row.validity==='matched'));assert.deepEqual(ids.map(id=>f.store.get('segments',id)),before);assert.equal(f.store.all('attempts').length,0);
  const worker=createWorker(f.store,f.domain,{key:''});t.mock.method(globalThis,'fetch',async()=>assert.fail('局部gap不得调用模型'));
  try {
    const submit=()=>worker.submit({kind:'master',chapterId:chapter.id,revision:f.store.get('chapters',chapter.id).revision,commandId:uid()});
    const queued=await submit();assert.deepEqual(queued.renderBoundaryPlan.gapFrames,[7200,7200]);const put=f.store.put;let interrupted=false;f.store.put=(table,...args)=>{if(table==='masters'&&!interrupted){interrupted=true;throw Error('本地登记中断');}return put(table,...args);};await worker.tick();f.store.put=put;const failed=f.store.get('jobs',queued.id);assert.equal(failed.localOutputPending,true);assert.deepEqual(failed.outputRecords.master.boundaryGapFrames,[7200,7200]);await worker.recover();const done=f.store.get('jobs',queued.id);assert.equal(done.status,'success',done.error);const result=f.store.get('masters',done.masterId);assert.deepEqual(result.boundaryGapFrames,[7200,7200]);assert.equal(result.id,failed.outputRecords.master.id);
    const second=await submit();await worker.tick();assert.equal(f.store.get('jobs',second.id).masterId,result.id,'相同边界复用母版');
    for(const format of ['wav','mp3']){const view=f.domain.chapter(chapter.id),job=await worker.submit({kind:'export',chapterId:chapter.id,revision:view.revision,arrangement:view.arrangement,commandId:uid(),format,reviewItems:view.reviewItems,renderSignature:view.renderSignature,confirm:true});await worker.tick();const output=f.store.get('jobs',job.id);assert.equal(output.status,'success',output.error);assert.equal(output.masterId,result.id);assert.equal(f.store.get('exports',output.exportId).renderSignature,result.renderSignature);assert.ok(existsSync(join(f.dir,f.store.get('exports',output.exportId).path)));}
    const c=f.store.get('chapters',chapter.id);f.domain.mutate('chapter.update',{chapterId:c.id,revision:c.revision,auditoryPolicy:{version:1,mode:'legacy'}});assert.ok(f.domain.chapter(chapter.id).playbackItems.every(row=>row.validity==='matched'));const changed=await submit();await worker.tick();const newer=f.store.get('jobs',changed.id);assert.equal(newer.status,'success',newer.error);assert.notEqual(newer.masterId,result.id);assert.deepEqual(f.store.get('masters',newer.masterId).boundaryGapFrames,[24000,24000]);
  }finally{worker.close();await worker.drain();}
});

test('容量校验和symlink缓存目录不越界回收；缺缓存目录是零变更',async t=>{
  const dir=directory(t);assert.deepEqual(await pruneAudioRangeCache({directory:dir}),{removedBytes:0,removedFiles:0,remainingBytes:0,remainingFiles:0,maxBytes:1024**3});
  for(const maxBytes of [-1,NaN,1.5,Infinity])await assert.rejects(pruneAudioRangeCache({directory:dir},{maxBytes}),/缓存容量/);
  const outside=join(dir,'outside');mkdirSync(outside);const file=cached(outside,key(1)+'.wav',30);symlinkSync(outside,join(dir,'.audio-range-cache'));
  const result=await pruneAudioRangeCache({directory:dir},{maxBytes:0});assert.equal(result.skipped,'cache-is-not-directory');assert.ok(existsSync(file));
});

test('真实PCM/clip/peaks命中更新LRU；回收后免费逐字节重建且原件、范围、撤销回执不变',async t=>{
  const f=fixture(t),sourceFile=join(f.dir,f.audio.path),original=readFileSync(sourceFile),cache=join(f.dir,'.audio-range-cache');
  const saved=await updateAudioRange(f.store,{operationId:uid(),unitId:f.segment.id,mode:'dry',audioId:f.audio.id,expectedRevision:0,startFrame:120,endFrame:4600});
  const source=await prepareAudioSource(f.store,f.audio.id),clip=await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id),wave=await audioWaveform(f.store,f.audio.id,{level:1024});
  const pcm=readFileSync(source.pcmPath),wavBytes=readFileSync(clip.path),before=f.store.all('settings');
  const generated=readdirSync(cache).map(name=>join(cache,name));assert.equal(generated.length,4);
  for(const path of generated)utimesSync(path,old,old);
  const activityBefore=audioRangeActivity();assert.equal(activityBefore.active,0);assert.equal(activityBefore.queued,0);assert.equal(activityBefore.preparing,0);assert.equal(activityBefore.clips,0);assert.equal(activityBefore.waves,0);
  await prepareAudioSource(f.store,f.audio.id);await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id);await audioWaveform(f.store,f.audio.id,{level:1024});
  for(const path of generated)assert.ok(statSync(path).mtimeMs>old.getTime(),basename(path));
  const total=generated.reduce((sum,path)=>sum+statSync(path).size,0),unused=cached(cache,key(999)+'.wav',100);
  const lru=await pruneAudioRangeCache(f.store,{maxBytes:total});assert.equal(lru.removedBytes,100);assert.equal(existsSync(unused),false);for(const path of generated)assert.ok(existsSync(path));
  const removed=await pruneAudioRangeCache(f.store,{maxBytes:0});assert.equal(removed.removedFiles,4);assert.equal(removed.remainingBytes,0);
  const restored=await prepareAudioSource(f.store,f.audio.id),restoredClip=await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id),restoredWave=await audioWaveform(f.store,f.audio.id,{level:1024});
  assert.deepEqual(readFileSync(restored.pcmPath),pcm);assert.deepEqual(readFileSync(restoredClip.path),wavBytes);assert.deepEqual(restoredWave,wave);
  assert.deepEqual(readFileSync(sourceFile),original);assert.deepEqual(f.store.all('settings'),before);assert.deepEqual(savedAudioRange(f.store,f.segment.id,'dry',f.audio.id),saved.range);assert.equal(getRangeOperation(f.store,saved.operationId).status,'completed');assert.equal(f.store.all('attempts').length,0);
});
