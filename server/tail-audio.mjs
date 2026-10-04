import { open, rm } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

async function pcmWave(file, use) {
  const handle = await open(file, 'r');
  try {
    const size = (await handle.stat()).size;
    const read = async (length, position) => {
      const buffer = Buffer.alloc(length);
      if ((await handle.read(buffer, 0, length, position)).bytesRead !== length) throw new Error('音频文件不完整');
      return buffer;
    };
    if (size < 44) return null;
    const header = await read(12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
    if (header.readUInt32LE(4) + 8 !== size) return null;
    let format, data, at = 12;
    while (at + 8 <= size) {
      const chunk = await read(8, at), length = chunk.readUInt32LE(4), kind = chunk.toString('ascii', 0, 4);
      if (at + 8 + length > size) return null;
      if (kind === 'fmt ') {
        if (format || length < 16) return null;
        format = await read(16, at + 8);
      } else if (kind === 'data') {
        if (data) return null;
        data = { offset: at + 8, length };
      }
      at += 8 + length + (length % 2);
    }
    if (at !== size || !format || !data || format.readUInt16LE(0) !== 1 || format.readUInt16LE(14) !== 16) return null;
    const channels = format.readUInt16LE(2), sampleRate = format.readUInt32LE(4), blockAlign = format.readUInt16LE(12);
    if (![1, 2].includes(channels) || sampleRate < 8000 || sampleRate > 192000 || blockAlign !== channels * 2 ||
      format.readUInt32LE(8) !== sampleRate * blockAlign || data.length % blockAlign) return null;
    return await use({ ...data, channels, sampleRate, blockAlign, frames: data.length / blockAlign, read });
  } finally { await handle.close(); }
}

async function analyzePulse({ offset, frames, sampleRate, channels, blockAlign, read }) {
  const duration = frames / sampleRate;
  const result = { detected: false, reason: 'no_isolated_pulse', duration, sampleRate, channels };
  if (duration < 0.5) return { ...result, reason: 'too_short' };
  const count = Math.min(frames, Math.ceil(sampleRate * 0.6));
  const pcm = await read(count * blockAlign, offset + (frames - count) * blockAlign);
  const levels = new Uint16Array(count);
  for (let frame = 0; frame < count; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      levels[frame] = Math.max(levels[frame], Math.abs(pcm.readInt16LE(frame * blockAlign + channel * 2)));
    }
  }
  // ponytail: a signal heuristic cannot distinguish an intentional isolated effect.
  // Call only for dry speech; ambiguous short utterances/effects ultimately need semantic detection.
  const searchStart = count - Math.ceil(sampleRate * 0.15);
  let peak = 0;
  const clusters = [];
  for (let i = searchStart; i < count; i++) {
    peak = Math.max(peak, levels[i]);
    if (levels[i] <= 100) continue;
    let cluster = clusters.at(-1);
    if (!cluster || i - cluster.end >= sampleRate * 0.005) {
      cluster = { start: i, end: i + 1, peak: 0 }; clusters.push(cluster);
    }
    cluster.end = i + 1; cluster.peak = Math.max(cluster.peak, levels[i]);
  }
  if (peak < 3277) return result;
  // A faint, separated residual must not turn a short click into a wider burst requiring
  // 400 ms of preceding quiet. Keep both the absolute and relative noise limits;
  // earlier sounds still constrain the unchanged isolation check.
  const audible = clusters.filter(cluster => cluster.peak > Math.min(327, peak * 0.01));
  const start = audible[0].start, end = audible.at(-1).end;
  const shortPulse = end - start <= sampleRate * 0.025;
  const trailingQuiet = count - end >= sampleRate * 0.005;
  // Wider terminal bursts need four times as much preceding quiet. Some provider bursts decay
  // to a tiny residual instead of literal silence at EOF; require the whole last millisecond to be quiet.
  const decayedEnd = levels.subarray(count - Math.ceil(sampleRate * 0.001)).every(value => value <= Math.min(327, peak * 0.01));
  if (shortPulse ? !trailingQuiet : end - start > sampleRate * 0.08 || count - start > sampleRate * 0.1 || (!trailingQuiet && !decayedEnd))
    return { ...result, reason: 'uncertain_tail' };
  const before = start - Math.ceil(sampleRate * (shortPulse ? 0.1 : 0.4));
  if (before < 0 || levels.subarray(before, start).some(value => value > 100)) return { ...result, reason: 'not_isolated' };
  const rise10 = levels.findIndex((value, i) => i >= start && value >= peak * 0.1);
  const rise50 = levels.findIndex((value, i) => i >= start && value >= peak * 0.5);
  if (rise50 - rise10 > sampleRate * 0.003) return { ...result, reason: 'uncertain_tail' };
  let cut = start - Math.ceil(sampleRate * 0.008);
  for (let i = cut + 1; i <= start - Math.ceil(sampleRate * 0.003); i++) if (levels[i] < levels[cut]) cut = i;
  if (levels[cut] > 10) return { ...result, reason: 'no_quiet_cut' };
  // cut points to the final retained frame, so even the last sample stays close to zero.
  const cutFrame = frames - count + cut + 1;
  return { ...result, detected: true, reason: 'isolated_tail_pulse', cutFrame, cutSeconds: cutFrame / sampleRate,
    removedSeconds: (frames - cutFrame) / sampleRate, pulseStartSeconds: (frames - count + start) / sampleRate,
    pulseEndSeconds: (frames - count + end) / sampleRate, peak };
}

async function lastSoundFrame({ offset, sampleRate, channels, blockAlign, read }, end) {
  // Scan backwards in bounded chunks, using every channel so a quiet/silent left channel
  // cannot hide speech in the right. A wholly silent result must not become an empty file.
  while (end > 0) {
    const start = Math.max(0, end - sampleRate), pcm = await read((end - start) * blockAlign, offset + start * blockAlign);
    for (let frame = end - start - 1; frame >= 0; frame--)
      for (let channel = 0; channel < channels; channel++)
        if (Math.abs(pcm.readInt16LE(frame * blockAlign + channel * 2)) > 32) return start + frame + 1;
    end = start;
  }
  return 0;
}

export async function analyzeTail(file) {
  return await pcmWave(file, async wave => {
    const pulse = await analyzePulse(wave), end = pulse.detected ? pulse.cutFrame : wave.frames;
    const soundEnd = await lastSoundFrame(wave, end);
    // ponytail: the -60 dBFS dry-speech threshold cannot identify words; quieter speech needs a speech-aware detector.
    // Keep 250 ms of release/breath; leave pauses shorter than 800 ms and all-silent results alone.
    if (!soundEnd || end - soundEnd < Math.ceil(wave.sampleRate * 0.8)) return pulse;
    let cutFrame = soundEnd + Math.round(wave.sampleRate * 0.25);
    const first = cutFrame - Math.ceil(wave.sampleRate * 0.005), count = Math.ceil(wave.sampleRate * 0.01);
    const pcm = await wave.read(count * wave.blockAlign, wave.offset + first * wave.blockAlign);
    let quietest = Infinity;
    for (let frame = 0; frame < count; frame++) {
      let level = 0;
      for (let channel = 0; channel < wave.channels; channel++)
        level = Math.max(level, Math.abs(pcm.readInt16LE(frame * wave.blockAlign + channel * 2)));
      if (level < quietest || (level === quietest && Math.abs(first + frame + 1 - soundEnd - wave.sampleRate * 0.25) <
        Math.abs(cutFrame - soundEnd - wave.sampleRate * 0.25))) { quietest = level; cutFrame = first + frame + 1; }
    }
    if (quietest > 10) return pulse;
    return { ...pulse, detected: true, reason: pulse.detected ? 'isolated_tail_pulse_and_silence' : 'long_tail_silence',
      cutFrame, cutSeconds: cutFrame / wave.sampleRate, removedSeconds: (wave.frames - cutFrame) / wave.sampleRate };
  }) ?? { detected: false, reason: 'unsupported_format' };
}

export async function trimTail(source, destination, analysis) {
  // Recheck the file rather than trusting an earlier analysis or a caller-supplied cut point.
  const current = await analyzeTail(source);
  if (!current.detected || !analysis?.detected || current.cutFrame !== analysis.cutFrame || current.duration !== analysis.duration)
    throw new Error('未找到可安全清理的尾部爆音或长空白，音频保持不变');
  await pcmWave(source, async ({ offset, sampleRate, channels, blockAlign }) => {
    const bytes = current.cutFrame * blockAlign, header = Buffer.alloc(44);
    header.write('RIFF'); header.writeUInt32LE(bytes + 36, 4); header.write('WAVEfmt ', 8);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * blockAlign, 28);
    header.writeUInt16LE(blockAlign, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(bytes, 40);
    const output = await open(destination, 'wx');
    try {
      await output.writeFile(header);
      await pipeline(createReadStream(source, { start: offset, end: offset + bytes - 1 }),
        createWriteStream(destination, { fd: output.fd, start: 44, autoClose: false }));
    } catch (error) {
      await output.close(); await rm(destination, { force: true }); throw error;
    }
    await output.close();
  });
  return current;
}
