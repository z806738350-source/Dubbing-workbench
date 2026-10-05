import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { startServer } from '../server/index.mjs';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { ffmpeg, runMediaProcess } from '../server/audio.mjs';
import { createAttachments } from '../server/assistant/attachments.mjs';
import { copyWorkspace, workspaceDiagnostics } from '../server/workspace.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'assistant-lifecycle-'))), directory = join(root, 'workspace');
  const store = openStore(directory), domain = createDomain(store); store.put('settings', { id: 'project-folders', enabled: true });
  const project = domain.mutate('project.create', { name: '附件项目' }), sessionId = uid();
  store.put('assistantSessions', { id: sessionId, projectId: project.id, state: 'active', revision: 1 }, project.id);
  const attachments = createAttachments(store), file = join(root, 'fixture.png');
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=40x40', '-frames:v', '1', file]);
  t.after(async () => { await attachments.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, directory, store, domain, project, sessionId, attachments, input: { sessionId, mime: 'image/png', dataBase64: readFileSync(file).toString('base64') } };
}

test('assistant source+derived images survive project rename, backup and workspace migration', async t => {
  const f = fixture(t), a = await f.attachments.create(f.input);
  const original = await f.attachments.read(a.id, f.sessionId);
  f.domain.mutate('project.rename', { id: f.project.id, name: '新项目名', entityRevision: f.project.revision ?? 1 });
  const record = f.store.get('assistantAttachments', a.id);
  assert.ok(record.path.startsWith('新项目名/assistant/attachments/'));
  assert.ok(record.sourcePath.startsWith('新项目名/assistant/attachments/'));
  assert.deepEqual((await f.attachments.read(a.id, f.sessionId)).data, original.data);
  const inventory = workspaceDiagnostics(f.store); assert.equal(inventory.counts.assistantAttachments, 1); assert.equal(inventory.primaryAvailable, true);
  const backup = join(f.root, 'backup'), result = spawnSync(process.execPath, [resolve('scripts/backup.mjs'), 'create', f.directory, backup], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(readFileSync(join(backup, record.path)), original.data);
  const target = await copyWorkspace(f.store, join(f.root, 'moved')), copy = openStore(target);
  try { assert.equal(copy.get('assistantAttachments', a.id).sourcePath, record.sourcePath); assert.deepEqual(readFileSync(join(target, record.path)), original.data); }
  finally { copy.close(); }
});

test('project deletion includes assistant reference scope; late upload invalidates preview and shared session survives', async t => {
  const f = fixture(t), a = await f.attachments.create(f.input), first = f.domain.deletionPlan({ id: f.project.id });
  await f.attachments.create(f.input);
  assert.throws(() => f.domain.mutate('project.delete', { id: f.project.id, scope: first.scope }), /范围已变化/);
  const sharedId = uid(); f.store.put('assistantSessions', { id: sharedId, projectId: null, state: 'active', revision: 1 });
  const global = await f.attachments.create({ ...f.input, sessionId: sharedId });
  const record = f.store.get('assistantAttachments', a.id);
  f.store.put('settings', { id: 'assistant-call:owned', projectId: f.project.id, sessionId: f.sessionId });
  f.store.put('settings', { id: 'assistant-call:shared', projectId: null, sessionId: sharedId });
  f.domain.mutate('project.delete', { id: f.project.id, scope: f.domain.deletionPlan({ id: f.project.id }).scope });
  assert.equal(existsSync(join(f.directory, record.path)), false); assert.equal(f.store.maybe('assistantSessions', f.sessionId), null);
  assert.ok(await f.attachments.read(global.id, sharedId));
  assert.equal(f.store.maybe('settings', 'assistant-call:owned'), null);
  assert.ok(f.store.get('settings', 'assistant-call:shared'));
});

test('HTTP uses independent settings, rejects unauthorised send, archives selected chat read-only and explicitly deletes only confirmed content', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-http-')), app = await startServer({ port: 0, directory: join(root, 'data'), config: { key: '', baseUrl: 'https://test.example/v1', model: 'seed-audio-1.0' }, assistantFetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"当前还没有音频，请先准备章节。","questions":["接下来要准备哪章？"]}' } }] })) });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const request = async (path, data, method = data ? 'POST' : 'GET') => { const r = await fetch(base + path, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) }); return { status: r.status, data: await r.json() }; };
  let settings = (await request('/assistant/config')).data; assert.equal(settings.model, 'claude-sonnet-5-5');
  assert.equal((await request('/assistant/config', { revision: 0, model: 'independent-vision', baseUrl: 'https://test.example/v1', enabled: true, credentialSource: 'audio', vision: false }, 'PUT')).status, 200);
  assert.equal((await request('/state')).data.settings.model, 'seed-audio-1.0');
  const project = app.domain.mutate('project.create', { name: 'HTTP助手' });
  const s1 = (await request('/assistant/sessions', { projectId: project.id })).data.session;
  const s2 = (await request('/assistant/sessions', { projectId: project.id })).data.session;
  assert.equal((await request(`/assistant/sessions/${s1.id}/messages`, { messageId: uid(), text: '你好' })).status, 403);
  assert.equal((await request(`/assistant/sessions/${s1.id}/messages`, { messageId: uid(), text: '你好', approved: true })).status, 200);
  for (let n = 0; n < 100 && app.assistant.active; n++) await new Promise(r => setTimeout(r, 5));
  const run = (await request(`/assistant/sessions/${s1.id}`)).data.runs[0];
  const amended = await request(`/assistant/runs/${run.id}/control`, { action: 'amend', revision: run.revision, decisionId: uid(), limits: { assistant: 4, analysis: 0, audio: 0 } });
  assert.equal(amended.status, 200, JSON.stringify(amended.data));
  assert.equal(amended.data.runs[0].budget.limits.assistant, 4, '异步调整返回实际记录而非空Promise');
  const stale = await request(`/assistant/runs/${run.id}/control`, { action: 'amend', revision: run.revision, decisionId: uid() });
  assert.equal(stale.status, 409, '异步拒绝仍按HTTP冲突返回');
  assert.equal((await request(`/assistant/sessions/${s1.id}`, null, 'DELETE')).status, 200);
  assert.equal((await request(`/assistant/sessions/${s2.id}`)).data.session.state, 'active');
  const archived=(await request(`/assistant/sessions/${s1.id}`)).data;
  assert.equal(archived.messages.length, 2);
  assert.equal((await request(`/assistant/sessions/${s1.id}/messages`, { messageId: uid(), text: '已归档不再发送', approved: true })).status,409);
  assert.equal((await request(`/assistant/sessions/${s1.id}/content-delete`, {sessionId:s2.id,revision:archived.session.revision,confirmed:true})).status,403);
  const deleted=await request(`/assistant/sessions/${s1.id}/content-delete`, {sessionId:s1.id,revision:archived.session.revision,confirmed:true});
  assert.equal(deleted.status,200,JSON.stringify(deleted.data));assert.deepEqual(deleted.data,{sessionId:s1.id,deleted:true});
  assert.equal((await request(`/assistant/sessions/${s1.id}`)).status,404);
  assert.deepEqual(app.store.all('assistantMessages',s1.id),[]);
  assert.equal((await request(`/assistant/sessions/${s2.id}`)).data.session.state,'active');
  assert.deepEqual((await request('/assistant/sessions')).data.map(s=>s.id),[s2.id]);
});

test('在途截图阻止本项目删除和重命名，保存完成后可按新范围删除', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-upload-delete-'));
  const app = await startServer({ port: 0, directory: join(root, 'data'), config: { key: '' } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const p = app.domain.mutate('project.create', { name: '上传中项目' });
  const s = app.assistant.create({ projectId: p.id }).session;
  const file = join(root, 'fixture.png');
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=40x40', '-frames:v', '1', file]);
  const held = runMediaProcess(process.execPath, ['-e', 'setTimeout(()=>{},500)']);
  const uploading = app.assistant.attachments.create({ sessionId: s.id, mime: 'image/png', dataBase64: readFileSync(file).toString('base64') });
  const post = async payload => { const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/action`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); return { status: r.status, data: await r.json() }; };
  assert.equal(app.assistant.attachments.busy(p.id), true);
  assert.equal((await post({ action: 'project.rename', id: p.id, name: '不应改名', entityRevision: 1 })).status, 409);
  assert.equal((await post({ action: 'project.delete', id: p.id, scope: app.domain.deletionPlan({ id: p.id }).scope })).status, 409);
  await held; const attachment = await uploading;
  assert.ok(app.store.get('assistantAttachments', attachment.id));
  assert.equal(app.assistant.attachments.busy(p.id), false);
  const removed = await post({ action: 'project.delete', id: p.id, scope: app.domain.deletionPlan({ id: p.id }).scope });
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(app.store.all('assistantAttachments').length, 0);
});

test('HTTP sends approved screenshots directly to the selected multimodal model; removed verification never sends and unknown image calls never retry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'assistant-direct-image-')), calls = []; let failNext = false;
  const app = await startServer({ port: 0, directory: join(root, 'data'), config: { key: '', baseUrl: 'https://test.example/v1' }, assistantFetchImpl: async (_url, options) => {
    calls.push(JSON.parse(options.body));
    return failNext ? new Response('private upstream error', { status: 502 }) : new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"请点击截图中的播放按钮。"}' } }] }));
  } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`, request = async (path, data, method = data ? 'POST' : 'GET') => {
    const r = await fetch(base + path, { method, ...(data ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  const wait = async () => { for (let i = 0; i < 300 && app.assistant.active; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(app.assistant.active, 0); };
  const connection = { model: 'user-chosen-multimodal', baseUrl: 'https://test.example/v1', enabled: true, credentialSource: 'audio', vision: true };
  const saved = await request('/assistant/config', { ...connection, revision: 0 }, 'PUT'); assert.equal(saved.status, 200);
  for (const key of ['verification', 'visionVerified', 'verifiedAt']) assert.equal(key in saved.data, false);
  for (const method of ['POST', 'GET']) assert.equal((await request('/assistant/verify', method === 'POST' ? { approved: true, requestId: uid() } : null, method)).status, 404);
  assert.equal(calls.length, 0);
  const session = (await request('/assistant/sessions', {})).data.session, other = (await request('/assistant/sessions', {})).data.session;
  const file = join(root, 'screenshot.png');
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=40x40', '-frames:v', '1', file]);
  const uploaded = await request('/assistant/attachments', { sessionId: session.id, mime: 'image/png', dataBase64: readFileSync(file).toString('base64') }); assert.equal(uploaded.status, 200);
  const attachment = uploaded.data, path = `/assistant/sessions/${session.id}/messages`, message = { messageId: uid(), text: '截图中的按钮怎样使用？', attachmentIds: [attachment.id], materials: ['text', 'image'], approved: true };
  assert.equal((await request(path, { ...message, approved: false })).status, 403);
  assert.equal((await request(path, { ...message, materials: ['text'] })).status, 403);
  assert.equal((await request(`/assistant/sessions/${other.id}/messages`, message)).status, 403);
  assert.equal((await request(`/assistant/attachments/${attachment.id}?sessionId=${other.id}`)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await request(path, message)).status, 200); await wait(); assert.equal(calls.length, 1);
  const preview = await fetch(base + `/assistant/attachments/${attachment.id}?sessionId=${session.id}`); assert.equal(preview.status, 200);
  const parts = calls[0].messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(p => p.type === 'image_url'); assert.equal(parts.length, 1);
  assert.deepEqual(Buffer.from(parts[0].image_url.url.split(',')[1], 'base64'), Buffer.from(await preview.arrayBuffer()));
  assert.equal(calls[0].model, connection.model);
  let detail = (await request(`/assistant/sessions/${session.id}`)).data;
  assert.equal(detail.runs[0].state, 'completed'); assert.equal(detail.runs[0].budget.used.assistant, 1);
  assert.equal(app.store.all('settings').filter(s => s.id.startsWith('assistant-vision:')).length, 0);
  assert.equal((await request(path, message)).status, 200); assert.equal(calls.length, 1, 'replaying a completed image message is free');
  failNext = true; const unknown = { ...message, messageId: uid() };
  assert.equal((await request(path, unknown)).status, 200); await wait(); assert.equal(calls.length, 2);
  detail = (await request(`/assistant/sessions/${session.id}`)).data;
  const run = detail.runs.find(r => r.state === 'needsReconciliation'); assert.ok(run); assert.equal(run.budget.used.assistant, 1); assert.ok(!run.error.includes('private upstream'));
  assert.equal((await request(path, unknown)).status, 200);
  assert.equal((await request(path, { ...unknown, messageId: uid() })).status, 409);
  assert.equal(calls.length, 2, 'unknown image request is never silently resent');
});
