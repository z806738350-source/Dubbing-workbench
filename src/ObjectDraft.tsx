import { useEffect, useRef, useState, type ReactNode } from "react";
import { clearDraft, discardDraft, finishDraftSave, listDrafts, readDraft, recoverDraft, writeDraft, type DraftRecord } from "./drafts";
import { Dialog } from "./components";

type Value<T> = { type: string; version: 1; value: T };
type Saved<T> = { value: T; revision: number; targetId?: string };
const envelope = <T,>(type: string, value: T): Value<T> => ({type, version: 1, value});
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const valid = (draft: unknown, type: string, shape: object) => !!draft && typeof draft === "object" && (draft as Value<object>).type === type && (draft as Value<object>).version === 1 && !!(draft as Value<object>).value && typeof (draft as Value<object>).value === "object" && Object.entries(shape).every(([field,v])=>Array.isArray(v) ? Array.isArray(((draft as Value<object>).value as Record<string,unknown>)[field]) : typeof ((draft as Value<object>).value as Record<string,unknown>)[field] === typeof v);
export const objectDraftId = (type: string, id: string) => type + "-v1/" + id;

// Keep subsequent user changes while accepting the exact normalized save result.
function mergeSaved<T extends object>(before: T, after: T, saved: T): T {
  return Object.fromEntries(Object.keys(saved).map(key => [key,
    same(before[key as keyof T], after[key as keyof T]) ? saved[key as keyof T] : after[key as keyof T],
  ])) as T;
}

export function useObjectDraft<T extends object>(type: string, id: string, value: T, revision: number) {
  const key = objectDraftId(type, id);
  let cached: {draft:Value<T>;revision:number} | null = null;
  let readError = "";
  try {
    const result=readDraft<Value<T>>(key);
    if(result && (!valid(result.draft,type,value) || !Number.isSafeInteger(result.revision) || result.revision < 0))readError="草稿格式不同，原记录仍保留；请明确处理后编辑。";
    else cached=result;
  } catch { readError="本页草稿无法读取，原记录仍保留；请明确处理后编辑。"; }
  const [cacheError,setCacheError]=useState(readError);
  const [draft, setDraft] = useState(cached?.draft.value || value);
  const [base, setBase] = useState(cached?.revision ?? revision);
  const [dirty, setDirty] = useState(!!cached);
  const [saving, setSaving] = useState(false);
  const current = useRef({draft, base, dirty});
  current.current = {draft, base, dirty};
  const put = (next: T, nextBase: number) => writeDraft(key, envelope(type, next), nextBase);
  const apply = (next: T, nextBase: number, nextDirty: boolean) => {
    current.current = {draft: next, base: nextBase, dirty: nextDirty};
    setDraft(next); setBase(nextBase); setDirty(nextDirty);
  };
  const savedText = JSON.stringify(value);
  useEffect(() => { if (!current.current.dirty) apply(value, revision, false); }, [savedText, revision]);
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{key: string; submitted: string; saved: Saved<T>}>).detail;
      if (detail.key !== key || !current.current.dirty) return;
      const before = JSON.parse(detail.submitted) as {draft: Value<T>; revision: number};
      const now = current.current;
      if (same(envelope(type, now.draft), before.draft) && now.base === before.revision) {
        clearDraft(key); apply(detail.saved.value, detail.saved.revision, false);
      } else {
        const nextBase = now.base === before.revision ? detail.saved.revision : now.base;
        const next = now.base === before.revision ? mergeSaved(before.draft.value, now.draft, detail.saved.value) : now.draft;
        put(next, nextBase); apply(next, nextBase, true);
      }
    };
    window.addEventListener("workbench-object-saved", listener);
    return () => window.removeEventListener("workbench-object-saved", listener);
  }, [key, type]);
  const edit = (patch: Partial<T>) => {
    if(cacheError)return;
    const next = {...current.current.draft, ...patch};
    put(next, current.current.base); apply(next, current.current.base, true);
  };
  const save = async (persist: (draft: T, expected: number) => Promise<Saved<T>>) => {
    if(cacheError)throw new Error(cacheError);
    if (saving) return;
    setSaving(true);
    const before = current.current;
    const submitted = JSON.stringify({draft: envelope(type, before.draft), revision: before.base});
    try {
      const saved = await persist(before.draft, before.base);
      let remaining = finishDraftSave<Value<T>>(key, submitted, saved.revision);
      if (remaining?.revision === saved.revision) {
        remaining = {draft:envelope(type, mergeSaved(before.draft, remaining.draft.value, saved.value)),revision:saved.revision};
        writeDraft(key, remaining.draft, remaining.revision);
      }
      window.dispatchEvent(new CustomEvent("workbench-object-saved", {detail: {key, submitted, saved}}));
      if (saved.targetId && objectDraftId(type, saved.targetId) !== key && remaining) {
        const target = objectDraftId(type, saved.targetId);
        if (readDraft(target)) throw new Error("已创建对象已有本页草稿，续写仍保留在新建草稿，请先处理");
        const source = JSON.stringify(remaining);
        writeDraft(target, remaining.draft, remaining.revision);
        if (!clearDraft(key, source)) {
          clearDraft(target, source);
          throw new Error("新建草稿已改变，续写仍保留，请重新处理");
        }
      }
      return {...saved,dirty:!!remaining};
    } finally { setSaving(false); }
  };
  const discard = () => { clearDraft(key); setCacheError(""); apply(value, revision, false); };
  const recover = async (entry: DraftRecord<Value<T>>) => {
    if (!valid(entry.data?.draft,type,value) || !Number.isSafeInteger(entry.data?.revision) || entry.data.revision < 0) throw new Error("草稿格式不同，原记录仍保留");
    const result = await recoverDraft<Value<T>>(key, entry);
    apply(result.draft.value, result.revision, true);
  };
  return {key, type, draft, base, dirty, saving, cacheError, edit, save, discard, recover, valid:(record:unknown)=>valid(record,type,value)};
}

export function ObjectDraftTools<T extends object>({controller, title, render, onError}: {
  controller: ReturnType<typeof useObjectDraft<T>>; title: string; render: (value: T) => ReactNode; onError: (error: string) => void;
}) {
  const [entries, setEntries] = useState<DraftRecord<Value<T>>[] | null>(null);
  const refresh = async () => setEntries(await listDrafts<Value<T>>(controller.key));
  const run = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { onError((error as Error).message); } };
  return <>
    {controller.cacheError && <div className="warning"><p>{controller.cacheError}</p><button type="button" className="text-button warning" onClick={controller.discard}>明确放弃无法读取的本页草稿</button></div>}
    {controller.dirty && <div className="draft-notice"><span>本页修改已暂存，尚未保存。</span><button type="button" className="text-button" onClick={controller.discard}>放弃本页草稿</button></div>}
    <button type="button" className="text-button" onClick={() => void run(refresh)}>查看本机草稿 · {title}</button>
    {entries && <Dialog title={title + " · 本机草稿"} onClose={() => setEntries(null)}>
      <p className="hint">活动页面的草稿请在原页处理。关闭页面的草稿可逐份恢复或放弃；恢复保留原保存基准。</p>
      <button type="button" className="text-button" onClick={() => void run(refresh)}>刷新草稿列表</button>
      {!entries.length && <p>没有本机草稿。</p>}
      {entries.map(entry => <section className="inspector-section" key={entry.key}>
        <h3>{entry.status === "current" ? "本页草稿" : entry.status === "active" ? "其他活动页面" : "已关闭页面"}</h3>
        {controller.valid(entry.data?.draft) ? render(entry.data.draft.value) : <><p className="warning">草稿格式不同，原记录仍保留。可核对原内容后明确处理。</p><pre className="prompt-text">{JSON.stringify(entry.data?.draft,null,2)}</pre></>}
        <p className="hint">保存基准 {entry.data?.revision}{entry.data?.revision !== controller.base ? " · 需核对当前资料" : ""}</p>
        {entry.status === "orphan" && <div className="button-row">
          <button className="button small" disabled={controller.dirty || controller.saving || !!controller.cacheError || !controller.valid(entry.data?.draft)} onClick={() => void run(async () => { await controller.recover(entry); setEntries(null); })}>恢复到本页</button>
          <button className="text-button warning" onClick={() => void run(async () => { await discardDraft(controller.key, entry); await refresh(); })}>放弃这份草稿</button>
        </div>}
      </section>)}
    </Dialog>}
  </>;
}
