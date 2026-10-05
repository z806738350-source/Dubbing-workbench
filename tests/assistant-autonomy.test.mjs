import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createExperience } from '../server/experience.mjs';
import { createWorker } from '../server/worker.mjs';
import { createAnalysis } from '../server/analysis.mjs';
import { createAssistant } from '../server/assistant/service.mjs';

function wav() {
  const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);
  return b;
}
async function idle(assistant) {
  for(let n=0;n<1000&&assistant.active;n++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(assistant.active,0);
}
const proposal=(capabilityId,input)=>({reply:'执行当前任务。',steps:[{capabilityId,input}]});
function fixture(t,{withVoice=true}={}) {
  const directory=mkdtempSync(join(tmpdir(),'assistant-autonomy-')),store=openStore(directory),domain=createDomain(store);
  const project=domain.mutate('project.create',{name:'自拟托管章'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'第一章',source:'第一句原文。\n第二句原文。',segment:true});
  const config={baseUrl:'https://fixture.invalid/v1',audioUrl:'https://fixture.invalid/audio',model:'seed-audio-1.0',key:'fixture-only'};
  const worker=createWorker(store,domain,config),analysis=createAnalysis(store,domain,config),experience=createExperience(store,domain,worker,analysis,config);
  const answers=[],requests=[],assistant=createAssistant({store,domain,worker,analysis,experience,config,fetchImpl:async(_url,options)=>{
    const request=JSON.parse(options.body);requests.push(request);assert.ok(answers.length,'不得额外轮询模型');
    const next=answers.shift(),reply=typeof next==='function'?await next(request):next;
    return reply instanceof Response?reply:Response.json({choices:[{message:{content:JSON.stringify(reply)}}]});
  }});
  assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'fixture-model',credentialSource:'audio',vision:false});
  const session=assistant.create({projectId:project.id,chapterId:chapter.id}).session;
  let voice;
  if(withVoice){
    voice={id:uid(),name:'当前合法旁白声音',state:'active',path:'voice.wav',revision:1};writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);
    const role=store.all('roles',project.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id,chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision});
    domain.mutate('segment.confirm',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id)});
  }
  t.after(async()=>{await assistant.close();await analysis.close();worker.close();await worker.drain();store.close();rmSync(directory,{recursive:true,force:true});});
  const send=(extra={})=>assistant.send(session.id,{messageId:uid(),text:'按当前设置完成这章，保留原文，未配置声音先问我。',mode:'task',approved:true,...extra});
  const state=()=>assistant.get(session.id),run=()=>state().runs[0];
  return {directory,store,domain,project,chapter,worker,analysis,experience,assistant,session,voice,answers,requests,send,state,run};
}

function changeOnFreshPreview(t,f,id) {
  const original=f.assistant.capabilities.preview.bind(f.assistant.capabilities);let reads=0;
  t.mock.method(f.assistant.capabilities,'preview',async(...args)=>{
    if(args[0]==='segment.update' && ++reads===2)f.domain.mutate('segment.update',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,id,performance:'另一页的新指导'});
    return original(...args);
  });
}

test('a delegated stale local plan re-reads current facts and replans without approving or overwriting another page',async t=>{
  const f=fixture(t),id=f.domain.list(f.chapter.id)[0].id;changeOnFreshPreview(t,f,id);
  f.answers.push(proposal('segment.update',{id,performance:'过时的指导'}),request=>{
    const context=JSON.parse(request.messages[1].content);assert.equal(context.facts.facts.segments.find(s=>s.id===id).performance,'另一页的新指导');assert.match(context.planError,/最新资料/);
    return proposal('chapter.update',{gap:0.9});
  },{reply:'按当前资料完成。',complete:true});
  await f.send({completionTarget:'requested-actions',limits:{assistant:3,analysis:0,audio:0}});await idle(f.assistant);
  assert.equal(f.run().state,'completed',f.run().error);assert.equal(f.store.get('segments',id).performance,'另一页的新指导');assert.equal(f.store.get('chapters',f.chapter.id).gap,0.9);assert.equal(f.requests.length,3);assert.equal(f.store.all('assistantDecisions').length,0);assert.equal(f.state().steps[0].state,'superseded');assert.equal(f.run().error,undefined);
});

test('a routine input rejected before execution is corrected from current scope with no partial writes or approval',async t=>{
  const f=fixture(t),third=f.domain.mutate('segment.create',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,text:'第三句夹具。'}),ids=f.domain.list(f.chapter.id).map(s=>s.id);
  f.answers.push(proposal('unit.create',{ids:[ids[0],third.id]}),request=>{
    assert.match(JSON.parse(request.messages[1].content).planError,/连续/);assert.equal(f.store.all('units',f.chapter.id).filter(u=>u.kind==='group').length,0);return proposal('unit.create',{ids:ids.slice(0,2)});
  },{reply:'有效连续范围已安排。',complete:true});
  await f.send({completionTarget:'requested-actions',limits:{assistant:3,analysis:0,audio:0}});await idle(f.assistant);
  assert.equal(f.run().state,'completed',f.run().error);assert.equal(f.store.all('assistantDecisions').length,0);assert.equal(f.store.all('units',f.chapter.id).filter(u=>u.kind==='group').length,1);assert.equal(f.requests.length,3);
});

test('automatic replanning respects the explicit assistant limit and never retries an unknown replacement receipt',async t=>{
  for(const kind of ['exhausted','unknown'])await t.test(kind,async t=>{
    const f=fixture(t),id=f.domain.list(f.chapter.id)[0].id;changeOnFreshPreview(t,f,id);f.answers.push(proposal('segment.update',{id,performance:'过时指导'}));
    if(kind==='unknown')f.answers.push(()=>new Response('更正请求回执丢失',{status:502}));
    await f.send({completionTarget:'requested-actions',limits:{assistant:kind==='exhausted'?1:3,analysis:0,audio:0}});await idle(f.assistant);
    const used=kind==='exhausted'?1:2;assert.equal(f.requests.length,used);assert.equal(f.run().budget.used.assistant,used);assert.equal(f.store.get('segments',id).performance,'另一页的新指导');assert.equal(f.store.all('assistantDecisions').length,0);
    assert.equal(f.run().state,kind==='exhausted'?'awaitingUser':'needsReconciliation');if(kind==='unknown')assert.equal(f.run().reconciliation.assistantRequest.state,'unknown');
    await f.assistant.tick();await idle(f.assistant);assert.equal(f.requests.length,used);assert.equal(f.store.all('attempts').length,0);
  });
});

test('default limits follow the first actual imported and extracted chapter without expanding explicit audio limits',async t=>{
  for(const explicit of [false,true])await t.test(explicit?'explicit zero remains zero':'default import through real master',async t=>{
    const f=fixture(t),session=f.assistant.create({}).session,state=()=>f.assistant.get(session.id),run=()=>state().runs[0],bound=()=>run().binding;let analysisCalls=0,audioCalls=0;
    t.mock.method(globalThis,'fetch',async(_url,options)=>{
      const request=JSON.parse(options.body);
      if(request.messages){analysisCalls++;const input=JSON.parse(request.messages[1].content);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:input.blocks.map(b=>({from:b.id,to:b.id,roleId:input.roles[0].id,type:'narration',performance:'自然',evidence:'原文明示',evidenceRefs:[b.id],reason:'自拟原文',uncertain:false}))})}}]});}
      audioCalls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});
    });
    f.answers.push(proposal('project.create',{name:'默认托管导入'}),proposal('chapter.create',{title:'导入章',source:'必须保留的自拟原文。',segment:false}),proposal('operation.prepareChapter',{analysisKind:'extract',autoApply:true}),()=>proposal('analysis.apply',{id:f.store.all('suggestions',bound().chapterId)[0].id,replaceConfirmed:true}),()=>proposal('operation.useVoice',{roleId:f.domain.list(bound().chapterId)[0].roleId,voiceId:f.voice.id,updateDefault:false}),()=>proposal('segment.confirm',{ids:f.domain.list(bound().chapterId).map(s=>s.id),roleOnly:true}),()=>proposal('operation.generateSelection',{ids:f.domain.list(bound().chapterId).map(s=>s.id),actionKind:'fillMissing'}),proposal('job.master',{}),{reply:'母版已就绪。',complete:true});
    await f.assistant.send(session.id,{messageId:uid(),text:'导入自拟文字并配完一章。',mode:'task',approved:true,voicePolicy:'chooseFromApprovedSet',allowedVoiceIds:[f.voice.id],...(explicit?{limits:{audio:0}}:{})});await idle(f.assistant);
    for(let n=0;n<8 && ['waitingJobs','planning','executing'].includes(run().state);n++){await f.analysis.close();await f.worker.tick();await f.assistant.tick();await idle(f.assistant);}
    assert.equal(f.store.get('chapters',bound().chapterId).source,'必须保留的自拟原文。');assert.equal(analysisCalls,1);assert.equal(f.store.all('assistantDecisions',run().id).length,0);assert.equal(run().budget.used.analysis,1);
    if(explicit){assert.equal(run().state,'awaitingUser',run().error);assert.equal(run().budget.limits.audio,0);assert.equal(audioCalls,0);assert.match(run().error,/额度|预算|上限/);}
    else{assert.equal(run().state,'completed',run().error);assert.equal(run().budget.limits.audio,1);assert.equal(run().budget.used.audio,1);assert.equal(audioCalls,1);assert.equal(run().delivery.review,'pending');assert.ok(existsSync(join(f.directory,f.store.get('masters',run().delivery.masterId).path)));}
  });
});

test('a matched chapter has a finite default remake allowance; reuse and gap edits still request no new TTS',async t=>{
  for(const remake of [false,true])await t.test(remake?'change performance and remake one line':'gap and free master only',async t=>{
    const f=fixture(t),ids=f.domain.list(f.chapter.id).map(s=>s.id);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
    const grantId=uid();f.experience.grant({grantId,projectId:f.project.id,chapterId:f.chapter.id,steps:['unit-generate'],materials:['text','reference'],voiceIds:[f.voice.id],audioLimit:ids.length,textLimit:0});
    await f.worker.submit({kind:'unit-generate',chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,unitIds:ids,grantId,commandId:uid()});await f.worker.tick();
    const old=f.domain.list(f.chapter.id).map(s=>s.current);assert.equal(calls,ids.length);assert.ok(f.domain.chapter(f.chapter.id).playbackItems.every(item=>item.validity==='matched'));
    f.answers.push(proposal(remake?'segment.update':'chapter.update',remake?{id:ids[0],performance:'轻声重做'}:{gap:0.9}),proposal('operation.generateSelection',{ids:remake?[ids[0]]:ids,actionKind:'fillMissing'}),proposal('job.master',{}),{reply:'当前章已准备好。',complete:true});
    await f.send({completionTarget:'chapter-master'});await idle(f.assistant);assert.equal(f.run().budget.limits.audio,ids.length);
    for(let n=0;n<6 && ['waitingJobs','planning','executing'].includes(f.run().state);n++){await f.worker.tick();await f.assistant.tick();await idle(f.assistant);}
    assert.equal(f.run().state,'completed',f.run().error);assert.equal(calls,ids.length+(remake?1:0));assert.equal(f.run().budget.used.audio,remake?1:0);assert.equal(f.domain.list(f.chapter.id)[1].current,old[1]);assert.equal(f.store.all('assistantDecisions',f.run().id).length,0);
  });
});

test('a human unknown-retry decision adds only confirmed retry costs, while explicit audio limits never grow',async t=>{
  for(const kind of ['default','explicit-send','explicit-amend'])await t.test(kind,async t=>{
    const explicit=kind!=='default';
    const f=fixture(t),ids=f.domain.list(f.chapter.id).map(s=>s.id);let calls=0,retrying=false;t.mock.method(globalThis,'fetch',async()=>{calls++;if(!retrying)throw Error('音频响应未知');return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
    f.answers.push(proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}),proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}),{reply:'确认后的请求已完成。',complete:true});
    await f.send({completionTarget:'requested-actions',...(kind==='explicit-send'?{limits:{audio:ids.length}}:{})});await idle(f.assistant);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
    let before=f.run();if(kind==='explicit-amend'){await f.assistant.control(before.id,{action:'amend',revision:before.revision,decisionId:uid(),limits:{audio:ids.length}});before=f.run();}
    const step=before.reconciliation.steps[0],decisionId=uid(),unknown=step.attempts.length;assert.equal(before.budget.used.audio,unknown);assert.ok(unknown>0);assert.equal(calls,unknown);
    const command={action:'reconcile',revision:before.revision,decisionId,resolution:'retry',stepId:step.stepId,acknowledgedAttemptIds:step.attempts.map(a=>a.id)};
    await f.assistant.control(before.id,command);await f.assistant.control(before.id,command);
    const confirmed=f.run();assert.equal(confirmed.budget.limits.audio,explicit?ids.length:ids.length+unknown);assert.equal(calls,unknown,'确认动作本身不发请求');
    if(!explicit)assert.equal(f.store.get('settings','ux-grant:'+f.store.get('assistantRuns',before.id).grantId).request.decisionId,decisionId);
    retrying=true;f.assistant.control(before.id,{action:'resume',revision:confirmed.revision});await idle(f.assistant);
    for(let n=0;n<6 && ['waitingJobs','planning','executing'].includes(f.run().state);n++){await f.worker.tick();await f.assistant.tick();await idle(f.assistant);}
    assert.equal(f.run().state,explicit?'awaitingUser':'completed',f.run().error);assert.equal(calls,explicit?ids.length:ids.length+unknown);assert.equal(f.run().budget.used.audio,explicit?ids.length:ids.length+unknown);assert.equal(f.store.all('assistantDecisions',before.id).length,kind==='explicit-amend'?2:1);
    assert.equal(f.store.all('attempts').filter(a=>a.status==='unknown').length,unknown,'旧unknown没有伪装成成功或退费');
  });
});

test('one task send automatically adopts analysis, reuses its existing voice and delivers a real master',async t=>{
  const f=fixture(t),before=f.domain.list(f.chapter.id),ids=before.map(s=>s.id),roleId=before[0].roleId,source=f.chapter.source;
  let analysisCalls=0,audioCalls=0;
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    const request=JSON.parse(options.body);
    if(request.messages){
      analysisCalls++;const input=JSON.parse(request.messages[1].content);
      return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:input.segments.map(s=>({segmentId:s.id,performance:'自然轻声',evidence:'创作建议',evidenceRefs:[],reason:'正常安排自拟台词',uncertain:false}))})}}]});
    }
    audioCalls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});
  });
  f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('operation.prepareChapter',{analysisKind:'director',ids,autoApply:false}),()=>{const draft=f.store.all('suggestions',f.chapter.id)[0];return proposal('analysis.apply',{id:draft.id,selected:draft.items.map(item=>item.id)});},proposal('operation.useVoice',{roleId,voiceId:f.voice.id,apply:true}),proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}),proposal('job.master',{}),{reply:'当前母版已完成，请试听。',complete:true});
  await f.send({completionTarget:'chapter-master'});await idle(f.assistant);
  assert.equal(f.run().state,'waitingJobs',f.run().error);assert.equal(f.store.get('chapters',f.chapter.id).gap,0.6);
  assert.ok(f.run().budget.limits.analysis>=1);assert.ok(f.run().budget.limits.audio>=ids.length);
  await f.analysis.close();await f.assistant.tick();await idle(f.assistant);
  assert.equal(f.run().state,'waitingJobs',f.run().error);assert.equal(f.store.all('suggestions',f.chapter.id)[0].status,'applied');
  const calls=f.requests.length;await f.assistant.tick();await f.assistant.tick();assert.equal(f.requests.length,calls,'等待音频期间不轮询模型');
  await f.worker.tick();await f.assistant.tick();await idle(f.assistant);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
  const run=f.run(),master=f.store.get('masters',run.delivery?.masterId);
  assert.equal(run.state,'completed',run.error);assert.ok(existsSync(join(f.directory,master.path)));assert.equal(run.delivery.review,'pending');
  assert.equal(analysisCalls,1);assert.equal(audioCalls,ids.length);assert.equal(run.budget.used.analysis,1);assert.equal(run.budget.used.audio,ids.length);
  assert.equal(f.store.all('assistantDecisions',run.id).length,0);assert.ok(f.store.all('assistantSteps',run.id).every(s=>s.state==='completed'&&!s.approvedBy));
  assert.equal(f.domain.list(f.chapter.id).map(s=>s.text).join(''),source);
  assert.ok(f.domain.list(f.chapter.id).every(s=>s.voiceId===f.voice.id&&s.performance==='自然轻声'&&s.decisions.performance.source==='policy_ai'&&s.review!=='passed'));
  assert.deepEqual(f.domain.list(f.chapter.id).map(s=>[s.id,s.roleId,s.voiceId,s.voiceSource,s.protectedFields||[]]),before.map(s=>[s.id,s.roleId,s.voiceId,s.voiceSource,s.protectedFields||[]]));
});

test('ask mode keeps a proposal while task mode needs no first-step approval',async t=>{
  for(const mode of ['ask','task'])await t.test(mode,async t=>{
    const f=fixture(t);f.answers.push(proposal('chapter.update',{gap:0.8}),{reply:'设置完成。',complete:true});
    await f.send({mode,completionTarget:'requested-actions',limits:{assistant:3,analysis:0,audio:0}});await idle(f.assistant);
    assert.equal(f.run().state,mode==='ask'?'awaitingApproval':'completed',f.run().error);
    assert.equal(f.store.get('chapters',f.chapter.id).gap,mode==='ask'?f.chapter.gap:0.8);assert.equal(f.store.all('assistantDecisions').length,0);
  });
});

test('missing or out-of-set voices ask by role before assigning or dispatching',async t=>{
  for(const kind of ['missing','out-of-set'])await t.test(kind,async t=>{
    const f=fixture(t,{withVoice:kind!=='missing'}),ids=f.domain.list(f.chapter.id).map(s=>s.id);let audioCalls=0;
    t.mock.method(globalThis,'fetch',async()=>{audioCalls++;throw Error('不得生成未授权声音');});
    if(kind==='missing')f.answers.push(proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}));
    else{const other={id:uid(),name:'集合外声音',state:'active'};f.store.put('voices',other);f.answers.push(proposal('segment.update',{id:ids[0],voiceId:other.id}));}
    const before=f.domain.list(f.chapter.id);await f.send({voicePolicy:kind==='missing'?'askMissing':'chooseFromApprovedSet',allowedVoiceIds:f.voice?[f.voice.id]:[],limits:{assistant:3,analysis:0,audio:2}});await idle(f.assistant);
    assert.equal(f.run().state,'awaitingUser',f.run().error);assert.ok(f.run().voiceQuestions.length);assert.equal(new Set(f.run().voiceQuestions.map(q=>q.roleId)).size,f.run().voiceQuestions.length);
    assert.deepEqual(f.domain.list(f.chapter.id).map(s=>s.voiceId),before.map(s=>s.voiceId));assert.equal(audioCalls,0);assert.equal(f.store.all('attempts').length,0);
  });
});

test('an explicit audio budget below the planned range stops before sending',async t=>{
  const f=fixture(t),ids=f.domain.list(f.chapter.id).map(s=>s.id);let audioCalls=0;
  t.mock.method(globalThis,'fetch',async()=>{audioCalls++;throw Error('预算不足不得发送');});
  f.answers.push(proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}));
  await f.send({limits:{assistant:3,analysis:0,audio:1}});await idle(f.assistant);
  assert.equal(f.run().state,'awaitingUser',f.run().error);assert.equal(f.run().budget.limits.audio,1);assert.equal(f.run().budget.used.audio,0);
  assert.equal(audioCalls,0);assert.equal(f.store.all('attempts').length,0);assert.match(f.run().error,/额度|上限|预算/);
});

test('sparse limits retain scope defaults while explicit zero limits and step ceilings stay exact',async t=>{
  for(const explicit of [false,true])await t.test(explicit?'explicit zero and 40 steps':'sparse assistant limit and default steps',async t=>{
    const f=fixture(t);f.answers.push(proposal('chapter.update',{gap:0.9}),{reply:'设置完成。',complete:true});
    await f.send({completionTarget:'requested-actions',limits:explicit?{assistant:16,analysis:0,audio:0}:{assistant:16},...(explicit?{stepLimit:40}:{})});await idle(f.assistant);
    assert.equal(f.run().state,'completed',f.run().error);assert.equal(f.run().budget.limits.assistant,16);assert.equal(f.run().stepLimit,explicit?40:200);
    if(explicit){assert.equal(f.run().budget.limits.analysis,0);assert.equal(f.run().budget.limits.audio,0);}
    else{assert.ok(f.run().budget.limits.analysis>=1);assert.ok(f.run().budget.limits.audio>=f.domain.list(f.chapter.id).length);}
    assert.equal(f.run().budget.used.audio,0);assert.equal(f.run().budget.used.analysis,0);assert.equal(f.store.all('assistantDecisions').length,0);
  });
});

test('unknown assistant and audio receipts remain charged and never retry automatically',async t=>{
  for(const kind of ['assistant','audio'])await t.test(kind,async t=>{
    const f=fixture(t),id=f.domain.list(f.chapter.id)[0].id;let audioCalls=0;
    f.answers.push(kind==='assistant'?()=>new Response('未确认',{status:502}):proposal('operation.generateSelection',{ids:[id],actionKind:'fillMissing'}));
    t.mock.method(globalThis,'fetch',async()=>{audioCalls++;throw Error('音频回执丢失');});
    await f.send({limits:{assistant:3,analysis:0,audio:1}});await idle(f.assistant);
    if(kind==='audio'){assert.equal(f.run().state,'waitingJobs',f.run().error);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);}
    assert.ok(['needsReconciliation','awaitingUser'].includes(f.run().state),f.run().error);
    const before=f.run().budget.used;await f.assistant.tick();await f.worker.recover();f.assistant.recover();await f.assistant.tick();await idle(f.assistant);
    assert.equal(f.requests.length,1);assert.equal(audioCalls,kind==='audio'?1:0);assert.deepEqual(f.run().budget.used,before);
    assert.equal(before.assistant,1);assert.equal(before.audio,kind==='audio'?1:0);
    if(kind==='audio')assert.equal(f.store.all('attempts')[0].status,'unknown');
    else assert.equal(f.store.all('settings').find(r=>r.id.startsWith('assistant-call:')).state,'unknown');
  });
});

test('a task cannot silently remove reading content or invent a passed human review',async t=>{
  for(const kind of ['exclude','delete','review'])await t.test(kind,async t=>{
    const f=fixture(t),segment=f.domain.list(f.chapter.id)[0];
    if(kind==='review'){
      t.mock.method(globalThis,'fetch',async()=>new Response(wav(),{headers:{'Content-Type':'audio/wav'}}));
      f.worker.enqueue({kind:'generate',chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids:[segment.id],commandId:uid()});await f.worker.tick();
    }
    const current=f.store.get('segments',segment.id),capabilityId=kind==='review'?'segment.review':kind==='delete'?'segment.delete':'segment.update';
    f.answers.push(proposal(capabilityId,kind==='review'?{id:segment.id,audioId:current.current,state:'passed'}:kind==='delete'?{ids:[segment.id]}:{id:segment.id,excluded:true}));
    await f.send({completionTarget:'requested-actions',limits:{assistant:3,analysis:0,audio:0}});await idle(f.assistant);
    assert.equal(f.run().state,'awaitingApproval',f.run().error);assert.equal(f.store.get('segments',segment.id).text,segment.text);
    assert.equal(f.store.get('segments',segment.id).excluded,false);assert.equal(f.store.get('segments',segment.id).deletion,undefined);assert.notEqual(f.store.get('segments',segment.id).review,'passed');
    if(kind==='review'){
      f.assistant.approve(f.run().id,{decisionId:uid(),revision:f.run().revision,accepted:true});await idle(f.assistant);
      assert.equal(f.run().state,'awaitingUser',f.run().error);assert.match(f.run().error,/人工听评/);assert.notEqual(f.store.get('segments',segment.id).review,'passed');
    }else{
      const sibling=f.domain.list(f.chapter.id)[1];f.answers.push({reply:'仅处理这一句。',complete:true});
      f.assistant.approve(f.run().id,{decisionId:uid(),revision:f.run().revision,accepted:true});await idle(f.assistant);
      assert.equal(f.run().state,'completed',f.run().error);assert.equal(f.store.get('segments',segment.id).excluded,true);
      assert.equal(!!f.store.get('segments',segment.id).deletion,kind==='delete');assert.deepEqual(f.store.get('segments',sibling.id),sibling);
      assert.equal(f.store.get('segments',segment.id).text,segment.text);assert.equal(f.store.all('assistantDecisions',f.run().id).length,1);
    }
  });
});
