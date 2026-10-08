import { api } from "./api";
import { clearDraft, draftWorkspace, listAllDrafts, readDraft, writeDraft } from "./drafts";
import { cancelDraftSave, flushDraftSaves, forgetSaveOperation, notifyDraftSaves, pendingSaveOperation, runDraftSave, saveOperationId, scheduleDraftSave, type SaveState } from "./autosave";
import type { AudioRangeRecord, ChapterDetail } from "./types";

export type RangeBounds = { startFrame: number; endFrame: number };
type RangeValue = RangeBounds & Pick<AudioRangeRecord, "sourceHash" | "decodeProfile">;
type RangeWrite = RangeValue & Pick<AudioRangeRecord, "unitId" | "mode" | "audioId"> & { expectedRevision: number };
type Receipt = { range: AudioRangeRecord; operationId?: string; status?: "completed" | "missing" };
export type RangeSaveSnapshot = { range: AudioRangeRecord; savedRange: AudioRangeRecord; status: SaveState; dirty: boolean; error: string; conflict?: AudioRangeRecord };
const equal = (a: RangeBounds, b: RangeBounds) => a.startFrame === b.startFrame && a.endFrame === b.endFrame;
export const audioRangeKey = (unitId: string, mode: string, audioId: string) => "audio-range-v1/" + unitId + "/" + mode + "/" + audioId;
const chapterKeys = new Map<string, Set<string>>();
export async function flushAudioRanges(chapterId: string) {
  const workspaceId = draftWorkspace(), keys = chapterKeys.get(workspaceId + "|" + chapterId);
  if (keys?.size) await flushDraftSaves("chapter:" + chapterId, [...keys]);
  const drafts = (await listAllDrafts()).filter(record => record.id.startsWith("audio-range-v1/") && record.entry.compatible);
  if (!drafts.length) return;
  const chapter = await api<ChapterDetail>("/chapters/" + encodeURIComponent(chapterId));
  const targets = new Map(chapter.playbackItems.filter(item => item.audioId).map(item => [audioRangeKey(item.unitId || item.id, item.mode || "dry", item.audioId!), item]));
  for (const record of drafts) {
    const item = targets.get(record.id); if (!item?.audioId) continue;
    if (draftWorkspace() !== workspaceId) throw new Error("工作区已变化，原范围暂存未发送到新工作区。");
    const { range } = await api<{ range: AudioRangeRecord }>("/units/" + encodeURIComponent(item.unitId || item.id) + "/audio-range?" + new URLSearchParams({ mode: item.mode || "dry", audioId: item.audioId }));
    const value = record.entry.data.draft as RangeValue;
    if (record.entry.error || !value || typeof value !== "object") throw new Error("本章有无法读取的范围暂存，请打开对应声音处理。");
    if (record.entry.status !== "current") {
      if (!equal(value, range)) throw Object.assign(new Error("声音单元 " + range.unitId + " 有其他页面的未同步范围，请在该段处理后继续。"), { status: 409, unitId: range.unitId, audioId: range.audioId });
      continue;
    }
    // Hidden rows have no mounted editor after reload; recover their exact original operation before export.
    const saver = createAudioRangeSave({ range, workspaceId, onChange: () => {} });
    try { await saver.flush(); } finally { saver.release(); }
  }
}
export function normalizeRange(bounds: RangeBounds, frames: number, minimum = Math.min(frames, 960)): RangeBounds {
  const startFrame = Math.max(0, Math.min(frames - minimum, Math.round(bounds.startFrame)));
  return { startFrame, endFrame: Math.max(startFrame + minimum, Math.min(frames, Math.round(bounds.endFrame))) };
}
const valueOf = (range: AudioRangeRecord): RangeValue => ({ startFrame: range.startFrame, endFrame: range.endFrame, sourceHash: range.sourceHash, decodeProfile: range.decodeProfile });
type RangeSaveOptions = { range: AudioRangeRecord; workspaceId: string; onChange: (snapshot: RangeSaveSnapshot) => void; onSaved?: (range: AudioRangeRecord) => void; request?: typeof api; deferSubscribe?: boolean };
const rangeControllers = new Map<string, { sourceHash: string; decodeProfile: string; controller: ReturnType<typeof createRangeSaveController>; listeners: Set<RangeSaveOptions> }>();

export function createAudioRangeSave(options: RangeSaveOptions) {
  const identity = options.workspaceId + "|" + audioRangeKey(options.range.unitId, options.range.mode, options.range.audioId);
  let entry = rangeControllers.get(identity);
  if (!entry || entry.sourceHash !== options.range.sourceHash || entry.decodeProfile !== options.range.decodeProfile) {
    const listeners = new Set<RangeSaveOptions>();
    const controller = createRangeSaveController({ ...options, onChange: snapshot => {
      listeners.forEach(listener => listener.onChange(snapshot));
      if (!listeners.size && !snapshot.dirty) rangeControllers.delete(identity);
    }, onSaved: range => listeners.forEach(listener => listener.onSaved?.(range)) });
    entry = { sourceHash: options.range.sourceHash, decodeProfile: options.range.decodeProfile, controller, listeners };
    rangeControllers.set(identity, entry);
  } else entry.controller.refresh(options.range);
  const current = entry;
  const connect = () => { rangeControllers.set(identity, current); current.listeners.add(options); };
  if (!options.deferSubscribe) connect();
  return { ...current.controller, connect, release: () => { current.listeners.delete(options); if (!current.listeners.size && !current.controller.dirty()) rangeControllers.delete(identity); } };
}

// The existing draft store and save registry own persistence; this queue only serializes one audio range.
function createRangeSaveController(options: RangeSaveOptions) {
  const { workspaceId, onChange, onSaved } = options, request = options.request || api;
  const key = audioRangeKey(options.range.unitId, options.range.mode, options.range.audioId);
  const chapterKey = workspaceId + "|" + options.range.chapterId;
  if (!chapterKeys.has(chapterKey)) chapterKeys.set(chapterKey, new Set());
  chapterKeys.get(chapterKey)!.add(key);
  let saved = options.range, desired = valueOf(saved), status: SaveState = "saved", error = "", conflict: AudioRangeRecord | undefined;
  let active: Promise<void> | null = null;
  const sameSource = (range: AudioRangeRecord) => range.unitId === saved.unitId && range.mode === saved.mode && range.audioId === saved.audioId && range.sourceHash === saved.sourceHash && range.decodeProfile === saved.decodeProfile;
  const valid = (value: RangeValue) => value.sourceHash === saved.sourceHash && value.decodeProfile === saved.decodeProfile && Number.isSafeInteger(value.startFrame) && Number.isSafeInteger(value.endFrame) && value.startFrame >= 0 && value.startFrame < value.endFrame && value.endFrame <= saved.sourceFrames;
  const hasPending = () => { try { return !!pendingSaveOperation(key, workspaceId); } catch { return true; } };
  const dirty = () => !equal(desired, saved) || hasPending() || status === "unreliable";
  const snapshot = (): RangeSaveSnapshot => ({ range: { ...saved, ...desired }, savedRange: saved, status, dirty: dirty(), error, conflict });
  const report = (next: SaveState, message = "") => { status = next; error = message; onChange(snapshot()); notifyDraftSaves(); };
  const put = () => writeDraft(key, desired, saved.revision, workspaceId);
  const workspaceMatches = () => draftWorkspace() === workspaceId;
  try {
    const draft = readDraft<RangeValue>(key, workspaceId);
    if (draft) {
      if (!valid(draft.draft) || !Number.isSafeInteger(draft.revision)) throw new Error("旧范围暂存与当前声音不匹配，原记录已保留。");
      desired = draft.draft;
      if (draft.revision !== saved.revision && !hasPending() && !equal(desired, saved)) { conflict = saved; status = "conflict"; }
      else status = equal(desired, saved) && !hasPending() ? "saved" : "local";
    } else if (hasPending()) status = "local";
  } catch (failure) { status = "unreliable"; error = (failure as Error).message; }

  const flush = (): Promise<void> => {
    if (active) return active;
    if (conflict) return Promise.reject(new Error("本段范围已被另一页调整，请选择采用哪一个范围。"));
    const work = async () => {
      if (!workspaceMatches()) throw new Error("工作区已变化，原声音的范围仍保留在原工作区。");
      if (status === "unreliable") { put(); status = "local"; }
      cancelDraftSave(key);
      while (dirty()) {
        if (!workspaceMatches()) throw new Error("工作区已变化，原范围仍保留在本机。");
        const previous = pendingSaveOperation(key, workspaceId);
        if (!previous && equal(desired, saved)) { clearDraft(key, undefined, false, workspaceId); report("saved"); return; }
        const sent: RangeWrite = previous ? previous.payload.value as RangeWrite : { ...desired, unitId: saved.unitId, mode: saved.mode, audioId: saved.audioId, expectedRevision: saved.revision };
        if (!valid(sent) || sent.unitId !== saved.unitId || sent.mode !== saved.mode || sent.audioId !== saved.audioId) throw new Error("待保存范围不属于当前声音，原暂存仍保留。");
        const operationId = previous?.id || saveOperationId(key, { value: sent, revision: sent.expectedRevision }, workspaceId);
        report("saving");
        let receipt: Receipt | undefined;
        try {
          if (previous) {
            receipt = await request<Receipt>("/audio-ranges/operations/" + encodeURIComponent(operationId));
            if (receipt.status === "missing") receipt = undefined;
          }
          if (!receipt) {
            try { receipt = await request<Receipt>("/audio-ranges/update", { ...sent, operationId }); }
            catch (failure) {
              const info = failure as { status?: number; retryClass?: string };
              if (info.status && info.retryClass !== "check-existing-operation") throw failure;
              try {
                const recovered = await request<Receipt>("/audio-ranges/operations/" + encodeURIComponent(operationId));
                if (recovered.status !== "completed" || !recovered.range) throw failure;
                receipt = recovered;
              } catch { throw failure; }
            }
          }
          if (!receipt.range || !sameSource(receipt.range) || !equal(receipt.range, sent) || ![sent.expectedRevision, sent.expectedRevision + 1].includes(receipt.range.revision)) throw new Error("保存回执与本次声音范围不匹配，暂存仍保留。");
          const continued = !equal(desired, sent);
          saved = receipt.range;
          if (!continued) desired = valueOf(saved);
          forgetSaveOperation(key, operationId, workspaceId);
          if (equal(desired, saved)) clearDraft(key, undefined, false, workspaceId); else put();
          report(equal(desired, saved) ? "saved" : "local");
          if (equal(desired, saved)) onSaved?.(saved);
        } catch (failure) {
          const info = failure as { status?: number; conflict?: boolean; range?: AudioRangeRecord; retryClass?: string };
          if (info.status && info.retryClass !== "check-existing-operation") forgetSaveOperation(key, operationId, workspaceId);
          if (info.status === 409 && info.conflict) {
            if (info.range && sameSource(info.range)) conflict = info.range;
            else {
              const current = await request<{ range: AudioRangeRecord }>("/units/" + encodeURIComponent(saved.unitId) + "/audio-range?" + new URLSearchParams({ mode: saved.mode, audioId: saved.audioId }));
              if (sameSource(current.range)) conflict = current.range;
            }
            if (conflict && equal(desired, conflict)) {
              saved = conflict; desired = valueOf(saved); conflict = undefined;
              clearDraft(key, undefined, false, workspaceId); report("saved"); onSaved?.(saved); continue;
            }
          }
          report(info.status === 409 && info.conflict ? "conflict" : ["QuotaExceededError", "SecurityError"].includes((failure as Error).name) ? "unreliable" : "local", (failure as Error).message);
          throw failure;
        }
      }
      report("saved");
    };
    active = runDraftSave(key, work).finally(() => { active = null; });
    return active;
  };
  const schedule = () => { if (!conflict && status !== "unreliable") scheduleDraftSave(key, flush, 180); };
  return {
    key, snapshot, dirty, flush,
    edit(bounds: RangeBounds) {
      if (!valid({ ...desired, ...bounds })) return;
      desired = { ...desired, ...bounds };
      try { put(); report(conflict ? "conflict" : equal(desired, saved) && !hasPending() ? "saved" : "local"); schedule(); }
      catch { report("unreliable", "浏览器未能保存范围暂存，请保持本页打开。"); }
    },
    refresh(range: AudioRangeRecord) {
      if (!sameSource(range) || active) return;
      if (dirty() && equal(desired, range) && !hasPending()) { saved = range; desired = valueOf(range); conflict = undefined; clearDraft(key, undefined, false, workspaceId); report("saved"); }
      else if (dirty() && range.revision !== saved.revision && !equal(desired, range)) { conflict = range; report("conflict", "另一页已修改同一声音的范围。"); }
      else if (!dirty()) { saved = range; desired = valueOf(range); report("saved"); }
    },
    choose(which: "mine" | "server") {
      if (!conflict || active) return;
      saved = conflict; conflict = undefined;
      if (which === "server") desired = valueOf(saved);
      try {
        if (equal(desired, saved)) clearDraft(key, undefined, true, workspaceId); else put();
        report(equal(desired, saved) ? "saved" : "local"); schedule();
      } catch { report("unreliable", "浏览器未能保存范围暂存，请保持本页打开。"); }
    },
    restoreDraft() {
      const draft = readDraft<RangeValue>(key, workspaceId);
      if (!draft || !valid(draft.draft)) throw new Error("这份范围暂存与当前声音不匹配，原记录已保留。");
      desired = draft.draft;
      conflict = draft.revision !== saved.revision && !hasPending() && !equal(desired, saved) ? saved : undefined;
      report(conflict ? "conflict" : "local"); schedule();
    },
    start: schedule,
  };
}
