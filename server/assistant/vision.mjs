import { randomInt } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpeg, runMediaProcess as exec } from '../audio.mjs';
import { fail, same, text, uid } from '../store.mjs';

export async function verifyVision(store, model, p) {
  if (!p || Object.keys(p).some(k => !['approved', 'requestId'].includes(k))) fail('识图验证参数无效');
  if (p.approved !== true) fail('识图验证会向当前助手模型发送一张随机测试图并消耗一次请求，请明确确认', 403);
  const expected = model.identity(); model.assertReady({ images: true, verifying: true, expected });
  const id = p.requestId === undefined ? uid() : text(p.requestId, '识图验证标识', 100), old = store.maybe('settings', 'assistant-vision:' + id);
  if (old) { if (!same(old.connection, expected)) fail('模型连接已变化，请重新确认识图验证',409); if (old.state !== 'completed') fail('此验证请求结果尚未确认，未重复发送', 409); return { ...model.publicSettings(), passed: old.passed }; }
  // Only pixels carry the random answer. The filename, prompt, and settings
  // contain no code, colour order, or alternate text revealing that answer.
  const colours = [[235, 30, 35], [20, 190, 65], [25, 70, 235], [245, 210, 25]], letters = 'RGBY';
  const cells = Array.from({ length: 25 }, () => randomInt(4));
  const pixels = Buffer.alloc(500 * 500 * 3);
  for (let y = 0; y < 500; y++) for (let x = 0; x < 500; x++) {
    const border = x % 100 < 4 || y % 100 < 4 || x >= 496 || y >= 496;
    const rgb = border ? [255, 255, 255] : colours[cells[Math.floor(y / 100) * 5 + Math.floor(x / 100)]];
    pixels.set(rgb, (y * 500 + x) * 3);
  }
  const directory = await mkdtemp(join(tmpdir(), 'workbench-vision-'));
  try {
    await writeFile(join(directory, 'image.ppm'), Buffer.concat([Buffer.from('P6\n500 500\n255\n'), pixels]));
    await exec(ffmpeg, ['-nostdin', '-v', 'error', '-i', join(directory, 'image.ppm'), '-frames:v', '1', join(directory, 'image.png')], { timeout: 15000 });
    const data = await readFile(join(directory, 'image.png'));
    store.put('settings', { id: 'assistant-vision:' + id, state: 'sending', connection: expected, at: new Date().toISOString() });
    const result = await model.generate({ expected, verifying: true, messages: [{ role: 'user', content: [
      { type: 'text', text: '读取图片5行5列的彩色格子，从上到下逐行、每行从左到右。红=R，绿=G，蓝=B，黄=Y。只回答25个字母，不要解释。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + data.toString('base64') } },
    ] }] });
    const passed = result.content.replace(/\s/g, '').toUpperCase() === cells.map(i => letters[i]).join('');
    store.put('settings', { id: 'assistant-vision:' + id, state: 'completed', passed, connection: expected, providerRequestId: result.providerRequestId, at: result.receivedAt });
    if (passed) model.recordVisionVerification(expected, { passed, providerRequestId: result.providerRequestId || id, attachmentId: id });
    return { ...model.publicSettings(), passed };
  } finally { await rm(directory, { recursive: true, force: true }); }
}
