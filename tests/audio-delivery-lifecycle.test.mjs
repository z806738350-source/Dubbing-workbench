import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { sealAudioDelivery, prepareAudioDelivery, verifyAudioDelivery } from '../server/audio-delivery.mjs';
import { analyzeTail, TAIL_PROCESSING_VERSION } from '../server/tail-audio.mjs';
import { copyWorkspace, recordFiles, workspaceDiagnostics } from '../server/workspace.mjs';

function wav() {
  const bytes = Buffer.alloc(44 + 96000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 28800; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 17) * 1000), 44 + i * 2);
  return bytes;
}
const runBackup = (...args) => spawnSync(process.execPath, [resolve('scripts/backup.mjs'), ...args], { encoding: 'utf8' });
const backup = (...args) => { const result = runBackup(...args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
async function fixture(t, { folders = true, processed = true, registered = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dubbing-delivery-lifecycle-')), directory = join(root, 'workspace'), store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  if (folders) store.put('settings', { id: 'project-folders', enabled: true });
  const project = domain.mutate('project.create', { name: '原件项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '章节', source: '保存原件及处理版。', segment: true });
  const job = { id: uid(), chapterId: chapter.id, status: 'unknown' }; store.put('jobs', job, chapter.id);
  const attempt = { id: uid(), jobId: job.id, status: 'unknown', deliveryVersion: 1, segmentId: domain.list(chapter.id)[0].id };
  attempt.path = `${project.folder ? project.folder + '/' : ''}audio/${attempt.id}.wav`; store.put('attempts', attempt, job.id);
  mkdirSync(dirname(join(directory, attempt.path)), { recursive: true }); writeFileSync(join(directory, attempt.path + '.part'), wav());
  await sealAudioDelivery(store, attempt, wav().length, new Response('', { status: 200 }));
  let meta;
  if (processed) meta = await prepareAudioDelivery(store, attempt);
  if (registered) {
    assert.ok(meta?.originalAudioId);
    store.put('audios', { id: meta.originalAudioId, path: attempt.path, delivery: attempt.delivery, sourceAttemptId: attempt.id }, chapter.id);
    store.put('audios', { id: attempt.id, ...meta }, chapter.id);
  }
  const remove = scope => domain.mutate('project.delete', { id: project.id, scope: scope || domain.deletionPlan({ id: project.id }).scope });
  return { root, directory, store, domain, project, chapter, job, attempt, meta, remove };
}

for (const registered of [false, true]) test(`AE-H01 ${registered ? '已登记原件及处理版' : '尚未登记的完整交付'}改名同步全部路径，清单与原始字节不改`, async t => {
  const f = await fixture(t, { registered }), manifest = readFileSync(join(f.directory, f.attempt.delivery.manifestPath)), files = recordFiles(f.attempt, true);
  f.domain.mutate('project.rename', { id: f.project.id, entityRevision: 1, name: '改名后的项目' });
  const attempt = f.store.get('attempts', f.attempt.id);
  for (const path of recordFiles(attempt, true)) assert.ok(path.startsWith('改名后的项目/audio/'), path);
  assert.deepEqual(readFileSync(join(f.directory, attempt.delivery.manifestPath)), manifest);
  assert.deepEqual(readFileSync(join(f.directory, attempt.path)), wav());
  assert.ok(files.every(path => !existsSync(join(f.directory, path))));
  await verifyAudioDelivery(f.store, attempt);
  if (registered) for (const audio of f.store.all('audios')) {
    assert.equal(audio.delivery.rawPath, attempt.path); assert.equal(audio.delivery.manifestPath, attempt.delivery.manifestPath);
    if (audio.processing) assert.equal(audio.processing.resultPath, attempt.processing.resultPath);
  }
  backup('verify', f.directory);
});

for (const stage of ['received', 'processed', 'receipt-before-db']) test(`AE-H01 平铺交付迁入项目目录后可免费恢复：${stage}`, async t => {
  const f = await fixture(t, { folders: false, processed: stage === 'processed', registered: false });
  if (stage === 'receipt-before-db') {
    renameSync(join(f.directory, f.attempt.path), join(f.directory, f.attempt.path + '.part'));
    delete f.attempt.delivery; f.store.put('attempts', f.attempt, f.job.id);
  }
  const manifestPath = f.attempt.path + '.delivery.json', manifest = readFileSync(join(f.directory, manifestPath));
  assert.equal(workspaceDiagnostics(f.store).primaryAvailable, true);
  assert.equal(workspaceDiagnostics(f.store).counts.deliveries, 1);
  const target = await copyWorkspace(f.store, join(f.root, 'moved')), next = openStore(target);
  try {
    const attempt = next.get('attempts', f.attempt.id);
    assert.equal(attempt.path, f.project.name + '/' + f.attempt.path);
    if (attempt.delivery) assert.equal(attempt.delivery.rawPath, attempt.path);
    assert.deepEqual(readFileSync(join(target, attempt.path + '.delivery.json')), manifest);
    if (stage === 'receipt-before-db') { assert.equal(existsSync(join(target, attempt.path)), false); assert.ok(existsSync(join(target, attempt.path + '.part'))); }
    const restored = await prepareAudioDelivery(next, attempt);
    assert.ok(restored.originalAudioId); assert.ok(restored.processing); assert.deepEqual(readFileSync(join(target, attempt.path)), wav());
    backup('verify', target);
  } finally { next.close(); }
  assert.deepEqual(readFileSync(join(f.directory, manifestPath)), manifest);
  assert.deepEqual(readFileSync(join(f.directory, f.attempt.path + (stage === 'receipt-before-db' ? '.part' : ''))), wav());
});

test('AE-H01 封存后尚未登记的原件、清单及处理版可备份恢复，cleanup只清无引用音频', async t => {
  const f = await fixture(t, { registered: false }), paths = recordFiles(f.attempt, true), source = paths.map(path => readFileSync(join(f.directory, path)));
  const orphan = join(dirname(join(f.directory, f.attempt.path)), uid() + '.wav'); writeFileSync(orphan, 'orphan');
  backup('create', f.directory, join(f.root, 'backup')); backup('restore', join(f.root, 'backup'), join(f.root, 'restored'));
  assert.match(backup('cleanup', f.directory, '--apply'), /1 个无引用文件/); assert.equal(existsSync(orphan), false);
  for (const [index, path] of paths.entries()) for (const folder of [f.directory, join(f.root, 'backup'), join(f.root, 'restored')])
    assert.deepEqual(readFileSync(join(folder, path)), source[index]);
  assert.equal(f.store.all('audios').length, 0);
});

test('AE-H01 清单已落盘但原件仍为part且DB未登记，维护只读校验保留可恢复状态', async t => {
  const f = await fixture(t, { processed: false, registered: false });
  renameSync(join(f.directory, f.attempt.path), join(f.directory, f.attempt.path + '.part'));
  delete f.attempt.delivery; f.store.put('attempts', f.attempt, f.job.id);
  const before = f.store.get('attempts', f.attempt.id);
  backup('create', f.directory, join(f.root, 'backup')); backup('cleanup', f.directory, '--apply');
  assert.equal(existsSync(join(f.directory, f.attempt.path)), false); assert.deepEqual(f.store.get('attempts', f.attempt.id), before);
  assert.deepEqual(readFileSync(join(f.root, 'backup', f.attempt.path + '.part')), wav());
});

test('AE-H01 文件缺失、伪清单、同长度原件改写或软链都不能通过备份和迁移', async t => {
  for (const mode of ['raw-missing', 'manifest-missing', 'result-missing', 'raw-changed', 'manifest-changed', 'raw-symlink', 'unsafe-delivery-path']) await t.test(mode, async t => {
    const f = await fixture(t, { registered: false });
    if (mode === 'raw-missing') rmSync(join(f.directory, f.attempt.path));
    if (mode === 'manifest-missing') rmSync(join(f.directory, f.attempt.delivery.manifestPath));
    if (mode === 'result-missing') rmSync(join(f.directory, f.attempt.processing.resultPath));
    if (mode === 'raw-changed') { const changed = wav(); changed[100] ^= 1; writeFileSync(join(f.directory, f.attempt.path), changed); }
    if (mode === 'manifest-changed') { const receipt = JSON.parse(readFileSync(join(f.directory, f.attempt.delivery.manifestPath))); receipt.attemptId = uid(); writeFileSync(join(f.directory, f.attempt.delivery.manifestPath), JSON.stringify(receipt)); }
    if (mode === 'raw-symlink') { const external = join(f.root, 'external.wav'); writeFileSync(external, wav()); rmSync(join(f.directory, f.attempt.path)); symlinkSync(external, join(f.directory, f.attempt.path)); }
    if (mode === 'unsafe-delivery-path') { f.attempt.delivery.rawPath = '../external.wav'; f.store.put('attempts', f.attempt, f.job.id); }
    const before = f.store.get('attempts', f.attempt.id);
    assert.notEqual(runBackup('create', f.directory, join(f.root, 'backup')).status, 0);
    assert.equal(existsSync(join(f.root, 'backup')), false);
    await assert.rejects(copyWorkspace(f.store, join(f.root, 'moved'))); assert.equal(existsSync(join(f.root, 'moved')), false);
    assert.deepEqual(f.store.get('attempts', f.attempt.id), before);
    if (mode.includes('missing') || mode === 'raw-symlink' || mode === 'unsafe-delivery-path') assert.equal(workspaceDiagnostics(f.store).primaryAvailable, false);
  });
});

for (const folders of [false, true]) test(`AE-H01 删除${folders ? '目录' : '平铺'}项目包含交付清单和派生临时文件，旧范围不能误删新处理记录`, async t => {
  const f = await fixture(t, { folders, registered: false }), files = recordFiles(f.attempt, true);
  for (const path of files) writeFileSync(join(f.directory, path + '.part'), 'unfinished');
  const scope = f.domain.deletionPlan({ id: f.project.id }).scope;
  f.attempt.processing.completedAt = 'changed'; f.store.put('attempts', f.attempt, f.job.id);
  assert.throws(() => f.remove(scope), { status: 409 }); assert.ok(files.every(path => existsSync(join(f.directory, path))));
  f.remove();
  for (const path of files) for (const suffix of ['', '.part']) assert.equal(existsSync(join(f.directory, path + suffix)), false, path + suffix);
});

test('AE-H01 其他记录只在delivery字段引用本项目原件时仍阻止整目录删除', async t => {
  const f = await fixture(t, { registered: false }), other = f.domain.mutate('project.create', { name: '另一个项目' });
  const chapter = f.domain.mutate('chapter.create', { projectId: other.id, title: '章', source: '共用原件必须保留。', segment: true });
  const shared = { id: uid(), path: '另一个项目/audio/shared.wav', delivery: f.attempt.delivery };
  mkdirSync(dirname(join(f.directory, shared.path)), { recursive: true }); writeFileSync(join(f.directory, shared.path), wav()); f.store.put('audios', shared, chapter.id);
  assert.throws(() => f.remove(), /共用素材/); assert.deepEqual(readFileSync(join(f.directory, f.attempt.path)), wav());
});

test('AE-H01 项目改名事务失败恢复目录及所有嵌套路径', async t => {
  const f = await fixture(t), before = ['attempts', 'audios', 'projects'].map(table => f.store.all(table));
  f.store.db.exec("CREATE TRIGGER deny_delivery_rename BEFORE UPDATE ON projects BEGIN SELECT RAISE(ABORT, 'rename rollback'); END");
  assert.throws(() => f.domain.mutate('project.rename', { id: f.project.id, entityRevision: 1, name: '回滚名称' }), /rename rollback/);
  assert.deepEqual(['attempts', 'audios', 'projects'].map(table => f.store.all(table)), before);
  assert.deepEqual(readFileSync(join(f.directory, f.attempt.path)), wav()); assert.equal(existsSync(join(f.directory, '回滚名称')), false);
});


test('AE-H01 平铺项目删除保留其他尝试共用的交付文件及part', async t => {
  const f = await fixture(t, { folders: false, registered: false });
  const other = f.domain.mutate('project.create', { name: '另一个项目' }), chapter = f.domain.mutate('chapter.create', { projectId: other.id, title: '章', source: '共用交付。', segment: true });
  const job = { id: uid(), chapterId: chapter.id, status: 'unknown' }; f.store.put('jobs', job, chapter.id);
  f.store.put('attempts', { ...f.attempt, id: uid(), jobId: job.id }, job.id);
  for (const path of recordFiles(f.attempt, true)) writeFileSync(join(f.directory, path + '.part'), 'shared pending');
  f.remove();
  for (const path of recordFiles(f.attempt, true)) {
    assert.ok(existsSync(join(f.directory, path))); assert.equal(readFileSync(join(f.directory, path + '.part'), 'utf8'), 'shared pending');
  }
  assert.ok(f.store.get('projects', other.id));
});


test('AE-H01 已保存处理计划但尚无派生文件是可备份和迁移的中断状态', async t => {
  const f = await fixture(t, { processed: false, registered: false }), path = join(f.directory, f.attempt.delivery.manifestPath);
  const receipt = JSON.parse(readFileSync(path)), analysis = await analyzeTail(join(f.directory, f.attempt.path));
  assert.equal(analysis.detected, true);
  receipt.evaluated = true; receipt.processing = { version: TAIL_PROCESSING_VERSION, analysis };
  writeFileSync(path, JSON.stringify(receipt));
  const plannedResult = f.attempt.path.slice(0, -4) + '.processed.wav';
  assert.equal(existsSync(join(f.directory, plannedResult)), false);
  assert.equal(workspaceDiagnostics(f.store).primaryAvailable, true);
  backup('create', f.directory, join(f.root, 'backup'));
  const target = await copyWorkspace(f.store, join(f.root, 'moved')), next = openStore(target);
  try {
    const attempt = next.get('attempts', f.attempt.id), result = await prepareAudioDelivery(next, attempt);
    assert.ok(result.processing); assert.ok(existsSync(join(target, result.path))); assert.deepEqual(readFileSync(join(target, attempt.path)), wav());
  } finally { next.close(); }
  assert.equal(existsSync(join(f.directory, plannedResult)), false);
});
