const storage = localStorage, session = sessionStorage, locks = navigator.locks;
let owner = "";
const keys = () => Array.from({length:storage.length}, (_, i) => storage.key(i)).filter((k): k is string => !!k?.startsWith("draft-"));
const keyOf = (id: string) => `draft-${id}:${owner}`;
const commandOf = (id:string,page=owner) => `pending-save:${page}:${id}`;
const ownerSuffix = (key:string) => key.match(/:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
const idOf = (key:string) => {const suffix=ownerSuffix(key);return key.slice(6,suffix ? -suffix[0].length : undefined);};
const matches = (key: string, id: string) => idOf(key) === id;

export type DraftRecord<T> = {
  key: string;
  raw: string;
  data: {draft:T; revision:number};
  status: "current" | "active" | "orphan";
  error?: string;
};

export async function initDrafts() {
  const previous = session.getItem("draft-owner");
  const candidates = previous ? [previous] : [...new Set(keys().flatMap(key=>{const suffix=ownerSuffix(key);return suffix ? [suffix[1]] : [];}))];
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
        const id=idOf(key),command=storage.getItem(commandOf(id,previous));
        if(command !== null)storage.setItem(commandOf(id),command);
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

export function clearDraft(id: string, expected?: string, abandonSave = false) {
  if (expected !== undefined && storage.getItem(keyOf(id)) !== expected) return false;
  storage.removeItem(keyOf(id));
  if(abandonSave){storage.removeItem(commandOf(id));if(typeof window !== "undefined")window.dispatchEvent(new CustomEvent("workbench-draft-discarded",{detail:{id}}));}
  return true;
}

export function finishDraftSave<T>(id: string, submitted: string, savedRevision: number, sentRevision?: number): {draft:T; revision:number} | null {
  if (!Number.isSafeInteger(savedRevision) || savedRevision < 1) throw new Error("保存结果缺少有效版本，草稿仍保留，请核对最新资料");
  const base = JSON.parse(submitted).revision;
  // A same-page coordinator may have advanced this base across proven unrelated writes.
  const expected = sentRevision ?? base;
  if (!Number.isSafeInteger(base) || !Number.isSafeInteger(expected) || expected < base || savedRevision !== expected + 1) throw new Error("保存版本与本次提交不一致，草稿仍保留，请核对最新资料");
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
  return (await listAllDrafts()).filter(record=>record.id === id).map(record=>record.entry as DraftRecord<T>);
}

export async function listAllDrafts(): Promise<{id:string;entry:DraftRecord<unknown>}[]> {
  const held = new Set(((await locks.query()).held || []).map(lock => lock.name));
  return keys().flatMap(key => {
    const raw = storage.getItem(key);
    if(raw === null)return [];
    const suffix=ownerSuffix(key),id=idOf(key);
    let data,error;
    try {data=JSON.parse(raw);}catch {data={draft:raw,revision:-1};error="这份暂存无法解析，原内容仍保留。";}
    const status:DraftRecord<unknown>["status"]=key === keyOf(id) ? "current" : suffix && held.has("workbench-drafts-" + suffix[1]) ? "active" : "orphan";
    return [{id,entry:{key,raw,data,status,...(error ? {error} : {})}}];
  });
}

async function accessOrphan<T>(id: string, entry: {key:string; raw:string}, apply: () => T): Promise<T> {
  if (!matches(entry.key, id) || entry.key === keyOf(id)) throw new Error("只能处理本片段的其他页面遗留草稿");
  const source = ownerSuffix(entry.key)?.[1] || `legacy:${id}`;
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
    const sourceOwner=ownerSuffix(entry.key)?.[1],sourceCommand=sourceOwner ? commandOf(id,sourceOwner) : null;
    const command=sourceCommand ? storage.getItem(sourceCommand) : null;
    if(command !== null && storage.getItem(commandOf(id)) !== null)throw new Error("本页已有未确认的保存回执，请先处理，不能覆盖");
    storage.setItem(keyOf(id), entry.raw);
    try {if(command !== null)storage.setItem(commandOf(id),command);}catch(error){clearDraft(id,entry.raw);throw error;}
    if (storage.getItem(entry.key) !== entry.raw) {
      clearDraft(id, entry.raw);
      if(command !== null && storage.getItem(commandOf(id)) === command)storage.removeItem(commandOf(id));
      throw new Error("草稿已改变，请重新查看后再处理");
    }
    storage.removeItem(entry.key);
    if(sourceCommand && command !== null && storage.getItem(sourceCommand) === command)storage.removeItem(sourceCommand);
    if(typeof window !== "undefined")window.dispatchEvent(new CustomEvent("workbench-draft-restored",{detail:{id,data}}));
    return data;
  });
}

export function discardDraft(id: string, entry: {key:string; raw:string}): Promise<void> {
  return accessOrphan(id, entry, () => {storage.removeItem(entry.key);const source=ownerSuffix(entry.key)?.[1];if(source)storage.removeItem(commandOf(id,source));});
}

export function hasDraft(id: string) {
  // ponytail: scan local draft keys; cache an index if large draft sets make rendering slow.
  return keys().some(key => matches(key, id));
}
