import { join } from 'node:path';
import { fail, uid } from './store.mjs';
import { audioDigest } from './audio-delivery.mjs';
import { analyzeTail, TAIL_PROCESSING_VERSION } from './tail-audio.mjs';
import { repairTailUnit } from './tail-repair.mjs';

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function chapterScope(store, domain, projectId, chapterId) {
  store.get('projects', projectId);
  const c = store.get('chapters', chapterId);
  if (c.projectId !== projectId) fail('章节不属于本次项目范围', 403);
  domain.editable(c.id, c.revision);
  if (store.all('suggestions', c.id).some(s => s.status === 'running')) fail('本章正在整理，请完成后再清理', 409);
  return c;
}
function currentUnits(domain, chapterId, unitIds) {
  if (!Array.isArray(unitIds) || !unitIds.length || unitIds.some(id => typeof id !== 'string') || new Set(unitIds).size !== unitIds.length)
    fail('请明确选择不重复的声音单元');
  const rows = domain.enhancement.resolve(chapterId);
  return unitIds.map(id => { const row = rows.find(row => row.s.id === id); if (!row) fail('声音单元不在当前章节范围内', 403); return row; });
}
function completedFor(store, scope, item) {
  return store.all('audios', scope.chapterId).find(a => a.maintenance?.id === scope.id &&
    a.maintenance.unitId === item.unitId && a.maintenance.sourceAudioId === item.sourceAudioId &&
    a.processing?.version === scope.algorithmVersion && a.processing?.inputSha256 === item.sourceSha256);
}
function assertScope(store, domain, scope) {
  const c = chapterScope(store, domain, scope.projectId, scope.chapterId);
  const rows = currentUnits(domain, c.id, scope.units.map(item => item.unitId));
  let completed = 0;
  scope.units.forEach((item, i) => {
    const row = rows[i], u = store.get('units', item.unitId), done = completedFor(store, scope, item);
    if (done) completed++;
    if (u.revision !== item.unitRevision + (done ? 1 : 0) || u.mode !== item.mode ||
      (row.a?.id || null) !== (done?.id || item.sourceAudioId) || row.validity !== item.validity)
      fail('清理预览后的声音或设置已变化，请重新预览', 409);
  });
  if (c.revision !== scope.chapterRevision || c.arrangement !== scope.arrangement + completed)
    fail('清理预览后的章节或编排已变化，请重新预览', 409);
  return rows;
}

export async function previewTailRepair(store, domain, { projectId, chapterId, unitIds }) {
  const c = chapterScope(store, domain, projectId, chapterId), rows = currentUnits(domain, c.id, unitIds);
  const scope = { id: uid(), projectId, chapterId, chapterRevision: c.revision, arrangement: c.arrangement,
    algorithmVersion: TAIL_PROCESSING_VERSION, units: rows.map(row => ({ unitId: row.s.id,
      unitRevision: store.get('units', row.s.id).revision, mode: row.s.mode, sourceAudioId: row.a?.id || null, validity: row.validity })) };
  for (const [i, row] of rows.entries()) {
    const item = scope.units[i];
    item.analysis = { detected: false, removedSeconds: 0, reason: row.s.mode !== 'dry' ? 'scene_audio' : row.validity };
    if (row.s.mode !== 'dry' || !row.a || row.validity !== 'matched') continue;
    const file = join(store.directory, row.a.path), digest = await audioDigest(file);
    item.sourceSha256 = digest.sha256;
    // A completed current-version derivative is not fed into the heuristic again.
    // Older tailRepair-only records still get a fresh analysis.
    if (row.a.provenance === 'processed' && row.a.processing?.version === TAIL_PROCESSING_VERSION && row.a.processing.resultSha256 === digest.sha256)
      item.analysis.reason = 'already_processed';
    else item.analysis = await analyzeTail(file);
    if ((await audioDigest(file)).sha256 !== digest.sha256) fail('分析期间原音频内容已变化，请重新预览', 409);
  }
  assertScope(store, domain, scope);
  return { scope, scanned: scope.units.length, eligible: scope.units.filter(i => i.analysis.detected).length,
    removedSeconds: scope.units.reduce((sum, i) => sum + (i.analysis.removedSeconds || 0), 0),
    details: scope.units.map(({ unitId, sourceAudioId, analysis }) => ({ unitId, sourceAudioId, ...analysis })) };
}

export async function applyTailRepair(store, domain, { projectId, chapterId, scope }) {
  if (!scope || scope.projectId !== projectId || scope.chapterId !== chapterId ||
    typeof scope.id !== 'string' || !scope.id || !Array.isArray(scope.units) || scope.algorithmVersion !== TAIL_PROCESSING_VERSION)
    fail('缺少当前范围的尾部清理预览，请重新预览', 409);
  assertScope(store, domain, scope);
  const details = [];
  for (const item of scope.units) {
    try {
      const rows = assertScope(store, domain, scope), done = completedFor(store, scope, item);
      if (done) {
        if ((await audioDigest(join(store.directory, done.path))).sha256 !== done.processing.resultSha256)
          fail('已完成的清理文件校验失败，保留原件供恢复', 409);
        details.push({ unitId: item.unitId, sourceAudioId: item.sourceAudioId, audioId: done.id, status: 'completed', changed: false, alreadyCompleted: true });
        continue;
      }
      if (!item.analysis.detected) {
        const row = rows.find(row => row.s.id === item.unitId);
        if (item.sourceSha256 && (await audioDigest(join(store.directory, row.a.path))).sha256 !== item.sourceSha256)
          fail('预览后的原音频内容已变化，请重新预览', 409);
        details.push({ unitId: item.unitId, sourceAudioId: item.sourceAudioId, status: 'skipped', changed: false, reason: item.analysis.reason });
        continue;
      }
      const result = await repairTailUnit(store, domain, chapterId, item.unitId, { expected: item, maintenanceId: scope.id });
      details.push({ ...result, status: result.changed ? 'completed' : 'skipped' });
    } catch (error) {
      details.push({ unitId: item.unitId, sourceAudioId: item.sourceAudioId, status: 'failed', changed: false, error: error.message, retryable: true });
    }
  }
  return { projectId, chapterId, scopeId: scope.id, state: details.some(item => item.status === 'failed') ? 'partial' : 'completed',
    scanned: details.length, cleaned: details.filter(item => item.changed).length,
    details };
}
