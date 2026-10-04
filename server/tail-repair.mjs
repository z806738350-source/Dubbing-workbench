import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail, uid } from './store.mjs';
import { projectFile } from './workspace.mjs';
import { analyzeTail, trimTail, TAIL_PROCESSING_VERSION } from './tail-audio.mjs';
import { audioDigest } from './audio-delivery.mjs';
import { inspect } from './audio.mjs';

// The online adapter supplies an already previewed, exact unit; the offline
// maintenance command uses the same file/transaction path for every current unit.
export async function repairTailUnit(store, domain, chapterId, unitId, { expected, maintenanceId } = {}) {
  const chapter = store.get('chapters', chapterId);
  const row = domain.enhancement.resolve(chapterId).find(row => row.s.id === unitId);
  if (!row) fail('当前声音单元不存在', 409);
  const detail = { chapterId, unitId, sourceAudioId: row.a?.id, changed: false };
  if (row.s.mode !== 'dry') return { ...detail, reason: 'scene_audio' };
  if (!row.a || row.validity !== 'matched') return { ...detail, reason: row.validity };
  const before = store.get('chapters', chapter.id), unit = store.get('units', row.s.id), source = row.a;
  const assertCurrent = () => {
    const current = domain.editable(chapter.id, before.revision), u = store.get('units', unit.id);
    if (current.arrangement !== before.arrangement || u.revision !== unit.revision || u.mode !== 'dry' ||
      u.state !== 'active' || u.variants.dry.current !== source.id ||
      store.get('audios', source.id).path !== source.path || domain.enhancement.status(u, 'dry').validity !== 'matched')
      fail('清理期间当前音频或编排已变化，未替换声音', 409);
    return current;
  };
  assertCurrent();
  const sourceFile = join(store.directory, source.path), sourceDigest = await audioDigest(sourceFile);
  if (expected && sourceDigest.sha256 !== expected.sourceSha256) fail('预览后的原音频内容已变化，未替换声音', 409);
  const analysis = await analyzeTail(sourceFile);
  if (expected && JSON.stringify(analysis) !== JSON.stringify(expected.analysis)) fail('预览后的尾部处理范围已变化，请重新预览', 409);
  assertCurrent();
  detail.reason = analysis.reason;
  if (!analysis.detected) return detail;
  const id = uid(), path = projectFile(store, chapter.id, 'audio', `${id}.wav`), file = join(store.directory, path);
  await mkdir(dirname(file), { recursive: true });
  try {
    await trimTail(join(store.directory, source.path), file, analysis);
    const metadata = await inspect(file), resultDigest = await audioDigest(file);
    if ((await audioDigest(sourceFile)).sha256 !== sourceDigest.sha256) fail('原音频在清理期间变化，未替换声音', 409);
    store.transaction(() => {
      assertCurrent();
      const audio = { ...source, id, path, ...metadata, createdAt: new Date().toISOString(),
        targetKind: source.targetKind || (unit.kind === 'single' ? 'single' : 'unit'), targetId: source.targetId || unit.id,
        originalAudioId: source.originalAudioId || source.id, originalAvailability: source.originalAvailability || 'not-saved', provenance: 'processed',
        processing: { version: TAIL_PROCESSING_VERSION, profile: 'dry-tail', sourceAudioId: source.id, inputSha256: sourceDigest.sha256,
          resultSha256: resultDigest.sha256, resultPath: path, frameCount: analysis.cutFrame, cutFrame: analysis.cutFrame,
          removedFrames: Math.round(analysis.removedSeconds * analysis.sampleRate), sampleRate: analysis.sampleRate,
          reason: analysis.reason, completedAt: new Date().toISOString() },
        ...(maintenanceId ? { maintenance: { id: maintenanceId, unitId: unit.id, sourceAudioId: source.id } } : {}),
        tailRepair: { sourceAudioId: source.id, reason: analysis.reason, cutSeconds: analysis.cutSeconds, removedSeconds: analysis.removedSeconds, at: new Date().toISOString() } };
      delete audio.review; delete audio.invalid;
      store.put('audios', audio, chapter.id);
      domain.mutate('unit.select-result', { chapterId: chapter.id, revision: before.revision,
        unitId: unit.id, entityRevision: unit.revision, mode: 'dry', audioId: id });
    });
  } catch (error) {
    await rm(file, { force: true });
    throw error;
  }
  return { ...detail, changed: true, audioId: id, removedSeconds: analysis.removedSeconds };
}

export async function repairProjectTails(store, domain, projectId) {
  const project = store.get('projects', projectId), chapters = store.all('chapters', projectId);
  // Refuse the whole maintenance run before any changes if a chapter is busy.
  for (const chapter of chapters) domain.editable(chapter.id, chapter.revision);
  const details = [];
  for (const chapter of chapters) for (const row of domain.enhancement.resolve(chapter.id))
    details.push(await repairTailUnit(store, domain, chapter.id, row.s.id));
  return { projectId, projectName: project.name, scanned: details.length,
    cleaned: details.filter(item => item.changed).length, skipped: details.filter(item => !item.changed).length, details };
}
