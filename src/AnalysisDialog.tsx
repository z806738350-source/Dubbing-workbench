import { useState, useRef, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "./api";
import { Field, Form, Select } from "./components";
import { submitOperation } from "./taskOperations";
import { draftScopeRevision, withSavedDrafts } from "./autosave";
import { FidelitySummary } from "./WorkspaceExperience";
import type { ChapterDetail, ExperiencePolicy, ExperienceState, Job, PerformanceCoverage, PerformanceReceipt, Role } from "./types";
interface TextPlan { chapterId:string;revision:number;kind:string;memberIds:string[];textRequests:number;repairRequests?:number;maxTextRequests?:number }
interface DraftItem {
  id: string;
  editVersion?: number;
  batchId?: string;
  text: string;
  from?: number;
  to?: number;
  segmentId?: string;
  roleId?: string | null;
  newRole?: string;
  newRoleKey?: string;
  type?: string;
  performance: string;
  evidence: string;
  evidenceRefs?: number[];
  sourceQuote?: string;
  reason: string;
  uncertain: boolean;
  issues?: string[];
  roleIssues?: string[];
  splitParts?: string[];
  splitIssue?: string;
  splitRequiresPerformanceConfirmation?: boolean;
  performanceEvidence?:{kind:string;refs:number[]};
  performanceUncertain?:boolean;
}
interface Suggestion {
  id: string;
  kind: string;
  status: string;
  revision: number;
  contextRevision: number;
  model: string;
  doneChunks?: number;
  totalChunks?: number;
  error?: string;
  replacementSource?: string;
  createdAt?: string;
  draftVersion?: number;
  appliedItemIds?: string[];
  splitOnly?: boolean;
  splitResults?: {segmentId:string;itemId:string;childIds:string[]}[];
  automation?: {applied:number;needsDecision:number;pendingItemIds?:string[];error?:string};
  performanceCoverage?:PerformanceCoverage;
  performanceReceipt?:PerformanceReceipt;
  productionBeats?:{guidance:string}[];
  productionBeatIssues?:{reason:string}[];
  performancePhase?:"analyzing"|"validating"|"repairing"|"saving";
  roles?: Role[];
  blocks?: { id: number; text: string }[];
  batches?: {
    id: string;
    status: string;
    error?: string;
    referenceIds: number[];
  }[];
  gaps?: {
    batchId: string;
    from?: number;
    to?: number;
    segmentId?: string;
    text: string;
  }[];
  issues?: string[];
  items: DraftItem[];
}
export default function AnalysisDialog({
  chapter,
  roles,
  selected,
  refresh,
  defaultModel,
  contextRevision,
  onLocate,
  onIssues,
  stateJobs = [],
}: {
  chapter: ChapterDetail;
  roles: Role[];
  selected: string[];
  refresh: () => Promise<void>;
  defaultModel: string;
  contextRevision: number;
  onLocate?: (segmentId:string) => void;
  onIssues?: () => void;
  stateJobs?: Job[];
}) {
  const [replaceSource, setReplaceSource] = useState(false),
    [source, setSource] = useState(chapter.source);
  const [kind, setKind] = useState(chapter.segments.length ? "director" : "extract"),
    [modelOverride, setModelOverride] = useState<string | null>(null),
    [checked, setChecked] = useState<string[]>([]),
    [ack, setAck] = useState(false);
  const model = modelOverride ?? defaultModel;
  const drafts = (chapter.suggestions as Suggestion[]).filter(d=>d.kind !== "scene");
  const [viewId, setViewId] = useState("");
  const [editing, setEditing] = useState<DraftItem | null>(null);
  const [inheritPerformanceConfirmed,setInheritPerformanceConfirmed]=useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [basicAnalysis,setBasicAnalysis]=useState(false);
  const [auditoryMode,setAuditoryMode]=useState<"legacy"|"conservative">(chapter.auditoryPolicy?.mode || (chapter.segments.length||chapter.deletedSegments?.length?"legacy":"conservative"));
  const [experience, setExperience] = useState<ExperienceState | null>(null);
  const [plan, setPlan] = useState<TextPlan | null>(null), [advancedPlan, setAdvancedPlan] = useState<TextPlan | null>(null);
  const [preparing, setPreparing] = useState(false), [policySaving, setPolicySaving] = useState(false), [prepareError, setPrepareError] = useState("");
  const [performanceMode,setPerformanceMode]=useState<"initial"|"fillMissing"|"replaceAi"|"selectedRewrite">(chapter.segments.length||chapter.deletedSegments?.length?"fillMissing":"initial");
  const [includeHumanPerformance,setIncludeHumanPerformance]=useState(false);
  const alive=useRef(true);useEffect(()=>()=>{alive.current=false;},[]);
  const auditoryPolicy={version:1,mode:auditoryMode};
  const mainPayload={kind:"prepareChapter",chapterId:chapter.id,revision:chapter.revision,ids:performanceMode==="fillMissing"?[]:selected,includePerformance:true,performanceMode,...(performanceMode==="initial"?{auditoryPolicy}:{analysisKind:"director"}),...(includeHumanPerformance?{includeHumanPerformance:true}:{})};
  const selectedKey = [...selected].sort().join(",");
  useEffect(()=>{
    if(performanceMode==="initial"&&(chapter.segments.length||chapter.deletedSegments?.length)){
      setPerformanceMode("fillMissing");setIncludeHumanPerformance(false);
    }
  },[performanceMode,chapter.segments.length,chapter.deletedSegments?.length]);
  useEffect(() => {
    let active = true;
    void api<ExperienceState>("/projects/" + chapter.projectId + "/experience").then(value=>{if(active)setExperience(value);}).catch(error=>{if(active)setPrepareError(error.message);});
    return ()=>{active=false;};
  }, [chapter.projectId, chapter.revision]);
  useEffect(() => {
    let active = true; setPlan(null);
    void api<TextPlan>("/operations/plan",mainPayload).then(value=>{if(active)setPlan(value);}).catch(error=>{if(active)setPrepareError(error.message);});
    return ()=>{active=false;};
  }, [chapter.id, chapter.revision, selectedKey,performanceMode,includeHumanPerformance,auditoryMode]);
  useEffect(() => {
    let active = true; setAdvancedPlan(null);
    void api<TextPlan>("/operations/plan",{kind:"prepareChapter",analysisKind:kind,includePerformance:kind==="director"||!basicAnalysis,performanceMode:kind==="extract"?"initial":"replaceAi",chapterId:chapter.id,revision:chapter.revision,ids:selected,...(kind==="extract"?{auditoryPolicy}:{}),...(kind==="extract" && replaceSource ? {source:source.replace(/\r\n?/g,"\n")} : {})}).then(value=>{if(active)setAdvancedPlan(value);}).catch(()=>{});
    return ()=>{active=false;};
  }, [chapter.id, chapter.revision, selectedKey, kind, replaceSource, source,basicAnalysis,auditoryMode]);
  const draft = drafts.find((d) => d.id === viewId) || drafts.at(-1);
  function editItem(item: DraftItem) {
    if (!draft) return;
    setViewId(draft.id);
    setEditing({...item, editVersion: draft.draftVersion});
  }
  useEffect(() => { setAck(false); setChecked(draft?.kind==="director"&&draft.performanceCoverage?draft.items.filter(item=>!item.issues?.length&&!draft.appliedItemIds?.includes(item.id)).map(item=>item.id):[]); setInheritPerformanceConfirmed(false); }, [draft?.id, draft?.draftVersion,draft?.status]);
  const applicable =
    draft?.revision === chapter.revision &&
    draft?.contextRevision === contextRevision;
  const working = drafts.some((d) => d.status === "running");
  async function choosePolicy(mode:ExperiencePolicy["mode"]) {
    if(!experience)return;
    setPolicySaving(true);setPrepareError("");
    try {
      const policy=await api<ExperiencePolicy>("/experience/policy",{projectId:chapter.projectId,revision:experience.policy.revision,mode});
      setExperience(value=>value?{...value,policy}:value);
    } catch(error){setPrepareError((error as Error).message);}
    finally{setPolicySaving(false);}
  }
  async function prepare() {
    if(!plan || preparing || working)return;
    setPreparing(true);setPrepareError("");
    try {
      await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
        const revision=draftScopeRevision("chapter:"+chapter.id,chapter.revision);
        const payload={...mainPayload,revision,model:defaultModel};
        const currentPlan=await api<TextPlan>("/operations/plan",payload);
        if(!alive.current)return;
        setPlan(currentPlan);
        if(!currentPlan.textRequests){setPrepareError("当前范围没有需要补齐的指导，已有内容保留。");return;}
        const result=await submitOperation<{analysis:Suggestion}>("prepare:"+chapter.id,payload,stateJobs);
        if(result.error)throw new Error(result.error);
        if(!alive.current)return;
        setViewId(result.result.analysis.id);setEditing(null);setChecked([]);setAck(false);
      });
      await refresh();
    } catch(error){if(alive.current)setPrepareError((error as Error).message);}
    finally{if(alive.current)setPreparing(false);}
  }
  const editable =
    applicable && !working && draft?.status !== "applied" && !!draft?.batches;
  async function updateDraft(path: string, data: object) {
    if (!draft) return;
    await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
      if(!alive.current)return;
      await api(path, {id:draft.id,draftVersion:draft.draftVersion,...data});
    });
    await refresh();
  }
  const current =
    draft?.status === "ready" &&
    draft.revision === chapter.revision &&
    draft.contextRevision === contextRevision;
  const invalidItems = draft?.items.filter(item => item.issues?.length) || [];
  const firstInvalid = invalidItems[0];
  const selectedSplits=draft?.items.filter(item=>checked.includes(item.id)&&item.splitParts?.length&&item.splitParts.length>=2)||[];
  const needsPerformanceConfirmation=selectedSplits.some(item=>item.splitRequiresPerformanceConfirmation===true);
  const coverage=chapter.performanceCoverage||draft?.performanceReceipt?.coverage;
  const candidateCoverage=draft?.performanceCoverage;
  const affectedPendingCount=draft?.performanceReceipt?.affectedUnitIds?.filter(id=>!chapter.playbackItems?.some(item=>(item.unitId||item.id)===id&&item.validity==="matched")).length||0;
  return (
    <section className="analysis-panel" aria-label="AI 剧本整理">
      <FidelitySummary audit={chapter.fidelity}/>
      <div className="analysis-prepare">
        <h3>{performanceMode==="initial"?"AI 整理这一章":"逐段表演指导"}</h3>
        <p className="hint">{performanceMode==="initial"?"同时分段并安排表演，保留原文和已有人工指导。":includeHumanPerformance?"只重写所选台词的表演指导，包含人工内容；原值可查看与撤销，正文、角色和声音不变。":performanceMode==="fillMissing"?"补齐有效台词的缺失指导，保留已有指导；不重新分段或生成音频。":"重新安排所选台词的 AI 表演指导，保留人工内容；不修改正文或生成音频。"}</p>
        {performanceMode==="initial"&&<Field label="小说听觉处理" hint="正文与引述语完整保留。文学演播安排有依据的局部接话，配声后按生成计划使用纯人声组；保真朗读沿用原有编排。基础朗读不安排演播关系。"><Select label="小说听觉处理" value={auditoryMode} options={[{value:"conservative",label:"文学演播"},{value:"legacy",label:"保真朗读"}]} onChange={value=>setAuditoryMode(value as "legacy"|"conservative")}/></Field>}
        <div className="tabs analysis-policy" aria-label="AI 协作方式">
          <button type="button" aria-pressed={experience?.policy.mode!=="review"} disabled={!experience || policySaving || preparing || working} onClick={()=>void choosePolicy("smart")}>AI 先安排</button>
          <button type="button" aria-pressed={experience?.policy.mode==="review"} disabled={!experience || policySaving || preparing || working} onClick={()=>void choosePolicy("review")}>先看建议</button>
        </div>
        <p className="hint">{performanceMode==="replaceAi"||performanceMode==="selectedRewrite"?"按本次所选范围直接重写并自动保存，原值可查看与撤销。":experience?.policy.mode==="review"?"先生成完整候选，一屏统一采用；采用后自动保存。":"合法指导自动安排，真正的角色疑点集中处理。AI 安排不会标记为试听通过。"}</p>
        {!!chapter.segments.length&&<div className="button-row">{performanceMode!=="fillMissing"&&<button type="button" className="text-button" disabled={preparing||working} onClick={()=>{setPerformanceMode("fillMissing");setIncludeHumanPerformance(false);}}>返回补齐缺失指导</button>}{!!selected.length&&<Select label="所选指导操作" value={performanceMode==="selectedRewrite"?"human":performanceMode==="replaceAi"?"ai":""} options={[{value:"",label:`已选 ${selected.length} 条`},{value:"ai",label:"重排 AI 指导"},{value:"human",label:"重写含人工指导"}]} onChange={value=>{setPerformanceMode(value==="human"?"selectedRewrite":value==="ai"?"replaceAi":"fillMissing");setIncludeHumanPerformance(value==="human");}}/>}</div>}
        {plan && <>
          <p className="hint">{plan.kind==="extract" ? "整章原文" : `本次 ${plan.memberIds.length} 条台词`} · {plan.textRequests} 次文本请求 · 不生成音频</p><details><summary className="hint">查看请求范围</summary><p className="hint">发送本章所需正文至 {defaultModel}。基础 {plan.textRequests} 次，缺失指导按当前范围局部补齐，合法结果自动保存。</p></details>
        </>}
        <button type="button" className="button primary" disabled={!plan || !experience || preparing || working||!plan.textRequests} onClick={()=>void prepare()}>{working ? "正在准备…" : preparing ? "正在保存并准备…" : performanceMode==="initial"?"准备这一章":performanceMode==="fillMissing"?"补齐缺失指导":includeHumanPerformance?"重写所选指导，包含人工内容":"重新安排所选指导"}</button>
        {plan?.textRequests===0&&performanceMode==="fillMissing"&&<p className="hint">当前没有可自动补齐的缺失项。已有指导保留{coverage?.missingIds.length?`；${coverage.missingIds.length} 段人工内容需核对，未自动覆盖`:""}。</p>}
        {prepareError && <p className="error-inline" role="alert">{prepareError}</p>}
      </div>
      {draft?.productionBeats&&<p className="hint">本轮保存 {draft.productionBeats.length} 个局部演播候选，配声后在生成计划中核对；原文全部保留。</p>}
      {!!draft?.productionBeatIssues?.length&&<details><summary>未采用的演播建议</summary>{draft.productionBeatIssues.map((issue,index)=><p className="hint" key={index}>{issue.reason}</p>)}</details>}
      {draft && <div className="analysis-summary" aria-live="polite">
        <div><strong>{draft.status === "running" ? (draft.performancePhase||candidateCoverage?.phase)==="repairing"?`正在补齐 ${candidateCoverage?.missingIds.length||0} 段`:(draft.performancePhase||candidateCoverage?.phase)==="saving"?"正在保存":"正在分析" : draft.performanceReceipt&&coverage ? `${coverage.coveredCount}/${coverage.eligibleCount} 段表演已安排` : candidateCoverage ? `${candidateCoverage.coveredCount}/${candidateCoverage.eligibleCount} 段指导候选已准备` : draft.automation ? `AI 已安排 ${draft.automation.applied} 条 · 需你判断 ${draft.automation.needsDecision} 条` : draft.status === "applied" ? "已应用" : !applicable ? "草稿已过期" : invalidItems.length ? `${invalidItems.length} 条需校对` : current ? "草稿待审阅" : "草稿需要处理"}</strong><span>{draft.items.length} 条标注 · {draft.doneChunks || 0}/{draft.totalChunks || 1} 批{draft.splitResults?.length ? ` · 已拆短 ${draft.splitResults.length} 处` : ""}</span>{draft.performanceReceipt&&<span>新增 {draft.performanceReceipt.writtenIds.length} 段，保留人工 {draft.performanceReceipt.preservedHumanIds.length} 段{coverage?.deletedCount?`；${coverage.deletedCount} 条已删除不参与`:""}{coverage?.waivedBasicIds?.length?`；${coverage.waivedBasicIds.length} 段按基础朗读保留空指导`:""}。{draft.performanceReceipt.affectedUnitIds?.length?`影响 ${draft.performanceReceipt.affectedUnitIds.length} 个声音单元，其中 ${affectedPendingCount} 个待更新；旧声音保留。`:""}</span>}{!draft.performanceReceipt&&candidateCoverage&&coverage&&<span>当前已保存 {coverage.coveredCount}/{coverage.eligibleCount} 段；候选尚未采用。</span>}</div>
        {editable && firstInvalid && <button type="button" className="text-button" onClick={() => editItem(firstInvalid)}>校对第 {draft.items.indexOf(firstInvalid) + 1} 条</button>}
        {!!draft.automation?.needsDecision && onIssues && <button type="button" className="text-button" onClick={onIssues}>集中处理疑点</button>}
        {draft.performanceReceipt&&onLocate&&chapter.segments.length>0&&<button type="button" className="text-button" onClick={()=>onLocate(draft.performanceReceipt!.writtenIds.find(id=>chapter.segments.some(segment=>segment.id===id))||chapter.segments[0].id)}>查看指导</button>}
        {draft.performanceReceipt?.changeSetId&&draft.performanceReceipt.writtenIds.length>0 ? <Form primary={false} label="撤销本次表演调整" children={null} onSubmit={async()=>{await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{await api("/experience/undo-performance",{changeSetId:draft.performanceReceipt!.changeSetId,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision),operationId:crypto.randomUUID()});});await refresh();}}/> : experience?.changes.some(change=>change.changeId===draft.id && !change.undoneAt) && <Form primary={false} label="撤销这次 AI 安排" children={null} onSubmit={async()=>{await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{await api("/experience/undo",{changeId:draft.id,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision)});});await refresh();}}/>}
      </div>}
      <div className="analysis-results">
      {draft && (
        <div className="section-rule">
          <Select
            label="分析记录"
            value={draft.id}
            options={drafts
              .slice()
              .reverse()
              .map((d) => ({
                value: d.id,
                label: `${d.splitOnly?"语义拆分 · ":""}${d.model} · ${d.createdAt ? new Date(d.createdAt).toLocaleString() : "历史草稿"}`,
              }))}
            onChange={(id) => {
              setViewId(id);
              setEditing(null);
              setChecked([]);
              setAck(false);
            }}
          />
          {!applicable && draft.status !== "applied" && (
            <p className="error-inline">
              章节或角色资料已改变。这份草稿仅供查看，请重新分析。
            </p>
          )}
          {draft.error && <p className="error-inline">{draft.error}</p>}
          {draft.status === "running" && (
            <p className="hint">
              切换面板不影响分析。已接收的草稿会保留；期间修改正式内容会使本轮建议过期。
            </p>
          )}
          {draft.batches?.some((b) => b.status !== "received") && editable && (
            <Form
              key={`${draft.id}:${draft.draftVersion}`}
              label={draft.batches.some(batch=>batch.status==="unknown")?"重新发送并继续（可能重复计费）":"继续未完成部分"}
              revision={draft.draftVersion}
              onSubmit={async (f, draftVersion) =>
                updateDraft("/analysis/resume", {
                  draftVersion,
                  retryUnknown: draft.batches!.some(batch=>batch.status==="unknown"),
                })
              }
            >
              {draft.batches.some((b) => b.status === "unknown") && (
                <p className="warning">上次请求结果不明，可能已计费。点击“重新发送并继续”将重发这里尚未确认的请求；已完成部分复用。</p>
              )}
              <p className="hint">
                复用已完成部分，使用本轮模型 {draft.model}
                。章节或角色资料变化后需重新分析。
              </p>
            </Form>
          )}
          {draft.batches?.map((b, i) => (
            <details key={b.id} className="analysis-batch">
              <summary>
                第 {i + 1} 批 ·{" "}
                {b.status === "received"
                  ? "已接收"
                  : b.status === "sending"
                    ? "正在请求"
                    : b.status === "unknown"
                      ? "结果不明"
                      : b.status === "stale"
                        ? "前批角色变化，需重新分析"
                        : "未完成"}
              </summary>
              {b.error && <p className="error-inline">{b.error}</p>}
              {editable && b.status === "received" && (
                <Form
                  key={`${draft.id}:${b.id}:${draft.draftVersion}`}
                  label="替换并重新分析本批"
                  revision={draft.draftVersion}
                  onSubmit={async (f, draftVersion) =>
                    updateDraft("/analysis/resume", {
                      draftVersion,
                      batchIds: [b.id],
                      replace: true,
                    })
                  }
                >
                  <p className="hint">替换本批候选，后续依赖批次需重新分析；本次会发送文本请求。</p>
                </Form>
              )}
            </details>
          ))}
          {!!draft.issues?.length && (
            <p className="error-inline">{draft.issues.join("；")}</p>
          )}
          {!!draft.gaps?.length && (
            <details open className="analysis-batch">
              <summary>尚有 {draft.gaps.length} 处原文或片段未覆盖</summary>
              {draft.gaps.map((g, i) => (
                <div key={i} className="analysis-gap">
                  <p>{g.text}</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={
                      !editable ||
                      draft.batches?.find((b) => b.id === g.batchId)?.status !==
                        "received"
                    }
                    onClick={() =>
                      editItem({
                        id: "",
                        ...g,
                        roleId: draft.roles?.find((r) => r.narrator)?.id || "",
                        type: "narration",
                        performance: "",
                        evidence: "创作建议",
                        evidenceRefs: [],
                        reason: "用户补齐缺口",
                        uncertain: true,
                      })
                    }
                  >
                    补齐这处标注
                  </button>
                </div>
              ))}
            </details>
          )}
          {editing && (
            <DraftEditor
              key={`${draft.id}:${editing.id}:${editing.from}`}
              item={editing}
              draft={draft}
              onClose={() => setEditing(null)}
              onSave={async (item) => {
                await updateDraft("/analysis/edit", {
                  draftVersion: editing.editVersion,
                    batchId: editing.batchId,
                  itemId: editing.id,
                  item,
                });
                setEditing(null);
              }}
            />
          )}
          <div className="suggestion-list">
            {draft.items.map((item, index) => (
              <article
                key={item.id}
                className={`suggestion-row ${item.issues?.length ? "analysis-invalid" : ""}`}
              >
                {draft.kind === "director" && (
                  <input
                    type="checkbox"
                    aria-label={`采用 ${item.text.slice(0, 16)} 的建议`}
                    checked={!!draft.appliedItemIds?.includes(item.id) || checked.includes(item.id)}
                    disabled={!current || !!draft.appliedItemIds?.includes(item.id)}
                    onChange={(e) => {
                      setInheritPerformanceConfirmed(false);
                      setChecked((v) =>
                        e.target.checked
                          ? [...v, item.id]
                          : v.filter((x) => x !== item.id),
                      );
                    }}
                  />
                )}
                <div>
                  <div className="suggestion-meta">
                    <span>第 {index + 1} 条</span>
                    <strong>
                      {roles.find((r) => r.id === item.roleId)?.name ||
                        item.newRole ||
                        "表演建议"}
                    </strong>
                    <span>{draft.kind==="extract"?"角色依据：":""}{item.evidence}</span>
                    {item.performanceEvidence&&<span>表演依据：{item.performanceEvidence.kind}</span>}
                    {!!draft.automation && draft.appliedItemIds?.includes(item.id) && <span>AI 已安排</span>}
                    {item.uncertain && (
                      <span className="warning">{draft.kind === "extract" ? "角色待确认" : "建议待核对"}</span>
                    )}
                    {draft.kind === "director" && draft.status === "applied" && (
                      <span>{!draft.appliedItemIds ? "历史记录未区分采用条目" : draft.appliedItemIds.includes(item.id) ? "本轮已采用" : "未采用 · 需重新分析"}</span>
                    )}
                  </div>
                  {!item.splitParts?.length&&<p className="suggestion-text">
                    {item.text || "原文范围待修正"}
                  </p>}
                  {!!item.splitParts?.length&&<section className="semantic-split-preview" aria-label="语义拆分预览"><strong>{draft.splitResults?.some(result=>result.itemId===item.id)?"已拆为":"建议拆为"} {item.splitParts.length} 条</strong><ol>{item.splitParts.map((text,index)=><li key={index}><p>{text}</p></li>)}</ol><p className="hint">原文、角色、声音和参数沿用；人工表演保留。拆分后需要重新生成。</p></section>}
                  {item.splitIssue&&!draft.splitResults?.some(result=>result.itemId===item.id)&&<p className="warning">{item.splitIssue}</p>}
                  {draft.splitOnly||item.splitParts?.length ? <p className="hint">应用拆分时沿用当前表演指导，不应用新的表演建议。</p> : <p className="suggestion-performance">{item.performance}</p>}
                  {(item.reason || item.sourceQuote) && (
                    <details open={item.uncertain}>
                      <summary className="hint">判断说明与依据</summary>
                      <p className="hint">{item.reason}</p>
                      {item.sourceQuote && <p className="suggestion-text">{item.sourceQuote}</p>}
                    </details>
                  )}
                  {!!item.issues?.length && (
                    <p className="error-inline">
                      <AlertTriangle size={14} /> {item.issues.join("；")}
                    </p>
                  )}
                  {!!item.roleIssues?.length&&<p className="warning">{item.roleIssues.join('；')}。正文与表演已保留，可在台词编辑中核对角色。</p>}
                  {onLocate && (item.segmentId || chapter.segments.some(s=>s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id)) && <button type="button" className="text-button" onClick={()=>{const id=draft.splitResults?.find(result=>result.itemId===item.id)?.childIds[0] || item.segmentId || chapter.segments.find(s=>s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id)?.id;if(id)onLocate(id);}}>{draft.splitResults?.some(result=>result.itemId===item.id)?"前往拆分后的台词":"前往这句"}</button>}
                  {chapter.segments.some(s=>(s.id===item.segmentId || s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id) && s.protectedFields?.includes('performance')) && <Form primary={false} label="允许 AI 下次安排这句表演" children={<p className="hint">当前人工表演仍保留；只解除这一句的表演保护。</p>} onSubmit={async()=>{const segment=chapter.segments.find(s=>s.id===item.segmentId || s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id);if(!segment)return;await withSavedDrafts("chapter:"+chapter.id,["segment:"+segment.id],async()=>{await api("/experience/unprotect",{chapterId:chapter.id,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision),segmentId:segment.id,field:"performance"});});await refresh();}}/>}
                  {editable && (
                    <div className="analysis-actions">
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => editItem(item)}
                      >
                        校对本条
                      </button>
                      <Form
                        label="移除此标注"
                        children={null}
                        onSubmit={async () =>
                          updateDraft("/analysis/edit", {
                            batchId: item.batchId,
                            itemId: item.id,
                            remove: true,
                          })
                        }
                      />
                    </div>
                  )}
                </div>
              </article>
            ))}
          </div>
          {current && (
            <Form
              label={candidateCoverage ? draft.kind==="extract"?"统一采用剧本与指导":"统一采用本轮指导" : draft.kind === "extract" ? "应用校对稿" : "应用本轮选择"}
              busy={needsPerformanceConfirmation&&!inheritPerformanceConfirmed||!!candidateCoverage&&draft.kind==="director"&&!checked.length}
              onSubmit={async () => {
                await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
                  await api("/analysis/apply", {
                    id:draft.id,draftVersion:draft.draftVersion,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision),selected:candidateCoverage&&draft.kind==="extract"?draft.items.filter(item=>!item.issues?.length&&!draft.appliedItemIds?.includes(item.id)).map(item=>item.id):checked,replaceConfirmed:ack||!chapter.segments.length&&!chapter.deletedSegments?.length,confirmRoles:draft.kind==="extract",...(inheritPerformanceConfirmed?{inheritPerformanceConfirmed:true}:{}),
                  });
                });
                await refresh();
              }}
            >
              {draft.kind === "extract" ? (
                <>
                  {(!!chapter.segments.length||!!chapter.deletedSegments?.length)&&<label className="check-label">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    确认替换当前剧本
                    {draft.replacementSource !== undefined ? "及原文" : ""}
                    ；旧片段和音频保留
                    {!!chapter.deletedSegments?.length && "；从原文重新提取会重置已删除台词的选择"}
                  </label>}
                  <p className="hint">合法分段与指导统一采用并保存；真实说话人疑点集中处理。</p>
                </>
              ) : (
                <><p className="hint">已选 {checked.length} 条，一次应用{selectedSplits.length ? `，其中 ${selectedSplits.length} 处按语义拆短` : ""}；未选择的台词和指导不改变。人工内容按本次明确范围保留或重写。</p>{needsPerformanceConfirmation&&<label className="check-label"><input type="checkbox" checked={inheritPerformanceConfirmed} onChange={event=>setInheritPerformanceConfirmed(event.target.checked)}/>我已核对所选拆分，决定沿用各条原有的人工表演指导</label>}</>
              )}
            </Form>
          )}
        </div>
      )}
      {!draft && (
        <div className="analysis-empty"><p className="hint">准备完成后，AI 安排和需要你判断的地方会显示在这里。</p></div>
      )}
      </div>
      <div className="analysis-composer">
        <button type="button" className="analysis-composer-toggle" aria-expanded={composerExpanded} onClick={() => setComposerExpanded(v => !v)}><span>{composerExpanded ? "收起高级整理" : "高级整理与原文替换"}</span><span aria-hidden="true">{composerExpanded ? "−" : "+"}</span></button>
        {composerExpanded && <>
        <div className="tabs analysis-tabs">
          <button type="button" aria-pressed={kind==="director"} className={kind==="director"?"active":""} onClick={()=>setKind("director")}>表演建议</button>
          <button type="button" aria-pressed={kind==="extract"} className={kind==="extract"?"active":""} onClick={()=>setKind("extract")}>重新整理原文与角色</button>
        </div>
        <div className="analysis-context" aria-label="本次分析范围">
          <span className="analysis-reference">{chapter.title}</span>
          {kind === "director" && selected.length ? <>
            <span>所选 {selected.length} 条</span>
            {chapter.segments.filter(s=>selected.includes(s.id)).slice(0,3).map(s=><span className="analysis-reference" key={s.id}>第 {s.order+1} 条</span>)}
            {selected.length>3 && <span>另 {selected.length-3} 条</span>}
          </> : <span>{kind === "extract" ? "整章原文" : "本章全部片段"}</span>}
        </div>
        {advancedPlan && <p className="hint">点击生成将向 {model} 发送本范围文字；预计 {advancedPlan.textRequests} 次文本请求，不生成音频。</p>}
      <Form
        label={draft?.status === "running" ? "分析中…" : "生成校对草稿"}
        busy={working || !advancedPlan}
        revision={chapter.revision}
        onSubmit={async () => {
          await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
            const revision=draftScopeRevision("chapter:"+chapter.id,chapter.revision);
            const payload={kind:"prepareChapter",analysisKind:kind,autoApply:false,includePerformance:kind==="director"||!basicAnalysis,performanceMode:kind==="extract"?"initial":"replaceAi",chapterId:chapter.id,revision,model,ids:selected,...(kind==="extract"?{auditoryPolicy}:{}),...(kind==="extract" && replaceSource?{source:source.replace(/\r\n?/g,"\n")}: {})};
            const currentPlan=await api<TextPlan>("/operations/plan",payload);
            if(!alive.current)return;
            setAdvancedPlan(currentPlan);
            const operation=await submitOperation<{analysis:Suggestion}>("advanced-analysis:"+chapter.id,payload,stateJobs);
            if(operation.error)throw new Error(operation.error);
            if(!alive.current)return;
            setViewId(operation.result.analysis.id);
          });
          setEditing(null);
          setChecked([]);
          setAck(false);
          setComposerExpanded(false);
          await refresh();
        }}
      >
        <div className="analysis-input-fields">
        {kind==="extract"&&<Field label="小说听觉处理" hint="正文与引述语完整保留；文学演播安排局部接话，保真朗读沿用原有编排。"><Select label="小说听觉处理" value={auditoryMode} options={[{value:"conservative",label:"文学演播"},{value:"legacy",label:"保真朗读"}]} onChange={value=>setAuditoryMode(value as "legacy"|"conservative")}/></Field>}
        {kind==="extract"&&<label className="check-label"><input type="checkbox" checked={basicAnalysis} onChange={event=>setBasicAnalysis(event.target.checked)}/>本次仅整理剧本／基础朗读，不安排表演</label>}
        {kind === "extract" && (
          <>
            <label className="check-label">
              <input
                type="checkbox"
                checked={replaceSource}
                onChange={(e) => setReplaceSource(e.target.checked)}
              />
              使用替换原文
            </label>
            {replaceSource && (
              <Field
                label="新原文"
                hint="粘贴替换内容。只有审阅并应用草稿后才更换正式原文；失败或关闭不会改动当前章节。"
              >
                <textarea
                  rows={6}
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                />
              </Field>
            )}
          </>
        )}
        <Field label="文本模型">
          <input value={model} onChange={(e) => setModelOverride(e.target.value)} />
        </Field>
        {modelOverride !== null && <button type="button" className="text-button analysis-default-model" onClick={() => setModelOverride(null)}>使用默认模型</button>}
        <p className="hint">本次 {advancedPlan?.textRequests || "—"} 次文本请求。只生成可校对草稿；重新分段及原文替换仍需明确应用。</p>
        </div>
      </Form>
      </>}
      </div>
    </section>
  );
}

function DraftEditor({
  item,
  draft,
  onSave,
  onClose,
}: {
  item: DraftItem;
  draft: Suggestion;
  onSave: (i: DraftItem) => Promise<void>;
  onClose: () => void;
}) {
  const [value, setValue] = useState(item);
  const editor = useRef<HTMLDivElement>(null);
  useEffect(() => { editor.current?.scrollIntoView({block: "start"}); editor.current?.querySelector<HTMLInputElement>("input, textarea")?.focus({preventScroll:true}); }, []);
  const [query, setQuery] = useState("");
  const keys = [
    ...new Map(
      draft.items
        .filter((i) => i.newRoleKey)
        .map((i) => [i.newRoleKey!, i.newRole || "待命名角色"]),
    ).entries(),
  ];
  const roleValue = value.roleId
    ? `existing:${value.roleId}`
    : value.newRoleKey
      ? `new:${value.newRoleKey}`
      : "create";
  const references =
    draft.batches?.find((b) => b.id === item.batchId)?.referenceIds || [];
  return (
    <div className="analysis-editor" ref={editor}>
      <div className="section-heading">
        <h3>{item.id ? "校对标注" : "补齐标注"}</h3>
        <button type="button" className="text-button" onClick={onClose}>
          取消
        </button>
      </div>
      {!!item.issues?.length && <p className="error-inline">{item.issues.join("；")}</p>}
      <Form label="保存本条校对" onSubmit={async () => onSave(value)}>
        {draft.kind === "extract" && (
          <>
            <div className="analysis-range">
              <Field label="原文起始块">
                <input
                  type="number"
                  min={1}
                  value={(value.from ?? 0) + 1}
                  onChange={(e) =>
                    setValue({ ...value, from: Number(e.target.value) - 1 })
                  }
                />
              </Field>
              <Field label="原文结束块">
                <input
                  type="number"
                  min={1}
                  value={(value.to ?? 0) + 1}
                  onChange={(e) =>
                    setValue({ ...value, to: Number(e.target.value) - 1 })
                  }
                />
              </Field>
            </div>
            <p className="original-excerpt">{draft.blocks?.filter(b => b.id >= (value.from ?? -1) && b.id <= (value.to ?? -1)).map(b => b.text).join("") || "请选择有效的原文范围"}</p>
            <Field label="说话人">
              <Select
                label="说话人"
                value={roleValue}
                options={[
                  ...(draft.roles || []).map((r) => ({
                    value: `existing:${r.id}`,
                    label: r.name,
                  })),
                  ...keys.map(([k, name]) => ({
                    value: `new:${k}`,
                    label: `${name} · 本轮新角色`,
                  })),
                  { value: "create", label: "创建独立角色" },
                  ...(value.newRoleKey &&
                  !keys.some(([k]) => k === value.newRoleKey)
                    ? [
                        {
                          value: `new:${value.newRoleKey}`,
                          label: value.newRole || "待命名角色",
                        },
                      ]
                    : []),
                ]}
                onChange={(v) => {
                  if (v.startsWith("existing:"))
                    setValue({
                      ...value,
                      roleId: v.slice(9),
                      newRole: "",
                      newRoleKey: "",
                    });
                  else {
                    const key =
                      v === "create" ? crypto.randomUUID() : v.slice(4);
                    setValue({
                      ...value,
                      roleId: null,
                      newRoleKey: key,
                      newRole: keys.find(([k]) => k === key)?.[1] || "",
                    });
                  }
                }}
              />
            </Field>
            {!value.roleId && (
              <Field label="新角色名称">
                <input
                  value={value.newRole || ""}
                  maxLength={100}
                  onChange={(e) =>
                    setValue({
                      ...value,
                      newRole: e.target.value,
                      newRoleKey: value.newRoleKey || crypto.randomUUID(),
                    })
                  }
                />
              </Field>
            )}
            <Field label="内容类型">
              <Select
                label="内容类型"
                value={value.type || "narration"}
                options={[
                  { value: "narration", label: "旁白" },
                  { value: "dialogue", label: "对白" },
                  { value: "thought", label: "心理独白" },
                ]}
                onChange={(type) => setValue({ ...value, type })}
              />
            </Field>
          </>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={!!value.uncertain}
            onChange={(e) => setValue({ ...value, uncertain: e.target.checked })}
          />
          {draft.kind === "extract" ? "说话人仍需确认" : "建议仍需核对"}
        </label>
        <Field label="表演指导">
          <textarea
            rows={2}
            value={value.performance || ""}
            maxLength={2000}
            onChange={(e) =>
              setValue({ ...value, performance: e.target.value })
            }
          />
        </Field>
        <Field label="依据类别">
          <Select
            label="依据类别"
            value={value.evidence || "创作建议"}
            options={["原文明示", "上下文推断", "创作建议"].map((x) => ({
              value: x,
              label: x,
            }))}
            onChange={(evidence) => setValue({ ...value, evidence })}
          />
        </Field>
        <Field label="判断说明">
          <input
            value={value.reason || ""}
            onChange={(e) => setValue({ ...value, reason: e.target.value })}
          />
        </Field>
        <details className="analysis-batch">
          <summary>
            选择原文依据 · 已选 {value.evidenceRefs?.length || 0} 处
          </summary>
          {!!value.evidenceRefs?.some(id => !references.includes(id)) && <p className="error-inline">存在不可用的出处，请清除后重新选择。</p>}
          <button type="button" className="text-button" onClick={() => setValue({...value, evidenceRefs: []})}>清除所选依据</button>
          <Field label="查找原文">
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </Field>
          <div className="analysis-references">
            {draft.blocks
              ?.filter(
                (b) => references.includes(b.id) && b.text.includes(query),
              )
              .map((b) => (
                <label className="check-label" key={b.id}>
                  <input
                    type="checkbox"
                    checked={value.evidenceRefs?.includes(b.id) || false}
                    onChange={(e) =>
                      setValue({
                        ...value,
                        evidenceRefs: e.target.checked
                          ? [...(value.evidenceRefs || []), b.id]
                          : value.evidenceRefs?.filter((id) => id !== b.id),
                      })
                    }
                  />
                  <span>
                    <strong>原文块 {b.id + 1}</strong> {b.text}
                  </span>
                </label>
              ))}
          </div>
        </details>
      </Form>
    </div>
  );
}
