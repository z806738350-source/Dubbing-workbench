import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { ffmpeg } from '../server/audio.mjs';
import { openStore, uid } from '../server/store.mjs';
import { createAssistantModel } from '../server/assistant/model.mjs';
import { verifyVision } from '../server/assistant/vision.mjs';

test('vision verification carries answer only in pixels, is explicitly paid once, and stale connection cannot reuse result', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'assistant-vision-')), store = openStore(directory); let calls = 0, expectedCode;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const model = createAssistantModel(store, { baseUrl: 'https://mock.invalid/v1' }, { fetchImpl: async (_url, options) => {
    calls++; const request = JSON.parse(options.body), parts = request.messages[0].content;
    const bytes = Buffer.from(parts[1].image_url.url.split(',')[1], 'base64');
    const pixels = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { input: bytes, maxBuffer: 2000000 });
    expectedCode = '';
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const offset = ((y * 100 + 50) * 500 + x * 100 + 50) * 3, [r,g,b] = pixels.subarray(offset, offset + 3);
      expectedCode += r > 180 && g > 150 ? 'Y' : r > g && r > b ? 'R' : g > b ? 'G' : 'B';
    }
    assert.ok(!parts[0].text.includes(expectedCode)); assert.equal(parts.length, 2); assert.equal(request.model, 'user-chosen-model');
    return new Response(JSON.stringify({ choices: [{ message: { content: expectedCode } }] }));
  } });
  const settings = { enabled: true, baseUrl: 'https://mock.invalid/v1', model: 'user-chosen-model', credentialSource: 'audio', vision: true };
  model.save({ ...settings, revision: 0 });
  await assert.rejects(verifyVision(store, model, {}), /确认/); assert.equal(calls, 0);
  const requestId = uid(), verified = await verifyVision(store, model, { approved: true, requestId });
  assert.equal(verified.visionVerified, true); assert.equal(verified.passed, true); assert.equal(calls, 1);
  await verifyVision(store, model, { approved: true, requestId }); assert.equal(calls, 1);
  assert.ok(!JSON.stringify(store.all('settings')).includes(expectedCode));
  model.save({ ...settings, revision: 1, model: 'changed' });
  await assert.rejects(verifyVision(store, model, { approved: true, requestId }), /模型连接已变化/); assert.equal(calls, 1);
});
