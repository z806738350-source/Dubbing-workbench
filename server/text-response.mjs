import { fail } from './store.mjs';

export const ASSISTANT_RESPONSE_BYTES = 2 * 1024 * 1024;
export function analysisResponseLimit(request, targets) {
  // Legacy batches have a text-size bound but no item-count bound. Allow their
  // existing large annotation lists; never let a broken provider stream forever.
  return Math.min(128 * 1024 * 1024, Math.max(8 * 1024 * 1024,
    targets * 16 * 1024, Buffer.byteLength(JSON.stringify(request)) * 8));
}
export function textDiskBytes(request, limit, draft) {
  return limit * 3 + Buffer.byteLength(JSON.stringify(request)) + (draft ? Buffer.byteLength(JSON.stringify(draft)) * 2 : 0);
}
export async function readTextResponse(response, limit, onChunk = () => {}) {
  const tooLarge = () => fail('文本回复超过本批安全接收上限，结果未完整确认；保留现有记录，不会自动重新付费发送', 502,
    { code: 'outcome-unknown', retryClass: 'review-existing-request' });
  if (Number(response.headers?.get('content-length')) > limit) {
    try { await response.body?.cancel(); } catch {}
    tooLarge();
  }
  let bytes = 0;
  const chunks = [];
  for await (const chunk of response.body || []) {
    onChunk();
    bytes += chunk.length;
    if (bytes > limit) tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
