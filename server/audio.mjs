import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  access,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  appendFile,
} from "node:fs/promises";
import { constants, existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail, uid } from "./store.mjs";
const exec = promisify(execFile);
export const ffmpeg =
  process.env.FFMPEG_PATH ||
  (existsSync(`${process.env.HOME}/.local/bin/ffmpeg`)
    ? `${process.env.HOME}/.local/bin/ffmpeg`
    : "ffmpeg");
export const ffprobe =
  process.env.FFPROBE_PATH || ffmpeg.replace(/ffmpeg$/, "ffprobe");
export async function inspect(file) {
  const { stdout } = await exec(
    ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name:stream=codec_type,sample_rate,channels",
      "-of",
      "json",
      file,
    ],
    { maxBuffer: 1024 * 1024 },
  );
  const meta = JSON.parse(stdout);
  const stream = meta.streams.find((s) => s.codec_type === "audio");
  if (
    !stream ||
    !Number.isFinite(Number(meta.format.duration)) ||
    Number(meta.format.duration) <= 0
  )
    fail("文件不含可播放的音频");
  await exec(
    ffmpeg,
    ["-v", "error", "-xerror", "-i", file, "-f", "null", "-"],
    { maxBuffer: 1024 * 1024 },
  );
  return {
    duration: Number(meta.format.duration),
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    format: meta.format.format_name,
  };
}
// Cache decoding only while the local file metadata is unchanged. No content hash,
// and no full decode on every chapter poll; restored files are inspected again.
const audioChecks = new WeakMap();
function fileVersion(file) {
  try { const s = statSync(file); return s.isFile() ? [s.size, s.mtimeMs, s.ctimeMs, s.ino].join(":") : null; }
  catch { return null; }
}
export function storedAudioUnavailable(store, a) {
  const file = join(store.directory, a.path), version = fileVersion(file);
  const check = audioChecks.get(store)?.get(a.id);
  return !version || !!a.invalid || !!(check && (check.version !== version || check.pending || !check.valid));
}
export async function validateStoredAudio(store, a) {
  let checks = audioChecks.get(store);
  if (!checks) { checks = new Map(); audioChecks.set(store, checks); }
  const file = join(store.directory, a.path), version = fileVersion(file);
  const previous = checks.get(a.id);
  if (previous?.version === version) return previous.promise;
  const check = {version, pending:true, valid:false};
  checks.set(a.id, check);
  check.promise = (async () => {
    let valid = false;
    try { if (version) { await inspect(file); valid = true; } }
    catch (e) {
      // A missing decoder is a setup failure, not evidence that the file is bad.
      if (['ENOENT','EACCES'].includes(e.code) && [ffmpeg,ffprobe].includes(e.path)) {
        checks.delete(a.id); throw e;
      }
    }
    if (fileVersion(file) !== version) return false;
    check.pending = false; check.valid = valid;
    const current = store.maybe('audios', a.id);
    if (current?.path === a.path && !!current.invalid !== !valid) {
      if (valid) delete current.invalid; else current.invalid = true;
      store.put('audios', current, current.chapterId || store.db.prepare('SELECT parent FROM audios WHERE id=?').get(a.id).parent);
    }
    return valid;
  })();
  return check.promise;
}
export async function uploadVoice(store, p) {
  if (typeof p.name !== "string" || !p.name.trim() || p.name.length > 100)
    fail("请填写音色名称");
  if (
    typeof p.data !== "string" ||
    p.data.length > 14 * 1024 * 1024 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(p.data)
  )
    fail("参考文件格式错误或大于 10 MB");
  if (!/\.(wav|mp3)$/i.test(p.filename || ""))
    fail("请选择 WAV 或 MP3 参考文件");
  const bytes = Buffer.from(p.data, "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    fail("参考文件应为 1 字节～10 MB");
  const id = uid(),
    path = `voices/${id}.${p.filename.split(".").pop().toLowerCase()}`;
  const file = join(store.directory, path);
  await mkdir(join(store.directory, "voices"), { recursive: true });
  await writeFile(file + ".part", bytes);
  try {
    const info = await inspect(file + ".part");
    if (info.duration > 30) fail("参考声音超过 30 秒，请先截取一段");
    if (!/(wav|mp3)/.test(info.format)) fail("文件内容不是 WAV 或 MP3");
    await rename(file + ".part", file);
    const voice = {
      id,
      name: p.name.trim(),
      path,
      state: "active",
      tested: false,
      ...info,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    store.put("voices", voice);
    return voice;
  } catch (e) {
    await rm(file + ".part", { force: true });
    throw e;
  }
}
export async function buildMaster(store, segments, gap, id) {
  await mkdir(join(store.directory, "masters"), { recursive: true });
  const base = join(store.directory, "masters", id);
  const pcm = base + ".pcm.part";
  await writeFile(pcm, Buffer.alloc(0));
  let cursor = 0;
  const mapping = [];
  const gapFrames = Math.round(gap * 48000);
  try {
    for (let i = 0; i < segments.length; i++) {
      const { s, a } = segments[i];
      const temp = base + `-${i}.pcm.part`;
      try {
        await exec(ffmpeg, [
          "-v",
          "error",
          "-xerror",
          "-i",
          join(store.directory, a.path),
          "-ar",
          "48000",
          "-ac",
          "1",
          "-f",
          "s16le",
          "-y",
          temp,
        ]);
        const raw = await readFile(temp);
        if (!raw.length || raw.length % 2) fail("音频采样帧不完整");
        const frames = raw.length / 2;
        await appendFile(pcm, raw);
        mapping.push({
          segmentId: s.id,
          audioId: a.id,
          startFrame: cursor,
          endFrame: cursor + frames,
        });
        cursor += frames;
        if (i < segments.length - 1) {
          await appendFile(pcm, Buffer.alloc(gapFrames * 2));
          cursor += gapFrames;
        }
      } finally {
        await rm(temp, { force: true });
      }
    }
    await exec(ffmpeg, [
      "-v",
      "error",
      "-f",
      "s16le",
      "-ar",
      "48000",
      "-ac",
      "1",
      "-i",
      pcm,
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-y",
      base + ".wav.part",
    ]);
    const info = await inspect(base + ".wav.part");
    if (Math.abs(info.duration * 48000 - cursor) > 1) fail("母版帧数校验失败");
    await rename(base + ".wav.part", base + ".wav");
    return {
      path: `masters/${id}.wav`,
      frames: cursor,
      mapping,
      sampleRate: 48000,
      channels: 1,
      gapFrames,
      processing: "pcm_s16le-48000-mono",
      duration: cursor / 48000,
    };
  } finally {
    await rm(pcm, { force: true });
  }
}
export async function exportMaster(store, master, id, format) {
  await mkdir(join(store.directory, "exports"), { recursive: true });
  const path = `exports/${id}.${format}`,
    file = join(store.directory, path);
  if (format === "wav")
    await writeFile(
      file + ".part",
      await readFile(join(store.directory, master.path)),
    );
  else
    await exec(ffmpeg, [
      "-v",
      "error",
      "-i",
      join(store.directory, master.path),
      "-c:a",
      "libmp3lame",
      "-b:a",
      "192k",
      "-f",
      "mp3",
      "-y",
      file + ".part",
    ]);
  await inspect(file + ".part");
  await rename(file + ".part", file);
  return path;
}
export async function toolsAvailable() {
  try {
    await exec(ffmpeg, ["-version"]);
    await exec(ffprobe, ["-version"]);
    return true;
  } catch {
    return false;
  }
}

export function drainReferenceDeletes(store, reading = new Map()) {
  for (const v of store.all("voices").filter((v) => v.deletePending)) {
    if (
      reading.get(v.id) ||
      store
        .all("attempts")
        .some((a) => a.input.voiceId === v.id && a.status === "sending")
    )
      continue;
    try {
      rmSync(join(store.directory, v.path), { force: true });
      v.path = null;
      v.state = "deleted";
      v.deletePending = false;
      delete v.deleteError;
    } catch {
      v.deleteError = "文件暂时无法删除，将在空闲时重试";
    }
    store.put("voices", v);
  }
}
