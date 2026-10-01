const storage = localStorage, session = sessionStorage, locks = navigator.locks;
let owner = "";
const keys = () => Array.from({length:storage.length}, (_, i) => storage.key(i)).filter((k): k is string => !!k?.startsWith("draft-"));
const keyOf = (id: string) => `draft-${id}:${owner}`;

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

export function hasDraft(id: string) {
  const prefix = "draft-" + id;
  // ponytail: scan local draft keys; cache an index if large draft sets make rendering slow.
  return keys().some(key => key === prefix || key.startsWith(prefix + ":"));
}
