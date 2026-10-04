import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { openStore } from '../server/store.mjs';
import { ffmpeg } from '../server/audio.mjs';
import { createAttachments } from '../server/assistant/attachments.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'assistant-images-')), store = openStore(dir);
  const attachments = createAttachments(store);
  store.put('projects', { id: 'p', name: '截图项目', folder: '截图项目' });
  for (const id of ['s1', 's2']) store.put('assistantSessions', { id, projectId: 'p', state: 'active' }, 'p');
  const png = join(dir, 'source.png');
  execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=green:s=160x80', '-frames:v', '1', png]);
  t.after(async () => { await attachments.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, attachments, data: readFileSync(png), input: { sessionId: 's1', mime: 'image/png', dataBase64: readFileSync(png).toString('base64') } };
}

test('实际图片解码后保留像素，受控项目目录存储，模型输入不以路径代替图片', async t => {
  const { dir, store, attachments, input } = fixture(t);
  const result = await attachments.create(input);
  assert.equal(result.width, 160); assert.equal(result.height, 80);
  assert.equal(result.path, undefined); assert.equal(result.hash, undefined);
  const record = store.get('assistantAttachments', result.id);
  assert.ok(record.path.startsWith('截图项目/assistant/attachments/'));
  assert.ok(existsSync(join(dir, record.sourcePath)));
  const parts = await attachments.imageParts([result.id], 's1');
  assert.equal(parts[0].type, 'image_url');
  assert.ok(parts[0].image_url.url.startsWith('data:image/png;base64,'));
  assert.deepEqual(Buffer.from(parts[0].image_url.url.split(',')[1], 'base64'), readFileSync(join(dir, record.path)));
  await assert.rejects(attachments.read(result.id, 's2'), { status: 403 });
  await assert.rejects(attachments.imageParts([result.id, result.id], 's1'), { code: 'attachment-invalid' });
  writeFileSync(join(dir, record.path), 'replaced');
  await assert.rejects(attachments.imageParts([result.id], 's1'), /图片已改变/);
});

test('伪格式、超像素、损坏、过大和关闭会话在发送前拒绝', async t => {
  const { attachments, input, data, store } = fixture(t);
  for (const changes of [
    { mime: 'image/jpeg' },
    { dataBase64: Buffer.from('<svg><script>bad</script></svg>').toString('base64') },
    { dataBase64: 'not base64' },
    { dataBase64: Buffer.alloc(5 * 1024 * 1024 + 1).toString('base64') },
    { dataBase64: data.subarray(0, 30).toString('base64') },
  ]) await assert.rejects(attachments.create({ ...input, ...changes }), { code: 'attachment-invalid' });
  const huge = Buffer.from(data); huge.writeUInt32BE(300000, 16);
  await assert.rejects(attachments.create({ ...input, dataBase64: huge.toString('base64') }), /1600/);
  assert.equal(store.all('assistantAttachments').length, 0);
  store.put('assistantSessions', { id: 's1', projectId: 'p', state: 'archived' }, 'p');
  await assert.rejects(attachments.create(input), { status: 409 });
  assert.equal(attachments.active, 0);
});
