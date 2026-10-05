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
  copyFile,
} from "node:fs/promises";
import { constants, existsSync, rmSync, statSync, renameSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { projectFile, projectExportFile } from './workspace.mjs';
import { fail, uid, text } from "./store.mjs";
import { createLocalPool } from './scheduler.mjs';
const nativeExec = promisify(execFile), mediaProcesses = createLocalPool(1);
// ponytail: one native media process per server keeps uploads and background
// rendering within the same CPU ceiling; raise only after measured headroom.
export function runMediaProcess(file, args, options = {}) {
  const timeout = options.timeout ?? 300000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2147483647) return Promise.reject(new Error('媒体处理时限应为有效的正整数毫秒数'));
  // The timeout starts after admission, so waiting behind another local task is
  // not counted as a stalled child. Kill a stalled child before releasing its slot.
  return mediaProcesses.run(() => nativeExec(file, args, { ...options, timeout, killSignal: 'SIGKILL' }));
}
export const mediaProcessActivity = () => ({ active: mediaProcesses.active, queued: mediaProcesses.queued, peak: mediaProcesses.peak, limit: 1 });
const exec = runMediaProcess;
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
    { maxBuffer: 1024 * 1024, timeout: 30000 },
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
    { maxBuffer: 1024 * 1024, timeout: 120000 },
  );
  return {
    duration: Number(meta.format.duration),
    sampleRate: Number(stream.sample_rate),
    channels: stream.channels,
    format: meta.format.format_name,
  };
}
// Keep successful and failed checks across restarts while file metadata matches.
// Changed or restored files are decoded again; no content hash or full reread.
const audioChecks = new WeakMap();
function fileVersion(file) {
  try { const s = statSync(file); return s.isFile() ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":") : null; }
  catch { return null; }
}
export function storedAudioUnavailable(store, a) {
  const file = join(store.directory, a.path), version = fileVersion(file);
  const check = audioChecks.get(store)?.get(a.id);
  return !version || !!a.invalid || !!(check && (check.path !== a.path || check.version !== version || check.pending || !check.valid));
}
export async function validateStoredAudio(store, a) {
  let checks = audioChecks.get(store);
  if (!checks) { checks = new Map(); audioChecks.set(store, checks); }
  const file = join(store.directory, a.path), version = fileVersion(file);
  const previous = checks.get(a.id);
  if (previous?.path === a.path && previous.version === version) return previous.promise;
  const retained = store.maybe('audios', a.id), cacheId = 'audio-file-check:' + a.id;
  const cached = retained?.path === a.path ? store.maybe('settings', cacheId) : null;
  const check = {path:a.path, version, pending:true, valid:false};
  checks.set(a.id, check);
  check.promise = (async () => {
    let valid = false;
    try {
      if (cached?.path === a.path && cached.version === version && typeof cached.valid === 'boolean' && cached.valid === !retained.invalid) valid = cached.valid;
      else if (version) { await inspect(file); valid = true; }
    }
    catch (e) {
      // A missing decoder is a setup failure, not evidence that the file is bad.
      if (['ENOENT','EACCES'].includes(e.code) && [ffmpeg,ffprobe].includes(e.path)) {
        checks.delete(a.id); throw e;
      }
    }
    if (fileVersion(file) !== version) return false;
    check.pending = false; check.valid = valid;
    const current = store.maybe('audios', a.id);
    if (current?.path === a.path) {
      const parent = current.chapterId || store.db.prepare('SELECT parent FROM audios WHERE id=?').get(a.id).parent;
      if (!!current.invalid !== !valid) {
        if (valid) delete current.invalid; else current.invalid = true;
        store.put('audios', current, parent);
      }
      if (cached?.path !== a.path || cached.version !== version || cached.valid !== valid)
        store.put('settings', {id:cacheId, audioId:a.id, chapterId:parent, path:a.path, version, valid}, parent);
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
  if (typeof p.filename !== 'string' || p.filename.length > 260 || !/\.(wav|mp3)$/i.test(p.filename))
    fail("请选择 WAV 或 MP3 参考文件");
  const bytes = Buffer.from(p.data, "base64");
  if (!bytes.length || bytes.length > 10 * 1024 * 1024)
    fail("参考文件应为 1 字节～10 MB");
  if (p.uploadId !== undefined && (typeof p.uploadId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(p.uploadId))) fail('上传标识无效');
  const id = p.uploadId || uid(),
    path = `voices/${id}.${p.filename.split(".").pop().toLowerCase()}`;
  const existingVoice = () => {
    const existing = store.maybe('voices',id);
    if (!existing) return null;
    if (existing.uploadId !== p.uploadId || existing.uploadName !== p.name.trim() || existing.uploadFilename !== p.filename || !existing.path || !existsSync(join(store.directory,existing.path)) || !readFileSync(join(store.directory,existing.path)).equals(bytes)) fail('同一上传标识的素材已改变，请保留现有声音并重新选择',409);
    return existing;
  };
  const previous = p.uploadId && existingVoice();
  if (previous) return previous;
  const file = join(store.directory, path);
  const temp = file + `.${uid()}.part`;
  await mkdir(join(store.directory, "voices"), { recursive: true });
  try {
    await writeFile(temp, bytes);
    const info = await inspect(temp);
    if (info.duration > 30) fail("参考声音超过 30 秒，请先截取一段");
    if (!/(wav|mp3)/.test(info.format)) fail("文件内容不是 WAV 或 MP3");
    const voice = {
      id,
      ...(p.uploadId ? {uploadId:p.uploadId,uploadName:p.name.trim(),uploadFilename:p.filename} : {}),
      name: p.name.trim(),
      path,
      state: "active",
      tested: false,
      ...info,
      bytes: bytes.length,
      createdAt: new Date().toISOString(),
    };
    return store.transaction(()=>{
      const existing = p.uploadId && existingVoice();
      if (existing) return existing;
      renameSync(temp,file);store.put("voices",voice);return voice;
    });
  } finally { await rm(temp,{force:true}); }
}
// Candidate and reference have separate paths: deleting either resource cannot
// remove the other. The source audio primary key makes save retries idempotent.
export async function saveCandidateVoice(store, p) {
  const audio = store.get("audios", p.audioId);
  if (audio.targetKind !== "candidate" && audio.input?.targetKind !== "candidate") fail("请选择声音创建的真实候选");
  const existing = store.maybe("voices", audio.id);
  if (existing) {
    if (existing.sourceAudioId !== audio.id) fail("候选身份冲突，请保留原文件并检查", 409);
    return existing;
  }
  const name = text(p.name, "音色名称", 100).trim();
  const attempt = store.get("attempts", audio.id);
  if (attempt.discarded || attempt.status !== "success") fail("候选已放弃或尚未完整确认");
  const source = join(store.directory, audio.path), sourceVersion = fileVersion(source);
  const bytes = statSync(source).size;
  if (!bytes || bytes > 10 * 1024 * 1024) fail("候选参考应为 1 字节～10 MB；请重新生成较短候选");
  const info = await inspect(source);
  if (info.duration > 30 || !/^(wav|mp3)$/.test(info.format)) fail("候选不符合 WAV/MP3、最长 30 秒参考规格；原候选已保留");
  const path = `voices/${audio.id}.${info.format === "mp3" ? "mp3" : "wav"}`;
  await mkdir(join(store.directory, "voices"), { recursive: true });
  const temp = join(store.directory, path + `.${uid()}.part`);
  try {
    await copyFile(source, temp);
    if (fileVersion(source) !== sourceVersion || statSync(temp).size !== bytes) fail("候选文件已变化，请重新核对", 409);
    await inspect(temp);
    return store.transaction(() => {
      const saved = store.maybe("voices", audio.id);
      if (saved) {
        if (saved.sourceAudioId !== audio.id) fail("候选身份冲突", 409);
        return saved;
      }
      const current = store.get("audios", audio.id), latest = store.get("attempts", audio.id);
      if (current.path !== audio.path || current.invalid || latest.discarded || latest.status !== "success" || fileVersion(source) !== sourceVersion) fail("候选已变化，请重新试听确认", 409);
      // Rename and DB registration are separate durable steps. A crash between
      // them leaves only this fixed-path copy; the same save safely replaces it.
      renameSync(temp, join(store.directory, path));
      return store.put("voices", { id: audio.id, name, path, state: "active", revision: 1, tested: false, ...info, bytes, sourceAudioId: audio.id, sourceSessionId: audio.input.sessionId || latest.targetId, source: { description: audio.input.description, text: audio.input.text, prompt: audio.prompt, model: audio.model || audio.input.model, template: audio.input.template, input: audio.input }, createdAt: new Date().toISOString() });
    });
  } finally {
    await rm(temp, { force: true });
  }
}
export async function buildMaster(store, segments, gap, id) {
  const path = projectFile(store, segments[0]?.s.chapterId, 'masters', `${id}.wav`);
  const base = join(store.directory, path.slice(0, -4));
  await mkdir(dirname(base), { recursive: true });
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
          ...(s.kind === "group" ? {} : {segmentId: s.members?.[0] || s.id}),
          ...(s.unitId ? { unitId: s.unitId, memberIds: s.members, mode: s.mode } : {}),
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
      path,
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
  const path = projectExportFile(store, { chapterId: master.chapterId, arrangement: master.arrangement, id, format }),
    file = join(store.directory, path);
  await mkdir(dirname(file), { recursive: true });
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
        .some((a) => (a.input.referenceVoiceIds || (a.input.voiceId ? [a.input.voiceId] : [])).includes(v.id) && (a.status === "sending" || a.phase === 'preparing'))
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
