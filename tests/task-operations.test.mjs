import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };
async function setup(call) {
  globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
  sessionStorage.setItem('draft-owner', 'test-page');
  globalThis.window = { dispatchEvent() {} }; globalThis.taskOperationApi = call;
  const source = readFileSync(new URL('../src/taskOperations.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText.replace('import { api } from "./api";', 'const api = globalThis.taskOperationApi;');
  return import('data:text/javascript;base64,' + Buffer.from(compiled + '\n//' + crypto.randomUUID()).toString('base64'));
}
const receipt = (body, extra = {}) => ({ operationId: body.operationId, kind: body.kind, outcome: 'processing', jobIds: ['job-one'], createdObjectIds: [], steps: {}, result: {}, ...extra });

test('查找原回执期间换工作区，旧操作保留原归属且不继续发送到新库',async()=>{
  let saved,release,sent=0;
  const {submitOperation}=await setup(async(path,body)=>{
    if(body){sent++;saved=receipt(body,{outcome:'needsInput',jobIds:[]});return saved;}
    await new Promise(resolve=>release=resolve);return saved;
  });
  sessionStorage.setItem('workbench-workspace','/A');
  const payload={kind:'generateSelection',chapterId:'same',revision:1};await submitOperation('same',payload);
  const pending=submitOperation('same',{...payload,revision:2});await Promise.resolve();sessionStorage.setItem('workbench-workspace','/B');release();
  await assert.rejects(pending,/工作区已变化/);assert.equal(sent,1);
  assert.ok(localStorage.getItem('workbench-operation/%2FA/test-page/same'));assert.equal(localStorage.getItem('workbench-operation/%2FB/test-page/same'),null);
});

test('lost operation response queries the exact committed operation without sending again', async () => {
  const calls = []; let written;
  const { submitOperation } = await setup(async (path, body) => {
    calls.push([path, body]);
    if (body) { written = receipt(body); throw new TypeError('lost response'); }
    assert.equal(path, '/operations/' + written.operationId); return written;
  });
  const result = await submitOperation('dialogue', { kind: 'groupAndGenerate', chapterId: 'chapter' });
  assert.equal(result.operationId, written.operationId); assert.equal(calls.length, 2);
  assert.equal(calls.filter(([, body]) => body).length, 1);
});

test('HTTP500需要核对原操作时查同ID已创建任务，不重复供应商入口',async()=>{
  let written,sent=0,reads=0;const {submitOperation}=await setup(async(path,body)=>{if(body){sent++;written=receipt(body);throw Object.assign(new Error('服务中断'),{status:500,retryClass:'check-existing-operation'});}reads++;assert.equal(path,'/operations/'+written.operationId);return written;});
  const result=await submitOperation('generate',{kind:'generateSelection',chapterId:'chapter'});assert.equal(result.operationId,written.operationId);assert.equal(sent,1);assert.equal(reads,1);
});

test('unresolved response and reload reuse the durable operation ID; no automatic paid retry', async () => {
  const sent = [];
  const { submitOperation } = await setup(async (path, body) => {
    if (body) { sent.push(body.operationId); throw new TypeError('offline'); }
    throw Object.assign(new Error('not found'), { status: 404 });
  });
  const payload = { kind: 'voiceCandidate', sessionId: 'voice', grantId: 'grant' };
  await assert.rejects(submitOperation('voice', payload), /offline/); assert.equal(sent.length, 1);
  await assert.rejects(submitOperation('voice', payload), /offline/); assert.equal(sent[0], sent[1]);
  await assert.rejects(submitOperation('voice', { ...payload, grantId: 'new-grant' }), /回执尚未确认/); assert.equal(sent.length, 2);
});

test('restored successful candidate receipt allows the next explicit candidate without resending the old request', async () => {
  const sent=[];let saved,unavailable=true;
  const {submitOperation}=await setup(async(path,body)=>{
    if(body){sent.push(body);saved=receipt(body);if(unavailable)throw Object.assign(new Error('missing receipt'),{status:404});return saved;}
    assert.equal(path,'/operations/'+saved.operationId);
    if(unavailable)throw Object.assign(new Error('missing receipt'),{status:404});
    return {...saved,outcome:'completed'};
  });
  const payload={kind:'voiceCandidate',sessionId:'voice',entityRevision:1,grantId:'grant'};
  await assert.rejects(submitOperation('voice',payload),/missing receipt/);
  await assert.rejects(submitOperation('voice',{...payload,entityRevision:2}),/回执尚未确认/);assert.equal(sent.length,1);
  unavailable=false;
  const next=await submitOperation('voice',{...payload,entityRevision:2},[{id:'job-one',status:'success'}]);
  assert.equal(sent.length,2);assert.notEqual(next.operationId,sent[0].operationId);assert.equal(sent[1].entityRevision,2);
});

test('finished text analysis may be explicitly submitted again, while running and unknown analysis cannot repeat', async () => {
  const ids = []; let status = 'running';
  const { submitOperation } = await setup(async (path, body) => {
    if (body) { ids.push(body.operationId); return receipt(body, { jobIds: [], result: { analysis: { status } } }); }
    return receipt({ operationId: path.split('/').at(-1), kind: 'prepareChapter' }, { jobIds: [], result: { analysis: { status } } });
  });
  const payload = { kind: 'prepareChapter', chapterId: 'chapter', revision: 1 };
  await submitOperation('analysis', payload); await submitOperation('analysis', payload); assert.equal(new Set(ids).size, 1);
  status = 'ready'; await submitOperation('analysis', payload); assert.equal(new Set(ids).size, 2);
  status = 'unknown'; await assert.rejects(submitOperation('analysis', payload), /结果不明/); assert.equal(ids.length, 3);
});

test('changing a pending request does not bypass its committed operation or duplicate a prepared group', async () => {
  let written, calls = 0;
  const { submitOperation } = await setup(async (path, body) => {
    if (body) { calls++; written = receipt(body); return written; }
    return written;
  });
  const payload = { kind: 'groupAndGenerate', chapterId: 'chapter', grantId: 'one' };
  await submitOperation('group', payload);
  await assert.rejects(submitOperation('group', { ...payload, grantId: 'two' }), /仍在处理中/); assert.equal(calls, 1);
  written = { ...written, outcome: 'prepared', jobIds: [], createdObjectIds: ['saved-group'], result: { unit: { id: 'saved-group' } }, error: 'quota' };
  const recovered = await submitOperation('group', { ...payload, grantId: 'two' }); assert.equal(recovered.result.unit.id, 'saved-group'); assert.equal(calls, 1);
});

test('prepared group survives retries; a new generation requires a known terminal task', async () => {
  const ids = []; let outcome = 'prepared';
  const { submitOperation } = await setup(async (path, body) => {
    ids.push(body.operationId); return receipt(body, { outcome, jobIds: outcome === 'prepared' ? [] : ['job-one'], result: { unit: { id: 'saved-group' } } });
  });
  const payload = { kind: 'groupAndGenerate', chapterId: 'chapter', ids: ['one', 'two'] };
  const first = await submitOperation('group', payload); const second = await submitOperation('group', payload);
  assert.equal(first.operationId, second.operationId); assert.equal(second.result.unit.id, 'saved-group');
  outcome = 'processing'; await submitOperation('group', payload);
  await submitOperation('group', payload, [{ id: 'job-one', status: 'queued' }]); assert.equal(new Set(ids).size, 1);
  await submitOperation('group', payload, [{ id: 'job-one', status: 'success' }]); assert.notEqual(ids.at(-1), ids[0]);
});

test('HTTP-success needsInput stays explicit, and failed durable storage sends zero requests', async () => {
  let calls = 0;
  const { submitOperation } = await setup(async (path, body) => { calls++; return receipt(body, { outcome: 'needsInput', jobIds: [], error: 'grant revoked', errorStatus: 403 }); });
  const result = await submitOperation('scene', { kind: 'sceneAndGenerate' });
  assert.equal(result.outcome, 'needsInput'); assert.equal(result.error, 'grant revoked');
  localStorage.setItem = () => { throw new Error('quota'); };
  await assert.rejects(submitOperation('new', { kind: 'sceneAndGenerate' }), /浏览器.*存储.*空间/); assert.equal(calls, 1);
});

test('an unknown paid result requires explicit retry; ordinary retries cannot force route recovery', async () => {
  const sent = [], known = new Map();
  const { submitOperation } = await setup(async (path, body) => {
    if (body) { sent.push(body); const result = receipt(body, { outcome: body.retryUnknown ? 'processing' : 'unknown' }); known.set(body.operationId, result); return result; }
    return known.get(path.split('/').at(-1));
  });
  const payload = { kind: 'generateSelection', chapterId: 'chapter', ids: ['one'] };
  await submitOperation('generation', payload);
  await assert.rejects(submitOperation('generation', payload, [{ id: 'job-one', status: 'unknown' }]), /结果不明/);
  await submitOperation('generation', { ...payload, retryUnknown: true });
  assert.equal(sent.length, 2); assert.notEqual(sent[0].operationId, sent[1].operationId);
  assert.equal(sent[0].retryUnknown, undefined); assert.equal(sent[1].retryUnknown, true);
  assert.equal(sent[0].resumeRoute, undefined); assert.equal(sent[1].resumeRoute, undefined);
});

test('partial text analysis with one unknown batch cannot be renewed by ordinary prepare', async () => {
  let sent = 0, saved;
  const { submitOperation } = await setup(async (path, body) => {
    if (body) { sent++; saved = receipt(body, { outcome: 'needsInput', jobIds: [], result: { analysis: { status: 'partial', batches: [{ status: 'received' }, { status: 'unknown' }] } } }); }
    return saved;
  });
  const payload = { kind: 'prepareChapter', chapterId: 'chapter', revision: 1 };
  await submitOperation('text', payload);
  await assert.rejects(submitOperation('text', payload), /结果不明/);
  await assert.rejects(submitOperation('text', { ...payload, grantId: 'new' }), /结果不明/); assert.equal(sent, 1);
});

test('rechecked generation keeps the same key, confirms its failed 409 receipt, then uses a new operation ID only on explicit start', async () => {
  const calls=[];let saved;
  const {submitOperation}=await setup(async(path,body)=>{
    calls.push({path,body});
    if(path==='/operations/plan')return {chapterId:'chapter',revision:1,arrangement:2,audioRequests:1};
    if(!body)return saved;
    saved=receipt(body,calls.filter(call=>call.path==='/operations'&&call.body).length===1?{outcome:'needsInput',jobIds:[],error:'编排已变化',errorStatus:409}:{});return saved;
  });
  const payload={kind:'generateSelection',chapterId:'chapter',revision:1,arrangement:1,ids:['one'],grantId:'grant'};
  const failed=await submitOperation('generate:chapter',payload);assert.equal(failed.errorStatus,409);assert.equal(failed.jobIds.length,0);
  const plan=await globalThis.taskOperationApi('/operations/plan',{kind:'generateSelection',chapterId:'chapter',revision:1,ids:['one']});
  assert.equal(calls.filter(call=>call.path==='/operations').length,1);
  const renewed=await submitOperation('generate:chapter',{...payload,arrangement:plan.arrangement});
  assert.notEqual(renewed.operationId,failed.operationId);assert.deepEqual(calls.map(call=>call.path),['/operations','/operations/plan','/operations/'+failed.operationId,'/operations']);
  assert.equal(calls[2].body,undefined);assert.equal(calls[3].body.arrangement,2);
});

async function setupFetch(t,fetchImpl){
  t.mock.method(globalThis,'fetch',fetchImpl);
  const source=readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const {api}=await import('data:text/javascript;base64,'+Buffer.from(compiled+'\n//'+crypto.randomUUID()).toString('base64'));
  return {...await setup(api),api};
}
const conflictResponse=()=>Response.json({error:'夹具仅章修订变化，本次尚未入队',code:'conflict',retryClass:'refresh'},{status:409});
const absentResponse=()=>Response.json({error:'原操作不存在'},{status:404});
const operationRecord=key=>'workbench-operation//test-page/'+key;

test('actual API: known HTTP409 plus same-operation 404 clears only the unsent guard before a corrected revision',async t=>{
  const calls=[],ids=[];let enqueued=0;
  const {submitOperation}=await setupFetch(t,async(path,options)=>{
    const body=options?JSON.parse(options.body):undefined;calls.push({path,body});
    if(!body)return absentResponse();ids.push(body.operationId);
    if(ids.length===1)return conflictResponse();enqueued++;return Response.json(receipt(body));
  });
  const payload={kind:'generateSelection',chapterId:'chapter',revision:1,ids:['one']};
  await assert.rejects(submitOperation('generation',payload),error=>error.status===409&&error.retryClass==='refresh');assert.equal(localStorage.getItem(operationRecord('generation')),null);
  await submitOperation('generation',{...payload,revision:2});assert.equal(enqueued,1);assert.equal(ids.length,2);assert.notEqual(ids[0],ids[1]);assert.equal(calls[1].path,'/api/operations/'+ids[0]);
});

test('actual App replan with actual submitOperation/API: before-run HTTP409 leads to one corrected task, not a second user start',async t=>{
  let revision=1,enqueued=0;const posts=[],reads=[];
  const chapter=()=>({id:'chapter',projectId:'project',revision,arrangement:1,segments:[{id:'one',order:0,text:'自拟台词'}],units:[],events:[]});
  const plan=()=>({chapterId:'chapter',revision,arrangement:1,model:'fixture-audio',memberIds:['one'],unitIds:['one'],units:[{unitId:'one',members:['one'],mode:'dry',reuse:false,audioId:null,model:'fixture-audio',referenceVoices:[{voiceId:'voice',revision:1,fileVersion:'reference-v1'}]}],audioRequests:1,textRequests:0});
  const client=await setupFetch(t,async(path,options)=>{
    const body=options?JSON.parse(options.body):undefined;
    if(path==='/api/operations/plan')return Response.json(plan());
    if(path.startsWith('/api/chapters/'))return Response.json(chapter());
    if(!body){reads.push(path);return absentResponse();}
    posts.push(body);if(posts.length===1){revision=2;return conflictResponse();}
    enqueued++;return Response.json(receipt(body,{steps:{enqueued:'job-one'}}));
  });
  const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let submit;
  const visit=node=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='submitGeneration')submit=node.initializer;ts.forEachChild(node,visit);};visit(file);assert.ok(submit);
  const workspaceSource=readFileSync(new URL('../src/WorkspaceExperience.tsx',import.meta.url),'utf8'),workspaceFile=ts.createSourceFile('WorkspaceExperience.tsx',workspaceSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX),scope=workspaceFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='generationPlanChanges');
  const scopeCode=ts.transpileModule(scope.getText(workspaceFile).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,generationPlanChanges=new Function(scopeCode+';return generationPlanChanges;')();
  const initial=chapter(),request={plan:plan(),ids:['one'],regenerate:true,retryUnknown:false,resumeRoute:false};let current=request;
  const state={jobs:[],voices:[],settings:{routeBlocked:false}};
  const env={api:client.api,submitOperation:client.submitOperation,generationPlan:request,chapter:initial,generationIntent:{current:1},chapterRef:{current:'chapter'},state,stateRef:{current:state},generationPlanChanges,withSavedDrafts:async(_scope,_deps,next)=>next(),hasDraft:()=>false,unitHasDraft:()=>false,draftScopeRevision:(_scope,value)=>value,playIntent:{current:0},pendingPlay:{current:null},pendingPlaySnapshot:{current:null},audio:{current:{pause(){}}},setPlayer(){},setChapter(){},setNotice(){},setGenerationPlan:value=>current=value,refresh:async()=>{}};
  const code=ts.transpileModule('const projected=('+submit.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  env.submitGeneration=(...args)=>new Function(...Object.keys(env),code+';return projected;')(...Object.values(env))(...args);
  await env.submitGeneration(undefined,undefined,request,initial,1);
  assert.equal(enqueued,1);assert.equal(posts.length,2);assert.notEqual(posts[0].operationId,posts[1].operationId);assert.equal(posts[1].revision,2);assert.deepEqual(posts[1].ids,['one']);assert.equal(posts[1].expectedModel,'fixture-audio');assert.equal(current,null);assert.deepEqual(reads,['/api/operations/'+posts[0].operationId]);
});

test('actual API: ambiguous writes, unreadable conflict receipts and failed lookups retain their original guard',async t=>{
  for(const mode of ['lost-write','unreadable-409','conflict-lookup-unavailable']){
    let posts=0;
    const {submitOperation}=await setupFetch(t,async(_path,options)=>{
      if(options){posts++;if(mode==='lost-write')return Response.json({error:'未知写入故障',retryClass:'check-existing-operation'},{status:500});if(mode==='unreadable-409')return new Response('{unreadable',{status:409});return conflictResponse();}
      return mode==='conflict-lookup-unavailable'?Response.json({error:'查询暂时不可用'},{status:503}):absentResponse();
    });
    const payload={kind:'generateSelection',chapterId:'chapter',revision:1,ids:['one']};
    await assert.rejects(submitOperation('guarded',payload),error=>error.retryClass==='check-existing-operation');const original=localStorage.getItem(operationRecord('guarded'));assert.ok(original,mode);
    await assert.rejects(submitOperation('guarded',{...payload,revision:2}),/回执尚未确认/);assert.equal(posts,1,mode);assert.equal(localStorage.getItem(operationRecord('guarded')),original,mode);
  }
});

test('actual API: definitive failed-no-effect receipt may renew, but unknown/jobs/prepared effects never clear the guard',async t=>{
  for(const [kind,extra,safe] of [
    ['generateSelection',{outcome:'needsInput',error:'确定未入队',errorStatus:409,jobIds:[],result:{plan:{}}},true],
    ['generateSelection',{outcome:'unknown'},false],
    ['generateSelection',{outcome:'processing'},false],
    ['groupAndGenerate',{outcome:'prepared',jobIds:[],createdObjectIds:['created-group'],result:{unit:{id:'created-group'}}},false],
    ['generateSelection',{outcome:'needsInput',error:'仍有已创建步骤',errorStatus:409,jobIds:[],steps:{effect:'already-created'}},false],
  ]){
    let submitted,posts=0;
    const {submitOperation}=await setupFetch(t,async(_path,options)=>{if(options){posts++;submitted=JSON.parse(options.body);return conflictResponse();}return Response.json(receipt(submitted,extra));});
    const result=await submitOperation('recover',{kind,chapterId:'chapter',revision:1,ids:['one']});assert.equal(result.outcome,extra.outcome);assert.equal(posts,1);assert.equal(localStorage.getItem(operationRecord('recover'))===null,safe);
    if(!safe){const record=JSON.parse(localStorage.getItem(operationRecord('recover')));assert.equal(record.receipt.operationId,submitted.operationId);assert.equal(record.receipt.outcome,extra.outcome);}
  }
});

test('actual API: conflict lookup cannot clear a newer local guard or a guard from another workspace',async t=>{
  for(const changed of ['workspace','newer-guard']){
    let release,posts=0;
    const {submitOperation}=await setupFetch(t,async(_path,options)=>{if(options){posts++;return conflictResponse();}return new Promise(resolve=>release=()=>resolve(absentResponse()));});
    sessionStorage.setItem('workbench-workspace','/A');
    const key='workbench-operation/%2FA/test-page/same',pending=submitOperation('same',{kind:'generateSelection',chapterId:'chapter',revision:1});
    await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    const original=localStorage.getItem(key);
    if(changed==='workspace')sessionStorage.setItem('workbench-workspace','/B');
    else localStorage.setItem(key,JSON.stringify({operationId:'newer-operation',payload:{kind:'generateSelection',chapterId:'chapter',revision:2}}));
    const kept=localStorage.getItem(key);release();await assert.rejects(pending,error=>error.retryClass==='check-existing-operation');assert.equal(localStorage.getItem(key),kept);assert.equal(posts,1);assert.ok(original);
  }
});

test('actual API: a cached paid job is preserved even if a later conflict lookup returns 404',async t=>{
  let posts=0,submitted;
  const {submitOperation}=await setupFetch(t,async(_path,options)=>{if(!options)return absentResponse();submitted=JSON.parse(options.body);posts++;return posts===1?Response.json(receipt(submitted)):conflictResponse();});
  const payload={kind:'generateSelection',chapterId:'chapter',revision:1};await submitOperation('paid',payload);
  const stored=localStorage.getItem(operationRecord('paid'));await assert.rejects(submitOperation('paid',payload),error=>error.retryClass==='check-existing-operation');
  assert.equal(localStorage.getItem(operationRecord('paid')),stored);assert.deepEqual(JSON.parse(stored).receipt.jobIds,['job-one']);assert.equal(posts,2);
});
