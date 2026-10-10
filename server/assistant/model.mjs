import { fail, same, text } from '../store.mjs';
import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { reserveDiskSpace } from '../disk-space.mjs';
import { readTextResponse, textDiskBytes, ASSISTANT_RESPONSE_BYTES } from '../text-response.mjs';
import defaults from './defaults.json' with { type: 'json' };

const settingsId = 'assistant-connection';
const allowedSettings = new Set(['revision', 'enabled', 'baseUrl', 'model', 'credentialSource', 'apiKey', 'clearKey', 'vision']);
const error = (message, code, status = 400) => fail(message, status, { code });
const stamp = () => new Date().toISOString();

export function createAssistantModel(store, audioConfig, { fetchImpl = (...args) => fetch(...args) } = {}) {
  const read = () => store.maybe('settings', settingsId) || { id: settingsId, revision: 0, enabled: false,
    baseUrl: audioConfig.assistantBaseUrl || audioConfig.baseUrl || '',
    model: audioConfig.assistantModel || defaults.model, credentialSource: 'audio', vision: false };
  function publicSettings() {
    const { apiKey, verification, ...settings } = read();
    return { ...settings, configured: !!settings.baseUrl && !!settings.model, hasKey: settings.credentialSource === 'audio' ? !!audioConfig.key : !!apiKey,
      protocol: 'openai-chat-completions' };
  }
  function save(p) {
    if (!p || Object.keys(p).some(key => !allowedSettings.has(key))) error('助手设置包含不支持的字段', 'assistant-settings-invalid');
    const previous = read();
    if (p.revision !== previous.revision) error('助手连接已在其他页面修改，请重新核对', 'assistant-settings-stale', 409);
    const model = text(p.model, '助手模型名称', 200).trim();
    if (/[\s\x00-\x1f]/u.test(model)) error('模型名称不能包含空格或控制字符', 'assistant-settings-invalid');
    let endpoint;
    try { endpoint = new URL(text(p.baseUrl, '助手接口地址', 2000).trim()); } catch { error('请填写完整的助手接口地址', 'assistant-settings-invalid'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        endpoint.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname))
      error('接口须使用 HTTPS；本机网关可使用 HTTP，地址中不能包含密钥或查询参数', 'assistant-settings-invalid');
    const baseUrl = endpoint.href.replace(/\/$/, '').replace(/\/chat\/completions$/, '');
    if (!['separate', 'audio'].includes(p.credentialSource) || typeof p.enabled !== 'boolean' || typeof p.vision !== 'boolean')
      error('请选择有效的连接和识图设置', 'assistant-settings-invalid');
    if (p.credentialSource === 'audio' && new URL(baseUrl).origin !== new URL(audioConfig.baseUrl || 'http://localhost').origin)
      error('复用配音凭据只适用于同一服务地址；其他服务请填写独立凭据', 'assistant-credential-scope', 403);
    if (p.apiKey !== undefined && (typeof p.apiKey !== 'string' || p.apiKey.length > 4096 || /[\r\n]/.test(p.apiKey)))
      error('助手凭据格式无效', 'assistant-settings-invalid');
    const sameCredentialOrigin = previous.baseUrl && new URL(previous.baseUrl).origin === new URL(baseUrl).origin;
    const next = { id: settingsId, revision: previous.revision + 1, enabled: p.enabled, baseUrl, model,
      credentialSource: p.credentialSource, apiKey: p.clearKey ? '' : p.apiKey || (sameCredentialOrigin ? previous.apiKey : '') || '', vision: p.vision, updatedAt: stamp() };
    if (next.apiKey) for (const suffix of ['', '-wal', '-shm']) {
      const file = join(store.directory, 'workbench.sqlite' + suffix);
      if (existsSync(file)) chmodSync(file, 0o600);
    }
    store.put('settings', next);
    return publicSettings();
  }
  const identity = () => { const { revision, baseUrl, model, credentialSource } = read(); return { revision, baseUrl, model, credentialSource }; };
  function assertReady({ images = false, expected } = {}) {
    const connection = read();
    if (!connection.enabled) error('AI 助手尚未开启，请先设置助手连接', 'assistant-disabled', 403);
    if (!connection.baseUrl || !connection.model) error('请先填写助手模型与接口地址', 'assistant-not-configured');
    if (expected && !same(expected, identity())) error('助手模型或接口已改变，请重新核对本次发送范围', 'assistant-route-changed', 409);
    if (images && !connection.vision)
      error('当前助手模型未设置为支持图片，图片未发送；请选择支持图片的多模态模型并开启图片支持', 'image-not-supported');
    return connection;
  }
  async function generate({ messages, expected, signal }) {
    if (!Array.isArray(messages) || !messages.length) error('助手消息不能为空', 'assistant-message-invalid');
    const images = messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url'));
    const connection = assertReady({ images, expected });
    const key = connection.credentialSource === 'audio' ? audioConfig.key : connection.apiKey;
    const request = { model: connection.model, messages, stream: false };
    const diskLease=reserveDiskSpace(store.directory,textDiskBytes(request,ASSISTANT_RESPONSE_BYTES),'AI助手文本请求');
    try {
    let response;
    try {
      response = await fetchImpl(connection.baseUrl + '/chat/completions', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(request), signal: signal || AbortSignal.timeout(300000) });
    } catch { error('助手请求中断，结果尚未确认；未自动重复发送', 'outcome-unknown', 502); }
    if (!response.ok) error(`助手服务返回 ${response.status}；请核对连接或现有请求记录`, response.status >= 500 ? 'outcome-unknown' : 'assistant-provider-rejected', response.status >= 500 ? 502 : 400);
    const responseAt = stamp();
    let firstByteAt, contentText;
    try { contentText=await readTextResponse(response,ASSISTANT_RESPONSE_BYTES,()=>{firstByteAt ||= stamp();}); }
    catch { error('助手回复未完整接收，请核对记录；未自动重复发送', 'outcome-unknown', 502); }
    let raw;
    try { raw=JSON.parse(contentText); } catch { error('助手回复格式无效，未执行任何提案', 'assistant-response-invalid'); }
    const envelope = raw.data || raw;
    const content = envelope.choices?.[0]?.message?.content ?? envelope.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') ??
      envelope.results?.map(p => p.text || '').join('') ?? envelope.text ?? envelope.output ?? envelope.content ?? envelope.markdown ?? envelope.caption;
    const reply = (typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text || '').join('') : '')
      .replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/gi, '').trim();
    if (!reply) error('助手未返回可用内容，未执行任何提案', 'assistant-response-invalid');
    return { content: reply, usage: envelope.usage || null, providerRequestId: response.headers.get('x-request-id') || raw.id || null,
      finishReason: envelope.choices?.[0]?.finish_reason || null, connection: { revision: connection.revision, baseUrl: connection.baseUrl, model: connection.model }, responseAt, firstByteAt: firstByteAt || null, receivedAt: stamp() };
    } finally { diskLease.release(); }
  }
  return { publicSettings, save, identity, assertReady, generate };
}
