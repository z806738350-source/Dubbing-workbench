import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { analyzeTail, trimTail } from '../server/tail-audio.mjs';

function wav({ duration = 1, channels = 2, sampleRate = 48000, signal } = {}) {
  const frames = Math.round(duration * sampleRate), b = Buffer.alloc(44 + frames * channels * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(channels, 22); b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * 2, 28); b.writeUInt16LE(channels * 2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(b.length - 44, 40);
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const time = frame / sampleRate;
    b.writeInt16LE(Math.round(signal?.(time, channel) ?? (time < 0.65 ? 6000 * Math.sin(time * 1500) : 0)), 44 + (frame * channels + channel) * 2);
  }
  return b;
}
const speech = time => time < 0.65 ? 6000 * Math.sin(time * 1500) : 0;
const pulse = (time, channel) => time >= 0.955 && time < 0.96 ? (channel ? -1 : 1) * 15000 * Math.sin((time - 0.955) * 12000) : speech(time);
async function fixture(t, bytes) {
  const directory = await mkdtemp(join(tmpdir(), 'tail-audio-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'source.wav'); await writeFile(file, bytes);
  return { file, output: join(directory, 'clean.wav') };
}

test('isolated stereo pulse is removed while every retained audio sample stays byte-identical', async t => {
  const source = wav({ signal: pulse }), { file, output } = await fixture(t, source);
  const a = await analyzeTail(file);
  assert.equal(a.detected, true);
  assert(a.cutSeconds > 0.94 && a.cutSeconds < 0.955);
  await trimTail(file, output, a);
  const cleaned = await readFile(output);
  assert.deepEqual(cleaned.subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
  assert.equal(cleaned.readUInt32LE(4), cleaned.length - 8);
  assert.equal(cleaned.readUInt32LE(40), a.cutFrame * 4);
  assert.deepEqual(await readFile(file), source);
  assert.equal((await analyzeTail(output)).detected, false);
  assert.equal(cleaned.readInt16LE(cleaned.length - 2), 0);
});

test('mono and non-48kHz PCM stay at their original channel count and rate', async t => {
  const source = wav({ channels: 1, sampleRate: 44100, signal: pulse }), { file, output } = await fixture(t, source);
  const a = await analyzeTail(file); assert.equal(a.detected, true);
  await trimTail(file, output, a);
  const b = await readFile(output);
  assert.equal(b.readUInt16LE(22), 1); assert.equal(b.readUInt32LE(24), 44100);
  assert.deepEqual(b.subarray(44), source.subarray(44, 44 + a.cutFrame * 2));
});

test('a wider burst requires a long quiet lead-in and a quiet or thoroughly decayed ending', async t => {
  const { file, output } = await fixture(t, Buffer.alloc(0));
  for (const decayAtEnd of [false, true]) {
    const source = wav({ signal: (time, channel) => {
      if (time < 0.4) return speech(time);
      if (time >= 0.93 && time < (decayAtEnd ? 0.999 : 0.985)) return 12000 * Math.sin((time - 0.93) * 14000) * (channel ? -1 : 1);
      return decayAtEnd && time >= 0.999 ? 50 : 0;
    } });
    await writeFile(file, source);
    const a = await analyzeTail(file); assert.equal(a.detected, true);
    await trimTail(file, output, a);
    assert.deepEqual((await readFile(output)).subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
    assert.equal((await analyzeTail(output)).detected, false);
    await rm(output);
  }
});

// Same timing as the reported 1.88-second result: speech, 716 ms of quiet,
// a 68 ms burst, another quiet gap, a sharp pulse, and a small residual.
function compoundTail(time, { precedingSpeech = true, firstWidth = 0.068, sharpLast = true, clickPeak = 31000, residualPeak = 261 } = {}) {
  if (precedingSpeech && time >= 0.424 && time < 0.902) return 9000 * Math.sin(time * 1500);
  if (time >= 1.618 && time < 1.618 + firstWidth)
    return 14500 * Math.min(1, (time - 1.618) / 0.05) * Math.sin((time - 1.618) * 1700);
  if (time >= 1.839 && time < 1.854)
    return clickPeak * (sharpLast ? 1 : (time - 1.839) / 0.015) * Math.sin((time - 1.839) * 1700);
  return time >= 1.871 && time < 1.877 ? residualPeak * Math.sin((time - 1.871) * 3000) : 0;
}

test('ignores a low residual after a sharp click and preserves an earlier short sound', async t => {
  const source = wav({ duration: 1.88, signal: time => compoundTail(time) });
  const { file, output } = await fixture(t, source), a = await analyzeTail(file);
  assert.equal(a.detected, true);
  assert(a.cutSeconds > 1.82 && a.cutSeconds < 1.839);
  await trimTail(file, output, a);
  const cleaned = await readFile(output);
  assert.deepEqual(cleaned.subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
  assert.equal((await analyzeTail(output)).detected, false);
});

for (const [name, options] of [
  ['a short utterance followed by a click', { precedingSpeech: false }],
  ['a normal final syllable followed by a click', { firstWidth: 0.1 }],
]) test(`tail-click removal preserves ${name}`, async t => {
  const source = wav({ duration: 1.88, signal: time => compoundTail(time, options) });
  const { file, output } = await fixture(t, source), a = await analyzeTail(file);
  assert.equal(a.detected, true);
  assert(a.cutSeconds > 1.82 && a.cutSeconds < 1.839);
  await trimTail(file, output, a);
  assert.deepEqual((await readFile(output)).subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
});

for (const [name, options] of [
  ['a long terminal sound before a click', { firstWidth: 0.2 }],
  ['two slowly rising short sounds without a sharp pulse', { sharpLast: false }],
  ['a separated residual louder than the absolute noise limit', { residualPeak: 340 }],
  ['a separated residual louder than one percent of the click', { clickPeak: 10000 }],
]) test(`tail-click detection preserves ${name}`, async t => {
  const { file } = await fixture(t, wav({ duration: 1.88, signal: time => compoundTail(time, options) }));
  assert.equal((await analyzeTail(file)).detected, false);
});

test('tail-click detection preserves the only utterance after long leading silence', async t => {
  const { file } = await fixture(t, wav({ duration: 1.88, signal: time => time > 1.61075
    ? 23280 * Math.min(1, (time - 1.61075) / 0.1) * Math.sin(time * 1500) : 0 }));
  assert.equal((await analyzeTail(file)).detected, false);
});

for (const [name, options] of [
  ['normal speech followed by silence', {}],
  ['silent file', { signal: () => 0 }],
  ['continuous music under the impulse', { signal: (time, channel) => pulse(time, channel) + 400 * Math.sin(time * 1300) }],
  ['speech continuing into the impulse', { signal: (time, channel) => time > 0.8 && time < 0.954 ? 3000 * Math.sin(time * 2300) : pulse(time, channel) }],
  ['a final syllable or longer burst', { signal: time => time > 0.91 && time < 0.98 ? 9000 * Math.sin(time * 1700) : speech(time) }],
  ['a normal fading ending', { signal: time => time > 0.8 ? 9000 * (1 - time) * Math.sin(time * 1800) : speech(time) }],
  ['a slow-rising short ending', { signal: time => time >= 0.96 && time < 0.98 ? 14000 * (time - 0.96) / 0.02 : speech(time) }],
  ['a pulse without trailing quiet', { signal: time => time > 0.995 ? 15000 : speech(time) }],
  ['a pulse too far from the end', { signal: time => time > 0.81 && time < 0.815 ? 15000 : speech(time) }],
  ['a low-volume tail', { signal: time => time > 0.955 && time < 0.96 ? 500 : speech(time) }],
  ['a normal final syllable after a long pause', { signal: time => time < 0.4 ? speech(time) : time > 0.88 ? 9000 * Math.sin(time * 1700) * Math.sin((time - 0.88) / 0.12 * Math.PI) : 0 }],
  ['a low-volume breath after a long pause', { signal: time => time < 0.4 ? speech(time) : time > 0.93 && time < 0.98 ? 900 * Math.sin(time * 14000) : 0 }],
  ['a slowly rising breath after a long pause', { signal: time => time < 0.4 ? speech(time) : time > 0.93 && time < 0.98 ? 8000 * Math.min(1, (time - 0.93) / 0.02) : 0 }],
  ['a longer burst after a long pause', { signal: time => time < 0.4 ? speech(time) : time > 0.9 && time < 0.99 ? 12000 * Math.sin(time * 14000) : 0 }],
  ['a wider burst with insufficient quiet before it', { signal: time => time > 0.93 && time < 0.985 ? 12000 * Math.sin(time * 14000) : speech(time) }],
  ['a wider burst still loud at the file ending', { signal: time => time < 0.4 ? speech(time) : time > 0.95 ? 12000 * Math.sin(time * 14000) : 0 }],
  ['a short file with no speech context', { duration: 0.2, signal: time => time > 0.16 && time < 0.165 ? 15000 : 0 }],
]) test(`leaves ${name} untouched`, async t => {
  const source = wav(options), { file, output } = await fixture(t, source), a = await analyzeTail(file);
  assert.equal(a.detected, false);
  await assert.rejects(trimTail(file, output, a));
  await assert.rejects(access(output));
  assert.deepEqual(await readFile(file), source);
});

test('preserves existing destinations and refuses stale or caller-invented cuts', async t => {
  const { file, output } = await fixture(t, wav({ signal: pulse })), a = await analyzeTail(file);
  await assert.rejects(trimTail(file, output, { ...a, cutFrame: a.cutFrame - 50 }));
  await assert.rejects(access(output));
  await writeFile(output, 'existing audio');
  await assert.rejects(trimTail(file, output, a), { code: 'EEXIST' });
  assert.equal(await readFile(output, 'utf8'), 'existing audio');
  await assert.rejects(trimTail(file, file, a), { code: 'EEXIST' });
  await writeFile(file, wav());
  await assert.rejects(trimTail(file, join(output, '..', 'other.wav'), a));
});

test('reads RIFF metadata and odd-size padding without mistaking it for audio', async t => {
  const source = wav({ signal: pulse }), metadata = Buffer.alloc(10);
  metadata.write('JUNK'); metadata.writeUInt32LE(1, 4); metadata[8] = 42;
  const extended = Buffer.concat([source.subarray(0, 36), metadata, source.subarray(36)]);
  extended.writeUInt32LE(extended.length - 8, 4);
  const { file, output } = await fixture(t, extended), a = await analyzeTail(file);
  assert.equal(a.detected, true); await trimTail(file, output, a);
  assert.deepEqual((await readFile(output)).subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
});

test('unsupported encodings and malformed PCM cannot produce a trim candidate', async t => {
  const { file } = await fixture(t, Buffer.alloc(0));
  const float = wav({ signal: pulse }); float.writeUInt16LE(3, 20);
  const badAlign = wav({ signal: pulse }); badAlign.writeUInt16LE(1, 32);
  const badChunk = wav({ signal: pulse }); badChunk.writeUInt32LE(badChunk.length, 40);
  const partialFrame = wav({ signal: pulse }); partialFrame.writeUInt32LE(partialFrame.length - 45, 40);
  for (const bytes of [Buffer.from('ID3 compressed audio'), float, badAlign, badChunk, partialFrame, wav().subarray(0, 100)]) {
    await writeFile(file, bytes);
    assert.deepEqual(await analyzeTail(file), { detected: false, reason: 'unsupported_format' });
  }
});

test('long trailing quiet is shortened to 250 ms without changing any retained sample', async t => {
  for (const [channels, sampleRate] of [[1, 8000], [2, 44100], [2, 48000], [1, 192000]]) {
    const source = wav({ duration: 3, channels, sampleRate, signal: time => time < 1 ? speech(time) : 0 });
    const { file, output } = await fixture(t, source), a = await analyzeTail(file);
    assert.equal(a.detected, true); assert.equal(a.reason, 'long_tail_silence');
    assert.ok(Math.abs(a.cutSeconds - 0.9) < 0.001);
    await trimTail(file, output, a);
    const cleaned = await readFile(output);
    assert.deepEqual(cleaned.subarray(44), source.subarray(44, 44 + a.cutFrame * channels * 2));
    assert.equal(cleaned.readUInt16LE(22), channels); assert.equal(cleaned.readUInt32LE(24), sampleRate);
    assert.equal((await analyzeTail(output)).detected, false);
  }
});

test('long quiet uses both channels and preserves leading/inter-word pauses and a quiet final syllable', async t => {
  const source = wav({ duration: 4, signal: (time, channel) => {
    if (time > 0.4 && time < 0.6) return speech(time);
    return channel && time > 1.8 && time < 2.2 ? 40 * Math.sin(time * 1900) : 0;
  } });
  const { file, output } = await fixture(t, source), a = await analyzeTail(file);
  assert.equal(a.detected, true); assert.ok(Math.abs(a.cutSeconds - 2.45) < 0.001);
  await trimTail(file, output, a);
  assert.deepEqual((await readFile(output)).subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
});

for (const [name, options] of [
  ['a normal pause shorter than 800 ms', { duration: 1.44 }],
  ['an entirely silent result', { duration: 3, signal: () => 0 }],
  ['only a low noise floor with no voice', { duration: 3, signal: time => 20 * Math.sin(time * 1700) }],
  ['very quiet speech continuing in the right channel', { duration: 3, signal: (time, channel) => channel ? 40 * Math.sin(time * 1500) : 0 }],
]) test(`long-silence cleanup preserves ${name}`, async t => {
  const { file } = await fixture(t, wav(options));
  assert.equal((await analyzeTail(file)).detected, false);
});

test('the 800 ms boundary is frame-accurate and low-level trailing noise also counts as quiet', async t => {
  const { file, output } = await fixture(t, Buffer.alloc(0));
  for (const quietFrames of [38399, 38400]) {
    const source = wav({ duration: (48000 + quietFrames) / 48000, signal: time => time < 1 ? 6000 : 20 * Math.sin(time * 1800) });
    await writeFile(file, source); const a = await analyzeTail(file);
    assert.equal(a.detected, quietFrames === 38400);
    if (a.detected) {
      assert.ok(Math.abs(a.cutSeconds - 1.25) < 0.005);
      await trimTail(file, output, a);
      assert.equal((await analyzeTail(output)).detected, false);
    }
  }
});

test('click removal also trims the long quiet exposed before the click in the same pass', async t => {
  const source = wav({ duration: 3, signal: time => time > 2.955 && time < 2.96
    ? 15000 * Math.sin((time - 2.955) * 12000) : speech(time) });
  const { file, output } = await fixture(t, source), a = await analyzeTail(file);
  assert.equal(a.detected, true); assert.ok(Math.abs(a.cutSeconds - 0.9) < 0.001);
  await trimTail(file, output, a);
  assert.deepEqual((await readFile(output)).subarray(44), source.subarray(44, 44 + a.cutFrame * 4));
  assert.equal((await analyzeTail(output)).detected, false);
});
