import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, symlinkSync, unlinkSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { exportMaster } from '../server/audio.mjs';
import { copyWorkspace, projectFile, recoverProjectFolders } from '../server/workspace.mjs';

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dubbing-legacy-output-'))), directory = join(root, 'workspace');
  const store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  store.put('settings', { id: 'project-folders', enabled: true });
  const project = domain.mutate('project.create', { name: '旧项目夹具' });
  // a25 stored this folder and marker legally. Seed that persisted state without
  // making ordinary regression tests depend on a Git checkout or old modules.
  renameSync(join(directory, project.folder), join(directory, 'output'));
  project.name = project.folder = 'output'; store.put('projects', project);
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '旧章节', source: '旧项目仍然可以使用。', segment: true });
  const write = (path, bytes = path) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), bytes); return path; };
  const audio = { id: uid(), chapterId: chapter.id, path: write('output/audio/old.wav') }; store.put('audios', audio, chapter.id);
  const exported = { id: uid(), chapterId: chapter.id, format: 'wav', path: write('output/output/old.wav') }; store.put('exports', exported, chapter.id);
  const remove = scope => domain.mutate('project.delete', { id: project.id, scope: scope || domain.deletionPlan({ id: project.id }).scope });
  return { root, directory, store, domain, project, chapter, audio, exported, write, remove };
}

function wav() {
  const bytes = Buffer.alloc(44 + 9600);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(9600, 40); return bytes;
}

test('AE-H02 已有output项目可读写并真实导出到其独立output目录', async t => {
  const f = fixture(t), before = f.domain.chapter(f.chapter.id);
  assert.equal(before.outputDirectory, join(f.directory, 'output/output'));
  f.domain.mutate('chapter.update', { chapterId: f.chapter.id, revision: before.revision, title: '继续编辑' });
  assert.equal(f.domain.chapter(f.chapter.id).title, '继续编辑');
  const bytes = wav(), path = f.write(projectFile(f.store, f.chapter.id, 'masters', 'master.wav'), bytes);
  const exported = await exportMaster(f.store, { path, chapterId: f.chapter.id, arrangement: 1 }, uid(), 'wav');
  assert.equal(dirname(exported), 'output/output'); assert.deepEqual(readFileSync(join(f.directory, exported)), bytes);
  assert.equal(readFileSync(join(f.directory, 'output/.project-id'), 'utf8'), f.project.id);
});

test('AE-H02 旧output项目迁移和改名保留原工作区及导出，恢复按项目标记识别', async t => {
  const f = fixture(t), target = await copyWorkspace(f.store, join(f.root, 'moved')), next = openStore(target), domain = createDomain(next);
  try {
    assert.equal(next.get('projects', f.project.id).folder, 'output');
    assert.equal(readFileSync(join(target, f.audio.path), 'utf8'), f.audio.path);
    assert.equal(readFileSync(join(target, f.exported.path), 'utf8'), f.exported.path);
    assert.equal(readFileSync(join(f.directory, f.audio.path), 'utf8'), f.audio.path);
    domain.mutate('project.rename', { id: f.project.id, entityRevision: 1, name: '正常项目名' });
    assert.equal(next.get('exports', f.exported.id).path, '正常项目名/output/old.wav');
    assert.equal(domain.chapter(f.chapter.id).outputDirectory, join(target, '正常项目名/output'));
    renameSync(join(target, '正常项目名'), join(target, '中断改名'));
    recoverProjectFolders(next);
    assert.equal(readFileSync(join(target, '正常项目名/.project-id'), 'utf8'), f.project.id);
  } finally { next.close(); }
  assert.equal(f.store.get('projects', f.project.id).folder, 'output');
});

test('AE-H02 旧output可明确删除；预览取消和确认后的范围变化不会删除', t => {
  const f = fixture(t), before = f.store.get('projects', f.project.id), scope = f.domain.deletionPlan({ id: f.project.id }).scope;
  assert.deepEqual(f.store.get('projects', f.project.id), before); assert.ok(existsSync(join(f.directory, f.audio.path)));
  const added = { id: uid(), chapterId: f.chapter.id, path: f.write('output/output/later.wav') }; f.store.put('exports', added, f.chapter.id);
  assert.throws(() => f.remove(scope), { status: 409 }); assert.ok(existsSync(join(f.directory, added.path)));
  assert.equal(f.remove().deleted, true); assert.equal(existsSync(join(f.directory, 'output')), false);
  assert.equal(f.store.maybe('projects', f.project.id), null);
});

test('AE-H02 新建及改名仍拒绝系统保留名和非法路径；同名目的目录不覆盖', t => {
  const f = fixture(t);
  for (const name of ['output', 'OUTPUT', 'audio', 'voices', 'masters', 'exports', 'workbench.sqlite', 'runtime.json', '../outside', 'x/y', 'x\\y']) {
    assert.throws(() => f.domain.mutate('project.create', { name }), /名称/);
    if (name !== 'output') assert.throws(() => f.domain.mutate('project.rename', { id: f.project.id, entityRevision: 1, name }), /名称/);
  }
  const other = f.domain.mutate('project.create', { name: '已有项目' });
  assert.throws(() => f.domain.mutate('project.rename', { id: f.project.id, entityRevision: 1, name: other.name }), /同名/);
  assert.throws(() => f.domain.mutate('project.rename', { id: other.id, entityRevision: 1, name: 'output' }), /名称/);
  assert.equal(readFileSync(join(f.directory, other.folder, '.project-id'), 'utf8'), other.id);
  assert.ok(existsSync(join(f.directory, f.audio.path)));
});

test('AE-H02 旧保留名仍需真实目录、匹配的非软链归属标记及安全路径', async t => {
  for (const mode of ['missing-marker', 'wrong-marker', 'marker-link', 'folder-link', 'folder-file', 'nested-folder', 'outside-folder', 'audio-link']) await t.test(mode, t => {
    const f = fixture(t), folder = join(f.directory, 'output'), marker = join(folder, '.project-id');
    if (mode === 'missing-marker') unlinkSync(marker);
    if (mode === 'wrong-marker') writeFileSync(marker, 'another-project');
    if (mode === 'marker-link') { const outside = join(f.root, 'marker'); writeFileSync(outside, f.project.id); unlinkSync(marker); symlinkSync(outside, marker); }
    if (mode === 'folder-link') { const outside = join(f.root, 'output'); renameSync(folder, outside); symlinkSync(outside, folder); }
    if (mode === 'folder-file') { rmSync(folder, { recursive: true }); writeFileSync(folder, 'not a project directory'); }
    if (mode === 'nested-folder' || mode === 'outside-folder') { f.project.folder = mode === 'nested-folder' ? 'output/audio' : '../output'; f.store.put('projects', f.project); }
    if (mode === 'audio-link') { const source = join(f.root, 'shared.wav'); writeFileSync(source, 'shared'); unlinkSync(join(f.directory, f.audio.path)); symlinkSync(source, join(f.directory, f.audio.path)); }
    const before = f.store.get('projects', f.project.id);
    assert.throws(() => f.remove()); assert.deepEqual(f.store.get('projects', f.project.id), before);
  });
});

test('AE-H02 公共output素材及其软链引用不能因历史同名项目一起删除', async t => {
  for (const alias of [false, true]) await t.test(alias ? 'alias' : 'direct', t => {
    const f = fixture(t), other = f.domain.mutate('project.create', { name: '保留项目' });
    const chapter = f.domain.mutate('chapter.create', { projectId: other.id, title: '另章', source: '请保留。', segment: true });
    const shared = f.write('output/shared.wav', 'public output bytes');
    let path = shared;
    if (alias) { path = 'exports/shared-alias.wav'; mkdirSync(join(f.directory, 'exports')); symlinkSync(join(f.directory, shared), join(f.directory, path)); }
    f.store.put('exports', { id: uid(), path }, chapter.id);
    assert.throws(() => f.remove(), /共用素材/);
    assert.equal(readFileSync(join(f.directory, shared), 'utf8'), 'public output bytes'); assert.ok(f.store.maybe('projects', other.id));
  });
});

test('AE-H02 无项目归属的根output不是整目录删除目标，平铺项目只删除自己的登记文件', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dubbing-public-output-'))), store = openStore(root), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const project = domain.mutate('project.create', { name: '平铺项目' }), chapter = domain.mutate('chapter.create', { projectId: project.id, title: '章', source: '只删这一份。', segment: true });
  mkdirSync(join(root, 'output')); writeFileSync(join(root, 'output/owned.wav'), 'own'); writeFileSync(join(root, 'output/unrelated.wav'), 'keep');
  store.put('exports', { id: uid(), path: 'output/owned.wav' }, chapter.id);
  domain.mutate('project.delete', { id: project.id, scope: domain.deletionPlan({ id: project.id }).scope });
  assert.equal(existsSync(join(root, 'output/owned.wav')), false); assert.equal(readFileSync(join(root, 'output/unrelated.wav'), 'utf8'), 'keep');
});

test('AE-H02 旧output迁移遇软链拒绝、删除数据库失败时原目录与数据回滚', async t => {
  const f = fixture(t), outside = join(f.root, 'outside.wav'), link = join(f.directory, 'output/audio/linked.wav');
  writeFileSync(outside, 'external bytes'); symlinkSync(outside, link);
  await assert.rejects(copyWorkspace(f.store, join(f.root, 'rejected')), /符号链接/);
  assert.equal(existsSync(join(f.root, 'rejected')), false); unlinkSync(link);
  f.store.db.exec("CREATE TRIGGER deny_legacy_delete BEFORE DELETE ON projects BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END");
  assert.throws(() => f.remove(), /fixture rollback/);
  assert.ok(f.store.maybe('projects', f.project.id)); assert.equal(readFileSync(join(f.directory, f.audio.path), 'utf8'), f.audio.path);
  assert.equal(readFileSync(join(f.directory, 'output/.project-id'), 'utf8'), f.project.id);
});
