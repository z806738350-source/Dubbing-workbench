import { useState, useRef, useEffect } from "react";
import { AlertTriangle } from "lucide-react";
import { api } from "./api";
import { Field, Form, Select } from "./components";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import { draftScopeRevision, withSavedDrafts } from "./autosave";
import type { ChapterDetail, ExperiencePolicy, ExperienceState, Job, Role } from "./types";
interface TextPlan { chapterId:string;revision:number;kind:string;memberIds:string[];textRequests:number }
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
  automation?: {applied:number;needsDecision:number;pendingItemIds?:string[];error?:string};
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
  const [confirmRoles, setConfirmRoles] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [experience, setExperience] = useState<ExperienceState | null>(null);
  const [plan, setPlan] = useState<TextPlan | null>(null), [advancedPlan, setAdvancedPlan] = useState<TextPlan | null>(null);
  const [grantId, setGrantId] = useState<string | null>(null), [advancedGrantId, setAdvancedGrantId] = useState<string | null>(null), [draftGrantId, setDraftGrantId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false), [policySaving, setPolicySaving] = useState(false), [prepareError, setPrepareError] = useState("");
  const selectedKey = [...selected].sort().join(",");
  useEffect(() => {
    let active = true;
    void api<ExperienceState>("/projects/" + chapter.projectId + "/experience").then(value=>{if(active)setExperience(value);}).catch(error=>{if(active)setPrepareError(error.message);});
    return ()=>{active=false;};
  }, [chapter.projectId, chapter.revision]);
  useEffect(() => {
    let active = true; setPlan(null);
    void api<TextPlan>("/operations/plan",{kind:"prepareChapter",chapterId:chapter.id,revision:chapter.revision,ids:selected}).then(value=>{if(active)setPlan(value);}).catch(error=>{if(active)setPrepareError(error.message);});
    return ()=>{active=false;};
  }, [chapter.id, chapter.revision, selectedKey]);
  useEffect(() => {
    let active = true; setAdvancedPlan(null);
    void api<TextPlan>("/operations/plan",{kind:"prepareChapter",analysisKind:kind,chapterId:chapter.id,revision:chapter.revision,ids:selected,...(kind==="extract" && replaceSource ? {source:source.replace(/\r\n?/g,"\n")} : {})}).then(value=>{if(active)setAdvancedPlan(value);}).catch(()=>{});
    return ()=>{active=false;};
  }, [chapter.id, chapter.revision, selectedKey, kind, replaceSource, source]);
  const draft = drafts.find((d) => d.id === viewId) || drafts.at(-1);
  function editItem(item: DraftItem) {
    if (!draft) return;
    setViewId(draft.id);
    setEditing({...item, editVersion: draft.draftVersion});
  }
  useEffect(() => { setAck(false); setConfirmRoles(false); setChecked([]); }, [draft?.id, draft?.draftVersion]);
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
    if(!plan || !grantId || !experience?.policy.revision)return;
    setPreparing(true);setPrepareError("");
    try {
      await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
        const revision=draftScopeRevision("chapter:"+chapter.id,chapter.revision);
        const currentPlan=await api<TextPlan>("/operations/plan",{kind:"prepareChapter",chapterId:chapter.id,revision,ids:selected});
        if(currentPlan.textRequests!==plan.textRequests || JSON.stringify(currentPlan.memberIds)!==JSON.stringify(plan.memberIds) || currentPlan.kind!==plan.kind){setPlan(currentPlan);await refresh();throw new Error("保存后的分析范围已更新，请核对请求次数后再次准备。");}
        const result=await submitOperation<{analysis:Suggestion}>("prepare:"+chapter.id,{kind:"prepareChapter",chapterId:chapter.id,revision,ids:selected,model:defaultModel,grantId},stateJobs);
        if(result.error)throw new Error(result.error);
        setViewId(result.result.analysis.id);setEditing(null);setChecked([]);setAck(false);
      });
      await refresh();
    } catch(error){setPrepareError((error as Error).message);}
    finally{setPreparing(false);}
  }
  const editable =
    applicable && !working && draft?.status !== "applied" && !!draft?.batches;
  async function updateDraft(path: string, data: object) {
    if (!draft) return;
    await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
      if(path==="/analysis/resume" && !draftGrantId)throw new Error("请先允许本次文本分析范围和请求次数。");
      await api(path, {id:draft.id,draftVersion:draft.draftVersion,...data,...(path==="/analysis/resume" ? {grantId:draftGrantId} : {})});
    });
    await refresh();
  }
  const current =
    draft?.status === "ready" &&
    draft.revision === chapter.revision &&
    draft.contextRevision === contextRevision;
  const invalidItems = draft?.items.filter(item => item.issues?.length) || [];
  const firstInvalid = invalidItems[0];
  return (
    <section className="analysis-panel" aria-label="AI 剧本整理">
      <div className="analysis-prepare">
        <h3>{chapter.segments.length ? "AI 帮我准备下一步" : "AI 整理这一章"}</h3>
        <p className="hint">{chapter.segments.length ? "补充表演建议，沿用角色和声音，保留你改过的内容。" : "从原文整理台词与角色；有歧义的地方集中交给你判断。"}</p>
        <div className="tabs analysis-policy" aria-label="AI 协作方式">
          <button type="button" aria-pressed={experience?.policy.mode==="smart" && experience.policy.revision>0} disabled={!experience || policySaving || preparing || working} onClick={()=>void choosePolicy("smart")}>AI 先安排</button>
          <button type="button" aria-pressed={experience?.policy.mode==="review" && experience.policy.revision>0} disabled={!experience || policySaving || preparing || working} onClick={()=>void choosePolicy("review")}>逐项审阅</button>
        </div>
        <p className="hint">{!experience?.policy.revision ? "先选择本项目的协作方式。" : experience.policy.mode==="smart" ? "明确说话人和常规表演可自动进入初稿，疑点、强烈表演与人工修改仍由你决定。AI 安排不会标记为试听通过。" : "所有建议先保存在草稿中，审阅后再应用。"}</p>
        {plan && <>
          <p className="hint">{plan.kind==="extract" ? "整章原文" : selected.length ? `所选 ${plan.memberIds.length} 条台词` : `本章 ${plan.memberIds.length} 条台词`} · 本次 {plan.textRequests} 次文本请求</p>
          <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="准备这一章" step="text" steps={[plan.kind]} model={defaultModel} requests={plan.textRequests} onReady={setGrantId} disabled={preparing || working}/>
        </>}
        <button type="button" className="button primary" disabled={!plan || !grantId || !experience?.policy.revision || preparing || working} onClick={()=>void prepare()}>{working ? "正在准备…" : preparing ? "正在保存并准备…" : "准备这一章"}</button>
        {prepareError && <p className="error-inline" role="alert">{prepareError}</p>}
      </div>
      {draft && <div className="analysis-summary" aria-live="polite">
        <div><strong>{draft.status === "running" ? "正在分析" : draft.automation ? `AI 已安排 ${draft.automation.applied} 条 · 需你判断 ${draft.automation.needsDecision} 条` : draft.status === "applied" ? "已应用" : !applicable ? "草稿已过期" : invalidItems.length ? `${invalidItems.length} 条需校对` : current ? "草稿待审阅" : "草稿需要处理"}</strong><span>{draft.items.length} 条标注 · {draft.doneChunks || 0}/{draft.totalChunks || 1} 批</span></div>
        {editable && firstInvalid && <button type="button" className="text-button" onClick={() => editItem(firstInvalid)}>校对第 {draft.items.indexOf(firstInvalid) + 1} 条</button>}
        {!!draft.automation?.needsDecision && onIssues && <button type="button" className="text-button" onClick={onIssues}>集中处理疑点</button>}
        {experience?.changes.some(change=>change.changeId===draft.id && !change.undoneAt) && <Form primary={false} label="撤销这次 AI 安排" children={null} onSubmit={async()=>{await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{await api("/experience/undo",{changeId:draft.id,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision)});});await refresh();}}/>}
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
                label: `${d.model} · ${d.createdAt ? new Date(d.createdAt).toLocaleString() : "历史草稿"}`,
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
          {editable && <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="继续或重做本轮分析" step="text" steps={[draft.kind]} model={draft.model} requests={Math.max(1,draft.batches?.filter(b=>b.status!=="received").length || 0)} onReady={setDraftGrantId} disabled={working}/>}
          {draft.batches?.some((b) => b.status !== "received") && editable && (
            <Form
              key={`${draft.id}:${draft.draftVersion}`}
              label="继续未完成部分"
              busy={!draftGrantId}
              revision={draft.draftVersion}
              onSubmit={async (f, draftVersion) =>
                updateDraft("/analysis/resume", {
                  draftVersion,
                  retryUnknown: f.get("retryUnknown") === "on",
                })
              }
            >
              {draft.batches.some((b) => b.status === "unknown") && (
                <label className="check-label">
                  <input type="checkbox" name="retryUnknown" required />
                  确认重新提交结果不明的请求，可能重复计费
                </label>
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
                  label="重新分析本批"
                  busy={!draftGrantId}
                  revision={draft.draftVersion}
                  onSubmit={async (f, draftVersion) =>
                    updateDraft("/analysis/resume", {
                      draftVersion,
                      batchIds: [b.id],
                      replace: f.get("replace") === "on",
                    })
                  }
                >
                  <label className="check-label">
                    <input type="checkbox" name="replace" required />
                    替换本批草稿，后续依赖批次需重新分析；会产生模型费用
                  </label>
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
                    onChange={(e) =>
                      setChecked((v) =>
                        e.target.checked
                          ? [...v, item.id]
                          : v.filter((x) => x !== item.id),
                      )
                    }
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
                    <span>{item.evidence}</span>
                    {!!draft.automation && draft.appliedItemIds?.includes(item.id) && <span>AI 已安排</span>}
                    {item.uncertain && (
                      <span className="warning">{draft.kind === "extract" ? "角色待确认" : "建议待核对"}</span>
                    )}
                    {draft.kind === "director" && draft.status === "applied" && (
                      <span>{!draft.appliedItemIds ? "历史记录未区分采用条目" : draft.appliedItemIds.includes(item.id) ? "本轮已采用" : "未采用 · 需重新分析"}</span>
                    )}
                  </div>
                  <p className="suggestion-text">
                    {item.text || "原文范围待修正"}
                  </p>
                  <p className="suggestion-performance">{item.performance}</p>
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
                  {onLocate && (item.segmentId || chapter.segments.some(s=>s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id)) && <button type="button" className="text-button" onClick={()=>{const id=item.segmentId || chapter.segments.find(s=>s.analysisOrigin?.draftId===draft.id && s.analysisOrigin.itemId===item.id)?.id;if(id)onLocate(id);}}>前往这句</button>}
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
              label={draft.kind === "extract" ? "应用校对稿" : "应用本轮选择"}
              onSubmit={async () => {
                await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
                  await api("/analysis/apply", {
                    id:draft.id,draftVersion:draft.draftVersion,revision:draftScopeRevision("chapter:"+chapter.id,chapter.revision),selected:checked,replaceConfirmed:ack,confirmRoles,
                  });
                });
                await refresh();
              }}
            >
              {draft.kind === "extract" ? (
                <>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={ack}
                      onChange={(e) => setAck(e.target.checked)}
                    />
                    确认替换当前剧本
                    {draft.replacementSource !== undefined ? "及原文" : ""}
                    ；旧片段和音频保留
                  </label>
                  <label className="check-label">
                    <input
                      type="checkbox"
                      checked={confirmRoles}
                      onChange={(e) => setConfirmRoles(e.target.checked)}
                    />
                    我已核对本轮明确的说话人；有疑点的角色仍保留待确认
                  </label>
                </>
              ) : (
                <p className="hint">
                  已选 {checked.length} 条，一次应用；未选择的指导不改变。
                </p>
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
        {advancedPlan && <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="高级整理" step="text" steps={[kind]} model={model} requests={advancedPlan.textRequests} onReady={setAdvancedGrantId} disabled={working}/>}
      <Form
        label={draft?.status === "running" ? "分析中…" : "生成校对草稿"}
        busy={working || !advancedGrantId || !advancedPlan}
        revision={chapter.revision}
        onSubmit={async () => {
          await withSavedDrafts("chapter:"+chapter.id,undefined,async()=>{
            const revision=draftScopeRevision("chapter:"+chapter.id,chapter.revision);
            const payload={kind:"prepareChapter",analysisKind:kind,autoApply:false,chapterId:chapter.id,revision,model,ids:selected,grantId:advancedGrantId,...(kind==="extract" && replaceSource?{source:source.replace(/\r\n?/g,"\n")}: {})};
            const currentPlan=await api<TextPlan>("/operations/plan",payload);
            if(currentPlan.textRequests!==advancedPlan?.textRequests){setAdvancedPlan(currentPlan);await refresh();throw new Error("保存后的分析请求数已变化，请核对后再次提交。");}
            const operation=await submitOperation<{analysis:Suggestion}>("advanced-analysis:"+chapter.id,payload,stateJobs);
            if(operation.error)throw new Error(operation.error);
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
