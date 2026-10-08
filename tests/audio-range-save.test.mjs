import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = source => 'data:text/javascript;base64,' + Buffer.from(source + '\n// ' + crypto.randomUUID()).toString('base64');
const storage = () => { const values = new Map(); return { get length() { return values.size; }, key: i => [...values.keys()][i] ?? null, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key), clear: () => values.clear() }; };
const initial = () => ({ id: 'r1', projectId: 'p1', chapterId: 'c1', unitId: 'u1', mode: 'dry', audioId: 'a1', sourceHash: 'source', decodeProfile: 'pcm-v1', sampleRate: 48000, sourceFrames: 48000, channels: 2, startFrame: 0, endFrame: 48000, edgePolicy: 'short-fade-v1', fadeInFrames: 0, fadeOutFrames: 0, revision: 0, lastOperationId: '', updatedAt: '' });
async function environment(t) {
  const originals = new Map(['localStorage', 'sessionStorage', 'navigator', 'window', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const local = storage(), session = storage(), owner = crypto.randomUUID();
  session.setItem('draft-owner', owner);
  for (const [key, value] of Object.entries({ localStorage: local, sessionStorage: session, navigator: { locks: { request: async (key, options, callback) => callback({}), query: async () => ({ held: [] }) } }, window: { dispatchEvent: () => {} } })) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; });
  const apiUrl = url(compile('../src/api.ts'));
  const draftsUrl = url(compile('../src/drafts.ts'));
  const autosaveUrl = url(compile('../src/autosave.ts').replace('"./api"', JSON.stringify(apiUrl)));
  const drafts = await import(draftsUrl), autosave = await import(autosaveUrl);
  await drafts.initDrafts(); drafts.bindDraftWorkspace('workspace-A');
  const module = await import(url(compile('../src/audioRangeSave.ts').replace('"./api"', JSON.stringify(apiUrl)).replace('"./drafts"', JSON.stringify(draftsUrl)).replace('"./autosave"', JSON.stringify(autosaveUrl))));
  return { ...module, drafts, autosave, local, owner };
}

test('100 completed gestures serialize one inflight request and retain only the latest following range', async t => {
  const env = await environment(t), snapshots = [], saved = [], bodies = [];
  let release, inFlight = 0, maximum = 0;
  const gate = new Promise(resolve => release = resolve);
  const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: next => snapshots.push(next), onSaved: range => saved.push(range), request: async (path, body) => {
    assert.equal(path, '/audio-ranges/update'); bodies.push(body); inFlight++; maximum = Math.max(maximum, inFlight);
    if (bodies.length === 1) await gate;
    inFlight--; return { operationId: body.operationId, range: { ...initial(), ...body, revision: body.expectedRevision + 1 } };
  } });
  controller.edit({ startFrame: 1, endFrame: 47000 });
  const finishing = controller.flush(); await Promise.resolve(); await Promise.resolve();
  for (let i = 2; i <= 100; i++) controller.edit({ startFrame: i, endFrame: 47000 - i });
  release(); await finishing;
  assert.equal(maximum, 1); assert.equal(bodies.length, 2); assert.equal(bodies[1].startFrame, 100); assert.equal(bodies[1].expectedRevision, 1);
  assert.equal(controller.snapshot().range.startFrame, 100); assert.equal(controller.snapshot().status, 'saved'); assert.equal(saved.length, 1);
  assert.ok(snapshots.filter(value => value.savedRange.revision === 1).every(value => value.range.startFrame === 100));
  assert.equal(env.drafts.readDraft(controller.key), null);
});

test('a lost receipt queries the same operation and completes without another POST', async t => {
  const env = await environment(t), calls = []; let written;
  const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request: async (path, body) => {
    calls.push([path, body]);
    if (body) { written = { ...initial(), ...body, revision: 1 }; throw new TypeError('response lost'); }
    return { operationId: written.operationId, status: 'completed', range: written };
  } });
  controller.edit({ startFrame: 123, endFrame: 45678 }); await controller.flush();
  assert.equal(calls.length, 2); assert.equal(calls[1][0], '/audio-ranges/operations/' + calls[0][1].operationId);
  assert.equal(controller.snapshot().status, 'saved'); assert.equal(env.autosave.pendingSaveOperation(controller.key), null);
});

test('CAS keeps both actual ranges until one inline choice, then uses the new server revision', async t => {
  const env = await environment(t), bodies = []; const other = { ...initial(), startFrame: 500, endFrame: 45000, revision: 1 };
  const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request: async (path, body) => {
    bodies.push(body);
    if (bodies.length === 1) throw Object.assign(new Error('another page changed this range'), { status: 409, conflict: true, range: other });
    return { range: { ...other, ...body, revision: body.expectedRevision + 1 } };
  } });
  controller.edit({ startFrame: 100, endFrame: 46000 }); await assert.rejects(controller.flush(), /another page/);
  assert.equal(controller.snapshot().range.startFrame, 100); assert.equal(controller.snapshot().conflict.startFrame, 500);
  await assert.rejects(controller.flush(), /选择/); assert.equal(bodies.length, 1);
  controller.choose('mine'); await controller.flush(); assert.equal(bodies[1].expectedRevision, 1); assert.equal(controller.snapshot().range.revision, 2);
});

test('after reload a hidden current-range draft is recovered before chapter rendering or export', async t => {
  const env = await environment(t), range = initial(), key = env.audioRangeKey(range.unitId, range.mode, range.audioId), bodies = [];
  env.drafts.writeDraft(key, { startFrame: 100, endFrame: 45000, sourceHash: range.sourceHash, decodeProfile: range.decodeProfile }, 0);
  globalThis.fetch = async (path, options) => {
    if (path === '/api/chapters/c1') return Response.json({ playbackItems: [{ id: 'u1', unitId: 'u1', mode: 'dry', audioId: 'a1' }] });
    if (path.startsWith('/api/units/u1/audio-range?')) return Response.json({ range });
    if (path === '/api/audio-ranges/update') { const body = JSON.parse(options.body); bodies.push(body); return Response.json({ range: { ...range, ...body, revision: 1 }, operationId: body.operationId }); }
    assert.fail(path);
  };
  await env.flushAudioRanges('c1'); assert.equal(bodies.length, 1); assert.equal(bodies[0].startFrame, 100); assert.equal(env.drafts.readDraft(key), null);
});

test('other active pages with unsynced current ranges block only their actual chapter target', async t => {
  const env = await environment(t), range = initial(), key = env.audioRangeKey(range.unitId, range.mode, range.audioId), otherOwner = crypto.randomUUID();
  env.local.setItem('draft-workspace/' + encodeURIComponent('workspace-A') + '/' + key + ':' + otherOwner, JSON.stringify({ draft: { startFrame: 100, endFrame: 45000, sourceHash: 'source', decodeProfile: 'pcm-v1' }, revision: 0 }));
  navigator.locks.query = async () => ({ held: [{ name: 'workbench-drafts-' + otherOwner }] });
  let posts = 0;
  globalThis.fetch = async path => {
    if (path.startsWith('/api/chapters/')) return Response.json({ playbackItems: path.endsWith('c1') ? [{ id: 'u1', unitId: 'u1', mode: 'dry', audioId: 'a1' }] : [] });
    if (path.startsWith('/api/units/u1/audio-range?')) return Response.json({ range });
    posts++; assert.fail(path);
  };
  await env.flushAudioRanges('unrelated');
  await assert.rejects(env.flushAudioRanges('c1'), error => error.status === 409 && error.unitId === 'u1'); assert.equal(posts, 0);
});

test('switching workspace retains an unsent later gesture under its original audio and sends nothing new', async t => {
  const env = await environment(t); let release; const gate = new Promise(resolve => release = resolve), bodies = [];
  const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request: async (path, body) => { bodies.push(body); await gate; return { range: { ...initial(), ...body, revision: 1 } }; } });
  controller.edit({ startFrame: 10, endFrame: 47000 }); const writing = controller.flush(); await Promise.resolve(); await Promise.resolve();
  controller.edit({ startFrame: 20, endFrame: 46000 }); env.drafts.bindDraftWorkspace('workspace-B'); release();
  await assert.rejects(writing, /工作区/); assert.equal(bodies.length, 1); assert.equal(env.drafts.readDraft(controller.key, 'workspace-A').draft.startFrame, 20); assert.equal(env.drafts.readDraft(controller.key, 'workspace-B'), null);
  env.autosave.cancelDraftSave(controller.key);
});

test('empty and crossed ranges never enter the queue; frame normalization respects short sources', async t => {
  const env = await environment(t); const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {} });
  for (const bounds of [{ startFrame: NaN, endFrame: 2000 }, { startFrame: -1, endFrame: 2000 }, { startFrame: 2000, endFrame: 2000 }, { startFrame: 3000, endFrame: 2000 }, { startFrame: 0, endFrame: 48001 }]) controller.edit(bounds);
  assert.equal(controller.dirty(), false); assert.deepEqual(env.normalizeRange({ startFrame: 50, endFrame: 100 }, 100), { startFrame: 0, endFrame: 100 });
});

test('remounting an audio while its save is inflight shares the same latest intent and never clears the new gesture', async t => {
  const env = await environment(t), bodies = []; let release; const gate = new Promise(resolve => release = resolve);
  const request = async (path, body) => { bodies.push(body); if (bodies.length === 1) await gate; return { range: { ...initial(), ...body, revision: body.expectedRevision + 1 } }; };
  const old = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request });
  old.edit({ startFrame: 10, endFrame: 47000 }); const finishing = old.flush(); await Promise.resolve(); await Promise.resolve(); old.release();
  const next = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request });
  next.edit({ startFrame: 100, endFrame: 46000 }); release(); await finishing; await next.flush();
  assert.equal(bodies.length, 2); assert.equal(bodies[1].startFrame, 100); assert.equal(next.snapshot().range.startFrame, 100); assert.equal(next.snapshot().status, 'saved'); assert.equal(env.drafts.readDraft(next.key), null);
});

test('StrictMode connect/cleanup/connect does not leak a discarded render subscription or stop updates', async t => {
  const env = await environment(t); let unused = 0, updates = 0;
  env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => unused++, deferSubscribe: true });
  const live = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => updates++, deferSubscribe: true, request: async () => {} });
  live.connect(); live.release(); live.connect();
  live.edit({ startFrame: 10, endFrame: 47000 }); assert.equal(updates, 1); assert.equal(unused, 0);
  env.autosave.cancelDraftSave(live.key);
});

test('a target generation lock is retained as a local draft without manufacturing a cross-page choice', async t => {
  const env = await environment(t); const controller = env.createAudioRangeSave({ range: initial(), workspaceId: 'workspace-A', onChange: () => {}, request: async () => { throw Object.assign(new Error('本段正在重新生成'), { status: 409 }); } });
  controller.edit({ startFrame: 100, endFrame: 45000 }); await assert.rejects(controller.flush(), /重新生成/);
  assert.equal(controller.snapshot().status, 'local'); assert.equal(controller.snapshot().conflict, undefined); assert.equal(env.drafts.readDraft(controller.key).draft.startFrame, 100);
});
