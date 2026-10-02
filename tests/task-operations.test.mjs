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
  await assert.rejects(submitOperation('new', { kind: 'sceneAndGenerate' }), /quota/); assert.equal(calls, 1);
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
