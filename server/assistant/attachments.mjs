import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ffmpeg, ffprobe, runMediaProcess as exec } from '../audio.mjs';
import { fail, uid } from '../store.mjs';
import { deletionPath } from '../workspace.mjs';
import { reserveDiskSpace } from '../disk-space.mjs';

const maxBytes = 5 * 1024 * 1024, maxPixels = 16000000;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = message => fail(message, 400, { code: 'attachment-invalid' });

function imageKind(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    if (bytes.length < 24) invalid('图片头不完整');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > maxPixels) invalid('图片超过 1600 万像素，请先裁剪');
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      if (type === 'acTL') invalid('请使用静态截图，不支持动画图片');
      if (length > bytes.length - offset - 12) invalid('图片数据不完整');
      offset += length + 12;
    }
    return 'png';
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const tag = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
      if (tag === 'ANIM' || tag === 'ANMF') invalid('请使用静态截图，不支持动画图片');
      if (length > bytes.length - offset - 8) invalid('图片数据不完整');
      offset += 8 + length + length % 2;
    }
    return 'webp';
  }
  invalid('仅支持真实的 PNG、JPEG 或 WebP 静态图片');
}

export function createAttachments(store) {
  const pending = new Map();
  let closing = false;
  const session = id => {
    const s = store.get('assistantSessions', id);
    if (s.state !== 'active') fail('此会话已关闭，图片未发送', 409);
    if (s.projectId) store.get('projects', s.projectId);
    return s;
  };
  const publicRecord = a => ({ id: a.id, sessionId: a.sessionId, mime: a.mime, bytes: a.bytes, sourceBytes: a.sourceBytes, width: a.width, height: a.height, createdAt: a.createdAt });
  async function create(input) {
    if (closing) fail('助手正在停止，请保留输入稍后重试', 503);
    if (pending.size >= 2) fail('已有两张截图正在处理，请等上传完成后再添加', 429);
    const s = session(input.sessionId);
    if (typeof input.dataBase64 !== 'string' || input.dataBase64.length > Math.ceil(maxBytes / 3) * 4 || input.dataBase64.length % 4 || /[^A-Za-z0-9+/=]/.test(input.dataBase64)) invalid('图片编码无效或超过 5 MB');
    const source = Buffer.from(input.dataBase64, 'base64');
    if (!source.length || source.length > maxBytes || source.toString('base64') !== input.dataBase64) invalid('图片编码无效或超过 5 MB');
    const kind = imageKind(source), id = uid();
    if (input.mime !== `image/${kind}`) invalid('图片声明格式与实际内容不一致');
    const folder = s.projectId ? store.get('projects', s.projectId).folder || '' : '';
    const sourcePath = join(folder, 'assistant', 'attachments', `${id}.source.${kind}`);
    const path = join(folder, 'assistant', 'attachments', `${id}.png`), file = join(store.directory, path);
    // PNG also has a filter byte per row, including narrow images at the pixel limit.
    const lease=reserveDiskSpace(store.directory,source.length+maxPixels*4+65536,'截图保存');
    const work = (async () => {
      let saved = false;
      try {
        await mkdir(dirname(file), { recursive: true });
        await writeFile(join(store.directory, sourcePath), source, { flag: 'wx', mode: 0o600 });
        const { stdout } = await exec(ffprobe, ['-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-show_entries', 'stream=width,height,codec_type,codec_name', '-of', 'json', join(store.directory, sourcePath)], { timeout: 10000, maxBuffer: 65536 });
        const streams = JSON.parse(stdout).streams;
        const meta = streams?.find(v => v.codec_type === 'video');
        if (streams?.length !== 1 || !meta || !['png', 'mjpeg', 'webp'].includes(meta.codec_name) || !meta.width || !meta.height || meta.width * meta.height > maxPixels) invalid('图片尺寸或真实格式无效，请裁剪后重试');
        await exec(ffmpeg, ['-nostdin', '-v', 'error', '-max_alloc', '67108864', '-protocol_whitelist', 'file,pipe', '-i', join(store.directory, sourcePath), '-map_metadata', '-1', '-frames:v', '1', '-vf', 'format=rgb24', '-c:v', 'png', '-f', 'image2', file + '.part'], { timeout: 15000, maxBuffer: 65536 });
        const clean = await readFile(file + '.part');
        if (clean.length > maxBytes) invalid('保留截图清晰度后的图片超过 5 MB，请裁剪后再上传');
        session(s.id);
        await rename(file + '.part', file);
        session(s.id);
        // Bind the preview and later external send to the same pixels, even if a
        // local file is replaced between upload and message approval.
        const record = { id, sessionId: s.id, projectId: s.projectId || null, path, sourcePath, mime: 'image/png', hash: digest(clean), sourceHash: digest(source), bytes: clean.length, sourceBytes: source.length, width: meta.width, height: meta.height, createdAt: new Date().toISOString() };
        store.put('assistantAttachments', record, s.id); saved = true;
        return publicRecord(record);
      } catch (e) {
        if (e.status) throw e;
        invalid('图片无法完整解码，未上传；请换一张静态截图');
      } finally {
        try {
          await rm(file + '.part', { force: true });
          if (!saved) await Promise.all([rm(file, { force: true }), rm(join(store.directory, sourcePath), { force: true })]);
        } finally { lease.release(); }
      }
    })();
    pending.set(work, s.projectId);
    try { return await work; } finally { pending.delete(work); }
  }
  async function read(id, sessionId) {
    const a = store.get('assistantAttachments', id);
    if (a.sessionId !== sessionId) fail('图片不属于当前会话', 403);
    const data = await readFile(deletionPath(store, a.path));
    if (digest(data) !== a.hash) invalid('图片已改变，请重新上传后再发送');
    return { ...publicRecord(a), data };
  }
  async function imageParts(ids, sessionId) {
    if (!Array.isArray(ids) || ids.length > 2 || new Set(ids).size !== ids.length) invalid('每条消息最多附两张不同截图');
    const images = await Promise.all(ids.map(id => read(id, sessionId)));
    if (images.reduce((n, a) => n + a.bytes, 0) > 8 * 1024 * 1024) invalid('本条截图合计超过 8 MB，请移除或裁剪');
    return images.map(a => ({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data.toString('base64')}` } }));
  }
  async function removeSession(id) {
    await Promise.allSettled([...pending.keys()]);
    for (const a of store.all('assistantAttachments', id)) {
      for (const path of [a.path, a.sourcePath].filter(Boolean)) await rm(deletionPath(store, path), { force: true });
      store.remove('assistantAttachments', a.id);
    }
  }
  return { create, read, imageParts, publicRecord, removeSession, busy: projectId => [...pending.values()].includes(projectId), get active() { return pending.size; }, stop() { closing = true; }, async close() { closing = true; await Promise.allSettled([...pending.keys()]); } };
}
