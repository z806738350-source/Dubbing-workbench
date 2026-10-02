import { api } from "./api";

export type SaveState = "saved" | "saving" | "local" | "conflict" | "unreliable";
export const saveStateLabels: Record<SaveState, string> = { saved: "已保存到工作区", saving: "正在保存", local: "仅暂存本机", conflict: "需要处理冲突", unreliable: "未能可靠暂存" };
export function speechDraftProblem(value: {text:string;excluded:boolean;config:Record<string,unknown>}): string | null {
  if(!value.text.trim() && !value.excluded)return "正文为空，尚未应用。请继续输入，或明确选择这句不朗读。";
  for(const [key,min,max] of [["speech_rate",-50,100],["loudness_rate",-50,100],["pitch_rate",-12,12]] as const){
    const raw=value.config[key],number=Number(raw);
    if((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "" || !Number.isInteger(number) || number < min || number > max)return "数值尚未填完或超出范围，编辑仅暂存本机。";
  }
  return null;
}
export type SaveContext = { operationId: string; chapterRevision?: number; replay?: boolean };
type Receipt = { revision: number; changes: string[]; operationId?: string };
type Chain = { tail: Promise<unknown>; receipts: { before: number; after: number; changes: string[]; operationId?: string }[] };
const chains = new Map<string, Chain>();
const inflight = new Map<string, Promise<unknown>>();
export const activeDraftSave = (key: string) => inflight.get(key);
export function runDraftSave<T>(key: string, work: () => Promise<T>): Promise<T> {
  const existing=inflight.get(key);if(existing)return existing as Promise<T>;
  const result=Promise.resolve().then(work).finally(()=>{if(inflight.get(key) === result)inflight.delete(key);});
  inflight.set(key,result);return result;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const intersects = (a: string[], b: string[]) => a.includes("*") || b.includes("*") || a.some(id => b.includes(id));
export function draftScopeRevision(scope: string, base: number): number {
  let revision=base;
  for(const receipt of chains.get(scope)?.receipts || [])if(receipt.before === revision)revision=receipt.after;
  return revision;
}

// Only receipts from this page may advance a queued edit's base, and only across unrelated writes.
export function queueDraftSave<T extends Receipt>(scope: string, base: number, dependencies: string[], persist: (revision: number) => Promise<T>, replayId?: string): Promise<T> {
  let chain = chains.get(scope);
  if (!chain) { chain = { tail: Promise.resolve(), receipts: [] }; chains.set(scope, chain); }
  const current = chain;
  const result = current.tail.catch(() => {}).then(async () => {
    const recovered=replayId && current.receipts.find(receipt=>receipt.operationId === replayId);
    if(recovered){const receipt=await persist(recovered.before);if(receipt.revision !== recovered.after)throw new Error("已确认保存的回执发生变化，编辑仍保留");return receipt;}
    let revision = base;
    for (const receipt of current.receipts) {
      if (receipt.before !== revision) continue;
      if (intersects(dependencies, receipt.changes)) throw Object.assign(new Error("本页另一项保存改变了相关设置，请比较后重新保存"), { status: 409 });
      revision = receipt.after;
    }
    const receipt = await persist(revision);
    if (!Number.isSafeInteger(receipt.revision) || receipt.revision !== revision + 1)
      throw new Error("保存回执的版本与本次提交不一致，编辑仍保留");
    current.receipts.push({ before: revision, after: receipt.revision, changes: receipt.changes, operationId:receipt.operationId });
    return receipt;
  });
  current.tail = result;
  return result;
}

type SaveOperation<T> = { outcome: string; result?: T; error?: string; errorStatus?: number; dependencies?: { segmentIds?: string[]; unitIds?: string[]; roleIds?: string[] } };
const commandKey = (key: string) => "pending-save:" + (sessionStorage.getItem("draft-owner") || "page") + ":" + key;
export function saveOperationId(key: string, payload: unknown): string {
  const storageKey = commandKey(key), signature = JSON.stringify(payload);
  const raw = localStorage.getItem(storageKey);
  if (raw) { const previous = JSON.parse(raw); if (previous.signature === signature) return previous.id; throw new Error("上一次保存回执尚未确认，请先恢复该次保存，不能再次创建或覆盖"); }
  const id = crypto.randomUUID();
  localStorage.setItem(storageKey, JSON.stringify({ id, signature }));
  return id;
}
export function pendingSaveOperation(key: string): {id:string;payload:{value:unknown;revision:number;chapterRevision?:number}} | null {
  const raw=localStorage.getItem(commandKey(key));if(!raw)return null;
  const record=JSON.parse(raw);return {id:record.id,payload:JSON.parse(record.signature)};
}
export function forgetSaveOperation(key: string, id: string) {
  const storageKey = commandKey(key), raw = localStorage.getItem(storageKey);
  if (raw && JSON.parse(raw).id === id) localStorage.removeItem(storageKey);
}
export async function saveAction<T = unknown>(action: string, data: Record<string, unknown>, operationId: string, replay = false): Promise<T> {
  let operation: SaveOperation<T> | undefined;
  if(replay)try {operation=await api<SaveOperation<T>>("/operations/" + encodeURIComponent(operationId));}catch(error){if((error as {status?:number}).status !== 404)throw error;}
  try { if(!operation)operation = await api<SaveOperation<T>>("/operations", { operationId, kind: "save", action, data }); }
  catch (error) {
    if ((error as { status?: number }).status) throw error;
    try { operation = await api<SaveOperation<T>>("/operations/" + encodeURIComponent(operationId)); }
    catch { throw error; }
  }
  if (operation.outcome !== "completed" || operation.result === undefined)
    throw Object.assign(new Error(operation.error || "本次保存尚未确认，编辑仍保留"), { status: operation.errorStatus, operationId });
  return operation.result;
}

export function mergeSavedValues<T extends object>(before: T, after: T, saved: T, coupled: string[][] = []): T {
  const protectedFields = new Set(coupled.filter(group => group.some(key => !same(before[key as keyof T], after[key as keyof T]))).flat());
  return Object.fromEntries(Object.keys(saved).map(key => {
    const old = before[key as keyof T], next = after[key as keyof T], normalized = saved[key as keyof T];
    if (protectedFields.has(key)) return [key, next];
    if (same(old, next)) return [key, normalized];
    if (old && next && normalized && typeof old === "object" && typeof next === "object" && typeof normalized === "object" && !Array.isArray(old) && !Array.isArray(next) && !Array.isArray(normalized))
      return [key, mergeSavedValues(old, next, normalized)];
    return [key, next];
  })) as T;
}

type Saver = { scope: string; dependencies: string[]; state: () => SaveState; dirty: () => boolean; flush: () => Promise<unknown>; freeze: (value: boolean) => void; mounted?: boolean };
const savers = new Map<string, Saver>(), timers = new Map<string, ReturnType<typeof setTimeout>>(), listeners = new Set<() => void>();
export const hasLiveDraft = (key:string) => !!activeDraftSave(key) || !!savers.get(key)?.dirty();
export async function flushRegisteredDraft(key:string) {
  const saver=savers.get(key);if(!saver)throw new Error("已创建对象的续写仍暂存本机，请从恢复入口返回该对象后继续。");
  return saver.flush();
}
export const notifyDraftSaves = () => {for(const [key,saver]of savers)if(saver.mounted === false && !saver.dirty()){savers.delete(key);cancelDraftSave(key);}listeners.forEach(listener => listener());};
export const subscribeDraftSaves = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function registerDraftSave(key: string, saver: Saver) {
  saver.mounted=true;savers.set(key, saver); notifyDraftSaves();
  return () => {saver.mounted=false;notifyDraftSaves();};
}
export function cancelDraftSave(key: string) { clearTimeout(timers.get(key)); timers.delete(key); }
export function scheduleDraftSave(key: string, save: () => Promise<unknown>, delay = 600) {
  cancelDraftSave(key);
  timers.set(key, setTimeout(() => { timers.delete(key); void save().catch(() => {}); }, delay));
}
const selected = (scope: string, dependencies?: string[]) => [...savers.values()].filter(saver => saver.scope === scope && (!dependencies || intersects(dependencies, saver.dependencies)));
export function draftSaveStatus(scope: string, dependencies?: string[]): SaveState {
  const states = selected(scope, dependencies).map(saver => saver.state());
  return (["unreliable", "conflict", "saving", "local", "saved"] as SaveState[]).find(state => states.includes(state)) || "saved";
}
export async function withSavedDrafts<T>(scope: string, dependencies: string[] | undefined, next: () => Promise<T>): Promise<T> {
  const relevant = selected(scope, dependencies);
  relevant.forEach(saver => saver.freeze(true));
  try { for (const saver of relevant) if (saver.dirty()) await saver.flush(); return await next(); }
  finally { relevant.forEach(saver => saver.freeze(false)); }
}
export async function flushDraftSaves(scope: string, dependencies?: string[]) {
  await withSavedDrafts(scope, dependencies, async () => {});
}
