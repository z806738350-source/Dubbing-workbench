import { useEffect, useState } from "react";
import { api } from "./api";
import { Select } from "./components";
import { draftScopeRevision, withSavedDrafts } from "./autosave";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import type { ChapterDetail, GenerationUnit } from "./types";

type Suggestion = { id: string; kind: string; unitId: string; unitRevision: number; revision: number; contextRevision: number; draftVersion: number; status: string; error?: string; issues?: string[]; createdAt?: string; model: string; items: {
  id: string; description: string; kind: string; memberId: string; position: string; endMemberId?: string; endPosition?: string; evidence: string; reason?: string; sourceQuote?: string; issues?: string[];
}[] };
export default function SceneSuggestions({ unit, chapter, contextRevision, model, enabled, refresh, savedBase }: { unit: GenerationUnit; chapter: ChapterDetail; contextRevision: number; model: string; enabled: boolean; refresh: () => Promise<void>; savedBase?: () => Promise<{ revision: number; entityRevision: number }> }) {
  const records = (chapter.suggestions as Suggestion[]).filter(record => record.kind === "scene" && record.unitId === unit.id);
  const [selected, setSelected] = useState<string[]>([]), [view, setView] = useState("");
  const [grantId, setGrantId] = useState<string | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const record = records.find(record => record.id === view) || records.at(-1);
  useEffect(() => setSelected([]), [record?.id, record?.draftVersion]);
  const current = record?.status === "ready" && record.revision === chapter.revision && record.contextRevision === contextRevision && record.unitRevision === unit.revision;
  const running = records.some(record => record.status === "running");
  const analyze = async () => {
    setPending(true); setError("");
    try {
      await withSavedDrafts("chapter:" + chapter.id, ["unit:" + unit.id + "/scene", "events:" + unit.id, ...unit.members.map(id => "segment:" + id)], async () => {
        const base = savedBase ? await savedBase() : { revision: draftScopeRevision("chapter:" + chapter.id, chapter.revision), entityRevision: unit.revision };
        if (base.revision !== draftScopeRevision("chapter:" + chapter.id, chapter.revision)) throw new Error("声音背景在准备期间发生了变化，请核对后再分析。");
        const result = await submitOperation("scene-analysis:" + unit.id, { kind: "prepareChapter", analysisKind: "scene", sceneEnabled: true, chapterId: chapter.id, revision: base.revision, unitId: unit.id, unitRevision: base.entityRevision, model, grantId });
        if (result.error) throw new Error(result.error);
        await refresh();
      });
    } catch (failure) { setError((failure as Error).message); }
    finally { setPending(false); }
  };
  return <details className="task-panel-section"><summary>让 AI 提供声音建议</summary>
    <p className="hint">只分析这段台词的声音背景，不改台词、不自动生成声音。选择需要的建议后，一次加入当前场景。</p>
    <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="分析这段声音背景" step="text" steps={["scene"]} model={model} onReady={setGrantId} disabled={!enabled || pending || running} />
    <button className="button secondary" disabled={!enabled || pending || running || !grantId} onClick={() => void analyze()}>{pending || running ? "正在分析…" : "分析声音建议"}</button>
    {error && <p className="error-inline" role="alert">{error}</p>}
    {record && <>
      <p className={current ? "hint" : "warning"}>{record.status === "running" ? "正在分析，关闭面板不会取消。" : current ? "请选择想加入这次场景的声音。" : record.status === "applied" ? "建议已加入目标场景，生成仍由你发起。" : "这份建议已过期或需要处理，请核对后重新分析。"}</p>
      {record.error && <p className="error-inline">{record.error}</p>}{record.issues?.map((issue, index) => <p className="warning" key={index}>{issue}</p>)}
      {record.items.map(item => <section className="task-event-card" key={item.id}>
        <label className="check-label"><input type="checkbox" aria-label={"加入声音 " + item.description} checked={selected.includes(item.id)} disabled={!current || !!item.issues?.length} onChange={event => setSelected(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} />{item.description}</label>
        <p className="hint">第 {(chapter.segments.find(segment => segment.id === item.memberId)?.order ?? -1) + 1} 句{({ before: "之前", during: "期间", after: "之后" } as Record<string, string>)[item.position]}{item.endMemberId && "，持续至第 " + ((chapter.segments.find(segment => segment.id === item.endMemberId)?.order ?? -1) + 1) + " 句"} · {item.evidence}</p>
        {(item.reason || item.sourceQuote) && <details><summary>为什么推荐</summary>{item.reason && <p>{item.reason}</p>}{item.sourceQuote && <p className="original-excerpt">{item.sourceQuote}</p>}</details>}{item.issues?.map((issue, index) => <p className="warning" key={index}>{issue}</p>)}
      </section>)}
      {current && <button className="button secondary" disabled={!selected.length || !enabled || pending} onClick={() => void (async () => {
        setPending(true); setError("");
        try { await api("/analysis/apply", { id: record.id, draftVersion: record.draftVersion, revision: chapter.revision, unitRevision: unit.revision, selected }); setSelected([]); await refresh(); }
        catch (failure) { setError((failure as Error).message); }
        finally { setPending(false); }
      })()}>加入选中的 {selected.length} 个声音</button>}
    </>}
    {!!records.length && <details><summary>历史建议与模型</summary><p className="hint">文本模型：{model}</p><Select label="历史声音建议" value={record!.id} options={records.map(record => ({ value: record.id, label: (record.createdAt ? new Date(record.createdAt).toLocaleString("zh-CN") : "历史建议") + " · " + record.model }))} onChange={id => { setView(id); setSelected([]); }} /></details>}
  </details>;
}
