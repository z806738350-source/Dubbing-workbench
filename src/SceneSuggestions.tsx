import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Select } from "./components";
import { draftScopeRevision, withSavedDrafts } from "./autosave";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import type { ChapterDetail, GenerationUnit, SoundEvent } from "./types";

type Suggestion = { id: string; kind: string; unitId: string; unitRevision: number; revision: number; contextRevision: number; draftVersion: number; status: string; error?: string; issues?: string[]; createdAt?: string; model: string; items: {
  id: string; description: string; kind: string; memberId: string; position: string; startMemberId?: string; startPosition?: string; endMemberId?: string; endPosition?: string; evidence: string; reason?: string; sourceQuote?: string; issues?: string[];
}[] };
const soundFields = ["kind", "description", "memberId", "position", "startMemberId", "endMemberId", "startPosition", "endPosition"] as const;
const soundValue = (sound: SoundEvent | Suggestion["items"][number], field: typeof soundFields[number]) =>
  field === "startPosition" ? sound.startMemberId ? sound.startPosition || "before" : undefined : field === "endPosition" ? sound.endMemberId ? sound.endPosition || "after" : undefined : sound[field];
export default function SceneSuggestions({ unit, chapter, contextRevision, model, enabled, refresh, savedBase }: { unit: GenerationUnit; chapter: ChapterDetail; contextRevision: number; model: string; enabled: boolean; refresh: () => Promise<void>; savedBase?: () => Promise<{ revision: number; entityRevision: number }> }) {
  const records = (chapter.suggestions as Suggestion[]).filter(record => record.kind === "scene" && record.unitId === unit.id);
  const [selected, setSelected] = useState<string[]>([]), [view, setView] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [grantId, setGrantId] = useState<string | null>(null), [pending, setPending] = useState<"analysis" | "apply" | null>(null), [error, setError] = useState(""), [applyError, setApplyError] = useState("");
  const [appliedMessage, setAppliedMessage] = useState("");
  const live=useRef(true);useEffect(()=>()=>{live.current=false;},[]);
  const record = records.find(record => record.id === view) || records.at(-1);
  useEffect(() => { setSelected([]); setAppliedMessage(""); }, [record?.id, record?.draftVersion]);
  const current = record?.status === "ready" && record.revision === chapter.revision && record.contextRevision === contextRevision && record.unitRevision === unit.revision;
  const reusable = historyOpen && !!record && ["ready", "applied", "partial"].includes(record.status);
  const included = (item: Suggestion["items"][number]) => (chapter.events || []).some(event => event.unitId === unit.id && event.state === "adopted" && event.validity === "valid" && soundFields.every(field => soundValue(event, field) === soundValue(item, field)));
  const hasMembers = (item: Suggestion["items"][number]) => {
    const positions = ["before", "during", "after"];
    if (!unit.members.includes(item.memberId) || !positions.includes(item.position)) return false;
    if (item.startMemberId === undefined && item.endMemberId === undefined) return true;
    const start = unit.members.indexOf(item.startMemberId!), end = unit.members.indexOf(item.endMemberId!);
    const from = positions.indexOf(item.startPosition || "before"), to = positions.indexOf(item.endPosition || "after");
    return start >= 0 && end >= start && from >= 0 && to >= 0 && (start !== end || from <= to);
  };
  const running = records.some(record => record.status === "running");
  const analyze = async () => {
    setPending("analysis"); setError(""); setApplyError(""); setAppliedMessage("");
    try {
      await withSavedDrafts("chapter:" + chapter.id, ["unit:" + unit.id + "/scene", "events:" + unit.id, ...unit.members.map(id => "segment:" + id)], async () => {
        const base = savedBase ? await savedBase() : { revision: draftScopeRevision("chapter:" + chapter.id, chapter.revision), entityRevision: unit.revision };
        if(!live.current)return;
        if (base.revision !== draftScopeRevision("chapter:" + chapter.id, chapter.revision)) throw new Error("声音背景在准备期间发生了变化，请核对后再分析。");
        const result = await submitOperation<{ analysis: Suggestion }>("scene-analysis:" + unit.id, { kind: "prepareChapter", analysisKind: "scene", sceneEnabled: true, chapterId: chapter.id, revision: base.revision, unitId: unit.id, unitRevision: base.entityRevision, model, grantId });
        if (result.error) throw new Error(result.error);
        if (!result.result?.analysis?.id) throw new Error("未取得这次分析的记录，请先在任务记录中核对。");
        if (live.current) { setView(result.result.analysis.id); setHistoryOpen(false); setSelected([]); }
        await refresh();
      });
    } catch (failure) { if(live.current)setError((failure as Error).message); }
    finally { if(live.current)setPending(null); }
  };
  const resultContent = record && <section className="scene-analysis-results" aria-label={historyOpen ? "历史分析结果" : "本次分析结果"}>
      <div className="scene-analysis-result-head"><h3>{historyOpen ? "这份历史建议" : "本次分析结果"}</h3><span className="scene-analysis-count">{record.items.length} 条建议</span></div>
      <p className="scene-analysis-meta">{!historyOpen && record.createdAt && new Date(record.createdAt).toLocaleString("zh-CN") + " · "}{record.model}</p>
      <p role="status" className={current || reusable || record.status === "applied" ? "scene-analysis-status" : "warning"}>{record.status === "running" ? "正在分析，关闭面板不会取消。" : reusable && record.items.length ? "勾选需要的旧建议，可重新加入当前场景。" : current ? record.items.length ? `分析完成，新增 ${record.items.length} 个声音建议。请选择想加入这次场景的声音。` : "分析完成，本次没有新增声音建议。已有背景与共同要求保持原样。" : ["ready", "applied", "partial"].includes(record.status) ? "这份建议已保留，可在「历史建议」中重新加入。" : "这份建议尚未完成或需要处理，请核对任务记录。"}</p>
      {record.error && <p className="error-inline">{record.error}</p>}{record.issues?.map((issue, index) => <p className="warning" key={index}>{issue}</p>)}
      <div className="scene-analysis-list">{record.items.map(item => <section className="task-event-card" key={item.id}>
        <label className="check-label"><input type="checkbox" aria-label={"加入声音 " + item.description} checked={selected.includes(item.id)} disabled={!(current || reusable) || !hasMembers(item) || included(item) || !!pending || !!item.issues?.length} onChange={event => setSelected(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id))} /><span>{item.description}</span></label>
        {included(item) ? <p className="success-text">已在当前场景，无需重复加入</p> : !hasMembers(item) && <p className="warning">原台词或声音位置已变化，请在当前台词上添加声音。</p>}
        <p className="hint">{({ environment: "环境", effect: "音效", music: "音乐" } as Record<string, string>)[item.kind] || item.kind} · 第 {(chapter.segments.find(segment => segment.id === item.memberId)?.order ?? -1) + 1} 句{({ before: "之前", during: "期间", after: "之后" } as Record<string, string>)[item.position]}{item.endMemberId && "，持续至第 " + ((chapter.segments.find(segment => segment.id === item.endMemberId)?.order ?? -1) + 1) + " 句"} · {item.evidence}</p>
        {(item.reason || item.sourceQuote) && <details><summary>为什么推荐</summary>{item.reason && <p>{item.reason}</p>}{item.sourceQuote && <p className="original-excerpt">{item.sourceQuote}</p>}</details>}{item.issues?.map((issue, index) => <p className="warning" key={index}>{issue}</p>)}
      </section>)}</div>
      {(current || reusable) && !!record.items.length && <div className="scene-analysis-apply"><button className="button primary" disabled={!selected.length || !enabled || !!pending} aria-busy={pending === "apply"} onClick={() => void (async () => {
        setPending("apply"); setError(""); setApplyError(""); setAppliedMessage("");
        try {
          await withSavedDrafts("chapter:" + chapter.id, ["unit:" + unit.id + "/scene", "events:" + unit.id, ...unit.members.map(id => "segment:" + id)], async () => {
            const base = savedBase ? await savedBase() : { revision: draftScopeRevision("chapter:" + chapter.id, chapter.revision), entityRevision: unit.revision };
            if (!live.current) return;
            if (base.revision !== draftScopeRevision("chapter:" + chapter.id, chapter.revision)) throw new Error("声音背景在准备期间发生了变化，请核对后再加入。");
            const result = await api<{ addedEventIds: string[]; skippedItemIds: string[] }>(reusable ? "/analysis/reuse" : "/analysis/apply", { id: record.id, draftVersion: record.draftVersion, revision: base.revision, unitRevision: base.entityRevision, selected, ...(reusable ? { chapterId: chapter.id, unitId: unit.id } : {}) });
            if (live.current) { setSelected([]); if (reusable) setAppliedMessage(result.addedEventIds.length ? `已重新加入 ${result.addedEventIds.length} 个声音，没有模型请求或费用。` : "所选声音已在当前场景，没有重复加入。" ); }
            await refresh();
          });
        }
        catch (failure) { if(live.current)setApplyError((failure as Error).message); }
        finally { if(live.current)setPending(null); }
      })()}>{pending === "apply" ? reusable ? "正在重新加入…" : "正在加入…" : `${reusable ? "重新加入" : "加入"}选中的 ${selected.length} 个声音`}</button><span className="hint">{reusable ? "免费复用 · 不重新分析或生成音频" : "加入场景不发生成请求"}</span>{applyError && <p className="error-inline" role="alert">{applyError}</p>}{appliedMessage && <p className="success-text" role="status">{appliedMessage}</p>}</div>}
    </section>;
  return <details className="task-panel-section scene-suggestions"><summary>让 AI 提供声音建议</summary>
    <div className="scene-analysis-toolbar">
      <button className={"button " + (records.length ? "secondary" : "primary")} disabled={!enabled || !!pending || running || !grantId} aria-busy={pending === "analysis" || running} onClick={() => void analyze()}>{pending === "analysis" || running ? "正在分析…" : "分析声音建议"}</button>
      <span className="hint">{grantId ? "已允许" : "先允许"} · 本次 1 次文本请求</span>
    </div>
    <details className="scene-analysis-permission"><summary>分析权限与模型</summary><p className="hint">文本模型：{model}</p><TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="分析这段声音背景" step="text" steps={["scene"]} model={model} onReady={setGrantId} disabled={!enabled || !!pending || running} /></details>
    {error && <p className="error-inline" role="alert">{error}</p>}
    {!!records.length && <>
      <div className="scene-analysis-views" role="group" aria-label="声音建议结果">
        <button type="button" disabled={!!pending} aria-pressed={!historyOpen} onClick={() => { if (historyOpen) { setHistoryOpen(false); setView(""); setSelected([]); setApplyError(""); setAppliedMessage(""); } }}>本次结果</button>
        <button type="button" disabled={!!pending} aria-pressed={historyOpen} onClick={() => setHistoryOpen(true)}>历史建议 · {records.length}</button>
      </div>
      {historyOpen ? <section className="scene-analysis-history" aria-label="历史声音建议">
        <Select label="历史声音建议" value={record!.id} disabled={!!pending} options={records.map(record => ({ value: record.id, label: (record.createdAt ? new Date(record.createdAt).toLocaleString("zh-CN") : "历史建议") + " · " + record.items.length + " 条 · " + (({ ready: "未加入", applied: "曾加入", running: "分析中", partial: "需核对", unknown: "结果不明", failed: "失败" } as Record<string, string>)[record.status] || "需核对") }))} onChange={id => { setView(id); setSelected([]); setApplyError(""); setAppliedMessage(""); }} />
        {resultContent}
      </section> : resultContent}
    </>}
  </details>;
}
