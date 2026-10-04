import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore } from '../server/store.mjs';
import { createAssistantModel } from '../server/assistant/model.mjs';

const image = 'data:image/png;base64,aW1hZ2UtcGl4ZWxz';
const messages = [{ role: 'user', content: [{ type: 'text', text: '图中是什么？' }, { type: 'image_url', image_url: { url: image } }] }];
function fixture(t, fetchImpl) {
  const path = mkdtempSync(join(tmpdir(), 'assistant-model-')), store = openStore(path);
  t.after(() => { store.close(); rmSync(path, { recursive: true, force: true }); });
  const audio = { model: 'audio-original', baseUrl: 'https://audio.example/v1', key: 'secret-audio-key' };
  return { store, audio, model: createAssistantModel(store, audio, { fetchImpl }) };
}
const config = (revision = 0, extra = {}) => ({ revision, enabled: true, baseUrl: 'https://vision.example/v1', model: 'custom/multimodal-name', credentialSource: 'separate', apiKey: 'secret-vision-key', vision: true, ...extra });

test('助手模型和接口用户可调整，独立于配音配置，公开设置不泄露凭据', t => {
  const { model, audio, store } = fixture(t);
  assert.equal(model.publicSettings().model, 'claude-sonnet-5-5');
  assert.equal(model.publicSettings().enabled, false);
  const saved = model.save(config());
  assert.equal(saved.model, 'custom/multimodal-name');
  assert.equal(saved.vision, true);
  assert.equal('visionVerified' in saved, false);
  assert.equal('verifiedAt' in saved, false);
  assert.equal(saved.hasKey, true);
  assert.ok(!JSON.stringify(saved).includes('secret-'));
  if (process.platform !== 'win32') assert.equal(statSync(join(store.directory, 'workbench.sqlite')).mode & 0o777, 0o600);
  model.save(config(1, { model: 'another/vendor-model', baseUrl: 'https://other.example/v2/chat/completions' }));
  assert.equal(model.publicSettings().baseUrl, 'https://other.example/v2');
  assert.equal(audio.model, 'audio-original');
  assert.throws(() => model.save(config(1)), { code: 'assistant-settings-stale' });
  assert.throws(() => model.save(config(2, { credentialSource: 'audio' })), { code: 'assistant-credential-scope' });
  model.save(config(2, { baseUrl: 'https://fresh.example/v1', apiKey: undefined }));
  assert.equal(model.publicSettings().hasKey, false, 'another provider must not silently inherit the previous credential');
});

test('用户声明支持图片后直接发送图片，换模型仍校验本次连接身份', async t => {
  const calls = [], { model } = fixture(t, async (url, request) => {
    calls.push({ url, request });
    return new Response(JSON.stringify({ id: 'provider-1', choices: [{ message: { content: '<think>隐含过程</think>图中答案' } }] }), { status: 200 });
  });
  model.save(config());
  const identity = model.identity(), result = await model.generate({ messages, expected: identity });
  assert.equal(calls.length, 1);
  assert.equal(result.content, '图中答案');
  assert.equal(calls[0].url, 'https://vision.example/v1/chat/completions');
  const sent = JSON.parse(calls[0].request.body);
  assert.deepEqual(sent.messages, messages);
  assert.equal(sent.model, 'custom/multimodal-name');
  assert.equal(sent.stream, false);
  assert.equal(sent.capabilities, undefined);
  assert.equal(calls[0].request.redirect, 'error');
  model.save(config(1, { model: 'changed-model' }));
  await model.generate({ messages, expected: model.identity() });
  assert.equal(JSON.parse(calls[1].request.body).model, 'changed-model');
  await assert.rejects(model.generate({ messages, expected: identity }), { code: 'assistant-route-changed' });
  assert.equal(calls.length, 2);
});

test('文本模型禁止带图，模型失败不自动重试且不回传供应商秘密', async t => {
  let calls = 0;
  const { model } = fixture(t, async () => { calls++; return new Response('secret-upstream-private-response', { status: 502 }); });
  model.save(config(0, { vision: false }));
  await assert.rejects(model.generate({ messages }), { code: 'image-not-supported' });
  assert.equal(calls, 0);
  for (const content of [[{ role: 'user', content: '你好' }], messages]) {
    if (content === messages) model.save(config(1));
    await assert.rejects(model.generate({ messages: content }), e => {
      assert.equal(e.code, 'outcome-unknown'); assert.ok(!e.message.includes('secret')); return true;
    });
  }
  assert.equal(calls, 2);
});

test('设置不接受凭据URL和非本地HTTP，纯文本包装响应与空回复校验', async t => {
  const { model } = fixture(t, async () => new Response(JSON.stringify({ data: { choices: [{ message: { content: '正常回复' } }] } })));
  for (const baseUrl of ['https://user:password@example.com/v1', 'https://example.com/v1?key=secret', 'http://remote.example/v1', 'file:///tmp/request'])
    assert.throws(() => model.save(config(0, { baseUrl })), { code: 'assistant-settings-invalid' });
  model.save(config(0, { baseUrl: 'http://127.0.0.1:9020/v1', vision: false }));
  assert.equal((await model.generate({ messages: [{ role: 'user', content: '你好' }] })).content, '正常回复');
  model.save(config(1, { enabled: false }));
  await assert.rejects(model.generate({ messages }), { code: 'assistant-disabled' });
});

test('历史识图验证结果不公开，也不能覆盖用户的图片支持设置', async t => {
  let calls = 0;
  const { model, store } = fixture(t, async () => { calls++; return new Response('{}'); });
  model.save(config(0, { vision: false }));
  const saved = store.get('settings', 'assistant-connection');
  store.put('settings', { ...saved, verification: { revision: saved.revision, at: '2026-10-01', providerRequestId: 'old-verification', attachmentId: 'old-challenge' } });
  const publicSettings = model.publicSettings();
  for (const key of ['verification', 'visionVerified', 'verifiedAt']) assert.equal(key in publicSettings, false);
  assert.ok(store.get('settings', 'assistant-connection').verification, '读取设置不改写旧记录');
  await assert.rejects(model.generate({ messages }), { code: 'image-not-supported' });
  assert.equal(calls, 0);
});
