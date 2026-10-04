import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { exportMaster, ffmpeg, inspect } from '../server/audio.mjs';
import { copyWorkspace, projectExportFile, revealExport } from '../server/workspace.mjs';
import { startServer } from '../server/index.mjs';

function fixture(t, folders = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dubbing-export-output-'))), directory = join(root, 'workspace');
  const store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  if (folders) store.put('settings', { id: 'project-folders', enabled: true });
  const project = domain.mutate('project.create', { name: '成品项目' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '第1章', source: '保存这一章。', segment: true });
  const write = (path, data) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), data); return path; };
  return { root, directory, store, domain, project, chapter, write };
}

test('WAV和MP3直接写入项目output，标题安全可读，同编排重复导出保留每份结果', async t => {
  const { directory, store, domain, project, chapter } = fixture(t);
  chapter.title = '../一章\\:🎧' + '长'.repeat(70); store.put('chapters', chapter, project.id);
  const masterPath = 'source.wav';
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.1', '-c:a', 'pcm_s16le', join(directory, masterPath)]);
  const master = { path: masterPath, chapterId: chapter.id, arrangement: 7 };
  const paths = [];
  for (const format of ['wav', 'mp3', 'wav']) {
    const id = uid(), path = await exportMaster(store, master, id, format); paths.push(path);
    assert.equal(dirname(path), project.folder + '/output');
    assert.ok(basename(path).endsWith(`-编排7-${id}.${format}`));
    assert.ok(Buffer.byteLength(basename(path)) < 255); assert.ok(!/[\\:\x00-\x1f]/.test(basename(path)));
    assert.ok(!basename(path).startsWith('.'), '特殊标题不会生成Finder默认隐藏的成品');
    assert.equal((await inspect(join(directory, path))).format, format);
    if (format === 'wav') assert.deepEqual(readFileSync(join(directory, path)), readFileSync(join(directory, masterPath)));
  }
  assert.equal(new Set(paths).size, 3); assert.ok(paths.every(path => existsSync(join(directory, path))));
  assert.equal(domain.chapter(chapter.id).outputDirectory, join(directory, project.folder, 'output'));
  assert.throws(() => projectExportFile(store, { chapterId: chapter.id, id: '../escape', format: 'wav' }), /标识/);
});

for (const folders of [true, false]) test(`迁移${folders ? '目录' : '旧平铺'}工作区保留output与历史exports，改名删除仍覆盖成品`, async t => {
  const { root, directory, store, domain, project, chapter, write } = fixture(t, folders);
  const modern = { id: uid(), chapterId: chapter.id, format: 'wav', arrangement: 1, confirmation: { reviewItems: [] } };
  modern.path = write(projectExportFile(store, modern), 'output bytes'); store.put('exports', modern, chapter.id);
  const legacy = { id: uid(), chapterId: chapter.id, path: write(`${project.folder ? project.folder + '/' : ''}exports/old.wav`, 'legacy bytes') };
  store.put('exports', legacy, chapter.id);
  const target = await copyWorkspace(store, join(root, 'moved')), next = openStore(target), nextDomain = createDomain(next);
  try {
    const moved = next.get('exports', modern.id), old = next.get('exports', legacy.id);
    assert.equal(dirname(moved.path), project.name + '/output'); assert.equal(dirname(old.path), project.name + '/exports');
    assert.equal(readFileSync(join(target, moved.path), 'utf8'), 'output bytes'); assert.equal(readFileSync(join(target, old.path), 'utf8'), 'legacy bytes');
    assert.equal(readFileSync(join(directory, modern.path), 'utf8'), 'output bytes');
    nextDomain.mutate('project.rename', { id: project.id, entityRevision: 1, name: '改名项目' });
    assert.equal(nextDomain.chapter(chapter.id).outputDirectory, join(target, '改名项目/output'));
    assert.equal(readFileSync(join(target, next.get('exports', modern.id).path), 'utf8'), 'output bytes');
    nextDomain.mutate('project.delete', { id: project.id, scope: nextDomain.deletionPlan({ id: project.id }).scope });
    assert.equal(existsSync(join(target, '改名项目')), false);
  } finally { next.close(); }
  // Flat projects have no enclosing directory; their new output still belongs to deletion.
  domain.mutate('project.delete', { id: project.id, scope: domain.deletionPlan({ id: project.id }).scope });
  assert.equal(existsSync(join(directory, modern.path)), false);
});

test('成品定位只使用登记文件，兼容历史路径，拒绝缺失、目录与符号链接外跳', async t => {
  const { root, directory, store, chapter, write } = fixture(t);
  const calls = [], run = async (...args) => { calls.push(args); };
  const put = path => { const id = uid(); store.put('exports', { id, chapterId: chapter.id, path }, chapter.id); return id; };
  for (const path of ['成品项目/output/new.wav', '成品项目/exports/old.wav']) {
    const id = put(write(path, 'file bytes'));
    assert.deepEqual(await revealExport(store, id, run), { path: join(directory, path) });
    assert.deepEqual(calls.at(-1), ['/usr/bin/open', ['-R', join(directory, path)], { timeout: 10000 }]);
  }
  const outside = join(root, 'outside.wav'); writeFileSync(outside, 'outside bytes');
  symlinkSync(outside, join(directory, 'linked.wav'));
  symlinkSync(join(root), join(directory, 'escape'));
  for (const path of ['../outside.wav', 'linked.wav', 'escape/outside.wav', '成品项目/output'])
    await assert.rejects(revealExport(store, put(path), run), { status: 403 });
  await assert.rejects(revealExport(store, put('missing.wav'), run), { status: 404 });
  await assert.rejects(revealExport(store, 'unregistered', run), { status: 404 });
  assert.equal(calls.length, 2);
  await assert.rejects(revealExport(store, put('成品项目/output/new.wav'), async () => { throw Error('open failed'); }), /无法打开成品位置/);
});

test('成品定位接口受同源保护且按记录校验，不接受客户端任意路径', async t => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dubbing-export-route-')));
  const app = await startServer({ port: 0, directory, config: { key: '' } });
  t.after(async () => { await app.close(); rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = headers => fetch(base + '/api/exports/missing/reveal', { method: 'POST', headers, body: JSON.stringify({ path: '/tmp/arbitrary.wav' }) });
  assert.equal((await post({ 'Content-Type': 'application/json' })).status, 404);
  assert.equal((await post({ Origin: 'https://example.com', 'Content-Type': 'application/json' })).status, 403);
});
