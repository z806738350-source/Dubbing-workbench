import {createHash} from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createExperience } from '../server/experience.mjs';
import {createWorker} from '../server/worker.mjs';
import { createAssistant } from '../server/assistant/service.mjs';

async function idle(assistant) { for (let i = 0; i < 300 && assistant.active; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(assistant.active, 0); }
function fixture(t, answers,realWorker=false) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-service-')), store = openStore(directory), domain = createDomain(store);
  const project = domain.mutate('project.create', { name: '助手项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '第1章', source: '第一句。\n第二句。', segment: true });
  const analysis = {};
  const config = { baseUrl: 'https://provider.example/v1', audioUrl: 'https://provider.example/v1/audio/speech', model: 'seed-audio-1.0', key: 'fixture-secret' };
  const worker=realWorker?createWorker(store,domain,config):{ submit: async () => { throw Error('unexpected paid dispatch'); } };
  const experience = createExperience(store, domain, worker, analysis, config), requests = [];
  const assistant = createAssistant({ store, domain, worker, analysis, experience, config, fetchImpl: async (_url, options) => {
    requests.push(JSON.parse(options.body)); const next = answers.shift();
    if (typeof next === 'function') return next(requests.at(-1));
    return new Response(JSON.stringify({ choices: [{ message: { content: typeof next === 'string' ? next : JSON.stringify(next) } }] }));
  } });
  assistant.model.save({ revision: 0, enabled: true, baseUrl: config.baseUrl, model: 'claude-sonnet-5-5', credentialSource: 'audio', vision: false });
  const session = assistant.create({ projectId: project.id, chapterId: chapter.id }).session;
  t.after(async () => { await assistant.close(); if(realWorker){worker.close();await worker.drain();} store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { assistant, store, domain, chapter, project, session, requests, answers,worker,experience,analysis,directory,config };
}
const send = (f, extra = {}) => f.assistant.send(f.session.id, { messageId: uid(), text: '请帮我处理', approved: true, materials: ['text'], ...extra });
const proposal = (capabilityId, input) => ({ reply: '已准备修改方案，请核对。', steps: [{ capabilityId, input }] });

for (const policy of ['askMissing','chooseFromApprovedSet']) test(`delegated segment voice assignment obeys ${policy} across generic writes`,async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[0],a={id:uid(),name:'A',state:'active'},b={id:uid(),name:'B',state:'active'};f.store.put('voices',a);f.store.put('voices',b);
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('segment.update',{id:s.id,voiceId:b.id}),{reply:'完成'});
 await send(f,{mode:'task',voicePolicy:policy,allowedVoiceIds:[a.id],limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 const state=f.assistant.get(f.session.id);assert.equal(f.store.get('segments',s.id).voiceId,null);assert.equal(state.runs[0].state,'awaitingUser');assert.ok(state.runs[0].voiceQuestions.some(q=>q.segmentIds.includes(s.id)));
});

test('delegation cannot remove a sentence from preserved reading scope; a specific approved exclusion can',async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[1];
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('segment.update',{id:s.id,excluded:true}),{reply:'完成'});
 await send(f,{mode:'task',limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 let state=f.assistant.get(f.session.id);assert.equal(f.store.get('segments',s.id).excluded,false);assert.equal(state.runs[0].state,'awaitingApproval');assert.match(state.runs[0].error,/朗读范围|省略/);
 f.assistant.approve(state.runs[0].id,{decisionId:uid(),revision:state.runs[0].revision,accepted:false});f.answers.length=0;
 f.answers.push(proposal('segment.update',{id:s.id,excluded:true}),{reply:'这句已按决定不朗读'});
 await send(f,{text:'这句不要读，请提出第二句的排除方案',mode:'task'});await idle(f.assistant);state=f.assistant.get(f.session.id);assert.equal(state.runs.at(-1).state,'awaitingApproval');assert.ok(state.steps.at(-1).preview.effects.readingRange);
 await approve(f);assert.equal(f.store.get('segments',s.id).excluded,true);assert.equal(f.store.get('segments',s.id).text,s.text);assert.equal(f.assistant.get(f.session.id).runs.at(-1).state,'completed');
});

test('allowed voice selection and unchanged saves continue without repeated approval',async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[0],v={id:uid(),name:'A',state:'active'};f.store.put('voices',v);
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('segment.update',{id:s.id,voiceId:v.id}),proposal('segment.update',{id:s.id,voiceId:v.id}),{reply:'完成'});
 await send(f,{mode:'task',voicePolicy:'chooseFromApprovedSet',allowedVoiceIds:[v.id],limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 assert.equal(f.store.get('segments',s.id).voiceId,v.id);assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');assert.equal(f.store.all('assistantDecisions').length,1);
});

test('task completion rechecks preserved reading scope after external omission',async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[1];f.answers.push(proposal('chapter.update',{gap:0.6}),()=>{f.store.put('segments',{...s,excluded:true},f.chapter.id);return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({reply:'全部完成',complete:true})}}]}));});
 await send(f,{mode:'task',limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 const r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'awaitingUser');assert.match(r.error,/朗读范围/);
});

for(const action of ['resetVoice','roleId','segment.rebind','segment.merge'])test(`indirect ${action} assignment cannot escape the approved voice set`,async t=>{
 const f=fixture(t,[]),[s,n]=f.domain.list(f.chapter.id),a={id:uid(),name:'A',state:'active'},b={id:uid(),name:'B',state:'active'};f.store.put('voices',a);f.store.put('voices',b);
 const role=f.store.get('roles',s.roleId);f.store.put('roles',{...role,voiceId:b.id},f.project.id);f.store.put('segments',{...s,voiceId:a.id,voiceSource:'default'},f.chapter.id);f.store.put('segments',{...n,voiceId:b.id},f.chapter.id);
 let capabilityId='segment.update',input={id:s.id,resetVoice:true};
 if(action==='roleId'||action==='segment.rebind'){const other=f.domain.mutate('role.create',{projectId:f.project.id,name:'另一角色'});f.store.put('roles',{...other,voiceId:b.id},f.project.id);if(action==='roleId')input={id:s.id,roleId:other.id};else {capabilityId='segment.rebind';input={ids:[s.id],roleId:other.id};}}
 if(action==='segment.merge'){capabilityId=action;input={id:s.id,choice:'second'};}
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal(capabilityId,input),{reply:'完成'});
 await send(f,{mode:'task',voicePolicy:'chooseFromApprovedSet',allowedVoiceIds:[a.id],limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 assert.equal(f.assistant.get(f.session.id).runs[0].state,'awaitingUser');assert.equal(f.store.get('segments',s.id).voiceId,a.id);assert.equal(f.store.get('segments',s.id).retired,undefined);assert.equal(f.domain.list(f.chapter.id).length,2);
});

test('exact split and merge preserve reading scope without extra approvals or repeated voice decisions',async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[0];
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('segment.split',{id:s.id,offset:2}),()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(proposal('segment.merge',{id:f.domain.list(f.chapter.id)[0].id}))}}]})),{reply:'完成'});
 await send(f,{mode:'task',limits:{assistant:5,audio:0}});await idle(f.assistant);await approve(f);
 const state=f.assistant.get(f.session.id);assert.equal(state.runs[0].state,'completed',state.runs[0].error);assert.equal(f.store.all('assistantDecisions').length,1);assert.equal(f.domain.list(f.chapter.id)[0].text,s.text);
});

test('ordinary question reads real context and ends without writes; message replay never resends', async t => {
  const f = fixture(t, [{ reply: '请在整章试听中播放当前章。' }]), messageId = uid();
  await send(f, { messageId }); await idle(f.assistant);
  await send(f, { messageId });
  const state = f.assistant.get(f.session.id);
  assert.equal(f.requests.length, 1); assert.equal(state.runs[0].state, 'completed');
  assert.equal(state.steps.length, 0); assert.ok(!JSON.stringify(f.requests).includes('fixture-secret'));
  assert.equal(f.requests[0].model, 'claude-sonnet-5-5');
  await assert.rejects(send(f, { messageId, text: '不同内容' }), /标识/);
});

test('specific proposal requires exact approval, refuses changed targets and persistent rejection', async t => {
  const f = fixture(t, []), segment = f.domain.list(f.chapter.id)[0];
  f.answers.push(proposal('segment.update', { id: segment.id, performance: '轻声' }));
  await send(f); await idle(f.assistant);
  let state = f.assistant.get(f.session.id), run = state.runs[0];
  assert.equal(run.state, 'awaitingApproval'); assert.equal(f.store.get('segments', segment.id).performance, '');
  f.domain.mutate('segment.update', { id:segment.id,chapterId: f.chapter.id, revision: f.store.get('chapters', f.chapter.id).revision, performance:'人工新表演' });
  f.assistant.approve(run.id, { decisionId: uid(), revision: run.revision, accepted: true }); await idle(f.assistant);
  state = f.assistant.get(f.session.id); assert.equal(state.runs[0].state, 'awaitingUser'); assert.match(state.runs[0].error, /改变/);
  assert.equal(f.store.get('segments', segment.id).performance, '人工新表演');
  const f2 = fixture(t, [proposal('chapter.update', { title: '不要采用' })]);
  await send(f2); await idle(f2.assistant); run = f2.assistant.get(f2.session.id).runs[0];
  const decisionId = uid(); f2.assistant.approve(run.id, { decisionId, revision: run.revision, accepted: false });
  assert.throws(() => f2.assistant.approve(run.id, { decisionId: uid(), revision: run.revision, accepted: true }), /已改变/);
  assert.equal(f2.store.get('chapters', f2.chapter.id).title, '第1章');
});

test('approved bounded task progresses through multiple local steps with AI source, preserves text and never marks listened', async t => {
  const f = fixture(t, []), segment = f.domain.list(f.chapter.id)[0];
  f.answers.push(proposal('segment.update', { id: segment.id, performance: '轻声' }), proposal('chapter.update', { gap: 0.7 }), { reply: '安排已保存，仍需生成和试听。', complete: true });
  await send(f, { mode: 'task', limits: { assistant: 6, audio: 0, analysis: 0 } }); await idle(f.assistant);
  let run = f.assistant.get(f.session.id).runs[0];
  f.assistant.approve(run.id, { decisionId: uid(), revision: run.revision, accepted: true }); await idle(f.assistant);
  run = f.assistant.get(f.session.id).runs[0];
  assert.equal(run.state, 'completed', run.error);
  assert.equal(f.store.get('segments', segment.id).performance, '轻声');
  assert.equal(f.store.get('segments', segment.id).text, segment.text);
  assert.equal(f.store.get('segments', segment.id).decisions.performance.source, 'policy_ai');
  assert.equal(f.store.get('chapters', f.chapter.id).gap, 0.7);
  assert.equal(f.requests.length, 3);
  assert.equal(f.assistant.get(f.session.id).steps.filter(s => s.state === 'completed').length, 2);
});

test('unregistered model action repairs at most once, then executes nothing', async t => {
  const bad = { reply: '越权', steps: [{ capabilityId: 'execute_any_action', input: { shell: 'no' } }] };
  const f = fixture(t, [bad, bad]); await send(f); await idle(f.assistant);
  const run = f.assistant.get(f.session.id).runs[0];
  assert.equal(run.state, 'awaitingUser'); assert.equal(f.requests.length, 2);
  assert.equal(f.assistant.get(f.session.id).steps.length, 0);
});

test('paid assistant unknown survives restart without sending again, and closing waits for in-flight receipt', async t => {
  let finish; const gate = new Promise(r => { finish = r; });
  const f = fixture(t, [async () => { await gate; return new Response('gateway lost', { status: 502 }); }]);
  await send(f); await new Promise(r => setTimeout(r, 10));
  let closed = false; const draining = f.assistant.close().then(() => { closed = true; });
  await new Promise(r => setTimeout(r, 10)); assert.equal(closed, false);
  finish(); await draining;
  assert.equal(f.assistant.get(f.session.id).runs[0].state, 'needsReconciliation');
  f.assistant.recover(); assert.equal(f.requests.length, 1);
});

test('pause while model is in flight keeps reply but dispatches no business action', async t => {
  let finish; const gate = new Promise(r => { finish = r; });
  const f = fixture(t, [async () => { await gate; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(proposal('chapter.update', { title: '暂停后的错误修改' })) } }] })); }]);
  await send(f, { mode: 'task' }); await new Promise(r => setTimeout(r, 10));
  let run = f.assistant.get(f.session.id).runs[0]; f.assistant.control(run.id, { action: 'pause', revision: run.revision });
  finish(); await idle(f.assistant);
  run = f.assistant.get(f.session.id).runs[0]; assert.equal(run.state, 'paused');
  assert.equal(f.store.get('chapters', f.chapter.id).title, '第1章'); assert.equal(f.requests.length, 1);
});

function wav(){const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;}
function voice(f){const v={id:uid(),name:'测试音色',state:'active',path:'voice.wav',revision:1,duration:0.1};writeFileSync(join(f.directory,v.path),wav());f.store.put('voices',v);const r=f.store.all('roles',f.project.id)[0];f.domain.mutate('role.update',{id:r.id,entityRevision:r.revision??1,voiceId:v.id,chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision});f.domain.mutate('segment.confirm',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids:f.domain.list(f.chapter.id).map(s=>s.id)});return v;}
async function approve(f){const r=f.assistant.get(f.session.id).runs.at(-1);f.assistant.approve(r.id,{decisionId:uid(),revision:r.revision,accepted:true});await idle(f.assistant);return r.id;}

test('unrelated manual title change does not expire a line performance proposal',async t=>{
 const f=fixture(t,[]),s=f.domain.list(f.chapter.id)[0];f.answers.push(proposal('segment.update',{id:s.id,performance:'轻声'}));await send(f);await idle(f.assistant);
 f.domain.mutate('chapter.update',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,title:'新标题'});await approve(f);
 assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');assert.equal(f.store.get('segments',s.id).performance,'轻声');
});
test('complete:true without a real master cannot complete a whole chapter task',async t=>{
 const f=fixture(t,[{reply:'完成了',complete:true}]);await send(f,{mode:'task',completionTarget:'chapter-master'});await idle(f.assistant);
 const r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'awaitingUser');assert.match(r.error,/母版/);assert.ok(r.voiceQuestions.length);assert.equal(r.delivery,undefined);
});
test('generation and master run through real worker receipts; waiting ticks spend no assistant calls',async t=>{
 const f=fixture(t,[],true),v=voice(f),ids=f.domain.list(f.chapter.id).map(s=>s.id);let audioCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{audioCalls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
 f.answers.push(proposal('operation.generateSelection',{ids,actionKind:'fillMissing'}),proposal('job.master',{}),{reply:'母版已准备好，等待人工试听。',complete:true});
 await send(f,{mode:'task',completionTarget:'chapter-master',materials:['text','reference'],allowedVoiceIds:[v.id],limits:{assistant:6,audio:ids.length,analysis:0}});await idle(f.assistant);const id=await approve(f);
 assert.equal(f.store.get('assistantRuns',id).state,'waitingJobs');await f.assistant.tick();assert.equal(f.requests.length,1);
 await f.worker.tick();await f.assistant.tick();await idle(f.assistant);assert.equal(f.requests.length,2);assert.equal(f.store.get('assistantRuns',id).state,'waitingJobs');
 await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
 const r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'completed',r.error);assert.ok(r.delivery.masterId);assert.equal(r.delivery.review,'pending');assert.equal(audioCalls,ids.length);assert.equal(r.budget.used.audio,ids.length);assert.equal(f.requests.length,3);
 assert.ok(f.domain.chapter(f.chapter.id).units.every(u=>u.variants[u.mode].review!=='passed'));
});
test('manual line changes while jobs complete are never rebased as assistant changes',async t=>{
 const f=fixture(t,[],true),v=voice(f),s=f.domain.list(f.chapter.id)[0],ids=f.domain.list(f.chapter.id).map(s=>s.id);
 t.mock.method(globalThis,'fetch',async()=>new Response(wav(),{headers:{'Content-Type':'audio/wav'}}));
 f.answers.push({reply:'先生成再安排',steps:[{capabilityId:'operation.generateSelection',input:{ids,actionKind:'fillMissing'}},{capabilityId:'segment.update',input:{id:s.id,performance:'模型接管'}}]});
 await send(f,{materials:['text','reference'],allowedVoiceIds:[v.id],limits:{assistant:4,audio:ids.length,analysis:0}});await idle(f.assistant);await approve(f);await f.worker.tick();
 f.domain.mutate('segment.update',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,id:s.id,performance:'我手动改的'});
 await f.assistant.tick();await idle(f.assistant);const state=f.assistant.get(f.session.id);assert.equal(state.runs[0].state,'awaitingUser');assert.equal(state.steps[1].state,'stale');assert.equal(f.store.get('segments',s.id).performance,'我手动改的');assert.equal(f.requests.length,1);
});
test('budget amendments keep past usage and require explicit route approval; unknown request needs exact decision',async t=>{
 const f=fixture(t,[async()=>new Response('lost',{status:502}),{reply:'已核对'}]);await send(f,{limits:{assistant:1,analysis:0,audio:0}});await idle(f.assistant);
 let r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'needsReconciliation');const requestId=r.reconciliation.assistantRequest.id;
 await assert.rejects(f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'retry',assistantRequestId:requestId}),/次数/);
 const decisionId=uid(),p={action:'amend',revision:r.revision,decisionId,limits:{assistant:3,analysis:2,audio:4}};await f.assistant.control(r.id,p);await f.assistant.control(r.id,p);
 r=f.assistant.get(f.session.id).runs[0];assert.equal(r.budget.used.assistant,1);assert.equal(r.state,'needsReconciliation');assert.equal(f.requests.length,1);
 await assert.rejects(f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'retry',assistantRequestId:'wrong'}),/已改变/);
 await f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'retry',assistantRequestId:requestId});r=f.assistant.get(f.session.id).runs[0];f.assistant.control(r.id,{action:'resume',revision:r.revision});await idle(f.assistant);
 assert.equal(f.requests.length,2);assert.equal(f.assistant.get(f.session.id).runs[0].budget.used.assistant,2);
});
test('consumed proposal response is not re-applied after service recovery',async t=>{
 const f=fixture(t,[proposal('chapter.update',{gap:0.7})]);await send(f);await idle(f.assistant);const id=await approve(f);
 let r=f.store.get('assistantRuns',id);assert.equal(r.request.state,'consumed');r.state='executing';f.store.put('assistantRuns',r,r.sessionId);f.assistant.recover();
 r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'paused');f.assistant.control(id,{action:'resume',revision:r.revision});await idle(f.assistant);
 assert.equal(f.requests.length,1);assert.equal(f.assistant.get(f.session.id).steps.length,1);assert.equal(f.store.get('chapters',f.chapter.id).gap,0.7);
});

test('an audio unknown requires its exact attempt decision; resumed generation does not reset either budget',async t=>{
 const f=fixture(t,[],true),v=voice(f),id=f.domain.list(f.chapter.id)[0].id;let calls=0;
 t.mock.method(globalThis,'fetch',async()=>++calls===1?new Response('uncertain',{status:502}):new Response(wav(),{headers:{'Content-Type':'audio/wav'}}));
 f.answers.push(proposal('operation.generateSelection',{ids:[id],actionKind:'fillMissing'}));
 await send(f,{materials:['text','reference'],allowedVoiceIds:[v.id],limits:{assistant:3,audio:2,analysis:0}});await idle(f.assistant);await approve(f);await f.worker.tick();await f.assistant.tick();
 let r=f.assistant.get(f.session.id).runs[0],detail=r.reconciliation.steps[0];assert.equal(detail.attempts.length,1);assert.equal(r.budget.used.audio,1);
 await assert.rejects(f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'retry',stepId:detail.stepId,acknowledgedAttemptIds:[]}),/全部/);
 await f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'retry',stepId:detail.stepId,acknowledgedAttemptIds:detail.attempts.map(a=>a.id)});
 r=f.assistant.get(f.session.id).runs[0];f.assistant.control(r.id,{action:'resume',revision:r.revision});await idle(f.assistant);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
 r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'completed',r.error);assert.equal(calls,2);assert.equal(r.budget.used.audio,2);assert.equal(r.budget.used.assistant,1);assert.equal(f.store.all('attempts').filter(a=>a.status==='unknown').length,1);
});

test('central voice choices are scoped business operations and do not fake a listened result',async t=>{
 const f=fixture(t,[{reply:'请为旁白选择声音。',questions:['旁白用哪个声音？']},{reply:'声音设置已保存。'}]);
 const v={id:uid(),name:'新声音',state:'active',path:'voice.wav',revision:1,duration:0.1};writeFileSync(join(f.directory,v.path),wav());f.store.put('voices',v);
 await send(f,{mode:'task',limits:{assistant:4,audio:0,analysis:0}});await idle(f.assistant);let r=f.assistant.get(f.session.id).runs[0];const roleId=r.voiceQuestions[0].roleId;
 await f.assistant.control(r.id,{action:'amend',revision:r.revision,decisionId:uid(),roleVoiceChoices:{[roleId]:v.id}});r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'paused');assert.ok(f.domain.list(f.chapter.id).every(s=>!s.voiceId));
 f.assistant.control(r.id,{action:'resume',revision:r.revision});await idle(f.assistant);
 assert.ok(f.domain.list(f.chapter.id).every(s=>s.voiceId===v.id && s.decisions.identity.source==='policy_ai'));
 assert.ok(f.assistant.get(f.session.id).steps.some(s=>s.capabilityId==='operation.useVoice'&&s.state==='completed'));
});

test('creation from an empty session binds only actual created objects and continues the mandate',async t=>{
 const f=fixture(t,[]);f.session=f.assistant.create({}).session;
 f.answers.push(proposal('project.create',{name:'全新助手项目'}),proposal('chapter.create',{title:'新章',source:'原文。',segment:true}),{reply:'导入已保存。'});
 await send(f,{mode:'task',limits:{assistant:5,audio:0,analysis:0}});await idle(f.assistant);await approve(f);
 const state=f.assistant.get(f.session.id),r=state.runs[0];assert.equal(r.state,'completed',r.error);assert.ok(r.binding.projectId);assert.ok(r.binding.chapterId);assert.equal(f.store.get('chapters',r.binding.chapterId).source,'原文。');assert.equal(state.session.chapterId,r.binding.chapterId);assert.equal(f.requests.length,3);
});

test('one corrupt waiting session cannot prevent other ready sessions from advancing',async t=>{
 const f=fixture(t,[{reply:'正常任务完成'}]);await send(f);await idle(f.assistant);
 const valid=f.store.all('assistantRuns')[0];f.store.put('assistantRuns',{...valid,id:'bad-run',sessionId:'missing-session',state:'waitingJobs'},'missing-session');f.store.put('assistantSteps',{id:'bad-step',runId:'bad-run',state:'waitingJobs',ordinal:0,resultRefs:{jobIds:null}},'bad-run');
 await f.assistant.tick();await idle(f.assistant);assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');assert.ok(['awaitingUser','completed'].includes(f.store.get('assistantRuns','bad-run').state));
});

test('each assistant call has a durable receipt, including format repair; archive retains response material until explicit deletion',async t=>{
 const bad={reply:'格式错误',steps:[{capabilityId:'unregistered',input:{}}]},f=fixture(t,[bad,{reply:'修正后回答'}]);await send(f);await idle(f.assistant);
 const rows=f.store.all('settings').filter(r=>r.id.startsWith('assistant-call:'));assert.equal(rows.length,2);assert.ok(rows.every(r=>r.state==='received'&&r.response&&r.runId&&r.sessionId&&r.messageIds.length));assert.equal(f.assistant.get(f.session.id).runs[0].callCounts.received,2);
 assert.ok(rows.every((r,i)=>r.inputSha256===createHash('sha256').update(JSON.stringify(f.requests[i].messages)).digest('hex')&&r.promptSha256&&r.promptVersion==='assistant-v1'&&r.capabilityVersion===1&&Array.isArray(r.materials)&&r.responseAt&&r.firstByteAt));assert.notEqual(rows[0].inputSha256,rows[1].inputSha256);assert.ok(!JSON.stringify(rows).includes('fixture-secret'));assert.ok(rows.every(r=>!r.headers&&!r.prompt));await f.assistant.archive(f.session.id);assert.ok(f.store.all('settings').filter(r=>r.id.startsWith('assistant-call:')).every(r=>r.response&&r.messageIds));const session=f.assistant.get(f.session.id).session;await f.assistant.removeContent(session.id,{sessionId:session.id,revision:session.revision,confirmed:true});assert.ok(f.store.all('settings').filter(r=>r.id.startsWith('assistant-call:')).every(r=>!r.response&&!r.messageIds&&!r.attachmentIds));
});

test('changing assistant or production route requires the corresponding explicit amendment',async t=>{
 const f=fixture(t,[{reply:'请选择后续操作',questions:['继续哪些内容？']},{reply:'继续完成'}]);await send(f);await idle(f.assistant);let r=f.assistant.get(f.session.id).runs[0];
 f.assistant.model.save({revision:1,enabled:true,baseUrl:f.config.baseUrl,model:'another-user-selected-model',credentialSource:'audio',vision:false});
 await f.assistant.control(r.id,{action:'amend',revision:r.revision,decisionId:uid(),limits:{assistant:5}});r=f.assistant.get(f.session.id).runs[0];assert.throws(()=>f.assistant.control(r.id,{action:'resume',revision:r.revision}),/已改变/);assert.equal(f.requests.length,1);
 f.config.audioUrl='https://new-provider.example/v1/audio/speech';await assert.rejects(f.assistant.control(r.id,{action:'amend',revision:r.revision,decisionId:uid(),acceptCurrentConnection:true}),/制作连接/);
 await f.assistant.control(r.id,{action:'amend',revision:r.revision,decisionId:uid(),acceptCurrentConnection:true,acceptCurrentProductionConnection:true});r=f.assistant.get(f.session.id).runs[0];assert.equal(r.budget.used.assistant,1);f.assistant.control(r.id,{action:'resume',revision:r.revision});await idle(f.assistant);assert.equal(f.requests.length,2);assert.equal(f.requests[1].model,'another-user-selected-model');assert.equal(f.assistant.get(f.session.id).runs[0].budget.used.assistant,2);
});

test('message/run publication is atomic; a failed run write cannot swallow an idempotent message',async t=>{
 const f=fixture(t,[{reply:'重试同一消息后得到的回答'}]),original=f.store.put.bind(f.store);let inject=true;
 f.store.put=(table,...args)=>{if(table==='assistantRuns'&&inject){inject=false;throw Error('disk write interrupted');}return original(table,...args);};
 const messageId=uid();await assert.rejects(send(f,{messageId}),/interrupted/);assert.equal(f.store.maybe('assistantMessages',messageId),null);assert.equal(f.requests.length,0);
 await send(f,{messageId});await idle(f.assistant);assert.equal(f.requests.length,1);assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');await send(f,{messageId});assert.equal(f.requests.length,1);
});
test('recovery resolves a committed local operation with missing step receipt instead of applying it twice',async t=>{
 const f=fixture(t,[proposal('chapter.update',{gap:0.8})]);await send(f);await idle(f.assistant);const id=await approve(f),step=f.store.all('assistantSteps',id)[0],run=f.store.get('assistantRuns',id);
 step.state='executing';delete step.resultRefs;f.store.put('assistantSteps',step,id);run.state='executing';f.store.put('assistantRuns',run,run.sessionId);const rev=f.store.get('chapters',f.chapter.id).revision;
 f.assistant.recover();assert.equal(f.store.get('assistantSteps',step.id).state,'completed');const r=f.assistant.get(f.session.id).runs[0];f.assistant.control(id,{action:'resume',revision:r.revision});await idle(f.assistant);assert.equal(f.store.get('chapters',f.chapter.id).revision,rev);assert.equal(f.requests.length,1);
});

test('malformed persisted assistant rows are isolated from listing, busy checks and other session context',async t=>{
 const f=fixture(t,[{reply:'仍可读取正常章节'}]);
 f.store.db.prepare("INSERT INTO assistantRuns(id,parent,data) VALUES(?,?,?)").run('invalid-json-shape','corrupt-session','null');
 f.store.db.prepare("INSERT INTO assistantSessions(id,parent,data) VALUES(?,?,?)").run('invalid-session-shape','','[]');
 f.store.put('assistantRuns',{id:'bad-binding',sessionId:'corrupt-session',state:'waitingJobs'},'corrupt-session');
 assert.doesNotThrow(()=>f.assistant.busy(f.project.id));assert.ok(f.assistant.list().every(s=>s&&s.id));await f.assistant.tick();await idle(f.assistant);f.assistant.recover();
 await send(f);await idle(f.assistant);assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');assert.equal(f.requests.length,1);assert.ok(!JSON.stringify(f.requests[0]).includes('corrupt-session'));
});

test('an approved voice set permits automatic role selection with AI provenance and no further approval',async t=>{
 const f=fixture(t,[]),v={id:uid(),name:'批准声音',state:'active',path:'voice.wav',revision:1,duration:0.1};writeFileSync(join(f.directory,v.path),wav());f.store.put('voices',v);const roleId=f.domain.list(f.chapter.id)[0].roleId;
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('operation.useVoice',{roleId,voiceId:v.id,updateDefault:false}),{reply:'本章音色已安排'});
 await send(f,{mode:'task',voicePolicy:'chooseFromApprovedSet',allowedVoiceIds:[v.id],limits:{assistant:5,audio:0,analysis:0}});await idle(f.assistant);await approve(f);
 assert.equal(f.assistant.get(f.session.id).runs[0].state,'completed');assert.equal(f.requests.length,3);assert.ok(f.domain.list(f.chapter.id).every(s=>s.voiceId===v.id&&s.decisions.identity.source==='policy_ai'));
});
test('duplicate approval returns the same decision and applies a local proposal exactly once',async t=>{
 const f=fixture(t,[proposal('chapter.update',{gap:0.9})]);await send(f);await idle(f.assistant);const r=f.assistant.get(f.session.id).runs[0],before=f.store.get('chapters',f.chapter.id).revision,p={decisionId:uid(),revision:r.revision,accepted:true};f.assistant.approve(r.id,p);f.assistant.approve(r.id,p);await idle(f.assistant);
 assert.equal(f.store.get('chapters',f.chapter.id).revision,before+1);assert.equal(f.store.all('assistantDecisions',r.id).length,1);assert.equal(f.store.all('settings').filter(r=>r.id.startsWith('assistant-operation:')).length,1);
});

test('one empty-session mandate imports exact text, selects approved voice and delivers a real master',async t=>{
 const f=fixture(t,[],true);f.session=f.assistant.create({}).session;const v={id:uid(),name:'已授权的旁白',state:'active',path:'voice.wav',revision:1,duration:0.1};writeFileSync(join(f.directory,v.path),wav());f.store.put('voices',v);
 const answer=p=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(p)}}]}));
 const bound=()=>f.assistant.get(f.session.id).runs[0].binding;
 f.answers.push(proposal('project.create',{name:'空白到母版'}),proposal('chapter.create',{title:'完整流程',source:'保留这句原文。',segment:true}),()=>answer(proposal('operation.useVoice',{roleId:f.domain.list(bound().chapterId)[0].roleId,voiceId:v.id,updateDefault:false})),()=>answer(proposal('segment.confirm',{ids:f.domain.list(bound().chapterId).map(s=>s.id),roleOnly:true})),()=>answer(proposal('operation.generateSelection',{ids:f.domain.list(bound().chapterId).map(s=>s.id),actionKind:'fillMissing'})),proposal('job.master',{}),{reply:'试听母版已就绪，请检查。',complete:true});
 t.mock.method(globalThis,'fetch',async()=>new Response(wav(),{headers:{'Content-Type':'audio/wav'}}));
 await send(f,{mode:'task',completionTarget:'chapter-master',voicePolicy:'chooseFromApprovedSet',allowedVoiceIds:[v.id],materials:['text','reference'],limits:{assistant:8,audio:2,analysis:0}});await idle(f.assistant);await approve(f);
 assert.equal(f.assistant.get(f.session.id).runs[0].state,'waitingJobs',f.assistant.get(f.session.id).runs[0].error);assert.equal(f.requests.length,5);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
 const r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'completed',r.error);assert.ok(r.delivery.masterId);assert.equal(f.store.get('chapters',r.binding.chapterId).source,'保留这句原文。');assert.equal(r.budget.used.audio,1);assert.equal(r.budget.used.assistant,7);assert.equal(f.store.all('assistantDecisions',r.id).length,1);assert.equal(f.domain.list(r.binding.chapterId)[0].decisions.identity.source,'policy_ai');
});
test('approved deletion of the bound project leaves only a generic archived result, not private data',async t=>{
 const f=fixture(t,[]);f.answers.push(proposal('project.delete',{id:f.project.id}));await send(f,{text:'删除这个项目和里面的素材'});await idle(f.assistant);const id=await approve(f);
 assert.equal(f.store.maybe('projects',f.project.id),null);const state=f.assistant.get(f.session.id);assert.equal(state.session.state,'archived');assert.equal(state.runs[0].state,'completed');assert.equal(state.runs[0].id,id);assert.equal(state.runs[0].binding.projectId,null);
 assert.ok(!JSON.stringify(state).includes('删除这个项目和里面的素材'));assert.ok(!JSON.stringify(state).includes('第一句。'));assert.equal(state.steps.length,0);assert.equal(f.store.all('settings').filter(r=>r.id.startsWith('assistant-call:')&&r.runId===id).length,0);
});
test('a separate active run still blocks a project deletion and changed deletion scope cannot be auto-refreshed',async t=>{
 const f=fixture(t,[]);f.answers.push(proposal('project.delete',{id:f.project.id}));await send(f);await idle(f.assistant);
 const other=f.assistant.create({projectId:f.project.id,chapterId:f.chapter.id}).session;
 f.store.put('assistantRuns',{id:uid(),sessionId:other.id,binding:{projectId:f.project.id,chapterId:f.chapter.id},state:'waitingJobs',revision:1,budget:{limits:{},used:{}}},other.id);
 await approve(f);assert.ok(f.store.get('projects',f.project.id));const r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'awaitingUser');assert.match(r.error,/范围已变化|助手任务/);
});

test('keeping an unknown assistant result does not authorize retrying the original message',async t=>{
 const f=fixture(t,[async()=>new Response('uncertain',{status:502}),{reply:'这是对新问题的回答'}]);await send(f);await idle(f.assistant);let r=f.assistant.get(f.session.id).runs[0];
 await f.assistant.control(r.id,{action:'reconcile',revision:r.revision,decisionId:uid(),resolution:'keep-results',assistantRequestId:r.reconciliation.assistantRequest.id});r=f.assistant.get(f.session.id).runs[0];assert.equal(r.state,'awaitingUser');assert.throws(()=>f.assistant.control(r.id,{action:'resume',revision:r.revision}),/暂停任务|新的明确/);assert.equal(f.requests.length,1);
 await f.assistant.control(r.id,{action:'amend',revision:r.revision,decisionId:uid(),limits:{assistant:5}});r=f.assistant.get(f.session.id).runs[0];assert.throws(()=>f.assistant.control(r.id,{action:'resume',revision:r.revision}),/新的明确/);assert.equal(f.requests.length,1);
 await send(f,{text:'现在只解释如何导出，不执行制作'});await idle(f.assistant);assert.equal(f.requests.length,2);assert.equal(f.requests[1].messages.at(-1).content[0].text,'现在只解释如何导出，不执行制作');
});


test('explicit workflow scope generates a group inside one mandate without repeated approvals',async t=>{
 const f=fixture(t,[],true),v=voice(f),ids=f.domain.list(f.chapter.id).map(s=>s.id);let audioCalls=0;
 t.mock.method(globalThis,'fetch',async()=>{audioCalls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('operation.groupAndGenerate',{ids,guidance:'自然衔接'}),{reply:'一起演绎已生成。',complete:true});
 await send(f,{mode:'task',workflowKinds:['dry','group'],materials:['text','reference'],allowedVoiceIds:[v.id],limits:{assistant:5,audio:1,analysis:0}});await idle(f.assistant);const id=await approve(f);
 assert.equal(f.store.get('assistantRuns',id).state,'waitingJobs');assert.equal(f.store.all('assistantDecisions',id).length,1);
 await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
 const state=f.assistant.get(f.session.id),group=f.store.all('units',f.chapter.id).find(u=>u.kind==='group');assert.equal(state.runs[0].state,'completed',state.runs[0].error);assert.equal(audioCalls,1);assert.equal(group.state,'active');assert.equal(group.creationSource.actorKind,'assistant_delegated');assert.equal(state.steps[1].approvedBy,undefined);
});

test('authorized existing scene generates directly and preserves manual guidance and sound events',async t=>{
 const f=fixture(t,[],true),v=voice(f),id=f.domain.list(f.chapter.id)[0].id,rev=()=>f.store.get('chapters',f.chapter.id).revision;
 f.domain.mutate('unit.update',{chapterId:f.chapter.id,revision:rev(),id,entityRevision:f.store.get('units',id).revision,mode:'scene',guidance:'保持低沉语气',backgroundPresence:'clear'});
 const event=f.domain.mutate('event.create',{chapterId:f.chapter.id,revision:rev(),unitId:id,entityRevision:f.store.get('units',id).revision,kind:'effect',description:'一下清晰敲门声',memberId:id,position:'after',state:'adopted'}),before=f.store.get('events',event.id);
 let audioCalls=0;t.mock.method(globalThis,'fetch',async()=>{audioCalls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('operation.sceneAndGenerate',{unitId:id,eventIds:[event.id]}),{reply:'指定场景已生成。',complete:true});
 await send(f,{mode:'task',workflowKinds:['dry','scene'],materials:['text','reference'],allowedVoiceIds:[v.id],limits:{assistant:5,audio:1,analysis:0}});await idle(f.assistant);const runId=await approve(f);
 assert.equal(f.store.get('assistantRuns',runId).state,'waitingJobs');await f.worker.tick();await f.assistant.tick();await idle(f.assistant);
 const state=f.assistant.get(f.session.id),unit=f.store.get('units',id),after=f.store.get('events',event.id);assert.equal(state.runs[0].state,'completed',state.runs[0].error);assert.equal(audioCalls,1);assert.equal(state.runs[0].budget.used.analysis,0);assert.equal(unit.mode,'scene');assert.equal(unit.variants.scene.guidance,'保持低沉语气');assert.equal(unit.variants.scene.guidanceSource.kind,'user');assert.equal(after.description,before.description);assert.deepEqual(after.source,before.source);assert.equal(state.steps[1].approvedBy,undefined);
 const originalAudioId=unit.variants.scene.current,extra=f.domain.mutate('event.create',{chapterId:f.chapter.id,revision:rev(),unitId:id,entityRevision:unit.revision,kind:'effect',description:'新手动加入的一下铃声',memberId:id,position:'before',state:'adopted'});
 const input={id,mode:'scene',audioId:originalAudioId,restoreSettings:true},preview=f.domain.enhancement.preview({kind:'restore',chapterId:f.chapter.id,revision:rev(),entityRevision:f.store.get('units',id).revision,...input});
 assert.ok(preview.changedAdoptedEvents.removedIds.includes(extra.id));
 assert.throws(()=>f.domain.mutate('unit.restore',{chapterId:f.chapter.id,revision:rev(),entityRevision:f.store.get('units',id).revision,baseRevisions:preview.baseRevisions,...input},{actorKind:'assistant_delegated',operationId:uid(),workflowKinds:['dry','scene']}),/人工声音事件受保护/);
 assert.equal(f.store.get('events',extra.id).state,'adopted');
 f.answers.push(proposal('unit.restore',input));await send(f);await idle(f.assistant);await approve(f);
 const restored=f.assistant.get(f.session.id);assert.equal(restored.runs.at(-1).state,'completed',restored.runs.at(-1).error);assert.equal(f.store.get('events',extra.id).state,'removed');assert.equal(f.store.get('events',event.id).description,before.description);
});

test('dry mandate asks once for a concrete group expansion and continues later group work automatically',async t=>{
 const f=fixture(t,[]),ids=f.domain.list(f.chapter.id).map(s=>s.id);voice(f);
 f.answers.push(proposal('chapter.update',{gap:0.6}),proposal('unit.create',{ids,guidance:'自然'}),()=>{const group=f.store.all('units',f.chapter.id).find(u=>u.kind==='group');return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(proposal('unit.update',{id:group.id,mode:'dry',guidance:'轻声衔接'}))}}]}));},{reply:'设置已完成。',complete:true});
 await send(f,{mode:'task',limits:{assistant:5,audio:0,analysis:0}});await idle(f.assistant);const id=await approve(f);let state=f.assistant.get(f.session.id);
 assert.equal(state.runs[0].state,'awaitingApproval');assert.equal(f.store.all('units',f.chapter.id).filter(u=>u.kind==='group').length,0);assert.deepEqual(state.runs[0].workflowKinds,['dry']);await approve(f);
 state=f.assistant.get(f.session.id);assert.equal(state.runs[0].state,'completed',state.runs[0].error);assert.deepEqual(state.runs[0].workflowKinds,['dry','group']);assert.equal(state.steps[2].approvedBy,undefined);assert.equal(f.store.all('assistantDecisions',id).length,2);
});

test('same task step-limit expansion keeps usage and consumes the saved model reply without resending',async t=>{
 const f=fixture(t,[proposal('chapter.update',{gap:0.6}),proposal('chapter.update',{gap:0.8}),{reply:'已完成',complete:true}]);
 await send(f,{mode:'task',stepLimit:1,limits:{assistant:5,audio:0,analysis:0}});await idle(f.assistant);const id=await approve(f);let run=f.assistant.get(f.session.id).runs[0];
 assert.equal(run.state,'awaitingUser');assert.match(run.error,/步骤上限/);assert.equal(f.requests.length,2);assert.equal(run.budget.used.assistant,2);
 await assert.rejects(f.assistant.control(id,{action:'amend',revision:run.revision,decisionId:uid(),stepLimit:201}),/上限/);
 await f.assistant.control(id,{action:'amend',revision:run.revision,decisionId:uid(),stepLimit:3});run=f.assistant.get(f.session.id).runs[0];assert.equal(run.budget.used.assistant,2);assert.equal(run.stepLimit,3);
 f.assistant.control(id,{action:'resume',revision:run.revision});await idle(f.assistant);run=f.assistant.get(f.session.id).runs[0];assert.equal(run.state,'completed',run.error);assert.equal(f.requests.length,3);assert.equal(f.assistant.get(f.session.id).steps.length,2);assert.equal(f.store.get('chapters',f.chapter.id).gap,0.8);
});


test('assistant call journal records only the actual attachment fingerprints and not pixel data',async t=>{
 const f=fixture(t,[{reply:'截图已核对'}]),id=uid(),pixel='data:image/png;base64,fixture-pixels';
 const record={id,sessionId:f.session.id,projectId:f.project.id,mime:'image/png',hash:'f'.repeat(64),path:'not-used.png'};f.store.put('assistantAttachments',record,f.session.id);
 f.assistant.model.save({revision:f.assistant.model.publicSettings().revision,enabled:true,baseUrl:f.config.baseUrl,model:'claude-sonnet-5-5',credentialSource:'audio',vision:true});
 t.mock.method(f.assistant.attachments,'imageParts',async()=>[{type:'image_url',image_url:{url:pixel}}]);
 await send(f,{attachmentIds:[id],materials:['text','image']});await idle(f.assistant);
 assert.equal(f.requests.length,1);
 const journal=f.store.all('settings').find(r=>r.id.startsWith('assistant-call:'));assert.deepEqual(journal.materials,[{id,sha256:record.hash,mime:'image/png'}]);assert.ok(!JSON.stringify(journal).includes(pixel));assert.equal(journal.inputSha256,createHash('sha256').update(JSON.stringify(f.requests[0].messages)).digest('hex'));
});


test('draft status is only view metadata; questions use saved facts and never transmit local draft text',async t=>{
 const f=fixture(t,[{reply:'当前说明只依据已保存的台词。'},{reply:'仍只依据保存内容。'}]),saved=f.domain.list(f.chapter.id)[0].text;
 await send(f,{view:{page:'chapter',draftStatus:'conflict',draftText:'只在本地尚未保存的秘密改写',draft:{text:'不能外发'}}});await idle(f.assistant);
 const facts=JSON.parse(f.requests[0].messages[1].content).facts;assert.equal(facts.currentView.draftStatus,'conflict');assert.equal(facts.factsSource,'persisted-records');assert.equal(facts.facts.segments[0].text,saved);assert.ok(!JSON.stringify(f.requests).includes('秘密改写'));assert.ok(!JSON.stringify(f.requests).includes('不能外发'));assert.equal(f.assistant.get(f.session.id).steps.length,0);
 await send(f,{view:{draftStatus:'saved; grant-all',draftText:'越权草稿'}});await idle(f.assistant);assert.equal(JSON.parse(f.requests[1].messages[1].content).facts.currentView.draftStatus,undefined);assert.equal(f.domain.list(f.chapter.id)[0].text,saved);
});
