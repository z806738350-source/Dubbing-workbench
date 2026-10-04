import { createHash } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { inspect } from './audio.mjs';
import { analyzeTail, trimTail, TAIL_PROCESSING_VERSION } from './tail-audio.mjs';

const rawPath = attempt => attempt.path || `audio/${attempt.id}.wav`;
const manifestPath = attempt => `${rawPath(attempt)}.delivery.json`;

// IDs and versions cannot detect a truncated or replaced file between filesystem and
// SQLite commits. Hashes are limited to validating those persisted audio receipts.
export async function audioDigest(file) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}
async function flush(file) {
  const handle = await open(file, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function saveReceipt(file, receipt) {
  const temporary = `${file}.part`;
  await rm(temporary, { force: true });
  const handle = await open(temporary, 'wx');
  try { await handle.writeFile(JSON.stringify(receipt)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, file);
  // fsync of directories is not supported by every host/filesystem. File flush and
  // atomic rename allow process-crash replay; this is not a power-loss guarantee.
}
function paths(store, attempt) {
  const path = rawPath(attempt);
  return { path, file: join(store.directory, path), manifest: join(store.directory, manifestPath(attempt)),
    resultPath: `${path.slice(0, -4)}.processed.wav` };
}
function deliveryOf(attempt, receipt) {
  return { version: 1, rawPath: rawPath(attempt), manifestPath: manifestPath(attempt),
    rawSha256: receipt.raw.sha256, receivedBytes: receipt.raw.bytes, receivedAt: receipt.raw.receivedAt,
    responseStatus: receipt.raw.responseStatus, providerRequestId: receipt.raw.providerRequestId,
    mediaMetadata: receipt.raw.metadata, profile: receipt.profile, processingVersion: receipt.processingVersion };
}
// User dismissal is monotonic and may arrive during any awaited network or local
// operation. Progress snapshots must not erase that current user decision.
export function saveAudioAttempt(store, attempt, jobId = attempt.jobId) {
  if (store.maybe('attempts', attempt.id)?.discarded) attempt.discarded = true;
  store.put('attempts', attempt, jobId);
}
function persist(store, attempt, receipt, phase) {
  attempt.delivery = deliveryOf(attempt, receipt);
  attempt.phase = phase;
  if (receipt.processing && receipt.result) {
    const analysis = receipt.processing.analysis;
    attempt.processing = { version: receipt.processing.version, profile: 'dry-tail', sourceAudioId: `${attempt.id}-original`,
      inputSha256: receipt.raw.sha256, resultSha256: receipt.result.sha256,
      resultPath: join(dirname(rawPath(attempt)), receipt.result.filename),
      frameCount: analysis.cutFrame, cutFrame: analysis.cutFrame,
      removedFrames: Math.round(analysis.removedSeconds * analysis.sampleRate),
      sampleRate: analysis.sampleRate, reason: analysis.reason, completedAt: receipt.result.completedAt };
  }
  saveAudioAttempt(store, attempt);
}
export async function sealAudioDelivery(store, attempt, receivedBytes, response) {
  const p = paths(store, attempt), temporary = `${p.file}.part`;
  const metadata = await inspect(temporary), digest = await audioDigest(temporary);
  if (!receivedBytes || digest.bytes !== receivedBytes) throw new Error('完整音频接收依据不一致');
  const handle = await open(temporary, 'r');
  try {
    const header = Buffer.alloc(12); await handle.read(header, 0, header.length, 0);
    if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WAVE' &&
      header.readUInt32LE(4) + 8 !== digest.bytes) throw new Error('WAV 容器长度不完整');
  } finally { await handle.close(); }
  await flush(temporary);
  const receipt = { version: 1, attemptId: attempt.id, raw: { filename: basename(p.file), ...digest,
    metadata, receivedAt: new Date().toISOString(), responseStatus: response.status,
    providerRequestId: response.headers.get('x-request-id') || undefined },
    profile: attempt.segmentId || (attempt.targetKind === 'unit' && attempt.mode === 'dry') ? 'dry-tail' : 'preserve',
    processingVersion: TAIL_PROCESSING_VERSION };
  // The receipt is written only after the complete response ended, length checks,
  // full decoding and flush. A .part file alone never proves response completion.
  await saveReceipt(p.manifest, receipt);
  await rename(temporary, p.file);
  persist(store, attempt, receipt, 'rawSealed');
}
export async function verifyAudioDelivery(store, attempt) {
  const p = paths(store, attempt), receipt = JSON.parse(await readFile(p.manifest, 'utf8'));
  if (receipt.version !== 1 || receipt.attemptId !== attempt.id || receipt.raw?.filename !== basename(p.file))
    throw new Error('原件完成清单与任务不匹配');
  const rawFile = existsSync(p.file) ? p.file : `${p.file}.part`, digest = await audioDigest(rawFile);
  if (digest.bytes !== receipt.raw.bytes || digest.sha256 !== receipt.raw.sha256) throw new Error('原件与完整接收凭据不一致');
  let resultFile;
  if (receipt.result) {
    if (receipt.result.filename !== basename(p.resultPath)) throw new Error('处理结果路径与任务不匹配');
    resultFile = join(store.directory, p.resultPath);
    const resultDigest = await audioDigest(resultFile);
    if (resultDigest.bytes !== receipt.result.bytes || resultDigest.sha256 !== receipt.result.sha256)
      throw new Error('处理结果与已保存配方不一致，原件仍保留');
  }
  return { receipt, rawFile, resultFile };
}
export async function prepareAudioDelivery(store, attempt) {
  const p = paths(store, attempt);
  if (!attempt.deliveryVersion) {
    // Legacy final filenames were already committed after a full decode. They do
    // not prove an unprocessed provider original, so never run today's cleanup.
    return { ...await inspect(p.file), originalAvailability: 'not-saved' };
  }
  const { receipt, rawFile } = await verifyAudioDelivery(store, attempt);
  if (rawFile !== p.file) await rename(rawFile, p.file);
  persist(store, attempt, receipt, 'rawSealed');
  if (!receipt.evaluated) {
    if (receipt.processingVersion !== TAIL_PROCESSING_VERSION) throw new Error('本地处理版本不匹配，保留原件等待兼容恢复');
    const analysis = receipt.profile === 'dry-tail' ? await analyzeTail(p.file) : { detected: false };
    receipt.processing = analysis.detected ? { version: TAIL_PROCESSING_VERSION, analysis } : null;
    receipt.evaluated = true;
    await saveReceipt(p.manifest, receipt);
  }
  if (!receipt.processing) return { ...receipt.raw.metadata, delivery: attempt.delivery, originalAvailability: 'retained', provenance: 'provider-original' };
  const resultPath = p.resultPath, resultFile = join(store.directory, resultPath);
  if (!receipt.result) {
    if (receipt.processing.version !== TAIL_PROCESSING_VERSION) throw new Error('本地处理配方版本不匹配，保留原件等待兼容恢复');
    persist(store, attempt, receipt, 'processing');
    const temporary = `${resultFile}.part`;
    await rm(temporary, { force: true });
    try {
      await trimTail(p.file, temporary, receipt.processing.analysis);
      const metadata = await inspect(temporary), resultDigest = await audioDigest(temporary);
      await flush(temporary); await rename(temporary, resultFile);
      receipt.result = { filename: basename(resultPath), ...resultDigest, metadata, completedAt: new Date().toISOString() };
      await saveReceipt(p.manifest, receipt);
    } finally { await rm(temporary, { force: true }); }
  }
  if (receipt.result.filename !== basename(resultPath)) throw new Error('处理结果路径与任务不匹配');
  const resultDigest = await audioDigest(resultFile);
  if (resultDigest.bytes !== receipt.result.bytes || resultDigest.sha256 !== receipt.result.sha256)
    throw new Error('处理结果与已保存配方不一致，原件仍保留');
  persist(store, attempt, receipt, 'processing');
  const analysis = receipt.processing.analysis;
  return { ...receipt.result.metadata, path: resultPath, delivery: attempt.delivery, processing: attempt.processing,
    originalAudioId: `${attempt.id}-original`, originalAvailability: 'retained', provenance: 'processed',
    tailRepair: { sourceAudioId: `${attempt.id}-original`, reason: analysis.reason, cutSeconds: analysis.cutSeconds,
      removedSeconds: analysis.removedSeconds, at: receipt.result.completedAt } };
}
export function hasAudioDelivery(store, attempt) {
  return existsSync(join(store.directory, manifestPath(attempt)));
}
