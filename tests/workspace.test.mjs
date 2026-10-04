import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { recoverProjectFolders, workspaceDirectory, projectFile } from '../server/workspace.mjs';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';

test('项目位置迁移保留资料、按名称分目录、失败回滚及重启读取', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dubbing-move-'))), source = join(root, 'original'), target = join(root, '新项目总目录'), configFile = join(root, 'location.json');
  const app = await startServer({ port: 0, directory: source, workspaceConfig: configFile, config: { key: '', model: 'seed-audio-1.0' } });
  let closed = false;
  t.after(async () => { if (!closed) await app.close(); rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}/api`;
  const post = async (path, p) => { const r = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) }); return { status: r.status, data: await r.json() }; };
  const p = app.domain.mutate('project.create', { name: '项目甲' });
  const c = app.domain.mutate('chapter.create', { projectId: p.id, title: '正文', source: '这是迁移测试正文。', segment: true });
  mkdirSync(join(source, 'audio'));
  const bytes = Buffer.from('preserved local audio bytes');
  writeFileSync(join(source, 'audio', 'old.wav'), bytes);
  app.store.put('audios', { id: 'old', path: 'audio/old.wav', input: { voiceId: null } }, c.id);
  app.store.put('jobs', { id: 'busy', status: 'running', chapterId: c.id }, c.id);
  assert.equal((await post('/workspace/move', { source, directory: target })).status, 409);
  assert.equal(existsSync(target), false);
  app.store.remove('jobs', 'busy');
  assert.equal((await post('/workspace/move', { source, directory: join(source, 'nested') })).status, 400);
  assert.equal((await post('/assistant/sessions', { projectId: p.id })).status, 200, '迁移拒绝后原助手仍可创建会话');
  const occupied = join(root, 'occupied'); mkdirSync(occupied); writeFileSync(join(occupied, 'keep'), 'untouched');
  assert.equal((await post('/workspace/move', { source, directory: occupied })).status, 400);
  assert.equal(readFileSync(join(occupied, 'keep'), 'utf8'), 'untouched');
  app.store.put('audios', { id: 'missing', path: 'audio/missing.wav' }, c.id);
  assert.equal((await post('/workspace/move', { source, directory: target })).status, 400);
  assert.equal(app.store.directory, source); assert.equal(existsSync(target), false);
  assert.equal((await post('/assistant/sessions', { projectId: p.id })).status, 200, '复制失败后原助手仍可使用');
  app.store.remove('audios', 'missing');
  mkdirSync(target); // User-selected existing empty folders are supported.
  const result = await post('/workspace/move', { source, directory: target });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(app.store.directory, target);
  assert.deepEqual(readFileSync(join(target, '项目甲/audio/old.wav')), bytes);
  assert.deepEqual(readFileSync(join(source, 'audio/old.wav')), bytes);
  assert.equal(app.store.get('chapters', c.id).source, '这是迁移测试正文。');
  assert.equal(app.store.get('audios', 'old').path, '项目甲/audio/old.wav');
  assert.equal(JSON.parse(readFileSync(configFile)).directory, target);
  assert.equal((await post('/workspace/move', { source, directory: join(root, 'elsewhere') })).status, 409);
  assert.equal(app.domain.mutate('project.create', { name: '项目乙' }).folder, '项目乙');
  assert.ok(existsSync(join(target, '项目乙')));
  assert.throws(() => app.domain.mutate('project.create', { name: '项目乙' }), /同名/);
  assert.throws(() => app.domain.mutate('project.create', { name: '../outside' }), /名称/);
  // A SQLite failure must undo the filesystem rename as well as database edits.
  app.store.db.exec(`CREATE TRIGGER deny_rename BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'test rollback'); END`);
  assert.throws(() => app.domain.mutate('project.rename', { id: p.id, entityRevision: 1, name: '新名称' }), /test rollback/);
  assert.ok(existsSync(join(target, '项目甲/audio/old.wav'))); assert.equal(existsSync(join(target, '新名称')), false);
  app.store.db.exec('DROP TRIGGER deny_rename');
  app.domain.mutate('project.rename', { id: p.id, entityRevision: 1, name: '新名称' });
  assert.equal(app.store.get('audios', 'old').path, '新名称/audio/old.wav');
  assert.equal(projectFile(app.store, c.id, 'exports', 'x.wav'), '新名称/exports/x.wav');
  assert.deepEqual(readFileSync(join(target, '新名称/audio/old.wav')), bytes);
  // Crash between folder rename and DB commit: recover from the existing project ID.
  renameSync(join(target, '新名称'), join(target, '中断改名'));
  recoverProjectFolders(app.store);
  assert.ok(existsSync(join(target, '新名称/audio/old.wav')));
  assert.equal((await (await fetch(base + '/state')).json()).settings.workspaceDirectory, target);
  await app.close(); closed = true;
  const savedEnv = process.env.DATA_DIR; delete process.env.DATA_DIR;
  try { assert.equal(workspaceDirectory(configFile), target); } finally { if (savedEnv !== undefined) process.env.DATA_DIR = savedEnv; }
});

test('位置配置无法保存时，不切换也不破坏源工作区', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dubbing-move-fail-')), source = join(root, 'source'), target = join(root, 'target');
  const app = await startServer({ port: 0, directory: source, workspaceConfig: join(root, 'missing-parent', 'config.json'), config: { key: '' } });
  t.after(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const p = app.domain.mutate('project.create', { name: '保留项目' });
  const r = await fetch(`http://127.0.0.1:${app.server.address().port}/api/workspace/move`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source, directory: target }) });
  assert.equal(r.status, 500);
  assert.equal(app.store.directory, source); assert.equal(app.store.get('projects', p.id).name, '保留项目');
  assert.equal(existsSync(target), false); assert.ok(existsSync(join(source, 'runtime.json')));
});

test('系统文件夹选择返回目录、取消不修改位置、失败给出可恢复提示', async () => {
  const { chooseWorkspaceDirectory } = await import('../server/workspace.mjs');
  const selected = await chooseWorkspaceDirectory(async (file, args) => {
    assert.equal(file, '/usr/bin/osascript'); assert.match(args[1], /choose folder/);
    return { stdout: '/Users/test/中文 目录/\n' };
  });
  assert.equal(selected, '/Users/test/中文 目录');
  assert.equal(await chooseWorkspaceDirectory(async () => { throw { stderr: 'User canceled. (-128)' }; }), null);
  await assert.rejects(chooseWorkspaceDirectory(async () => { throw { stderr: 'not permitted' }; }), /无法打开/);
});

test('项目目录下增强单条、组和场景入队使用本项目音频路径，声音候选保持全局', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dubbing-enhanced-paths-')), store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.put('settings', { id: 'project-folders', enabled: true });
  const project = domain.mutate('project.create', { name: '增强项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '章节', source: '风很轻。我们走吧。', segment: true });
  const voice = { id: uid(), path: 'reference.wav', state: 'active' };
  writeFileSync(join(directory, voice.path), 'enqueue-only reference fixture'); store.put('voices', voice);
  const rows = domain.list(chapter.id);
  for (const s of rows) domain.mutate('segment.update', { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, id: s.id, voiceId: voice.id, roleConfirmed: true, identityConfirmed: true });
  const group = domain.mutate('unit.create', { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, ids: rows.map(s => s.id) });
  for (const [unitId, mode] of [[rows[0].id, 'dry'], [group.id, 'dry'], [group.id, 'scene']]) {
    const worker = createWorker(store, domain, { key: 'fixture', model: 'seed-audio-1.0', audioUrl: 'https://example.invalid' });
    const job = worker.enqueue({ kind: 'unit-generate', chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, unitId, mode, commandId: uid() });
    const [attempt] = store.all('attempts', job.id);
    assert.equal(attempt.path, `${project.folder}/audio/${attempt.id}.wav`);
    assert.equal(attempt.unitId, unitId); assert.equal(attempt.mode, mode); worker.close();
  }
  const session = domain.mutate('voice-session.create', { description: '清晰温和的成年人声音' });
  const worker = createWorker(store, domain, { key: 'fixture', model: 'seed-audio-1.0', audioUrl: 'https://example.invalid' });
  const job = worker.enqueue({ kind: 'voice-create', sessionId: session.id, entityRevision: session.revision, commandId: uid() });
  const [attempt] = store.all('attempts', job.id);
  assert.equal(job.chapterId, ''); assert.equal(attempt.path, `audio/${attempt.id}.wav`); worker.close();
});
