const storage = localStorage, session = sessionStorage, locks = navigator.locks;
let owner = "";
const keys = () => Array.from({length:storage.length}, (_, i) => storage.key(i)).filter((k): k is string => !!k?.startsWith("draft-"));
const keyOf = (id: string) => `draft-${id}:${owner}`;
const matches = (key: string, id: string) => key === "draft-" + id || key.startsWith(`draft-${id}:`);

export type DraftRecord<T> = {
  key: string;
  raw: string;
  data: {draft:T; revision:number};
  status: "current" | "active" | "orphan";
};

export async function initDrafts() {
  const previous = session.getItem("draft-owner");
  const candidates = previous ? [previous] : [...new Set(keys().filter(k => k.includes(":")).map(k => k.slice(k.lastIndexOf(":") + 1)))];
  candidates.push(crypto.randomUUID());
  for (const candidate of candidates) {
    // A copied tab inherits sessionStorage; the native lock keeps its owner distinct.
    const claimed = await new Promise<boolean>((resolve, reject) => {
      void locks.request(`workbench-drafts-${candidate}`, {ifAvailable:true}, lock => {
        resolve(!!lock);
        if (lock) return new Promise<void>(() => {}); // Released by the browser when this document closes.
      }).catch(reject);
    });
    if (!claimed) continue;
    owner = candidate;
    if (previous && previous !== owner) {
      for (const key of keys().filter(k => k.endsWith(":" + previous))) {
        storage.setItem(key.slice(0, -previous.length) + owner, storage.getItem(key)!);
      }
    }
    session.setItem("draft-owner", owner);
    return;
  }
}

export function readDraft<T>(id: string): {draft:T; revision:number} | null {
  let raw = storage.getItem(keyOf(id));
  if (raw === null) {
    const legacy = "draft-" + id;
    raw = storage.getItem(legacy);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      storage.setItem(keyOf(id), raw);
      if (storage.getItem(legacy) === raw) storage.removeItem(legacy);
      return parsed;
    }
  }
  return raw === null ? null : JSON.parse(raw);
}

export function writeDraft(id: string, draft: unknown, revision: number) {
  storage.setItem(keyOf(id), JSON.stringify({draft, revision}));
}

export function clearDraft(id: string, expected?: string) {
  if (expected !== undefined && storage.getItem(keyOf(id)) !== expected) return false;
  storage.removeItem(keyOf(id));
  return true;
}

export function finishDraftSave<T>(id: string, submitted: string, savedRevision: number): {draft:T; revision:number} | null {
  if (!Number.isSafeInteger(savedRevision) || savedRevision < 1) throw new Error("保存结果缺少有效版本，草稿仍保留，请核对最新资料");
  const base = JSON.parse(submitted).revision;
  if (!Number.isSafeInteger(base) || savedRevision !== base + 1) throw new Error("保存版本与本次提交不一致，草稿仍保留，请核对最新资料");
  if (clearDraft(id, submitted)) return null;
  const raw = storage.getItem(keyOf(id));
  if (raw === null) return null;
  const remaining = JSON.parse(raw);
  if (remaining.revision === base) {
    remaining.revision = savedRevision;
    storage.setItem(keyOf(id), JSON.stringify(remaining));
  }
  return remaining;
}

export async function listDrafts<T>(id: string): Promise<DraftRecord<T>[]> {
  const held = new Set(((await locks.query()).held || []).map(lock => lock.name));
  return keys().filter(key => matches(key, id)).flatMap(key => {
    const raw = storage.getItem(key);
    return raw === null ? [] : [{key, raw, data:JSON.parse(raw), status:key === keyOf(id) ? "current" :
      key.includes(":") && held.has("workbench-drafts-" + key.slice(key.lastIndexOf(":") + 1)) ? "active" : "orphan"}];
  });
}

async function accessOrphan<T>(id: string, entry: {key:string; raw:string}, apply: () => T): Promise<T> {
  if (!matches(entry.key, id) || entry.key === keyOf(id)) throw new Error("只能处理本片段的其他页面遗留草稿");
  const source = entry.key.includes(":") ? entry.key.slice(entry.key.lastIndexOf(":") + 1) : `legacy:${id}`;
  return locks.request("workbench-drafts-" + source, {ifAvailable:true}, lock => {
    if (!lock) throw new Error("该草稿页面仍在使用，请在原页面保存或放弃");
    if (storage.getItem(entry.key) !== entry.raw) throw new Error("草稿已改变，请重新查看后再处理");
    return apply();
  });
}

export function recoverDraft<T>(id: string, entry: {key:string; raw:string}): Promise<{draft:T; revision:number}> {
  return accessOrphan(id, entry, () => {
    if (storage.getItem(keyOf(id)) !== null) throw new Error("本页已有未保存草稿，请先保存或放弃，不能覆盖");
    const data = JSON.parse(entry.raw);
    storage.setItem(keyOf(id), entry.raw);
    if (storage.getItem(entry.key) !== entry.raw) {
      clearDraft(id, entry.raw);
      throw new Error("草稿已改变，请重新查看后再处理");
    }
    storage.removeItem(entry.key);
    return data;
  });
}

export function discardDraft(id: string, entry: {key:string; raw:string}): Promise<void> {
  return accessOrphan(id, entry, () => storage.removeItem(entry.key));
}

export function hasDraft(id: string) {
  // ponytail: scan local draft keys; cache an index if large draft sets make rendering slow.
  return keys().some(key => matches(key, id));
}
