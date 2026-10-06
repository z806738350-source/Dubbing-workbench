import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createAnalysis} from '../server/analysis.mjs';
import {createExperience} from '../server/experience.mjs';
import {createAssistant} from '../server/assistant/service.mjs';
import {performanceDependency} from '../server/performance.mjs';
async function idle(a){for(let n=0;n<300&&a.active;n++)await new Promise(r=>setTimeout(r,5));assert.equal(a.active,0);}
function fixture(t,{input={},invalid=false,plan,assistantLimit=1}={}){
  const directory=mkdtempSync(join(tmpdir(),'assistant-purpose-')),store=openStore(directory),domain=createDomain(store),config={baseUrl:'https://purpose.invalid/v1',key:'fixture-only'};
  const project=domain.mutate('project.create',{name:'明确用途'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'所选与未选',source:'她展开信纸。\n明早集合。',segment:true}),worker={submit:()=>assert.fail('仅整理任务不得生成声音')},analysis=createAnalysis(store,domain,config),experience=createExperience(store,domain,worker,analysis,config);
  const requests=[],textInputs=[];
  t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,config.baseUrl+'/chat/completions');const request=JSON.parse(options.body),facts=JSON.parse(request.messages[1].content);textInputs.push(facts);return Response.json({choices:[{message:{content:JSON.stringify({items:facts.targets?facts.targets.map(s=>({targetId:s.targetId,performance:invalid?'待补充':'平静清楚，句末收住。',performanceEvidence:{kind:'创作建议',refs:[]},performanceUncertain:false,performanceAnchors:[]})):facts.segments.map(s=>({segmentId:s.id,performance:invalid?'待补充':'平静清楚，句末收住。',evidence:'创作建议',evidenceRefs:[],uncertain:false}))})},finish_reason:'stop'}]});});
  const assistant=createAssistant({store,domain,worker,analysis,experience,config,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));if(!plan)assert.equal(requests.length,1,'PG结束无需第二次助手规划');const reply=plan?plan(requests.length):{reply:'正在整理。',steps:[{capabilityId:'operation.prepareChapter',input:{analysisKind:'director',autoApply:true,...input}}]};return Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});}});
  assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'fixture',credentialSource:'audio',vision:false});const session=assistant.create({projectId:project.id,chapterId:chapter.id}).session;
  t.after(async()=>{await assistant.close();await analysis.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,domain,chapter,analysis,assistant,session,requests,textInputs,rows:()=>domain.list(chapter.id),async send(text,selectedSegmentIds=[]){await assistant.send(session.id,{messageId:uid(),text,approved:true,mode:'task',limits:{assistant:assistantLimit,analysis:2,audio:0},view:{selectedSegmentIds}});await idle(assistant);await analysis.close();await assistant.tick();await idle(assistant);return assistant.get(session.id);}};
}

test('selected PG fills exact human target and completes locally despite a gap elsewhere',async t=>{
  const f=fixture(t,{input:{performanceMode:'replaceAi'}}),[chosen,other]=f.rows();
  const final=await f.send('只补齐所选这一句的表演指导，不生成音频。',[chosen.id]);assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(final.runs[0].delivery.coverage.eligibleCount,1);assert.equal(final.runs[0].delivery.coverage.coveredCount,1);assert.equal(f.rows()[1].id,other.id);assert.equal(f.rows()[1].performance,'');assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,1);assert.equal(f.store.all('jobs').length,0);assert.equal(f.store.all('suggestions')[0].performancePolicy.scope,'fillMissing');
});

test('fillMissing ignores model replace mode and preserves valid existing AI guidance',async t=>{
  const f=fixture(t,{input:{performanceMode:'replaceAi'}}),existing=f.rows()[1];existing.performance='这份已有指导必须保留。';existing.decisions={...existing.decisions,performance:{source:'policy_ai',values:existing.performance,dependencies:performanceDependency(existing)}};f.store.put('segments',existing,f.chapter.id);
  const final=await f.send('只补齐每段缺失指导，不要配音。');assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(f.rows()[1].performance,existing.performance);assert.equal(f.textInputs[0].segments.length,1);assert.equal(f.requests.length,1);
});

test('remaining PG gaps stop with real scope counts rather than completion or an extra model round',async t=>{
  const f=fixture(t,{invalid:true}),first=f.rows()[0];const final=await f.send('补齐所选表演指导，不生成声音。',[first.id]);assert.equal(final.runs[0].state,'awaitingUser');assert.equal(final.runs[0].delivery.coverage.coveredCount,0);assert.equal(final.runs[0].delivery.coverage.eligibleCount,1);assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,2);assert.equal(f.rows()[0].performance,'');
});

test('a positive Basic instruction records exact waivers locally with no text or audio calls',async t=>{
  const f=fixture(t,{input:{includePerformance:false}}),first=f.rows()[0];const final=await f.send('本次基础朗读，仅整理所选剧本，不安排表演。',[first.id]);assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(final.runs[0].delivery.coverage.waivedBasicIds.length,1);assert.match(final.runs[0].summary,/基础朗读|未承诺逐段适配/);assert.equal(f.rows()[1].decisions?.performance?.waivedBasic,undefined);assert.equal(f.textInputs.length,0);assert.equal(f.requests.length,1);assert.equal(f.store.all('jobs').length,0);
});


test('generic segment.update cannot overwrite valid AI under fillMissing; routine replanning fills only the missing sibling with no approval',async t=>{
  let existingId;
  const f=fixture(t,{assistantLimit:3,plan:turn=>turn===1?{reply:'补齐。',steps:[{capabilityId:'segment.update',input:{id:existingId,performance:'这次不应覆盖的指导。'}}]}:{reply:'只补缺失。',steps:[{capabilityId:'operation.prepareChapter',input:{analysisKind:'director',performanceMode:'fillMissing',autoApply:true}}]}}),[existing,missing]=f.rows();
  existingId=existing.id;existing.performance='原有AI指导，平静叙述，句尾轻收。';existing.decisions={...existing.decisions,performance:{source:'policy_ai',values:existing.performance,dependencies:performanceDependency(existing)}};f.store.put('segments',existing,f.chapter.id);
  const before=f.rows().map(s=>({id:s.id,text:s.text,voiceId:s.voiceId}));
  const final=await f.send('只补齐缺失表演指导，不要配音。');
  assert.equal(f.rows()[0].performance,existing.performance);assert.deepEqual(f.rows().map(s=>({id:s.id,text:s.text,voiceId:s.voiceId})),before);
  assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(f.rows()[1].id,missing.id);assert.equal(f.rows()[1].performance,'平静清楚，句末收住。');
  assert.equal(f.store.all('assistantDecisions').length,0);assert.ok(final.steps.every(s=>s.state!=='proposed'));assert.equal(f.requests.length,2);assert.equal(f.textInputs.length,1);assert.equal(f.store.all('jobs').length,0);
});

for(const kind of ['scene','legacy-director'])test('PG-only rejects '+kind+' analysis.apply before events or structure mutations',async t=>{
  let draftId,itemId;
  const f=fixture(t,{plan:()=>({reply:'采用已有标注。',steps:[{capabilityId:'analysis.apply',input:{id:draftId,selected:[itemId]}}]})}),first=f.rows()[0],unit=f.domain.chapter(f.chapter.id).units[0];
  draftId=uid();itemId=uid();const c=f.store.get('chapters',f.chapter.id),project=f.store.get('projects',c.projectId);
  f.store.put('suggestions',{id:draftId,chapterId:c.id,kind:kind==='scene'?'scene':'director',unitId:kind==='scene'?unit.id:undefined,status:'ready',revision:c.revision,contextRevision:project.contextRevision,draftVersion:1,sourceVersion:c.sourceVersion,source:c.source,...(kind==='scene'?{unitRevision:unit.revision,sceneRevision:unit.variants.scene.revision,memberIds:[...unit.members]}:{}),items:kind==='scene'?[{id:itemId,unitId:unit.id,kind:'environment',description:'只补指导不该添加的风声',memberId:first.id,position:'during',evidence:'创作建议',sourceQuote:'她展开信纸。',issues:[]}]:[{id:itemId,segmentId:first.id,text:first.text,type:'dialogue',roleId:first.roleId,performance:'低声清楚。',evidence:'创作建议',evidenceRefs:[],uncertain:false,issues:[],splitParts:[first.text.slice(0,2),first.text.slice(2)]}]},c.id);
  const before=f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,type:s.type,voiceId:s.voiceId,performance:s.performance})),events=f.store.all('events');
  const final=await f.send('只补齐缺失表演指导，不要配音。');
  assert.equal(final.runs[0].state,'awaitingUser');assert.match(final.runs[0].error,/仅处理|表演|场景|草稿/);assert.deepEqual(f.store.all('events'),events);assert.deepEqual(f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,type:s.type,voiceId:s.voiceId,performance:s.performance})),before);assert.equal(f.store.get('suggestions',draftId).status,'ready');assert.equal(f.store.all('jobs').length,0);assert.equal(f.textInputs.length,0);assert.equal(f.requests.length,1);assert.equal(f.store.all('assistantDecisions').length,0);
});

for(const scenario of [{storedReview:false,text:'先给我看看所选表演建议，先别采用，不生成声音。'},{storedReview:true,text:'补齐所选表演指导，不配音。'},{storedReview:false,text:'先给我看当前章的分段与表演指导建议，先不要采用，不生成音频。'},{storedReview:false,text:'补齐所选指导建议，暂时不要写入，不配音。'}])test('ready '+(scenario.storedReview?'stored review':'explicit candidate-only')+' results need no second helper and one adoption writes then completes',async t=>{
  const f=fixture(t,{input:{autoApply:true}}),chosen=f.rows()[0];
  const {storedReview}=scenario;
  if(storedReview){const c=f.store.get('chapters',f.chapter.id);f.store.put('settings',{id:'ux-policy:'+c.projectId,projectId:c.projectId,mode:'review',revision:1});}
  const final=await f.send(scenario.text,[chosen.id]);
  assert.equal(final.runs[0].state,'awaitingApproval',final.runs[0].error);assert.equal(final.runs[0].error,undefined);assert.match(final.runs[0].summary,/候选已准备|实际写入0段/);assert.equal(f.rows()[0].performance,'');assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,1);
  const proposal=final.steps.find(step=>step.state==='proposed');assert.equal(proposal.capabilityId,'analysis.apply');const expected=scenario.text.includes('当前章')?2:1;assert.equal(proposal.preview.preview.candidateCount,expected);assert.equal(proposal.preview.preview.structureCount,expected);assert.equal(proposal.preview.preview.missingPerformanceCount,0);assert.equal(proposal.preview.preview.writtenCount,0);assert.equal(proposal.preview.preview.candidates[0].performance,'平静清楚，句末收住。');
  f.assistant.approve(final.runs[0].id,{decisionId:uid(),revision:final.runs[0].revision,accepted:true});await idle(f.assistant);await f.assistant.tick();await idle(f.assistant);
  const adopted=f.assistant.get(f.session.id);assert.equal(adopted.runs[0].state,'completed',adopted.runs[0].error);assert.equal(f.rows()[0].performance,'平静清楚，句末收住。');assert.equal(f.rows()[1].performance,scenario.text.includes('当前章')?'平静清楚，句末收住。':'');assert.equal(f.store.all('assistantDecisions').length,1);assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,1);assert.equal(f.store.all('jobs').length,0);
});

test('explicit selected rewrite writes with no repeated result approval despite an old review preference',async t=>{
  const f=fixture(t,{input:{autoApply:false}}),chosen=f.rows()[0],c=f.store.get('chapters',f.chapter.id);chosen.performance='之前的有效AI指导。';chosen.decisions={...chosen.decisions,performance:{source:'policy_ai',values:chosen.performance,dependencies:performanceDependency(chosen)}};f.store.put('segments',chosen,c.id);f.store.put('settings',{id:'ux-policy:'+c.projectId,projectId:c.projectId,mode:'review',revision:1});
  const final=await f.send('重新安排所选这一句的表演指导，不要配音。',[chosen.id]);assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(f.rows()[0].performance,'平静清楚，句末收住。');assert.equal(f.store.all('assistantDecisions').length,0);assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,1);assert.equal(f.store.all('jobs').length,0);
});


test('不要先看建议 is a direct rewrite instruction, not a candidate approval detour',async t=>{
  const f=fixture(t,{input:{autoApply:true}}),chosen=f.rows()[0];const final=await f.send('不要先看建议，直接重新安排所选这一句的表演指导，不配音。',[chosen.id]);assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(f.rows()[0].performance,'平静清楚，句末收住。');assert.equal(f.store.all('assistantDecisions').length,0);assert.equal(f.requests.length,1);assert.equal(f.textInputs.length,1);assert.equal(f.store.all('jobs').length,0);
});
