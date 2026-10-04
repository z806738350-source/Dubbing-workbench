import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';

function wav() {
  const bytes = Buffer.alloc(44 + 96000 * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  for (let i = 0; i < 28800; i++) bytes.writeInt16LE(Math.round(Math.sin(i / 17) * 1000), 44 + i * 2);
  return bytes;
}
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'audio-delivery-')), store = openStore(dir), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const project = domain.mutate('project.create', { name: 'delivery' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '章', source: '一句。', segment: true });
  const voice = { id: uid(), path: 'reference.wav', state: 'active' };
  writeFileSync(join(dir, voice.path), wav()); store.put('voices', voice);
  const role = store.all('roles', project.id)[0];
  domain.mutate('role.update', { id: role.id, entityRevision: role.revision ?? 1, voiceId: voice.id, chapterId: chapter.id, revision: chapter.revision });
  const segment = domain.list(chapter.id)[0];
  domain.mutate('segment.update', { id: segment.id, chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, roleConfirmed: true });
  const config = { key: 'test', model: 'seed-audio-1.0', audioUrl: 'https://example.invalid' };
  const worker = createWorker(store, domain, config);
  const job = worker.enqueue({ kind: 'generate', chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, ids: [segment.id], commandId: uid() });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(wav(), { headers: { 'Content-Type': 'audio/wav' } }); });
  return { store, domain, worker, config, job, dir, chapter, segment, calls: () => calls };
}

test('AE-H01 完整供应商原件与带版本配方的处理版分别保留', async t => {
  const { store, worker, job, dir, calls } = setup(t);
  await worker.tick();
  assert.equal(store.get('jobs', job.id).status, 'success');
  const attempt = store.all('attempts', job.id)[0], audio = store.get('audios', attempt.id);
  assert.ok(audio.duration < 1);
  assert.ok(audio.originalAudioId, '处理结果必须能关联原件');
  const original = store.get('audios', audio.originalAudioId);
  assert.deepEqual(readFileSync(join(dir, original.path)), wav());
  assert.notEqual(audio.path, original.path);
  assert.ok(audio.processing?.version); assert.ok(audio.processing?.inputSha256);
  assert.ok(audio.processing?.resultSha256); assert.ok(audio.processing?.cutFrame > 0);
  assert.deepEqual(attempt.processing, audio.processing);
  assert.equal(calls(), 1);
});

test('AE-H01-R 登记失败后重开仅本地恢复，清理来源不丢，旧批次不复活', async t => {
  const { store, domain, worker, config, job, dir, calls, chapter } = setup(t);
  const put = store.put.bind(store); let failed = false;
  const registration = t.mock.method(store, 'put', (table, value, ...rest) => {
    if (table === 'audios' && !failed) { failed = true; throw new Error('injected registration failure'); }
    return put(table, value, ...rest);
  });
  await worker.tick(); registration.mock.restore();
  const ended = store.get('jobs', job.id), before = domain.chapter(chapter.id);
  assert.equal(ended.status, 'unknown'); assert.equal(store.all('audios').length, 0);
  store.close(); store.close = () => {};
  const reopened = openStore(dir); t.after(() => reopened.close());
  const next = createWorker(reopened, createDomain(reopened), config);
  await next.recover(); await next.tick();
  const attempt = reopened.all('attempts', job.id)[0], audio = reopened.get('audios', attempt.id);
  assert.ok(audio.tailRepair, '重启不能丢失清理来源');
  assert.ok(audio.processing?.version); assert.ok(audio.originalAudioId);
  assert.deepEqual(readFileSync(join(dir, reopened.get('audios', audio.originalAudioId).path)), wav());
  assert.deepEqual(reopened.get('jobs', job.id), ended);
  assert.equal(reopened.get('segments', before.segments[0].id).current, before.segments[0].current);
  const records = reopened.all('audios'); await next.recover(); assert.deepEqual(reopened.all('audios'), records);
  assert.equal(calls(), 1);
});

test('有完整原件的本地失败不能通过 retryUnknown 重发，免费恢复可以重复调用', async t => {
  const { store, domain, worker, job, chapter, segment, calls } = setup(t), put = store.put.bind(store);
  const mock = t.mock.method(store, 'put', (table, ...args) => { if (table === 'audios') throw new Error('register blocked'); return put(table, ...args); });
  await worker.tick(); mock.mock.restore();
  const attempt = store.all('attempts', job.id)[0];
  for (const kind of ['generate', 'unit-generate']) assert.throws(() => worker.enqueue({ kind, chapterId: chapter.id,
    revision: domain.chapter(chapter.id).revision, ids: [segment.id], unitIds: [segment.id], mode: 'dry', commandId: uid(), retryUnknown: true }),
    error => error.code === 'raw-received-local-pending' && error.scope.ids.includes(attempt.id));
  const jobs = store.all('jobs');
  const audio = await worker.recoverLocal(attempt.id);
  assert.deepEqual(await worker.recoverLocal(attempt.id), audio);
  assert.deepEqual(store.all('jobs'), jobs); assert.equal(calls(), 1);
});

test('封存、配方、派生与登记各边界中断均凭清单恢复原件和处理来源', async t => {
  const fs = (await import('node:fs/promises')).default, { syncBuiltinESMExports } = await import('node:module');
  for (const boundary of ['seal', 'recipe', 'processed', 'result']) await t.test(boundary, async t => {
    const { store, worker, job, dir, calls } = setup(t), rename = fs.rename;
    let failed = false;
    const mock = t.mock.method(fs, 'rename', async (from, to) => {
      let matches = false;
      if (!failed && String(to).endsWith('.delivery.json')) {
        const receipt = JSON.parse(readFileSync(from, 'utf8'));
        matches = boundary === 'recipe' ? receipt.evaluated && !receipt.result : boundary === 'result' && !!receipt.result;
      }
      if (!failed && boundary === 'seal') matches = String(to).endsWith('.wav') && !String(to).endsWith('.processed.wav');
      if (!failed && boundary === 'processed') matches = String(to).endsWith('.processed.wav');
      if (matches) { failed = true; if (boundary !== 'seal') await rename(from, to); throw new Error(`interruption after ${boundary}`); }
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try { await worker.tick(); } finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(failed, true);
    const attempt = store.all('attempts', job.id)[0];
    assert.equal(attempt.phase, 'localRecoveryPending'); assert.equal(store.all('audios').length, 0);
    const audio = await worker.recoverLocal(attempt.id), original = store.get('audios', audio.originalAudioId);
    assert.deepEqual(readFileSync(join(dir, original.path)), wav());
    assert.equal(audio.processing.cutFrame, Math.round(audio.duration * 48000));
    const records = store.all('audios'); await worker.recover(); assert.deepEqual(store.all('audios'), records);
    assert.equal(calls(), 1);
  });
});

test('完整性反例：没有清单的可解码文件、被修改的原件均不冒充完整回执', async t => {
  const { store, worker, job, dir, calls } = setup(t), attempt = store.all('attempts', job.id)[0];
  const { mkdirSync } = await import('node:fs'), { dirname } = await import('node:path');
  mkdirSync(dirname(join(dir, attempt.path)), { recursive: true });
  writeFileSync(join(dir, attempt.path), wav()); writeFileSync(join(dir, `${attempt.path}.part`), wav());
  store.put('attempts', { ...attempt, deliveryVersion: 1, status: 'sending' }, job.id);
  await worker.recover(); assert.equal(store.all('audios').length, 0); assert.equal(calls(), 0);
  await assert.rejects(worker.recoverLocal(attempt.id), /完整接收凭据/);
});

test('已保存配方无需再次分析；损坏原件拒绝恢复且保留历史', async t => {
  const { store, worker, job, dir, calls } = setup(t), put = store.put.bind(store);
  const mock = t.mock.method(store, 'put', (table, ...args) => { if (table === 'audios') throw new Error('register blocked'); return put(table, ...args); });
  await worker.tick(); mock.mock.restore();
  const attempt = store.all('attempts', job.id)[0], file = join(dir, attempt.path), raw = readFileSync(file);
  const modified = Buffer.from(raw); modified[70] ^= 1; writeFileSync(file, modified);
  await assert.rejects(worker.recoverLocal(attempt.id), /完整接收凭据不一致/); assert.equal(store.all('audios').length, 0);
  writeFileSync(file, raw);
  const manifest = join(dir, `${attempt.path}.delivery.json`), receipt = JSON.parse(readFileSync(manifest));
  receipt.processingVersion = 'older-algorithm'; receipt.processing.version = 'older-algorithm';
  writeFileSync(manifest, JSON.stringify(receipt));
  const audio = await worker.recoverLocal(attempt.id);
  assert.equal(audio.processing.version, 'older-algorithm', '完成的派生只核验原件和结果，不以现行算法重写历史');
  assert.equal(calls(), 1);
});

test('旧算法未完成配方不借用新算法重剪，原件仍可找回', async t => {
  const { store, worker, job, dir } = setup(t), put = store.put.bind(store);
  const mock = t.mock.method(store, 'put', (table, ...args) => { if (table === 'audios') throw new Error('register blocked'); return put(table, ...args); });
  await worker.tick(); mock.mock.restore();
  const attempt = store.all('attempts', job.id)[0], manifest = join(dir, `${attempt.path}.delivery.json`), receipt = JSON.parse(readFileSync(manifest));
  delete receipt.result; receipt.processing.version = 'older-algorithm'; writeFileSync(manifest, JSON.stringify(receipt));
  await assert.rejects(worker.recoverLocal(attempt.id), /配方版本不匹配/);
  assert.deepEqual(readFileSync(join(dir, attempt.path)), wav()); assert.equal(store.all('audios').length, 0);
});


test('没有 Content-Length 的可解码截断 WAV 不能取得封存凭据', async t => {
  const { store, worker, job, dir } = setup(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(wav().subarray(0, 60044), { headers: { 'Content-Type': 'audio/wav' } }));
  await worker.tick();
  const attempt = store.all('attempts', job.id)[0];
  assert.equal(attempt.status, 'unknown'); assert.equal(attempt.delivery, undefined);
  await worker.recover(); assert.equal(store.all('audios').length, 0);
  await assert.rejects(worker.recoverLocal(attempt.id), /完整接收凭据/);
});
