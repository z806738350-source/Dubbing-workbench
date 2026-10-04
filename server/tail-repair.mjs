import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fail, uid } from './store.mjs';
import { projectFile } from './workspace.mjs';
import { analyzeTail, trimTail } from './tail-audio.mjs';
import { inspect } from './audio.mjs';

export async function repairProjectTails(store, domain, projectId) {
  const project = store.get('projects', projectId);
  const chapters = store.all('chapters', projectId);
  // Refuse the whole maintenance run before any changes if a chapter is busy.
  for (const chapter of chapters) domain.editable(chapter.id, chapter.revision);
  const details = [];
  for (const chapter of chapters) {
    for (const row of domain.enhancement.resolve(chapter.id)) {
      const detail = { chapterId: chapter.id, unitId: row.s.id, sourceAudioId: row.a?.id, changed: false };
      details.push(detail);
      if (row.s.mode !== 'dry') { detail.reason = 'scene_audio'; continue; }
      if (!row.a || row.validity !== 'matched') { detail.reason = row.validity; continue; }
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
      const analysis = await analyzeTail(join(store.directory, source.path));
      assertCurrent();
      detail.reason = analysis.reason;
      if (!analysis.detected) continue;
      const id = uid(), path = projectFile(store, chapter.id, 'audio', `${id}.wav`), file = join(store.directory, path);
      await mkdir(dirname(file), { recursive: true });
      try {
        await trimTail(join(store.directory, source.path), file, analysis);
        const metadata = await inspect(file);
        store.transaction(() => {
          assertCurrent();
          const audio = { ...source, id, path, ...metadata, createdAt: new Date().toISOString(),
            targetKind: source.targetKind || (unit.kind === 'single' ? 'single' : 'unit'), targetId: source.targetId || unit.id,
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
      Object.assign(detail, { changed: true, audioId: id, removedSeconds: analysis.removedSeconds });
    }
  }
  return { projectId, projectName: project.name, scanned: details.length,
    cleaned: details.filter(item => item.changed).length, skipped: details.filter(item => !item.changed).length, details };
}
