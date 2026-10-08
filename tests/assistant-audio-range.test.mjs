import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf} from '../server/domain.mjs';
import {createExperience} from '../server/experience.mjs';
import {createAssistant} from '../server/assistant/service.mjs';
import {resolveAudioRange,updateAudioRange,savedAudioRange} from '../server/audio-range.mjs';
import {getHelp} from '../server/assistant/context.mjs';

async function idle(a){for(let n=0;n<300&&a.active;n++)await new Promise(r=>setTimeout(r,5));assert.equal(a.active,0);}
function wav(){const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;}
function fixture(t,reply){
  const dir=mkdtempSync(join(tmpdir(),'assistant-audio-range-')),store=openStore(dir),domain=createDomain(store),config={key:'fixture-only',baseUrl:'https://mock.invalid/v1'};
  const project=domain.mutate('project.create',{name:'自拟范围'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟',source:'第一句。\n第二句。',segment:true});
  const rows=domain.list(chapter.id),audioIds=rows.map(s=>{const audio={id:uid(),path:uid()+'.wav',input:inputOf(s),basis:basisOf(s)};writeFileSync(join(dir,audio.path),wav());store.put('audios',audio,chapter.id);s.current=audio.id;s.latest='success';store.put('segments',s,chapter.id);domain.enhancement.syncLegacySegment(s);return audio.id;});
  const experience=createExperience(store,domain,{}, {},config),requests=[],assistant=createAssistant({store,domain,worker:{},analysis:{},experience,config,fetchImpl:async(_url,options)=>{const request=JSON.parse(options.body);requests.push(request);return Response.json({choices:[{message:{content:JSON.stringify(await reply(request,requests.length))}}]});}});
  assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'mock',credentialSource:'audio',vision:false});const session=assistant.create({projectId:project.id,chapterId:chapter.id}).session;
  t.mock.method(globalThis,'fetch',()=>assert.fail('范围修改不得调用真实模型'));
  t.after(async()=>{await assistant.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const binding={projectId:project.id,chapterId:chapter.id},input={unitId:rows[0].id,mode:'dry',audioId:audioIds[0],expectedRevision:0,startFrame:480,endFrame:4320};
  return {dir,store,domain,assistant,session,rows,audioIds,requests,binding,input,async send(text,extra={}){await assistant.send(session.id,{messageId:uid(),approved:true,mode:'task',text,limits:{assistant:2,analysis:0,audio:0},...extra});await idle(assistant);return assistant.get(session.id);}};
}
const proposal=input=>({reply:'按所指定范围调整。',steps:[{capabilityId:'audio.range.update',input}]});

for(const instruction of ['第1句从0.01秒播到0.09秒。','请帮我把第1句从0.01秒播放到0.09秒。'])test('明确秒数在send冻结实际帧，完整助手执行无需再审批且原件、台词和模型用量不变 '+instruction,async t=>{
  const f=fixture(t,(request,n)=>n===1?proposal(JSON.parse(request.messages[1].content).mandate.audioRangeScope&&f.input):{reply:'已调整。',complete:true}),before=readFileSync(join(f.dir,f.store.get('audios',f.audioIds[0]).path));
  const result=await f.send(instruction);assert.equal(result.runs[0].state,'completed',result.runs[0].error);assert.equal(f.requests.length,2);assert.equal(f.store.all('assistantDecisions').length,0);assert.equal(result.runs[0].budget.used.analysis,0);assert.equal(result.runs[0].budget.used.audio,0);
  const range=savedAudioRange(f.store,f.rows[0].id,'dry',f.audioIds[0]);assert.equal(range.startFrame,480);assert.equal(range.endFrame,4320);assert.equal(range.updatedBy.kind,'explicit-assistant');assert.equal(result.steps[0].resultRefs.range.revision,1);assert.equal(result.steps[0].resultRefs.renderRevision,1);assert.equal(f.domain.list(f.binding.chapterId)[0].text,f.rows[0].text);assert.deepEqual(readFileSync(join(f.dir,f.store.get('audios',f.audioIds[0]).path)),before);
  const read=await f.assistant.capabilities.read('read.audioRange',{unitId:f.rows[0].id,mode:'dry',audioId:f.audioIds[0]},f.binding);assert.equal(read.range.startFrame,480);assert.ok(!JSON.stringify(read).includes(f.dir));
  const receipt=await f.assistant.capabilities.read('read.operation',{id:result.steps[0].resultRefs.operationId},f.binding);assert.equal(receipt.range.revision,1);
});

for(const text of ['整理这一章。','给这句表演指导：“第1句从0.01秒播到0.09秒。”','第1句台词：从0.01秒播到0.09秒。','截图文字：第1句从0.01秒播到0.09秒。','日志：第1句从0.01秒播到0.09秒。','如何让第1句从0.01秒播到0.09秒？','不要让第1句从0.01秒播到0.09秒。','他提到第1句从0.01秒播到0.09秒。','第1句和第2句从0.01秒播到0.09秒。'])test('非裁剪授权的完整助手路径拒绝模型自定范围 '+text,async t=>{
  const f=fixture(t,()=>proposal(f.input)),state=await f.send(text);assert.equal(state.runs[0].state,'awaitingUser');assert.equal(f.requests.length,1);assert.equal(savedAudioRange(f.store,f.rows[0].id,'dry',f.audioIds[0]),null);assert.equal(f.store.all('assistantDecisions').length,0);assert.match(state.runs[0].error,/权限|范围|用法|仅整理/);
});

test('另一页等待期间的范围新值保持，明确旧指令不覆盖新修改或重发模型',async t=>{
  const f=fixture(t,async()=>{await updateAudioRange(f.store,{...f.input,operationId:uid(),startFrame:960,endFrame:3840});return proposal(f.input);});
  const state=await f.send('第1句从0.01秒播到0.09秒。',{limits:{assistant:1,analysis:0,audio:0}});assert.equal(state.runs[0].state,'awaitingUser');assert.equal(f.requests.length,1);assert.equal(savedAudioRange(f.store,f.rows[0].id,'dry',f.audioIds[0]).startFrame,960);assert.equal(f.store.all('assistantDecisions').length,0);
});

test('免费读取按绑定章节限制对象，所选声音的明确范围同样零审批；帮助可发现',async t=>{
  const f=fixture(t,(_request,n)=>n===1?proposal(f.input):{reply:'完成。',complete:true});
  const state=await f.send('所选这段从0.01秒播放到0.09秒。',{view:{selectedUnitId:f.rows[0].id,targetMode:'dry'}});assert.equal(state.runs[0].state,'completed',state.runs[0].error);assert.equal(f.store.all('assistantDecisions').length,0);
  const other=f.domain.mutate('chapter.create',{projectId:f.binding.projectId,title:'其他章',source:'其他。',segment:true});await assert.rejects(f.assistant.capabilities.read('read.audioRange',{unitId:f.domain.list(other.id)[0].id,mode:'dry'},f.binding),e=>e.status===403);
  assert.equal(getHelp({capabilityId:'audio.range.update'}).chunks[0].id,'audio-range');
});

test('旧听评提案不能把同audio新裁剪范围自动通过，范围key跟随预览而不跟随执行时新值',async t=>{
  const f=fixture(t,()=>({reply:'已读。',complete:true})),input={id:f.rows[0].id,mode:'dry',audioId:f.audioIds[0],state:'passed'};
  const preview=await f.assistant.capabilities.preview('unit.review',input,f.binding);assert.equal(preview.preview.rangeContentKey,null);
  await updateAudioRange(f.store,{...f.input,operationId:uid()});
  const current=await f.assistant.capabilities.preview('unit.review',input,f.binding);assert.notEqual(current.preview.rangeContentKey,null);assert.notDeepEqual(preview.dependencies,current.dependencies);
  await assert.rejects(f.assistant.capabilities.execute('unit.review',input,f.binding,{actorKind:'human_approved_proposal',operationId:uid(),baseRevisions:preview.baseRevisions,preview:preview.preview,humanReview:{audioIds:[f.audioIds[0]]}}),e=>e.status===409);
});
