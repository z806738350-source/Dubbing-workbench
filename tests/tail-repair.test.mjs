import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, uid } from '../server/store.mjs';
import { createDomain, inputOf, basisOf } from '../server/domain.mjs';
import { compile } from '../server/templates.mjs';
import { repairProjectTails } from '../server/tail-repair.mjs';
import { analyzeTail } from '../server/tail-audio.mjs';
import { buildMaster, inspect } from '../server/audio.mjs';

function wave(pulse = true) {
  const rate = 48000, frames = pulse === 'silence' ? rate * 2 : rate, data = Buffer.alloc(44 + frames * 2);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28); data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(frames * 2, 40);
  for (let i = 4800; i < 33600; i++) data.writeInt16LE(Math.round(Math.sin(i * 220 * 2 * Math.PI / rate) * 6000), 44 + i * 2);
  if (pulse === true) for (let i = 46560; i < 46800; i++) data.writeInt16LE(i % 2 ? 14000 : -14000, 44 + i * 2);
  return data;
}

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dubbing-tail-repair-')), store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const project = domain.mutate('project.create', { name: '尾部清理' });
  const chapter = domain.mutate('chapter.create', { projectId: project.id, title: '样章', source: '第一句。第二句。第三句。', segment: true });
  const role = store.all('roles', project.id)[0], voice = { id: uid(), name: '参考', state: 'active', path: 'voices/reference.wav' };
  mkdirSync(join(directory, 'voices')); writeFileSync(join(directory, voice.path), wave(false)); store.put('voices', voice);
  const mutate = (action, p) => domain.mutate(action, { chapterId: chapter.id, revision: store.get('chapters', chapter.id).revision, ...p });
  mutate('role.update', { id: role.id, entityRevision: role.revision || 1, voiceId: voice.id });
  mutate('segment.confirm', { ids: domain.list(chapter.id).map(s => s.id) });
  function putFile(audio, pulse) {
    const file = join(directory, audio.path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, wave(pulse));
    store.put('audios', audio, chapter.id); return audio;
  }
  function singleAudio(index = 0, pulse = true, passed = false) {
    const segment = domain.list(chapter.id)[index], id = uid();
    const audio = putFile({ id, path: `audio/${id}.wav`, input: inputOf(segment), basis: basisOf(segment), prompt: compile(segment),
      targetKind: 'single', targetId: segment.id, duration: pulse === 'silence' ? 2 : 1, sampleRate: 48000, channels: 1, format: 'wav', model: segment.model }, pulse);
    segment.current = id; segment.latest = 'success';
    if (passed) {
      segment.review = { audioId: id, basis: basisOf(segment), state: 'passed' }; segment.approved = id;
      audio.review = segment.review; store.put('audios', audio, chapter.id);
    }
    store.put('segments', segment, chapter.id); domain.enhancement.syncLegacySegment(segment); return audio;
  }
  function unitAudio(unitId, mode = 'dry') {
    const e = domain.enhancement, prepared = e.prepare({ kind: 'unit-generate', chapterId: chapter.id,
      revision: store.get('chapters', chapter.id).revision, unitId, mode }, { model: 'seed-audio-1.0' });
    const job = { ...prepared.job, id: uid(), kind: 'unit-generate', status: 'running' }, attempt = { ...prepared.attempts[0], id: uid(), jobId: job.id, status: 'sending' };
    store.put('jobs', job, chapter.id); store.put('attempts', attempt, job.id);
    const audio = putFile({ id: attempt.id, path: `audio/${attempt.id}.wav`, input: attempt.input, basis: attempt.basis,
      prompt: compile(attempt.input), model: attempt.input.model, duration: 1, sampleRate: 48000, channels: 1, format: 'wav' }, true);
    assert.equal(e.register(job, attempt, audio), true);
    job.status = 'success'; store.put('jobs', job, chapter.id); attempt.status = 'success'; store.put('attempts', attempt, job.id);
    return audio;
  }
  return { directory, store, domain, project, chapter, mutate, singleAudio, unitAudio };
}

test('清理当前干声保留正文、原history与approved，采用新ID并使整章版本失效', async t => {
  const { directory, store, domain, project, chapter, singleAudio } = setup(t);
  const source = singleAudio(0, true, true), clean = singleAudio(1, false), before = store.get('chapters', chapter.id);
  const original = readFileSync(join(directory, source.path));
  const result = await repairProjectTails(store, domain, project.id);
  assert.equal(result.cleaned, 1); assert.equal(result.details.find(d => d.sourceAudioId === clean.id).changed, false);
  const changed = result.details.find(d => d.changed), audio = store.get('audios', changed.audioId), unit = store.get('units', changed.unitId);
  assert.equal(audio.tailRepair.sourceAudioId, source.id); assert.equal(audio.review, undefined); assert.ok(Math.abs(audio.duration - audio.tailRepair.cutSeconds) < 1 / 48000);
  assert.equal(unit.variants.dry.current, audio.id); assert.equal(unit.variants.dry.previous, source.id);
  assert.equal(unit.variants.dry.approved, source.id); assert.equal(unit.variants.dry.review.state, 'pending');
  assert.equal(store.get('segments', unit.id).current, audio.id); assert.equal(store.get('segments', unit.id).approved, source.id);
  assert.equal(store.get('chapters', chapter.id).revision, before.revision); assert.equal(store.get('chapters', chapter.id).arrangement, before.arrangement + 1);
  assert.deepEqual(store.get('audios', source.id), source); assert.deepEqual(readFileSync(join(directory, source.path)), original);
  assert.deepEqual(readFileSync(join(directory, audio.path)).subarray(44), original.subarray(44, 44 + Math.round(audio.duration * 48000) * 2));
  assert.equal((await analyzeTail(join(directory, audio.path))).detected, false);
  assert.equal((await inspect(join(directory, audio.path))).duration, audio.duration);
  const count = store.all('audios').length;
  assert.equal((await repairProjectTails(store, domain, project.id)).cleaned, 0); assert.equal(store.all('audios').length, count);
});

test('只清理目标项目当前匹配声音，旧history、失效声音及场景版不动', async t => {
  const { store, domain, project, chapter, mutate, singleAudio, unitAudio } = setup(t);
  const historical = singleAudio(0), current = singleAudio(0, false), stale = singleAudio(1), rows = domain.list(chapter.id);
  mutate('segment.update', { id: rows[1].id, entityRevision: rows[1].revision, text: rows[1].text + '改。' });
  const scene = unitAudio(rows[2].id, 'scene');
  const another = domain.mutate('project.create', { name: '不处理项目' });
  const result = await repairProjectTails(store, domain, project.id);
  assert.equal(result.cleaned, 0); assert.equal(store.get('segments', rows[0].id).current, current.id);
  assert.equal(result.details.find(d => d.sourceAudioId === stale.id).reason, 'stale');
  assert.equal(result.details.find(d => d.sourceAudioId === scene.id).reason, 'scene_audio');
  assert.ok(store.get('audios', historical.id)); assert.equal(store.all('chapters', another.id).length, 0);
});

test('旧清理标记不豁免波形复检，残留脉冲或长空白采用新ID并供整章使用', async t => {
  for (const tail of [true, 'silence']) await t.test(tail === true ? 'pulse' : tail, async t => {
    const { directory, store, domain, project, chapter, singleAudio } = setup(t), source = singleAudio(0, tail);
    source.tailRepair = { sourceAudioId: 'earlier-result', cutSeconds: source.duration, removedSeconds: 0.01 };
    store.put('audios', source, chapter.id);
    const original = readFileSync(join(directory, source.path)), before = store.get('chapters', chapter.id);
    const result = await repairProjectTails(store, domain, project.id);
    assert.equal(result.cleaned, 1);
    const audio = store.get('audios', result.details.find(item => item.changed).audioId);
    assert.notEqual(audio.id, source.id); assert.equal(audio.tailRepair.sourceAudioId, source.id);
    if (tail === 'silence') assert.ok(Math.abs(audio.duration - 0.95) < 0.006);
    assert.equal(store.get('segments', source.targetId).current, audio.id);
    assert.equal(store.get('chapters', chapter.id).arrangement, before.arrangement + 1);
    const cleaned = readFileSync(join(directory, audio.path));
    assert.deepEqual(cleaned.subarray(44), original.subarray(44, cleaned.length));
    assert.deepEqual(readFileSync(join(directory, source.path)), original);
    const rows = domain.enhancement.resolve(chapter.id).filter(row => row.a), master = await buildMaster(store, rows, before.gap, uid());
    assert.deepEqual(master.mapping.map(item => item.audioId), [audio.id]);
    assert.equal(master.mapping[0].endFrame, Math.round(audio.duration * 48000));
    const count = store.all('audios').length;
    assert.equal((await repairProjectTails(store, domain, project.id)).cleaned, 0); assert.equal(store.all('audios').length, count);
  });
});

test('纯对白组只清理一次，保留成员原单条音频', async t => {
  const { store, domain, project, chapter, mutate, singleAudio, unitAudio } = setup(t);
  const single = singleAudio(), ids = domain.list(chapter.id).slice(0, 2).map(s => s.id);
  const group = mutate('unit.create', { kind: 'group', ids, mode: 'dry' }), source = unitAudio(group.id);
  const result = await repairProjectTails(store, domain, project.id);
  assert.equal(result.cleaned, 1); assert.equal(result.details.filter(d => d.unitId === group.id).length, 1);
  assert.equal(store.get('segments', ids[0]).current, single.id);
  assert.equal(store.get('units', group.id).variants.dry.previous, source.id);
});

test('事务失败回滚采用记录，删除新文件并保留原音频', async t => {
  const { directory, store, domain, project, singleAudio } = setup(t), source = singleAudio();
  const before = ['audios', 'units', 'segments', 'chapters'].map(table => store.all(table)), files = readdirSync(join(directory, 'audio'));
  store.db.exec("CREATE TRIGGER reject_tail_repair BEFORE UPDATE ON units BEGIN SELECT RAISE(ABORT,'injected failure'); END");
  await assert.rejects(repairProjectTails(store, domain, project.id), /injected failure/);
  assert.deepEqual(['audios', 'units', 'segments', 'chapters'].map(table => store.all(table)), before);
  assert.deepEqual(readdirSync(join(directory, 'audio')), files); assert.ok(existsSync(join(directory, source.path)));
});

test('处理开始前拒绝活动任务，异步处理期间更换声音也不覆盖新选择', async t => {
  const { store, domain, project, chapter, singleAudio } = setup(t), source = singleAudio();
  const job = { id: uid(), status: 'running' }; store.put('jobs', job, chapter.id);
  await assert.rejects(repairProjectTails(store, domain, project.id), /正在处理/);
  job.status = 'stopped'; store.put('jobs', job, chapter.id);
  const pending = repairProjectTails(store, domain, project.id), replacement = singleAudio(0, false);
  await assert.rejects(pending, /已变化/);
  assert.equal(store.get('segments', replacement.targetId).current, replacement.id);
  assert.equal(store.all('audios').length, 2); assert.ok(store.get('audios', source.id));
});

test('离线命令拒绝live runtime且不删除别人的运行标记', t => {
  const { directory, store, project } = setup(t), runtime = join(directory, 'runtime.json');
  const marker = JSON.stringify({ pid: process.pid, port: 4318 }); writeFileSync(runtime, marker);
  const before = store.all('audios');
  assert.throws(() => execFileSync(process.execPath, ['scripts/clean-tail-audio.mjs', directory, project.id], { cwd: new URL('..', import.meta.url), stdio: 'pipe' }), /请先停止/);
  assert.equal(readFileSync(runtime, 'utf8'), marker); assert.deepEqual(store.all('audios'), before);
});

test('离线命令实际清理并释放runtime，重复运行不再新建处理版本', t => {
  const { directory, store, project, singleAudio } = setup(t); singleAudio();
  const run = () => JSON.parse(execFileSync(process.execPath, ['scripts/clean-tail-audio.mjs', directory, project.id],
    { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }));
  assert.equal(run().cleaned, 1); assert.equal(existsSync(join(directory, 'runtime.json')), false);
  const count = store.all('audios').length;
  assert.equal(run().cleaned, 0); assert.equal(store.all('audios').length, count);
  assert.equal(existsSync(join(directory, 'runtime.json')), false);
});
