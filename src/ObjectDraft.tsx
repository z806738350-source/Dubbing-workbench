import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { draftWorkspace, clearDraft, discardDraft, finishDraftSave, listDrafts, readDraft, recoverDraft, writeDraft, type DraftRecord } from "./drafts";
import { Dialog } from "./components";
import { activeDraftSave, cancelDraftSave, draftSaveStatus, flushRegisteredDraft, forgetSaveOperation, mergeSavedValues, notifyDraftSaves, pendingSaveOperation, queueDraftSave, registerDraftSave, runDraftSave, saveOperationId, saveStateLabels, scheduleDraftSave, subscribeDraftSaves, type SaveContext, type SaveState } from "./autosave";

type Value<T> = { type: string; version: 1; value: T };
export type Saved<T> = { value: T; revision: number; chapterRevision?: number; targetId?: string; changes?: string[] };
export type DraftOptions<T> = { scope?: string; chapterRevision?: number; dependencies?: string[]; changes?: string[]; coupled?: string[][]; legacyRaw?: boolean; deferUnmounted?: boolean; locked?: boolean; delay?: number; validate?: (value: T) => string | null; persist?: (value: T, expected: number, context: SaveContext) => Promise<Saved<T>> };
const envelope = <T,>(type: string, value: T): Value<T> => ({type, version: 1, value});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const storageFailure = (error:unknown) => ["QuotaExceededError","SecurityError"].includes((error as Error)?.name);
const valid = (draft: unknown, type: string, shape: object) => !!draft && typeof draft === "object" && (draft as Value<object>).type === type && (draft as Value<object>).version === 1 && !!(draft as Value<object>).value && typeof (draft as Value<object>).value === "object" && Object.entries(shape).every(([field,v])=>Array.isArray(v) ? Array.isArray(((draft as Value<object>).value as Record<string,unknown>)[field]) : typeof ((draft as Value<object>).value as Record<string,unknown>)[field] === typeof v);
export const objectDraftId = (type: string, id: string) => type + "-v1/" + id;
export function useDraftSaveStatus(scope: string, dependencies?: string[]) {
  return useSyncExternalStore(subscribeDraftSaves,()=>draftSaveStatus(scope,dependencies),()=>"saved" as SaveState);
}

// Keep subsequent user changes while accepting the exact normalized save result.
export function useObjectDraft<T extends object>(type: string, id: string, value: T, revision: number, options: DraftOptions<T> = {}) {
  const key = options.legacyRaw ? id : objectDraftId(type, id);
  const workspaceIdentity=useRef(draftWorkspace()).current;
  const wrap = (next: T) => options.legacyRaw ? next : envelope(type, next);
  const unwrap = (next: T | Value<T>) => options.legacyRaw ? next as T : (next as Value<T>).value;
  const validValue = (next: unknown) => options.legacyRaw ? !!next && typeof next === "object" && ["text","performance","roleId","config"].filter(field => field in value).every(field=>typeof (next as Record<string,unknown>)[field] === typeof (value as Record<string,unknown>)[field]) : valid(next, type, value);
  let cached: {draft:Value<T>;revision:number} | null = null;
  let readError = "";
  try {
    const result=readDraft<T | Value<T>>(key,workspaceIdentity);
    if(result && (!validValue(result.draft) || !Number.isSafeInteger(result.revision) || result.revision < 0))readError="草稿格式不同，原记录仍保留；请明确处理后编辑。";
    else if (result) cached={draft:envelope(type,unwrap(result.draft)),revision:result.revision};
  } catch { readError="本页草稿无法读取，原记录仍保留；请明确处理后编辑。"; }
  const [cacheError,setCacheError]=useState(readError);
  const [draft, setDraft] = useState(cached?.draft.value || value);
  const [base, setBase] = useState(cached?.revision ?? revision);
  const [dirty, setDirty] = useState(!!cached);
  const [saving, setSaving] = useState(false);
  const initialStatus:SaveState=readError ? "unreliable" : cached ? "local" : "saved";
  const initialChapterRevision=options.legacyRaw ? cached?.revision ?? options.chapterRevision : (cached?.draft.value as {chapterRevision?:number} | undefined)?.chapterRevision ?? options.chapterRevision;
  const [composing, setComposing] = useState(false), [frozen, setFrozen] = useState(false), [error, setError] = useState(""), [status, setStatus] = useState<SaveState>(initialStatus), [targetId, setTargetId] = useState<string | undefined>();
  const current = useRef({draft, base, dirty, chapterRevision:initialChapterRevision, composing:false, frozen:false, status:initialStatus as SaveState, error:"", options, targetId:undefined as string | undefined,transferredKey:undefined as string|undefined});
  current.current = {...current.current,draft,base,dirty,options,targetId};
  const pending = useRef<Promise<Saved<T> & {dirty:boolean}> | null>(null);
  const report = (state: SaveState, message = "") => { current.current.status=state;current.current.error=message;setStatus(state);setError(message);notifyDraftSaves(); };
  const put = (next: T, nextBase: number) => writeDraft(key, wrap(next), nextBase,workspaceIdentity);
  const apply = (next: T, nextBase: number, nextDirty: boolean) => {
    current.current = {...current.current,draft: next, base: nextBase, dirty: nextDirty};
    setDraft(next); setBase(nextBase); setDirty(nextDirty);
  };
  const savedText = JSON.stringify(value);
  useEffect(() => { if (!current.current.dirty && !pending.current) { apply(value, revision, false);current.current.chapterRevision=options.chapterRevision; } }, [savedText, revision, options.chapterRevision]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{key: string; submitted: string; saved: Saved<T>;workspaceIdentity?:string}>).detail;
      if (detail.key !== key || detail.workspaceIdentity!==workspaceIdentity || !current.current.dirty) return;
      const before = JSON.parse(detail.submitted) as {draft: Value<T>; revision: number};
      const now = current.current;
      current.current.chapterRevision=detail.saved.chapterRevision ?? current.current.chapterRevision;
      if (same(wrap(now.draft), before.draft) && now.base === before.revision) {
        clearDraft(key,undefined,false,workspaceIdentity); apply(detail.saved.value, detail.saved.revision, false);
      } else {
        const nextBase = now.base === before.revision ? detail.saved.revision : now.base;
        const next = now.base === before.revision ? mergeSavedValues(unwrap(before.draft), now.draft, detail.saved.value, current.current.options.coupled) : now.draft;
        apply(next, nextBase, true);
        try {put(next, nextBase);} catch {report("unreliable","未能可靠暂存，请复制保留本页编辑；不要关闭页面。");}
      }
    };
    window.addEventListener("workbench-object-saved", listener);
    return () => window.removeEventListener("workbench-object-saved", listener);
  }, [key, type]);
  const edit = (patch: Partial<T>) => {
    if(cacheError)return;
    if(current.current.frozen || current.current.options.locked)return;
    const next = {...current.current.draft, ...patch};
    apply(next, current.current.base, true);
    try { put(next, current.current.base); if(current.current.status !== "conflict")report("local"); } catch { report("unreliable","未能可靠暂存，请复制保留本页编辑；不要关闭页面。"); }
  };
  const save = (persist: (draft: T, expected: number, context: SaveContext) => Promise<Saved<T>>): Promise<Saved<T> & {dirty:boolean}> => {
    if(pending.current)return pending.current;
    const existing=activeDraftSave(key);if(existing)return existing.then(()=>flush());
    const work = async () => {
    if(draftWorkspace()!==workspaceIdentity)throw new Error("工作区已变化，原编辑保留在原工作区的本机暂存；请重新打开目标后继续。");
    if(cacheError)throw new Error(cacheError);
    if(current.current.composing)throw new Error("正在输入中文，请完成选字后再继续");
    if(current.current.options.locked)throw new Error("当前章节正在制作，本页修改仅暂存本机");
    if(typeof navigator !== "undefined" && navigator.onLine === false)throw new Error("连接已断开，本页修改仅暂存本机");
    const problem=current.current.options.validate?.(current.current.draft);if(problem)throw new Error(problem);
    if(current.current.status === "unreliable"){try {put(current.current.draft,current.current.base);}catch{throw new Error("未能可靠暂存，请先复制保留本页编辑");}}
    setSaving(true);
    report("saving");
    cancelDraftSave(key);
    const before = current.current;
    const previous=pendingSaveOperation(key,workspaceIdentity);
    const submittedValue=previous ? previous.payload.value as T : before.draft;
    const submittedBase=previous?.payload.revision ?? before.base;
    const submitted = JSON.stringify({draft: wrap(submittedValue), revision: previous ? submittedBase : before.base});
    try {
      const scoped = before.options.chapterRevision !== undefined;
      const scope = before.options.scope || key;
      const received = await queueDraftSave(scope, scoped ? previous?.payload.chapterRevision ?? before.chapterRevision ?? before.options.chapterRevision! : submittedBase, before.options.dependencies || [key], async actualRevision => {
        if(draftWorkspace()!==workspaceIdentity)throw new Error("工作区已变化，本次未保存；原编辑仍在本机暂存。");
        const expected = previous?.payload.revision ?? (before.options.legacyRaw && scoped ? actualRevision : before.base);
        const operationId=previous?.id || saveOperationId(key,{value:submittedValue,revision:expected,chapterRevision:scoped ? actualRevision : undefined},workspaceIdentity);
        const saved=await persist(submittedValue,expected,{operationId,chapterRevision:scoped ? previous?.payload.chapterRevision ?? actualRevision : undefined,replay:!!previous});
        return {saved,operationId,inputRevision:expected,revision:scoped ? saved.chapterRevision! : saved.revision,changes:saved.changes || before.options.changes || before.options.dependencies || [key]};
      },previous?.id);
      const saved = received.saved;
      let remaining = finishDraftSave<T | Value<T>>(key, submitted, saved.revision, received.inputRevision,workspaceIdentity);
      if (remaining?.revision === saved.revision) {
        remaining = {draft:wrap(mergeSavedValues(submittedValue, unwrap(remaining.draft), saved.value, before.options.coupled)),revision:saved.revision};
        writeDraft(key, remaining.draft, remaining.revision,workspaceIdentity);
      }
      current.current.chapterRevision=saved.chapterRevision ?? current.current.chapterRevision;
      if(current.current.status === "unreliable" && current.current.dirty){
        const kept=mergeSavedValues(submittedValue,current.current.draft,saved.value,before.options.coupled);
        remaining={draft:wrap(kept),revision:saved.revision};writeDraft(key,remaining.draft,remaining.revision,workspaceIdentity);
      }
      apply(remaining ? unwrap(remaining.draft) : saved.value,saved.revision,!!remaining);
      window.dispatchEvent(new CustomEvent("workbench-object-saved", {detail: {key, submitted, saved,workspaceIdentity}}));
      if (saved.targetId && objectDraftId(type, saved.targetId) !== key && remaining) {
        const target = options.legacyRaw ? saved.targetId : objectDraftId(type, saved.targetId);
        if (readDraft(target,workspaceIdentity)) throw new Error("已创建对象已有本页草稿，续写仍保留在新建草稿，请先处理");
        const source = JSON.stringify(remaining);
        writeDraft(target, remaining.draft, remaining.revision,workspaceIdentity);
        if (!clearDraft(key, source,false,workspaceIdentity)) {
          clearDraft(target, source,false,workspaceIdentity);
          throw new Error("新建草稿已改变，续写仍保留，请重新处理");
        }
        current.current.transferredKey=target;
        apply(unwrap(remaining.draft),remaining.revision,false);
      }
      if(saved.targetId){current.current.targetId=saved.targetId;setTargetId(saved.targetId);}
      forgetSaveOperation(key,received.operationId,workspaceIdentity);
      report(remaining ? "local" : "saved");
      if(remaining && current.current.options.persist && !saved.targetId)scheduleDraftSave(key,flush,current.current.options.delay);
      return {...saved,dirty:!!remaining};
    } catch (failure) { if((failure as {status?:number}).status&&(failure as {retryClass?:string}).retryClass!=='check-existing-operation'){const known=pendingSaveOperation(key,workspaceIdentity);if(known)forgetSaveOperation(key,known.id,workspaceIdentity);}report((failure as {status?:number}).status === 409 ? "conflict" : storageFailure(failure) || current.current.status === "unreliable" ? "unreliable" : "local", storageFailure(failure) ? "未能可靠暂存，请复制保留本页编辑；原草稿仍保留。" : (failure as Error).message);throw failure; }
    finally { setSaving(false); }
    };
    pending.current=runDraftSave(key,work).catch(failure=>{if(current.current.status !== "conflict")report((failure as {status?:number}).status === 409 ? "conflict" : current.current.status === "unreliable" ? "unreliable" : "local",(failure as Error).message);throw failure;}).finally(()=>{pending.current=null;});
    return pending.current;
  };
  const flush = async (): Promise<Saved<T> & {dirty:boolean}> => {
    if(pending.current)await pending.current;
    if(current.current.transferredKey && hasTransferredDraft())return flushRegisteredDraft(current.current.transferredKey) as Promise<Saved<T> & {dirty:boolean}>;
    if(!current.current.dirty)return {value:current.current.draft,revision:current.current.base,chapterRevision:current.current.chapterRevision,targetId:current.current.targetId,dirty:false};
    const persist=current.current.options.persist;if(!persist)throw new Error("这份编辑尚未接入自动保存，请在原编辑区保存");
    return save(persist);
  };
  const discard = () => { cancelDraftSave(key);clearDraft(key,undefined,true,workspaceIdentity);setCacheError("");apply(value, revision, false);current.current.chapterRevision=options.chapterRevision;report("saved"); };
  useEffect(()=>{
    const abandoned=(event:Event)=>{const detail=(event as CustomEvent<{id:string;workspaceIdentity?:string}>).detail;if(detail.id !== key || detail.workspaceIdentity!==workspaceIdentity)return;cancelDraftSave(key);setCacheError("");apply(value,revision,false);current.current.chapterRevision=options.chapterRevision;report("saved");};
    const restored=(event:Event)=>{
      const detail=(event as CustomEvent<{id:string;data:{draft:T|Value<T>;revision:number};workspaceIdentity?:string}>).detail;if(detail.id !== key || detail.workspaceIdentity!==workspaceIdentity)return;
      if(!validValue(detail.data.draft)){setCacheError("草稿格式不同，原记录仍保留；请明确处理后编辑。");report("unreliable");return;}
      const restoredValue=unwrap(detail.data.draft);apply(restoredValue,detail.data.revision,true);
      current.current.chapterRevision=options.legacyRaw ? detail.data.revision : (restoredValue as {chapterRevision?:number}).chapterRevision ?? options.chapterRevision;report("local");
    };
    window.addEventListener("workbench-draft-discarded",abandoned);window.addEventListener("workbench-draft-restored",restored);
    return()=>{window.removeEventListener("workbench-draft-discarded",abandoned);window.removeEventListener("workbench-draft-restored",restored);};
  },[key,savedText,revision,options.chapterRevision]);
  const rebase = () => { if(pending.current || current.current.frozen)return;apply(current.current.draft,revision,true);current.current.chapterRevision=options.chapterRevision;put(current.current.draft,revision);report("local"); };
  const recover = async (entry: DraftRecord<T | Value<T>>) => {
    if (!validValue(entry.data?.draft) || !Number.isSafeInteger(entry.data?.revision) || entry.data.revision < 0) throw new Error("草稿格式不同，原记录仍保留");
    const result = await recoverDraft<T | Value<T>>(key, entry);
    apply(unwrap(result.draft), result.revision, true);report("local");
  };
  const freeze = (next: boolean) => {current.current.frozen=next;setFrozen(next);};
  const compositionStart = () => {current.current.composing=true;setComposing(true);cancelDraftSave(key);};
  const compositionEnd = () => {current.current.composing=false;setComposing(false);};
  const hasTransferredDraft=()=>{if(!current.current.transferredKey)return false;try{return !!readDraft(current.current.transferredKey,workspaceIdentity);}catch{return true;}};
  useEffect(()=>registerDraftSave(key,{scope:options.scope || key,dependencies:options.dependencies || [key],deferUnmounted:()=>{if(!current.current.options.deferUnmounted || current.current.targetId || pending.current || activeDraftSave(key))return false;try{return !pendingSaveOperation(key,workspaceIdentity);}catch{return false;}},state:()=>hasTransferredDraft()?"local":current.current.status,dirty:()=>current.current.dirty || hasTransferredDraft(),flush,freeze}),[key,options.scope,JSON.stringify(options.dependencies)]);
  useEffect(()=>{
    if(!dirty || !options.persist || composing || options.locked || status === "conflict" || status === "unreliable")return;
    if(options.validate?.(draft))return;
    scheduleDraftSave(key,flush,options.delay);
  },[key,dirty,savedText,JSON.stringify(draft),composing,options.locked,status,options.delay]);
  useEffect(()=>{const reconnect=()=>{if(current.current.dirty && current.current.options.persist && current.current.status !== "conflict")scheduleDraftSave(key,flush,0);};window.addEventListener("online",reconnect);return()=>window.removeEventListener("online",reconnect);},[key]);
  return {key,type,draft,base,dirty,saving,cacheError,error,status,composing,frozen,targetId,workspaceValue:value,workspaceRevision:revision,edit,save,flush,discard,rebase,recover,compositionStart,compositionEnd,valid:validValue,unwrap,label:saveStateLabels[status]};
}

export function ObjectDraftTools<T extends object>({controller, title, render, onError, inline = false}: {
  controller: ReturnType<typeof useObjectDraft<T>>; title: string; render: (value: T) => ReactNode; onError: (error: string) => void; inline?: boolean;
}) {
  const [entries, setEntries] = useState<DraftRecord<Value<T> | T>[] | null>(null);
  const [others,setOthers]=useState({orphan:0,active:0});
  useEffect(()=>{
    let disposed=false;
    const scan=()=>void listDrafts(controller.key).then(records=>{if(!disposed)setOthers({orphan:records.filter(entry=>entry.status === "orphan").length,active:records.filter(entry=>entry.status === "active").length});}).catch(()=>{});
    scan();const changed=(event:StorageEvent)=>{if(event.key?.startsWith("draft-"))scan();};window.addEventListener("storage",changed);
    return()=>{disposed=true;window.removeEventListener("storage",changed);};
  },[controller.key,controller.dirty,controller.status]);
  const refresh = async () => {const records=await listDrafts<Value<T> | T>(controller.key);setEntries(records);setOthers({orphan:records.filter(entry=>entry.status === "orphan").length,active:records.filter(entry=>entry.status === "active").length});};
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { onError((error as Error).message); } };
  return <>
    {controller.cacheError && <div className="warning"><p>{controller.cacheError}</p><button type="button" className="text-button warning" onClick={controller.discard}>明确放弃无法读取的本页草稿</button></div>}
    <div className={"draft-notice " + controller.status}><span role="status" aria-live="polite">{controller.label}</span>{controller.dirty && <button type="button" className="text-button" disabled={controller.frozen} onClick={controller.discard}>放弃本页编辑</button>}</div>
    {controller.error && <p className={controller.status === "conflict" ? "warning" : "hint"}>{controller.error}</p>}
    {controller.status === "conflict" && <section className="save-conflict"><div className="merge-comparison"><div><strong>本页编辑</strong>{render(controller.draft)}</div><div><strong>工作区当前内容</strong>{render(controller.workspaceValue)}</div></div><button className="button small" disabled={controller.saving || controller.frozen} onClick={()=>void run(async()=>controller.rebase())}>已比较，用本页编辑更新这一处</button><button className="text-button" disabled={controller.saving || controller.frozen} onClick={controller.discard}>保留工作区内容</button></section>}
    {controller.status === "unreliable" && <button type="button" className="button small" onClick={()=>void run(()=>navigator.clipboard.writeText(JSON.stringify(controller.draft,null,2)))}>复制保留本页编辑</button>}
    {others.active > 0 && <p className="hint">另一页有未提交修改，请在原页面处理。</p>}
    {(controller.dirty || controller.status !== "saved" || others.orphan > 0) && <button type="button" className="text-button" onClick={() => void run(refresh)}>恢复未完成编辑 · {title}{others.orphan > 0 ? " · " + others.orphan : ""}</button>}
    {entries && <Dialog title={title + " · 未完成编辑"} presentation={inline ? "inline" : "sidepanel"} onClose={() => setEntries(null)}>
      <p className="hint">活动页面的草稿请在原页处理。关闭页面的草稿可逐份恢复或放弃；恢复保留原保存基准。</p>
      <button type="button" className="text-button" onClick={() => void run(refresh)}>刷新草稿列表</button>
      {!entries.length && <p>没有本机草稿。</p>}
      {entries.map(entry => <section className="inspector-section" key={entry.key}>
        <h3>{entry.status === "current" ? "本页草稿" : entry.status === "active" ? "其他活动页面" : "已关闭页面"}</h3>
        {controller.valid(entry.data?.draft) ? render(controller.unwrap(entry.data.draft)) : <><p className="warning">草稿格式不同，原记录仍保留。可核对原内容后明确处理。</p><pre className="prompt-text">{JSON.stringify(entry.data?.draft,null,2)}</pre></>}
        <p className="hint">保存基准 {entry.data?.revision}{entry.data?.revision !== controller.base ? " · 需核对当前资料" : ""}</p>
        {entry.status === "orphan" && <div className="button-row">
          <button className="button small" disabled={controller.dirty || controller.saving || !!controller.cacheError || !controller.valid(entry.data?.draft)} onClick={() => void run(async () => { await controller.recover(entry); setEntries(null); })}>恢复到本页</button>
          <button className="text-button warning" onClick={() => void run(async () => { await discardDraft(controller.key, entry); await refresh(); })}>放弃这份草稿</button>
        </div>}
      </section>)}
    </Dialog>}
  </>;
}
