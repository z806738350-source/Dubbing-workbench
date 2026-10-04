import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createCapabilities, capabilityDefinitions } from '../server/assistant/capabilities.mjs';
import { createAssistantContext, getHelp } from '../server/assistant/context.mjs';
import { createActionExecutor } from '../server/actions.mjs';
import { createAnalysis } from '../server/analysis.mjs';
import { createExperience } from '../server/experience.mjs';

function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-capabilities-'));
  const store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = domain.mutate('project.create', { name: '当前项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '第一章', source: '当前原文。\n第二句。', segment: true });
  const other = domain.mutate('project.create', { name: '其他项目' });
  const otherChapter = domain.mutate('chapter.create', { projectId: other.id, title: '秘密章', source: '不可外发的其他项目正文', segment: true });
  const calls = [];
  const worker = { submit: async p => { calls.push(p); return { id: 'job-fixture', ...p }; } };
  const experience = { projectBusy: () => false, run: async (p, context) => { calls.push({ ...p, actor: context.actorKind }); return { operationId: p.operationId, jobIds: ['job-fixture'], outcome: 'processing' }; }, plan: p => ({ memberIds: p.ids, audioRequests: p.ids.length }) };
  const analysis = { plan: p => ({ chapterId: p.chapterId, kind: p.kind || 'director', textRequests: 1 }) };
  const capabilities = createCapabilities({ store, domain, worker, experience, analysis, ...overrides });
  const scope = { projectId: project.id, chapterId: chapter.id };
  return { directory, store, domain, project, chapter, other, otherChapter, calls, capabilities, scope, analysis, experience, worker };
}
async function approved(capabilities, id, input, scope, additions = {}) {
  const plan = await capabilities.preview(id, input, scope);
  return { actorKind: 'human_approved_proposal', operationId: uid(), baseRevisions: plan.baseRevisions, preview: plan.preview, ...additions };
}

test('capability whitelist rejects unknown tools, raw forwarding and server-owned fields', async t => {
  const { capabilities, scope } = fixture(t);
  for (const id of ['execute_any_action', '/api/action', 'operation.save']) await assert.rejects(capabilities.preview(id, {}, scope), /未注册/);
  const segment = (await capabilities.read('read.chapter', {}, scope)).segments[0];
  for (const payload of [{ id: segment.id, revision: 2 }, { id: segment.id, source: 'human' }, { id: segment.id, config: { speech_rate: 0, loudness_rate: 0, pitch_rate: 0, shell: 'x' } }])
    await assert.rejects(capabilities.preview('segment.update', payload, scope), /未注册字段/);
  assert.equal(new Set(capabilityDefinitions.map(item => item.id)).size, capabilityDefinitions.length);
});

test('cross-project and cross-chapter object IDs cannot write or read another target', async t => {
  const { capabilities, scope, domain, otherChapter, store, project } = fixture(t);
  const otherSegment = domain.list(otherChapter.id)[0];
  await assert.rejects(capabilities.preview('segment.update', { id: otherSegment.id, performance: '越界' }, scope), /超出/);
  await assert.rejects(capabilities.read('read.segment', { id: otherSegment.id }, scope), /超出/);
  await assert.rejects(capabilities.read('read.chapter', {}, { projectId: project.id, chapterId: otherChapter.id }), /不属于/);
  const next = domain.mutate('chapter.create', { projectId: project.id, title: '同项目其他章', source: '第三句。', segment: true });
  await assert.rejects(capabilities.preview('segment.update', { id: domain.list(next.id)[0].id, performance: '越章' }, scope), /超出/);
  assert.equal(store.get('segments', otherSegment.id).performance, '');
});

test('writes require trusted execution context and unchanged plain revision dependencies', async t => {
  const { capabilities, scope, domain, chapter, store } = fixture(t);
  const segment = domain.list(chapter.id)[0], input = { id: segment.id, performance: '轻声' };
  await assert.rejects(capabilities.execute('segment.update', input, scope), /可信助手执行上下文/);
  const context = await approved(capabilities, 'segment.update', input, scope);
  domain.mutate('chapter.update', { chapterId: chapter.id, revision: chapter.revision, title: '人工改过' });
  await assert.rejects(capabilities.execute('segment.update', input, scope, context), /计划后已变化/);
  assert.equal(store.get('segments', segment.id).performance, '');
});

test('scoped local mutation reuses the real domain and carries trusted actor separately', async t => {
  const { capabilities, scope, domain, chapter, store } = fixture(t);
  const segment = domain.list(chapter.id)[0], input = { id: segment.id, performance: '轻声' };
  const context = await approved(capabilities, 'segment.update', input, scope);
  await capabilities.execute('segment.update', input, scope, context);
  assert.equal(store.get('segments', segment.id).performance, '轻声');
  assert.equal(store.get('segments', segment.id).text, segment.text);
});

test('paid operations cannot start without a server-provided grant; no model-supplied grant allowed', async t => {
  const { capabilities, scope, domain, chapter, calls } = fixture(t);
  const input = { ids: domain.list(chapter.id).map(s => s.id), actionKind: 'updateSelected' };
  const context = await approved(capabilities, 'operation.generateSelection', input, scope);
  await assert.rejects(capabilities.execute('operation.generateSelection', input, scope, context), /尚未获准/);
  assert.equal(calls.length, 0);
  await assert.rejects(capabilities.preview('operation.generateSelection', { ...input, grantId: 'self-issued' }, scope), /未注册字段/);
  await capabilities.execute('operation.generateSelection', input, scope, { ...context, grantId: 'executor-grant' });
  assert.equal(calls.length, 1); assert.equal(calls[0].requireGrant, true); assert.equal(calls[0].grantId, 'executor-grant');
});

test('automatic export always confirm=false and human-only model settings/grants stay unexecutable', async t => {
  const { capabilities, scope, calls } = fixture(t);
  const input = { format: 'mp3' }, context = await approved(capabilities, 'operation.export', input, scope);
  await capabilities.execute('operation.export', input, scope, { ...context, actorKind: 'assistant_delegated' });
  assert.equal(calls[0].kind, 'export'); assert.equal(calls[0].confirm, false);
  await assert.rejects(capabilities.preview('operation.export', { ...input, confirm: true }, scope), /未注册字段/);
  for (const id of ['settings.assistant', 'settings.update', 'experience.grant', 'workspace.move']) {
    assert.equal((await capabilities.preview(id, {}, scope)).delegation, 'human-only');
    await assert.rejects(capabilities.execute(id, {}, scope, context), /安全界面/);
  }
});

test('review passed requires an explicit human audio decision and never uses model assertion', async t => {
  const { capabilities, scope, store, domain, chapter } = fixture(t, { executeAction: async () => ({ ok: true }) });
  const unit = domain.chapter(chapter.id).units[0], audioId = uid();
  store.put('audios', { id: audioId, chapterId: chapter.id, path: '/sensitive/audio.wav' }, chapter.id);
  const input = { id: unit.id, audioId, mode: 'dry', state: 'passed' };
  const context = await approved(capabilities, 'unit.review', input, scope);
  await assert.rejects(capabilities.execute('unit.review', input, scope, context), /人工听评需要/);
  await assert.rejects(capabilities.execute('unit.review', input, scope, { ...context, actorKind: 'assistant_delegated', humanReview: { audioIds: [audioId] } }), /具体范围/);
  assert.deepEqual(await capabilities.execute('unit.review', input, scope, { ...context, humanReview: { audioIds: [audioId] } }), { ok: true });
});

test('empty project can initialize without guessed chapter or inherited model configuration', async t => {
  const { capabilities, store } = fixture(t);
  const input = { name: '助手新项目' }, context = await approved(capabilities, 'project.create', input, {});
  const p = await capabilities.execute('project.create', input, {}, context);
  const scope = { projectId: p.id }, chapterInput = { title: '新章', source: '保持原文。', segment: false };
  const c = await capabilities.execute('chapter.create', chapterInput, scope, await approved(capabilities, 'chapter.create', chapterInput, scope));
  assert.equal(c.projectId, p.id); assert.equal(c.source, '保持原文。'); assert.equal(store.all('segments', c.id).length, 0);
});

test('context/help use real scoped facts without local paths, other project text or credentials', async t => {
  const { store, domain, capabilities, scope, chapter } = fixture(t);
  store.put('settings', { id: 'provider-secret', apiKey: 'fixture-secret' });
  const context = createAssistantContext({ store, domain, capabilities, config: { key: 'fixture-secret', assistantKey: 'second-secret' } })(scope, { page: 'workspace', arbitraryPath: '/private/local' });
  const serialized = JSON.stringify(context);
  for (const secret of ['fixture-secret', 'second-secret', '/private/local', '不可外发的其他项目正文']) assert.ok(!serialized.includes(secret));
  assert.equal(context.facts.chapter.id, chapter.id);
  assert.equal(context.taskBinding.chapterId, chapter.id);
  assert.equal(getHelp({ capabilityId: 'settings.assistant' }).chunks[0].id, 'assistant-settings');
  assert.match(getHelp({ errorCode: 'audio-unreviewed' }).chunks[0].text, /confirm=false/);
});

test('operation reads resolve scope from durable request, not public receipt with request removed', async t => {
  const { capabilities, scope, store, experience, otherChapter } = fixture(t);
  const operationId = uid();
  store.put('settings', { id: 'ux-operation:' + operationId, request: { chapterId: scope.chapterId }, operationId });
  experience.get = () => ({ operationId, kind: 'save', outcome: 'completed', request: undefined });
  assert.equal((await capabilities.read('read.operation', { id: operationId }, scope)).outcome, 'completed');
  store.put('settings', { id: 'ux-operation:' + operationId, request: { chapterId: otherChapter.id }, operationId });
  await assert.rejects(capabilities.read('read.operation', { id: operationId }, scope), /不属于/);
});

test('shared action guard preserves rename/delete occupancy and audio validation before mutation', async () => {
  let writes = 0;
  const store = { directory: '/unused', maybe: () => ({ folder: 'project' }), get: () => ({}) };
  const domain = { mutate: () => { writes++; } };
  const execute = createActionExecutor({ store, domain, experience: { projectBusy: () => true }, audioTools: false, activity: () => ({ activeRequests: 2, referenceReads: 1 }) });
  await assert.rejects(execute('project.rename', { id: 'p' }), /读取或保存/);
  await assert.rejects(execute('project.delete', { id: 'p' }), /仍有操作/);
  await assert.rejects(execute('segment.restore', { audioId: 'a' }), /音频处理程序/);
  assert.equal(writes, 0);
});

test('assistant mutations record AI provenance, protect human fields and preserve exact text', async t => {
  const { capabilities, scope, store, domain, chapter } = fixture(t);
  const segment = domain.list(chapter.id)[0], input = { id: segment.id, performance: '自然' };
  await capabilities.execute('segment.update',input,scope,await approved(capabilities,'segment.update',input,scope,{actorKind:'assistant_delegated',runId:'run',stepId:'step'}));
  let current = store.get('segments',segment.id);
  assert.equal(current.decisions.performance.source,'policy_ai'); assert.equal(current.decisions.performance.runId,'run');
  assert.ok(!current.protectedFields.includes('performance'));
  domain.mutate('segment.update',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,id:segment.id,performance:'用户指定低声',identityChosen:true});
  const revision = store.get('chapters',chapter.id).revision;
  const conflicting = {id:segment.id,performance:'大声'};
  await assert.rejects(capabilities.execute('segment.update',conflicting,scope,await approved(capabilities,'segment.update',conflicting,scope)),/人工设置受保护/);
  assert.equal(store.get('chapters',chapter.id).revision,revision);
  assert.equal(store.get('segments',segment.id).performance,'用户指定低声');
  await capabilities.execute('segment.update',conflicting,scope,await approved(capabilities,'segment.update',conflicting,scope,{namedOverrides:[segment.id+'.performance']}));
  current = store.get('segments',segment.id); assert.equal(current.performance,'大声'); assert.ok(current.protectedFields.includes('performance')); assert.equal(current.decisions.performance.source,'policy_ai');
  const rewrite={id:segment.id,text:'改写正文。'};
  await assert.rejects(capabilities.execute('segment.update',rewrite,scope,await approved(capabilities,'segment.update',rewrite,scope)),/保留原文/);
  await capabilities.execute('segment.update',rewrite,scope,await approved(capabilities,'segment.update',rewrite,scope,{textMutationPolicy:'explicitSpecifiedEdit'}));
  assert.equal(store.get('segments',segment.id).text,'改写正文。');
});

test('domain mutation and durable assistant receipt commit together; lost step receipt is replayable', async t => {
  const { capabilities, scope, store, domain, chapter } = fixture(t);
  const segment=domain.list(chapter.id)[0], input={id:segment.id,performance:'自然'};
  const context=await approved(capabilities,'segment.update',input,scope);
  const first=await capabilities.execute('segment.update',input,scope,context);
  const revision=store.get('chapters',chapter.id).revision;
  assert.deepEqual(await capabilities.execute('segment.update',input,scope,context),first);
  assert.equal(store.get('chapters',chapter.id).revision,revision);
  assert.ok(store.get('settings','assistant-operation:'+context.operationId).result);
  await assert.rejects(capabilities.execute('segment.update',{...input,performance:'另一个值'},scope,context),/参数不同/);
  const next={id:segment.id,performance:'清楚'}, failing=await approved(capabilities,'segment.update',next,scope);
  const put=store.put.bind(store);
  t.mock.method(store,'put',(table,row,...rest)=>{ if(row.id==='assistant-operation:'+failing.operationId)throw new Error('fixture disk full'); return put(table,row,...rest); });
  await assert.rejects(capabilities.execute('segment.update',next,scope,failing),/disk full/);
  assert.equal(store.get('segments',segment.id).performance,'自然');
  assert.equal(store.get('chapters',chapter.id).revision,revision);
  assert.equal(store.maybe('settings','assistant-operation:'+failing.operationId),null);
});

test('composite useVoice propagates trusted actor without marking inherited choices as human', async t => {
  const f=fixture(t),voiceId=uid();
  f.store.put('voices',{id:voiceId,name:'批准的声音',state:'active',revision:1});
  const role=f.store.all('roles',f.project.id)[0];
  const e=createExperience(f.store,f.domain,f.worker,f.analysis,{});
  const result=await e.run({kind:'useVoice',operationId:uid(),chapterId:f.chapter.id,revision:f.chapter.revision,roleId:role.id,entityRevision:1,voiceId,apply:true},{actorKind:'assistant_delegated',runId:'run',stepId:'voice-step',operationId:'voice-step'});
  assert.equal(result.outcome,'completed');
  for(const s of f.domain.list(f.chapter.id)){assert.equal(s.voiceId,voiceId);assert.equal(s.decisions.identity.source,'policy_ai');assert.equal(s.decisions.identity.stepId,'voice-step');assert.ok(!s.protectedFields.includes('voiceId'));}
});

test('analysis application respects human protection and records an atomic AI receipt', async t => {
  const f=fixture(t), segment=f.domain.list(f.chapter.id)[0];
  f.domain.mutate('segment.update',{chapterId:f.chapter.id,revision:f.chapter.revision,id:segment.id,performance:'人工指定',identityChosen:true});
  const analysis=createAnalysis(f.store,f.domain,{key:'fixture',model:'fixture',baseUrl:'https://example.invalid/v1'});
  t.after(()=>analysis.close());
  t.mock.method(globalThis,'fetch',async()=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:[{segmentId:segment.id,performance:'自然',evidence:'原文明示',evidenceRefs:[0],uncertain:false,reason:'当前原文'}]})}}]}));
  const revision=f.store.get('chapters',f.chapter.id).revision;
  const draft=await analysis.start({chapterId:f.chapter.id,revision,kind:'director',ids:[segment.id],autoApply:false},{actorKind:'assistant_delegated',runId:'analysis-run',stepId:'analysis-start'});
  await analysis.close();
  const ready=f.store.get('suggestions',draft.id),payload={id:ready.id,revision,draftVersion:ready.draftVersion,selected:ready.items.map(i=>i.id)};
  const ctx={actorKind:'human_approved_proposal',operationId:uid(),runId:'analysis-run',stepId:'apply-step'};
  assert.throws(()=>analysis.apply(payload,false,ctx),/人工设置受保护/);
  assert.equal(f.store.get('segments',segment.id).performance,'人工指定');
  ctx.namedOverrides=[segment.id+'.performance'];
  const applied=analysis.apply(payload,false,ctx);
  assert.equal(f.store.get('segments',segment.id).decisions.performance.source,'policy_ai');
  assert.deepEqual(analysis.apply(payload,false,ctx),applied);
  assert.equal(f.store.get('settings','assistant-operation:'+ctx.operationId).action,'analysis.apply');
});

test('registered UI actions require a click, do not autoplay, and reject arbitrary URLs or targets', async t => {
  const {capabilities,scope,store}=fixture(t),voiceId=uid();store.put('voices',{id:voiceId,name:'声音',state:'active'});
  const nav={target:'voices'};
  assert.deepEqual((await capabilities.execute('ui.navigate',nav,scope,await approved(capabilities,'ui.navigate',nav,scope))).uiAction,{type:'navigate',target:'voices',chapterId:scope.chapterId,requiresUserClick:true});
  const play={kind:'voices',id:voiceId};
  assert.equal((await capabilities.execute('ui.play',play,scope,await approved(capabilities,'ui.play',play,scope))).uiAction.requiresUserClick,true);
  await assert.rejects(capabilities.preview('ui.navigate',{target:'arbitrary-shell'},scope),/允许范围/);
  await assert.rejects(capabilities.preview('ui.play',{kind:'voices',id:voiceId,url:'https://example.invalid/private'},scope),/未注册字段/);
});


test('capability map tracks all accepted actions and every tool has indexed help',()=>{
 const manifest=JSON.parse(readFileSync(new URL('../doc/concurrency-assistant/capability-map.json',import.meta.url),'utf8'));
 const help=JSON.parse(readFileSync(new URL('../doc/concurrency-assistant/help-index.json',import.meta.url),'utf8'));
 const source=['domain','enhancement'].map(file=>readFileSync(new URL('../server/'+file+'.mjs',import.meta.url),'utf8')).join('\n');
 const actions=new Set([...source.matchAll(/action\s*===\s*['"]([a-z][a-z.-]+\.[a-z.-]+)['"]/g)].map(m=>m[1]));actions.add('event.reconfirm');
 assert.deepEqual([...actions].sort(),manifest.ordinaryActions.map(a=>a.action).sort());
 assert.deepEqual(manifest.capabilities,JSON.parse(JSON.stringify(capabilityDefinitions)));
 for(const def of capabilityDefinitions){assert.ok(def.helpRefs.length);for(const id of def.helpRefs)assert.ok(help.chunks.some(c=>c.id===id),def.id+' help '+id);}
});
test('tail maintenance only sends approved scope through shared adapter and cannot acquire its own consent',async t=>{
 const calls=[],f=fixture(t,{repairAudio:async p=>{calls.push(p);return p.phase==='preview'?{scope:{id:'fixed-maintenance',units:p.unitIds}}:{state:'completed'};}}),unitId=f.domain.list(f.chapter.id)[0].id,input={unitIds:[unitId]};
 const preview=await f.capabilities.preview('audio.tail.repair',input,f.scope);
 await assert.rejects(f.capabilities.execute('audio.tail.repair',input,f.scope,{actorKind:'assistant_delegated',operationId:uid(),baseRevisions:preview.baseRevisions,preview:preview.preview}),/明确决定/);
 await f.capabilities.execute('audio.tail.repair',input,f.scope,{actorKind:'human_approved_proposal',operationId:uid(),baseRevisions:preview.baseRevisions,preview:preview.preview});
 assert.deepEqual(calls[1],{phase:'apply',...f.scope,scope:preview.preview.scope});
 await assert.rejects(f.capabilities.preview('audio.tail.repair',{unitIds:[unitId],scope:{id:'invented'}},f.scope),/未注册字段/);
});

test('a delegated run cannot stop a manual job or revoke a different grant',async t=>{
 const f=fixture(t),j={id:uid(),chapterId:f.chapter.id,request:{projectId:f.project.id},status:'queued',kind:'master'};f.store.put('jobs',j,f.chapter.id);
 f.store.put('settings',{id:'ux-grant:manual-grant',grantId:'manual-grant',projectId:f.project.id,chapterId:f.chapter.id,revision:1,revoked:false});
 for(const [id,input] of [['job.stop',{id:j.id}],['experience.revoke',{grantId:'manual-grant'}]]){
  const preview=await f.capabilities.preview(id,input,f.scope);await assert.rejects(f.capabilities.execute(id,input,f.scope,{actorKind:'assistant_delegated',operationId:uid(),baseRevisions:preview.baseRevisions}),/明确决定/);
 }
 assert.equal(f.store.get('jobs',j.id).stop,undefined);assert.equal(f.store.get('settings','ux-grant:manual-grant').revoked,false);
});
test('partial maintenance retry keeps original scope and leaves version ownership to maintenance adapter',async t=>{
 let phases=[],f;f=fixture(t,{repairAudio:async p=>{phases.push(p);if(p.phase==='preview')return {scope:{id:'fixed',units:p.unitIds}};if(phases.length===2){const c=f.store.get('chapters',f.chapter.id);c.arrangement++;f.store.put('chapters',c,c.projectId);return {state:'partial'};}return {state:'completed'};}});
 const input={unitIds:[f.domain.list(f.chapter.id)[0].id]},ctx=await approved(f.capabilities,'audio.tail.repair',input,f.scope);
 assert.equal((await f.capabilities.execute('audio.tail.repair',input,f.scope,ctx)).state,'partial');assert.equal((await f.capabilities.execute('audio.tail.repair',input,f.scope,ctx)).state,'completed');assert.deepEqual(phases[1].scope,phases[2].scope);
});

test('truncated automatic context is explicitly partial and full segment reads preserve all text',async t=>{
 const f=fixture(t),s=f.domain.list(f.chapter.id)[0];s.text='原'.repeat(3000);f.store.put('segments',s,f.chapter.id);
 const context=createAssistantContext({store:f.store,domain:f.domain,capabilities:f.capabilities})(f.scope,{});
 assert.equal(context.facts.visibility,'partial');assert.equal(context.facts.segments[0].text.length,2000);assert.equal(context.facts.segments[0].textComplete,false);
 assert.equal((await f.capabilities.read('read.segment',{id:s.id},f.scope)).text.length,3000);
});


test('group and scene delegation never overwrites manual guidance, adopted events or grouping',async t=>{
 const {store,domain,chapter,scope,capabilities}=fixture(t),ids=domain.list(chapter.id).map(s=>s.id),rev=()=>store.get('chapters',chapter.id).revision;
 const v={id:uid(),name:'参考',state:'active',revision:1,path:'fixture.wav'};store.put('voices',v);const role=store.all('roles',scope.projectId)[0];domain.mutate('role.update',{id:role.id,chapterId:chapter.id,revision:rev(),entityRevision:role.revision??1,voiceId:v.id});domain.mutate('segment.confirm',{chapterId:chapter.id,revision:rev(),ids});
 const group=domain.mutate('unit.create',{chapterId:chapter.id,revision:rev(),ids,guidance:'人工设置'});
 const event=domain.mutate('event.create',{chapterId:chapter.id,revision:rev(),unitId:group.id,entityRevision:store.get('units',group.id).revision,kind:'effect',description:'一声敲门',memberId:ids[0],position:'after',state:'adopted'});
 const ctx={actorKind:'assistant_delegated',workflowKinds:['dry','group','scene']};
 for(const [id,input] of [['unit.update',{id:group.id,mode:'dry',guidance:'强行修改'}],['event.remove',{id:event.id,unitId:group.id}],['unit.dissolve',{id:group.id}]])await assert.rejects(capabilities.execute(id,input,scope,await approved(capabilities,id,input,scope,ctx)),/人工.*受保护/);
 assert.equal(store.get('units',group.id).variants.dry.guidance,'人工设置');assert.equal(store.get('events',event.id).state,'adopted');assert.equal(store.get('units',group.id).state,'pending');
 const input={id:event.id,unitId:group.id};await capabilities.execute('event.remove',input,scope,await approved(capabilities,'event.remove',input,scope,{namedOverrides:[event.id+'.state']}));assert.equal(store.get('events',event.id).state,'removed');
});
