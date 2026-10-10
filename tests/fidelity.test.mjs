import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {compile} from '../server/templates.mjs';
import {createCapabilities} from '../server/assistant/capabilities.mjs';
import {createWorker} from '../server/worker.mjs';
import {createExperience} from '../server/experience.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'dubbing-fidelity-')),store=openStore(directory),domain=createDomain(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const project=domain.mutate('project.create',{name:'自拟保真样例'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'第一章',source:'甲托住😀落下的纸片。乙递给她一只木盒。',segment:true});
  return {store,domain,chapter,project,directory};
}

test('来源跨度完整不能掩盖字词丢失；已记录标点和文字编辑不伪称系统遗漏',t=>{
  const f=fixture(t),s=f.domain.list(f.chapter.id)[0];s.text='甲托住纸片。';f.store.put('segments',s,f.chapter.id);
  let audit=f.domain.fidelity({chapterId:f.chapter.id});assert.equal(audit.sourceCoverage.valid,true);assert.equal(audit.textFidelity.status,'mismatch');assert.equal(audit.textFidelity.wordEdits,1);
  s.text='甲托住😀落下的纸片！';s.editHistory=[{revision:1,text:'甲托住😀落下的纸片。'}];f.store.put('segments',s,f.chapter.id);
  audit=f.domain.fidelity({chapterId:f.chapter.id});assert.equal(audit.textFidelity.status,'edited');assert.equal(audit.textFidelity.punctuationEdits,1);assert.equal(audit.items[0].actor,'unknown');
  s.text='甲接住😀落下的纸片！';f.store.put('segments',s,f.chapter.id);audit=f.domain.fidelity({chapterId:f.chapter.id});assert.equal(audit.textFidelity.status,'edited');assert.equal(audit.textFidelity.wordEdits,1);
});

test('排除与删除保持用户选择，退役父段不能冒充有效朗读参与；审计只读且有界',t=>{
  const f=fixture(t),s=f.domain.list(f.chapter.id)[0];s.excluded=true;s.deletion={operationId:uid()};f.store.put('segments',s,f.chapter.id);
  f.store.put('segments',{...s,id:uid(),retired:true,excluded:false},f.chapter.id);
  const before=JSON.stringify(['chapters','segments','units','settings','jobs','attempts'].map(k=>f.store.all(k)));
  const audit=f.domain.fidelity({chapterId:f.chapter.id,limit:1});assert.equal(audit.sourceCoverage.valid,true);assert.ok(audit.participation.gaps>0);assert.equal(audit.participation.deleted,1);assert.equal(audit.participation.retired,1);assert.equal(audit.items.length,1);assert.equal(audit.nextCursor,'1');
  assert.equal(JSON.stringify(['chapters','segments','units','settings','jobs','attempts'].map(k=>f.store.all(k))),before);
  assert.throws(()=>f.domain.fidelity({chapterId:f.chapter.id,limit:101}));assert.throws(()=>f.domain.fidelity({chapterId:f.chapter.id,cursor:'1.5'}));assert.throws(()=>f.domain.fidelity({chapterId:f.chapter.id,projectId:'other'}),e=>e.status===403);
});

test('冻结正文与参考字节独立核对，事件字段中的原字不能替代朗读成员',t=>{
  const f=fixture(t),s=f.domain.list(f.chapter.id)[0],u=f.store.get('units',s.id),input=f.domain.enhancement.input(u,'dry'),audio={id:uid(),path:'sample.wav',input,prompt:compile(input),basis:f.domain.enhancement.basis(u,'dry')};
  writeFileSync(join(f.directory,audio.path),'sample');f.store.put('audios',audio,f.chapter.id);u.variants.dry.current=audio.id;f.store.put('units',u,f.chapter.id);
  let audit=f.domain.fidelity({chapterId:f.chapter.id});assert.equal(audit.spokenPayload.matched,1);assert.equal(audit.audioProvenance.originalUnknown,1);assert.equal(audit.listening.quality,'not-assessed');
  audio.input.members[0].text='甲托住纸片。';audio.input.events=[{description:s.text}];audio.prompt=compile({...audio.input,events:[]});f.store.put('audios',audio,f.chapter.id);
  audit=f.domain.fidelity({chapterId:f.chapter.id});assert.equal(audit.spokenPayload.status,'mismatch');assert.ok(audit.spokenPayload.mismatches>0);assert.equal(f.store.get('segments',s.id).text,s.text);
});

test('历史编排只报告历史冻结成员，不把当前源版本倒填成历史证明',async t=>{
  const f=fixture(t),s=f.domain.list(f.chapter.id)[0],u=f.store.get('units',s.id),input=f.domain.enhancement.input(u,'dry');input.referenceVoiceIds=['frozen-reference'];input.members[0].voiceId='frozen-reference';input.slots[0].voiceId='frozen-reference';input.slots[0].reference=1;
  const audio={id:uid(),path:'old.wav',input,prompt:compile(input),referenceAssets:[{voiceId:'frozen-reference',contentHash:'a'.repeat(64),bytes:123}],delivery:{rawPath:'empty-raw.wav',receivedBytes:123}};writeFileSync(join(f.directory,'empty-raw.wav'),'');
  f.store.put('audios',audio,f.chapter.id);f.store.put('masters',{id:uid(),arrangement:0,createdAt:'2026-10-01',mapping:[{id:s.id,unitId:s.id,memberIds:[s.id],audioId:audio.id,clipStartFrame:100,clipEndFrame:900}]},f.chapter.id);
  f.store.put('settings',{id:`audio-range:${u.id}:dry:${audio.id}`,startFrame:300,endFrame:800,sourceFrames:1000},f.chapter.id);
  const audit=f.domain.fidelity({chapterId:f.chapter.id,arrangement:0});assert.equal(audit.scope.kind,'historical');assert.equal(audit.scope.sourceVersion,null);assert.equal(audit.textFidelity.status,'unknown');assert.equal(audit.renderProfile,'legacy-mono-v1');assert.equal(audit.current.textFidelity.status,'retained');assert.equal(audit.items[0].kind,'audio');
  assert.equal(audit.items[0].range.startFrame,100);assert.equal(audit.items[0].range.endFrame,900);assert.equal(audit.audioProvenance.referenceFrozen,1);assert.equal(audit.audioProvenance.originalAvailable,0);assert.equal(audit.listening.reviewed,0);
  const c=f.store.get('chapters',f.chapter.id);f.store.put('chapters',{...c,arrangement:0},f.project.id);assert.equal(f.domain.fidelity({chapterId:c.id,arrangement:0}).scope.kind,'historical');
  const caps=createCapabilities({...f,analysis:{},experience:{},worker:{}}),bound={projectId:f.project.id,chapterId:f.chapter.id};assert.equal((await caps.read('read.fidelity',{arrangement:0,limit:1},bound)).masterId,audit.masterId);
  await assert.rejects(caps.read('read.fidelity',{chapterId:'other'},bound),/未注册|未允许|不支持|无效|不接受|包含|参数/);
});

test('计划后的模型或参考文件变化在发送前停止，零模型请求；不扩大发起范围',async t=>{
  const f=fixture(t),bytes=Buffer.alloc(44+9600);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);
  const voice={id:uid(),path:'reference.wav',state:'active',revision:1};writeFileSync(join(f.directory,voice.path),bytes);f.store.put('voices',voice);
  const role=f.store.all('roles',f.project.id)[0];f.domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,voiceId:voice.id,apply:true});
  const ids=f.domain.list(f.chapter.id).map(s=>s.id);f.domain.mutate('segment.confirm',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids});
  const config={key:'fixture-only',model:'seed-audio-1.0',audioUrl:'https://fixture.invalid/audio'},worker=createWorker(f.store,f.domain,config),experience=createExperience(f.store,f.domain,worker,{},config);let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;throw Error('变化素材不应发送');});
  const p={kind:'generateSelection',chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids:[ids[0]],actionKind:'forceRegenerate'},plan=experience.plan(p),refs=plan.units.flatMap(u=>u.referenceVoices);
  const blocked=await experience.run({...p,operationId:uid(),expectedModel:'changed-model',expectedReferenceVoices:refs});assert.equal(blocked.errorStatus,409);assert.equal(f.store.all('jobs').length,0);
  const job=worker.enqueue({kind:'unit-generate',commandId:uid(),chapterId:f.chapter.id,revision:p.revision,unitIds:plan.unitIds,expectedModel:config.model,expectedReferenceVoices:refs});
  const replacement=Buffer.from(bytes);replacement.writeInt16LE(1234,44);writeFileSync(join(f.directory,voice.path),replacement);
  await worker.tick();worker.close();assert.equal(calls,0);assert.equal(f.store.get('jobs',job.id).status,'failed');assert.match(f.store.all('attempts',job.id)[0].error,/参考素材与本次发起时不同/);
});
