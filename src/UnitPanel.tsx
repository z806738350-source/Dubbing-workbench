import { useEffect, useRef, useState } from "react";
import { ChevronRight, CircleHelp } from "lucide-react";
import { api, action } from "./api";
import { hasDraft } from "./drafts";
import { Dialog, Field, Select, Status } from "./components";
import { ObjectDraftTools, objectDraftId, useObjectDraft } from "./ObjectDraft";
import { saveAction, withSavedDrafts, draftScopeRevision, type SaveContext } from "./autosave";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import SceneSuggestions from "./SceneSuggestions";
import { AudioProvenance } from "./AudioProvenance";
import type { ChapterDetail, GenerationUnit, Job, Role, SoundEvent, State, Voice } from "./types";

const labels: Record<string, string> = { invalid: "需要修复", missing: "还没有声音", stale: "内容已修改，需要更新声音", matched: "声音已更新", broken: "声音文件不可用", pending: "尚未听评", passed: "人工听评通过", rework: "需要重做", queued: "排队中", running: "生成中", failed: "生成失败", unknown: "结果不明，可能已计费", stopped: "已停止", success: "已生成" };
const message = (conflict: unknown) => typeof conflict === "string" ? conflict : (conflict as { message?: string; reason?: string })?.message || (conflict as { reason?: string })?.reason || "成员设置存在冲突，请核对";
const modeLabel = (mode: "dry" | "scene") => mode === "dry" ? "纯人声" : "带背景声";
const positions = [{ value: "before", label: "之前" }, { value: "during", label: "期间" }, { value: "after", label: "之后" }];
type TextSelection = { start: number; end: number };
const dependencies = (unit: GenerationUnit, mode: "dry" | "scene") => ["unit:" + unit.id + "/" + mode, ...unit.members.map(id => "segment:" + id), ...(mode === "scene" ? ["events:" + unit.id] : [])];

export function unitHasDraft(unit: GenerationUnit, events: SoundEvent[], mode = unit.mode) {
  return unit.members.some(id => hasDraft(id)) || hasDraft(objectDraftId("unit", unit.id + "/" + mode)) ||
    (mode === "scene" && events.some(event => event.unitId === unit.id && event.state !== "removed" && hasDraft(objectDraftId("sound-event", event.id))));
}
function Members({ ids, chapter, roles, voices = [], open }: { ids: string[]; chapter: ChapterDetail; roles: Role[]; voices?: Voice[]; open: (id: string) => void }) {
  return <ol className="task-member-list">{ids.map(id => {
    const segment = chapter.segments.find(segment => segment.id === id);
    return <li key={id}>{segment ? <><div><strong>第 {segment.order + 1} 条 · {roles.find(role => role.id === segment.roleId)?.name || "未分配角色"}</strong><span className="hint">{voices.find(voice => voice.id === segment.voiceId)?.name || "需要选择声音"}</span></div><p className="original-excerpt">{segment.text}</p><button className="text-button" onClick={() => open(id)}>{hasDraft(id) ? "处理这句的未完成编辑" : "修改这句"}</button></> : <p className="warning">成员已不存在，请核对。</p>}</li>;
  })}</ol>;
}
export function CreateGroup({ chapter, ids, roles, enabled, state, refresh, close, open, created }: {
  chapter: ChapterDetail; ids: string[]; roles: Role[]; enabled: boolean; state?: State;
  refresh: () => Promise<void>; close: () => void; open: (id: string) => void; created: (unit: GenerationUnit, warning?: string) => void;
}) {
  const controller = useObjectDraft("unit", "new-" + chapter.id, { ids: chapter.segments.filter(segment => ids.includes(segment.id)).map(segment => segment.id), guidance: "", chapterRevision: chapter.revision }, 0, { scope: "chapter:" + chapter.id, dependencies: ["new-group:" + chapter.id], deferUnmounted: true });
  const [preview, setPreview] = useState<{ conflicts: unknown[]; prompt?: string } | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [grantId, setGrantId] = useState<string | null>(null), [resumeRoute,setResumeRoute]=useState(false);
  useEffect(()=>{setResumeRoute(false);},[state?.settings.routeBlocked,state?.settings.model]);
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const signature = JSON.stringify({ ids: controller.draft.ids, guidance: controller.draft.guidance, revision: chapter.revision });
  useEffect(() => {
    let current = true;
    if (controller.composing) return;
    const timer = setTimeout(() => {
      void api<{ conflicts: unknown[]; prompt?: string }>("/enhancement-preview", { kind: "group", chapterId: chapter.id, revision: chapter.revision, ids: controller.draft.ids, guidance: controller.draft.guidance }).then(result => { if (current) setPreview(result); }).catch(failure => { if (current) setError(failure.message); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [signature, controller.composing]);
  const generate = async () => {
    if(state?.settings.routeBlocked&&!resumeRoute){setError("请先核对接口权限与额度，再明确恢复本次声音请求。");return;}
    setPending(true); setError("");
    let savedUnit: GenerationUnit | undefined, warning: string | undefined, opened = false;
    try {
      await withSavedDrafts("chapter:" + chapter.id, controller.draft.ids.map(id => "segment:" + id), async () => {
        if(!active.current)return;
        if (controller.draft.ids.some(id => hasDraft(id))) throw new Error("相关台词有其他页面或遗留编辑，请先在上方处理。");
        const receipt = await controller.save(async value => {
          if(!active.current)throw new Error("准备已取消，未发送音频请求；编辑仍保留。");
          const operation = await submitOperation<{ unit?: GenerationUnit; job?: Job }>("group:" + chapter.id, { kind: "groupAndGenerate", chapterId: chapter.id, revision: draftScopeRevision("chapter:" + chapter.id, chapter.revision), ids: value.ids, guidance: value.guidance, mode: "dry", grantId, ...(resumeRoute?{resumeRoute:true}:{}) }, state?.jobs);
          const unit = operation.result?.unit;
          if (!unit) throw new Error(operation.error || "对话尚未创建，请处理提示后重试。");
          savedUnit = unit; warning = operation.error ? "对话已保存，声音未生成：" + operation.error : undefined;
          return { value: { ids: unit.members, guidance: unit.variants.dry.guidance || "", chapterRevision: unit.chapterRevision! }, revision: unit.revision, targetId: unit.id + "/dry" };
        });
        if (receipt.dirty) warning = "准备已保存，后续编辑仍保留，请在这段对话中继续修改。";
        if (active.current && savedUnit) { opened = true; created(savedUnit, warning); }
        await refresh();
      });
    } catch (failure) {
      if (active.current && savedUnit && !opened) created(savedUnit, "对话已保存，未完成编辑仍保留：" + (failure as Error).message);
      else if (active.current) setError((failure as Error).message);
    }
    finally { if (active.current) {setResumeRoute(false);setPending(false);} }
  };
  const voiceIds = [...new Set(chapter.segments.filter(segment => controller.draft.ids.includes(segment.id)).flatMap(segment => segment.voiceId ? [segment.voiceId] : []))];
  return <Dialog title="一起演绎" presentation="sidepanel" onClose={close} footer={<>
    <p className="task-request-summary">这 {controller.draft.ids.length} 句一起生成 · 1 次音频请求 · 原有声音保留</p>
    {state?.settings.routeBlocked&&<label className="check-label warning"><input type="checkbox" checked={resumeRoute} disabled={pending} onChange={event=>setResumeRoute(event.target.checked)}/>已核对接口权限与额度，恢复本次声音请求。</label>}
    <button className="button primary" disabled={!enabled || pending || controller.composing || !grantId || !!preview?.conflicts.length || controller.base !== 0 || state?.settings.configured === false || state?.settings.audioTools === false || (state?.settings.routeBlocked&&!resumeRoute)} onClick={() => void generate()}>{pending ? "正在准备这段对话…" : "生成这段对话"}</button>
    {state?.settings.routeBlocked && <p className="warning">声音接口已暂停。核对权限与额度后，勾选上方恢复选项，再点击生成。</p>}
  </>}>
    <p className="task-panel-summary">连续台词一起演绎，修改其中一句会重做整段。生成成功后才替换当前编排。</p>
    <Members ids={controller.draft.ids} chapter={chapter} roles={roles} voices={state?.voices} open={open} />
    <Field label="希望他们怎样接话？" hint="例如：紧张地争论，轮流接话，后一句稍有迟疑。"><textarea rows={3} disabled={pending || controller.frozen} value={controller.draft.guidance} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event => { controller.edit({ guidance: event.target.value }); setPreview(null); }} /></Field>
    {preview?.conflicts?.map((conflict, index) => <p className="warning" key={index}>{message(conflict)}</p>)}
    {error && <p className="error-inline" role="alert">{error}</p>}
    <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="制作这段对话" steps={["unit-generate"]} model={state?.settings.model} voiceIds={voiceIds} onReady={setGrantId} disabled={pending} />
    <details><summary>未完成编辑与请求详情</summary><ObjectDraftTools inline controller={controller} title="这段对话" onError={setError} render={value => <><Members ids={value.ids} chapter={chapter} roles={roles} open={open} /><p>{value.guidance}</p></>} />{preview?.prompt && <pre className="prompt-text">{preview.prompt}</pre>}</details>
    {controller.base !== 0 && <p className="warning">对话已保存。请从正文中的对话块继续，不会再次创建相同对话。</p>}
  </Dialog>;
}

type UnitPanelProps = {
  playingId?: string;
  unit: GenerationUnit; chapter: ChapterDetail; roles: Role[]; state: State; locked: boolean; connected: boolean; initialMode?: "dry" | "scene"; initialEventId?: string;
  refresh: () => Promise<void>; close: () => void; open: (id: string) => void; play: (id: string, title: string, historical?: boolean) => void;
  onTask?: (jobId: string, attemptId: string) => void | Promise<void>;
};
type Preview = { kind: "dissolve" | "restore" | "template"; base: { revision: number; entityRevision: number; arrangement?: number }; audioId?: string; items?: { id: string; audioId: string | null; validity: string; review: string; diagnostics: string[] }[]; differences?: unknown[]; input?: { guidance?: string; template?: string; events?: {kind:string;description:string}[] }; candidateInput?:Preview['input']; targetCompilerIdentity?:string; preservedDraftIds?:string[]; conflicts?:string[]; blockers?:unknown[]; baseRevisions?:Record<string,unknown>; resultWouldMatch?:boolean; changedAdoptedEvents?:{removedIds:string[];restoredIds:string[]}; before?: string; after?: string; to?: string };
export default function UnitPanel(props: UnitPanelProps) {
  const [mode, setMode] = useState<"dry" | "scene">(props.initialMode || props.unit.mode);
  return <UnitDetails key={props.unit.id + "/" + mode} {...props} mode={mode} setMode={setMode} />;
}
function UnitDetails({ unit, chapter, roles, state, locked, connected, refresh, close, open, play, playingId, mode, setMode, initialEventId, onTask }: UnitPanelProps & { mode: "dry" | "scene"; setMode: (mode: "dry" | "scene") => void }) {
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [grantId, setGrantId] = useState<string | null>(null), [resumeRoute,setResumeRoute]=useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [feedbackScope, setFeedbackScope] = useState("generate"), [notice, setNotice] = useState("");
  useEffect(()=>{setResumeRoute(false);},[state.settings.routeBlocked,state.settings.model]);
  const confirmed = useRef({ revision: unit.revision, chapterRevision: chapter.revision });
  const confirmedEvents = useRef(new Map<string, SoundEvent>());
  for (const event of chapter.events || []) if (event.unitId === unit.id && (event.revision || 0) >= (confirmedEvents.current.get(event.id)?.revision || 0)) confirmedEvents.current.set(event.id, event);
  if (unit.revision >= confirmed.current.revision) confirmed.current = { revision: unit.revision, chapterRevision: chapter.revision };
  const rememberEvent = (event: SoundEvent) => {
    if ((event.revision || 0) >= (confirmedEvents.current.get(event.id)?.revision || 0)) confirmedEvents.current.set(event.id, event);
    if (event.unitRevision && event.chapterRevision && event.unitRevision >= confirmed.current.revision) confirmed.current = { revision: event.unitRevision, chapterRevision: event.chapterRevision };
  };
  const [eventSelection, setEventSelection] = useState<TextSelection | undefined>();
  const [editingEvent, setEditingEvent] = useState<string | null>(initialEventId || null), [createdEvent, setCreatedEvent] = useState<SoundEvent | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null), [retryUnknown, setRetryUnknown] = useState(false);
  const invalid = !!unit.diagnostics?.length, editLocked = locked || invalid || unit.state === "dissolved";
  const events = (chapter.events || []).filter(event => event.unitId === unit.id);
  const visibleEvents = events.filter(event => event.state !== "removed" || event.id === editingEvent);
  const variant = unit.variants[mode], status = variant.status;
  const history = variant.history || [], originalIds = new Set(history.map(result => result.originalAudioId).filter(Boolean));
  const visibleHistory = history.filter(result => !originalIds.has(result.id) || result.selected);
  const relatedDraft = unitHasDraft(unit, events, mode);
  const using = !invalid && unit.state === "active" && unit.mode === mode && status.validity === "matched" && chapter.playbackItems.some(item => (item.unitId || item.id) === unit.id && (item.mode || "dry") === mode && item.audioId === variant.current && item.validity === "matched");
  const switchHint = invalid ? "这段声音需要修复，请先处理上方提示。" : unit.state === "dissolved" ? "这段对戏已取消，这里仅保留历史声音。" : locked ? "本章正在制作，完成后才能切换声音。" : relatedDraft ? "相关修改尚未完成，请先保存或处理未完成编辑，再选用声音。" : status.validity === "missing" ? `还没有${modeLabel(mode)}版本，请先生成；生成会发送音频请求。` : status.validity === "broken" ? "声音文件不可用，请恢复已有声音或重新生成。" : status.validity === "stale" ? "设置已修改，请按当前设置生成，或从历史中恢复匹配的声音。" : status.validity !== "matched" ? "这份声音暂时不能选用，请先处理上方提示。" : !using && unit.mode === mode ? "这份声音未进入当前整章编排，请在正文中查看所属片段或对戏段。" : "";
  const switchHintId = "unit-switch-" + unit.id + "-" + mode;
  const singleDry = unit.kind === "single" && mode === "dry";
  const persistSettings = async (value: { guidance: string; backgroundPresence: NonNullable<typeof variant.backgroundPresence>; chapterRevision: number }, expected: number, context: SaveContext) => {
      const saved = await saveAction<GenerationUnit>("unit.update", { chapterId: chapter.id, revision: context.chapterRevision, id: unit.id, entityRevision: expected, mode, guidance: value.guidance, ...(mode==='scene'?{backgroundPresence:value.backgroundPresence}:{}) }, context.operationId, context.replay);
      if (saved.revision >= confirmed.current.revision) confirmed.current = { revision: saved.revision, chapterRevision: saved.chapterRevision! };
      void refresh().catch(failure => { if (active.current) { setFeedbackScope("settings"); setError("要求已保存，界面更新失败：" + failure.message); } });
      return { value: { guidance: saved.variants[mode].guidance || "", backgroundPresence:saved.variants[mode].backgroundPresence??"clear", chapterRevision: saved.chapterRevision! }, revision: saved.revision, chapterRevision: saved.chapterRevision, changes: ["unit:" + unit.id + "/" + mode] };
  };
  const controller = useObjectDraft("unit", unit.id + "/" + mode, { guidance: variant.guidance || "", backgroundPresence:variant.backgroundPresence??"clear", chapterRevision: chapter.revision }, unit.revision, {
    scope: "chapter:" + chapter.id, chapterRevision: chapter.revision, dependencies: ["unit:" + unit.id + "/" + mode], locked: editLocked || !!editingEvent || singleDry,
    persist: persistSettings,
  });
  // Persist the visible default only on an explicit operation, preserving old audio on opening.
  const flushSettings = () => mode === "scene" && variant.backgroundPresence === undefined && !controller.dirty && controller.base === unit.revision
    ? controller.save(persistSettings) : controller.flush();
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const currentTemplate = status.input?.template || variant.template || (singleDry ? chapter.segments.find(segment => segment.id === unit.id)?.template : "") || "";
  const effectiveTemplate = variant.resolvedCompilerId || currentTemplate;
  const needsPresenceTemplate = mode === "scene" && controller.draft.backgroundPresence !== "unspecified" && effectiveTemplate !== "scene-v4-presence-1";
  const presenceTemplateWarning = `当前旧模板不支持“${({subtle:"轻",natural:"自然",clear:"清楚",unspecified:"未指定"})[controller.draft.backgroundPresence]}”。先切换至 v4，再按此存在感生成。`;
  const templates = (state.enhancementTemplates || []).filter(template => mode === "scene" ? template.mode === "scene" : unit.kind === "group" ? template.scope === "group" : template.scope === "single" && template.mode === "dry");
  const [targetTemplate, setTargetTemplate] = useState(currentTemplate);
  const enabled = !invalid && unit.state !== "dissolved" && (unit.kind !== "group" || state.settings.features?.groups !== false) && (mode !== "scene" || state.settings.features?.scenes !== false);
  const jobs = state.jobs.filter(job => job.unitId === unit.id || job.unitIds?.includes(unit.id) || unit.kind === "single" && job.kind === "generate" && job.ids?.includes(unit.id));
  const job = jobs.find(job => ["queued", "running"].includes(job.status));
  const outstandingAttemptIds=[...new Set([...(variant.outstandingAttemptIds||[]),...(unit.readiness?.generate.blockers.filter(issue=>issue.code==='request-unknown').flatMap(issue=>issue.attemptIds||[])||[])])];
  const unknown = !!outstandingAttemptIds.length || variant.latest === "unknown";
  const localRecoveryPending = jobs.some(job => job.localRecoveryAttemptIds?.some(id => outstandingAttemptIds.includes(id)));
  const payload = { chapterId: chapter.id, revision: chapter.revision, id: unit.id, entityRevision: unit.revision };
  const run = async (next: () => Promise<unknown>, scope = "settings", success = "") => { setFeedbackScope(scope); setError(""); setNotice(""); try { await next(); if (active.current) setNotice(success); } catch (failure) { if (active.current) setError((failure as Error).message); } };
  const feedback = (scope: string) => feedbackScope === scope && (error ? <p className="error-inline" role="alert">{error}</p> : notice ? <p className="success-text" role="status">{notice}</p> : null);
  const previewTemplate = (template: string, scope = "settings") => void run(async () => {
    setPending(true);
    try {
      await flushSettings();
      if (!active.current) return;
      if (unitHasDraft(unit, events, mode)) throw new Error("还有相关未完成编辑，请先处理后核对模板。");
      const base = { revision: draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision), entityRevision: confirmed.current.revision };
      const result = await api<{before:string;after:string;to:string}>("/enhancement-preview", { kind:"template", ...payload, ...base, mode, template });
      if (active.current) setPreview({ ...result, kind:"template", base });
    } finally { if (active.current) setPending(false); }
  }, scope);
  const previewRestore = (audioId: string, scope = "history") => void run(async () => {
    setPending(true);
    try {
      const result = await api<Omit<Preview, "kind" | "audioId" | "base">>("/enhancement-preview", { kind: "restore", ...payload, mode, audioId });
      if (active.current) setPreview({ ...result, kind: "restore", audioId, base: { revision: payload.revision, entityRevision: payload.entityRevision } });
    } finally { if (active.current) setPending(false); }
  }, scope);
  const viewRecord = () => void run(async () => {
    setPending(true);
    try {
      for (const item of [...jobs].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))) {
        const attempts = await api<{ id: string; unitId?: string; targetId?: string; segmentId?: string; mode?: "dry" | "scene"; input?: { mode?: "dry" | "scene" }; status: string }[]>("/attempts/" + item.id);
        const attempt = attempts.filter(attempt => outstandingAttemptIds.includes(attempt.id)||(attempt.unitId || attempt.targetId || attempt.segmentId) === unit.id && (attempt.mode || attempt.input?.mode || "dry") === mode && attempt.status === variant.latest).at(-1);
        if (attempt) { if (active.current) await onTask?.(item.id, attempt.id); return; }
      }
      throw new Error("这次记录暂未找到，请刷新后再查看；已有声音仍然保留。");
    } finally { if (active.current) setPending(false); }
  }, "record");
  const generate = async () => {
    setFeedbackScope("generate"); setNotice("");
    if (localRecoveryPending) { setError("原件已接收，请先在任务记录免费恢复。"); return; }
    if (needsPresenceTemplate) { setError(presenceTemplateWarning); return; }
    if(state.settings.routeBlocked&&!resumeRoute){setError("请先核对接口权限与额度，再明确恢复本次声音请求。");return;}
    if (unknown && !retryUnknown) { setError("请先核对这次记录，再明确选择再次提交。"); return; }
    setPending(true); setError("");
    const baseRevision = chapter.revision;
    try {
      await withSavedDrafts("chapter:" + chapter.id, dependencies(unit, mode), async () => {
        if(!active.current)return;
        await flushSettings();
        if(!active.current)return;
        if (unitHasDraft(unit, events, mode)) throw new Error("还有相关未完成编辑，请通过恢复入口处理；其他页面的编辑不会被覆盖。");
        const revision = draftScopeRevision("chapter:" + chapter.id, baseRevision);
        if (draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision) !== revision) throw new Error("这段声音在准备期间发生了变化，请核对当前内容后再生成。");
        const operation = await submitOperation("unit:" + unit.id + "/" + mode, {
          kind: mode === "scene" ? "sceneAndGenerate" : "generateSelection", chapterId: chapter.id,
          revision,
          ...(mode === "scene" ? { unitId: unit.id, entityRevision: confirmed.current.revision, eventIds: [...confirmedEvents.current.values()].filter(event => event.state === "adopted").map(event => event.id) } : { ids: unit.members, unitId: unit.id, mode, regenerate: true }),
          grantId, ...(unknown && retryUnknown ? { retryUnknown: true, ...(outstandingAttemptIds.length?{acknowledgedAttemptIds:outstandingAttemptIds}:{}) } : {}), ...(resumeRoute?{resumeRoute:true}:{}),
        }, state.jobs);
        if (operation.error&&active.current) setError((operation.outcome === "prepared" ? "设置已保存，声音尚未生成：" : "") + operation.error);
        if(active.current)setRetryUnknown(false); await refresh();
      });
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) {setResumeRoute(false);setPending(false);} }
  };
  const openEvent = (id: string, scope = id === "new" ? "settings" : id) => void run(async () => { await controller.flush(); setEventSelection(undefined); setEditingEvent(id); }, scope);
  const eventUnit = { ...unit, revision: confirmed.current.revision }, eventChapter = { ...chapter, revision: draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision) };
  const voiceIds = [...new Set(chapter.segments.filter(segment => unit.members.includes(segment.id)).flatMap(segment => segment.voiceId ? [segment.voiceId] : []))];
  const keptMode = variant.current && status.validity !== "broken" ? mode : unit.mode, kept = unit.variants[keptMode];
  const memberAudio = !kept.current && unit.state === "pending" ? chapter.playbackItems.find(item => item.audioId && item.validity === "matched" && (item.members || [item.id]).some(id => unit.members.includes(id))) : undefined;
  const keptId = kept.current || memberAudio?.audioId;
  const footer = !preview && <div className="unit-submit">
    {feedback("generate")}
    <div className="unit-submit-scope">
      <p className="task-request-summary">{unit.kind === "group" ? "整段 " : ""}{unit.members.length} 句 · {modeLabel(mode)} · 本次发送 1 次请求</p>
      {mode === "scene" && hasDraft(objectDraftId("sound-event", "new-" + unit.id)) && <p className="hint">未添加的声音草稿已保留，不加入本次生成。<button className="button secondary small" disabled={pending || editLocked || !!editingEvent} onClick={() => openEvent("new", "generate")}>继续编辑草稿</button></p>}
      {unknown && !localRecoveryPending && !job && <label className="check-label"><input type="checkbox" checked={retryUnknown} disabled={pending} onChange={event => setRetryUnknown(event.target.checked)} />我已核对这次记录，明确再次提交 1 次请求，可能再次计费。</label>}
      {state.settings.routeBlocked&&!job&&<label className="check-label warning"><input type="checkbox" checked={resumeRoute} disabled={pending} onChange={event=>setResumeRoute(event.target.checked)}/>已核对接口权限与额度，恢复本次声音请求。</label>}
      {needsPresenceTemplate && !job && <p className="unit-presence-required" id={"unit-template-required-" + unit.id}>{presenceTemplateWarning}切换免费，不会生成声音。</p>}
    </div>
    <div className="unit-submit-actions">
    {job ? <div role="status"><p>{labels[job.status]} · {job.done} / {job.total}</p><button className="button secondary" onClick={() => void run(async () => { await action("job.stop", { id: job.id }); await refresh(); }, "generate")}>停止后续请求</button></div> : <>
      {localRecoveryPending ? <button className="button primary" disabled={pending} onClick={viewRecord}>查看并免费恢复</button> : <button className={"button " + (needsPresenceTemplate ? "secondary" : "primary")} aria-describedby={needsPresenceTemplate ? "unit-template-required-" + unit.id : undefined} disabled={needsPresenceTemplate || !enabled || !state.settings.configured || !state.settings.audioTools || locked || pending || !grantId || !!editingEvent || controller.composing || (!!unknown && !retryUnknown) || (state.settings.routeBlocked&&!resumeRoute)} onClick={() => void generate()}>{pending ? feedbackScope === "generate" ? "正在保存与准备…" : "正在处理当前操作…" : unknown ? "再次提交 1 次请求" : status.validity === "matched" ? "再做一版" : mode === "scene" ? "应用并生成带背景声" : unit.kind === "group" ? "生成这段对话" : "更新这句声音"}</button>}
      {needsPresenceTemplate && !localRecoveryPending && <button className="button primary" aria-describedby={"unit-template-required-" + unit.id} disabled={editLocked || pending || !!editingEvent || controller.composing || controller.frozen} onClick={() => previewTemplate("scene-v4-presence-1", "generate")}>查看并切换到 v4</button>}
      {state.settings.routeBlocked && <p className="warning">声音接口已暂停。核对权限与额度后，勾选上方恢复选项，再点击生成。</p>}
      {!state.settings.configured && <p className="warning">尚未连接声音接口，请打开设置与连接。</p>}
      {!state.settings.audioTools && <p className="warning">音频处理不可用，请打开设置与连接检查。</p>}
      {!grantId && enabled && <p className="hint">先在“生成权限与剩余次数”中允许本次制作范围，再生成新版。</p>}
      {!!editingEvent && <p className="hint">先点击正在编辑的背景旁“完成编辑”，再生成新版。</p>}
    </>}
    </div>
  </div>;
  return <Dialog title={preview ? preview.kind === "dissolve" ? "取消一起演绎" : preview.kind === "template" ? "切换提示模板" : "恢复历史声音" : mode === "scene" ? "声音背景" : unit.kind === "group" ? "一起演绎" : "这句声音"} presentation="sidepanel" onClose={close} onBack={preview ? () => setPreview(null) : undefined} footer={footer}
    headerActions={<button type="button" className="icon unit-help-trigger" aria-label={mode === "scene" ? "声音背景操作说明" : "纯人声操作说明"} aria-haspopup="dialog" aria-expanded={showHelp} onClick={() => setShowHelp(true)}><CircleHelp size={18} aria-hidden="true" /></button>}>
    {preview ? <section className="task-panel-section unit-preview">
      {preview.kind === "dissolve" ? <>
        <p>将恢复以下单句纯人声；对话历史保留，不裁切、不自动补生成。</p>
        {preview.items?.map(item => <p key={item.id}>第 {(chapter.segments.find(segment => segment.id === item.id)?.order ?? -1) + 1} 条 · {labels[item.validity] || item.validity} · {labels[item.review] || item.review}{!item.audioId ? " · 需要补生成" : ""}{!!item.diagnostics?.length && " · " + item.diagnostics.join("；")}</p>)}
        <p className="warning">整段场景将退出当前编排；缺少的纯人声会阻止整章试听与导出。</p>
        <button className="button primary" disabled={locked} onClick={() => void run(async () => { await action("unit.dissolve", { ...payload, ...preview.base }); await refresh(); close(); })}>确认取消一起演绎</button>
      </> : preview.kind === "template" ? <>
        <h3>当前提示</h3><pre className="prompt-text">{preview.before}</pre><h3>新模板提示</h3><pre className="prompt-text">{preview.after}</pre>
        <p>仅更新下一次生成的模板设置，不发送声音请求。原音频与历史保留。</p><button className="button primary" disabled={locked} onClick={() => void run(async () => { await action("unit.template", { ...payload, ...preview.base, mode, template: preview.to, confirm: true }); await refresh(); if (preview.to) setTargetTemplate(preview.to); setPreview(null); })}>使用这个模板</button>
      </> : <>
        <h3>恢复已有{modeLabel(mode)}版本</h3>
        <p className="hint">将选用这份已生成音频，恢复当时的表演、背景和提示模板。不重新生成，不产生 API 费用。</p>
        <p className="hint">不会撤销后来修改的台词、角色、参考声音或数值设置；这些内容不兼容时，旧版仅供试听。</p>
        {!!preview.differences?.length && <><h3>与当前设置的差异</h3><ul className="unit-restore-differences">{preview.differences.map((difference, index) => <li key={index}>{message(difference)}</li>)}</ul></>}
        {preview.input && <div className="unit-restore-settings"><h3>恢复后的背景与表演</h3><p>{preview.input.guidance || "没有额外表演要求"}</p>{mode === "scene" && (preview.input.events?.length ? <ul>{preview.input.events.map((event,index) => <li key={index}>{({environment:"环境",effect:"音效",music:"音乐"})[event.kind] || event.kind} · {event.description}</li>)}</ul> : <p>这份旧版没有背景事件。</p>)}</div>}
        {!!preview.preservedDraftIds?.length&&<p className="hint">保留 {preview.preservedDraftIds.length} 份未采用背景草稿，它们不会加入这份声音。</p>}
        {preview.changedAdoptedEvents&&<p className="hint">已采用背景：替换 {preview.changedAdoptedEvents.removedIds.length} 项，恢复 {preview.changedAdoptedEvents.restoredIds.length} 项。</p>}
        {preview.targetCompilerIdentity&&<p className="hint">恢复模板：{preview.targetCompilerIdentity}</p>}
        {preview.conflicts?.map((conflict,index)=><p className="warning" key={index}>{conflict}</p>)}
        <button className="button primary" disabled={locked || pending || relatedDraft || !!preview.conflicts?.length || !!preview.blockers?.length || preview.resultWouldMatch===false} onClick={() => void run(async () => { setPending(true); try { await action("unit.restore", { ...payload, ...preview.base, mode, audioId: preview.audioId, restoreSettings: true, baseRevisions:preview.baseRevisions }); await refresh(); if (active.current) setPreview(null); } finally { if (active.current) setPending(false); } }, "current", "已恢复并选用这份历史声音。整章试听与导出会使用它。")}>{pending ? "正在恢复…" : "恢复并使用这份声音"}</button>
      </>}
      {error && <p className="error-inline" role="alert">{error}</p>}
    </section> : <>
      {unknown && <section className="unit-safe-result" aria-label="先处理这次未确认的结果"><h3>{localRecoveryPending ? "原件已接收，待本地恢复。已有声音仍然保留。" : "这次新结果尚未确认，可能已计费。已有声音仍然保留。"}</h3><div className="unit-safe-actions"><button className="button primary" disabled={!keptId || !connected || !memberAudio && kept.status.validity === "broken"} onClick={() => play(keptId!, memberAudio ? "第 " + ((chapter.segments.find(segment => segment.id === (memberAudio.members || [memberAudio.id])[0])?.order ?? -1) + 1) + " 句 · 已有纯人声" : modeLabel(keptMode) + " · 已有声音", !!memberAudio || invalid || unit.state === "dissolved" || kept.status.validity !== "matched")}>{playingId===keptId?"暂停已有声音":"试听已有声音"}</button><button className="button secondary" disabled={pending || !onTask} onClick={viewRecord}>查看这次记录</button></div>{memberAudio && <p className="hint">尚无整段声音，可先试听第 {(chapter.segments.find(segment => segment.id === (memberAudio.members || [memberAudio.id])[0])?.order ?? -1) + 1} 句已有纯人声；其他单句声音仍按原顺序保留。</p>}{!keptId && <p className="hint">这段还没有可试听的声音。先查看这次记录，再决定是否再次提交。</p>}{feedback("record")}</section>}
      <div className="task-version-summary"><strong>整章使用：{modeLabel(unit.mode)}</strong>{unit.state === "pending" ? <p className="hint">这段对话尚未生成，原单句声音仍在使用。</p> : unit.state === "dissolved" ? <p className="hint">此对话已取消，以下仅为历史记录。</p> : mode !== unit.mode && <p className="hint">当前查看：{modeLabel(mode)}</p>}</div>
      {invalid && <div className="error-inline" role="alert"><p>{unit.diagnostics!.join("；")}</p><p>历史声音仍保留。{unit.kind === "group" ? "请预览并取消一起演绎，再处理缺失成员。" : "请先修复相关台词。"}</p></div>}
      <div className="tabs enhancement-mode-tabs"><button className={mode === "dry" ? "active" : ""} aria-pressed={mode === "dry"} disabled={pending || controller.saving || !!editingEvent} onClick={() => { setRetryUnknown(false); setResumeRoute(false); setMode("dry"); }}>纯人声</button><button className={mode === "scene" ? "active" : ""} aria-pressed={mode === "scene"} disabled={pending || controller.saving || !!editingEvent} onClick={() => { setRetryUnknown(false); setResumeRoute(false); setMode("scene"); }}>带背景声</button></div>
      <section className="task-panel-section unit-current-result" aria-label="试听与选用">
        <h3>试听与选用 · {modeLabel(mode)}</h3><Status kind={status.review === "passed" ? "success" : status.validity === "stale" ? "warning" : ""}>{labels[status.validity] || status.validity} · {labels[status.review] || status.review}</Status>
        {!!status.promptIssues?.length && <p className="warning">{status.promptIssues.join("；")}</p>}
        <div className="unit-current-action">{!unknown && <button className="button secondary" disabled={!variant.current || !connected || status.validity === "broken"} onClick={() => play(variant.current!, modeLabel(mode) + (status.validity !== "matched" ? " · 旧版" : ""), invalid || unit.state === "dissolved")}>{playingId===variant.current?"暂停":"试听"}{status.validity === "matched" ? "这份声音" : "旧版声音"}</button>}<button className="button secondary" aria-describedby={switchHint ? switchHintId : undefined} disabled={pending || !!editingEvent || editLocked || unit.mode === mode || status.validity !== "matched" || relatedDraft} onClick={() => void run(async () => { await action("unit.switch", { ...payload, mode }); await refresh(); }, "current", "已选用" + modeLabel(mode) + "，整章试听与导出会使用它。") }>{using ? "正在使用" + modeLabel(mode) : mode === "dry" ? "切回纯人声" : "使用这份带背景声"}</button></div>
        {switchHint && <p className="hint" id={switchHintId}>{switchHint}</p>}
        <div className="unit-review-actions"><button className="button secondary small" disabled={status.review === "passed" || pending || editLocked || !connected || status.validity !== "matched" || unitHasDraft(unit, events, mode)} onClick={() => void run(async () => { await action("unit.review", { ...payload, mode, audioId: variant.current, basis: status.basis, state: "passed" }); await refresh(); }, "current", "已记录你的人工听评通过。") }>{status.review === "passed" ? "人工听评已通过" : "我已试听，检查通过"}</button><button className="button secondary small warning" disabled={status.review === "rework" || pending || editLocked || status.validity !== "matched"} onClick={() => void run(async () => { await action("unit.review", { ...payload, mode, audioId: variant.current, basis: status.basis, state: "rework" }); await refresh(); }, "current", "已标记需要重做；当前声音保留，尚未提交生成请求。") }>{status.review === "rework" ? "已标记需要重做" : "标记需要重做"}</button></div>
        {feedback("current")}
      </section>
      <details className="task-panel-section unit-history"><summary>历史声音 · {visibleHistory.length} 版</summary>
        <div className="button-row unit-history-actions">{([[variant.previous, "恢复上一版"], [variant.approved, "恢复最近通过版"]] as const).map(([id, label]) => <button key={label} className="button secondary small" disabled={!id || editLocked || pending || relatedDraft || !!editingEvent} onClick={() => previewRestore(id!)}>{label}</button>)}</div>
        {!variant.approved && <p className="hint">还没有人工听评通过的历史版本。</p>}
        {feedback("history")}
        {(editLocked || relatedDraft || !!editingEvent) && <p className="hint">{editLocked ? switchHint : "请先完成相关编辑，再选用或恢复历史声音。"}</p>}
        {!variant.history?.length && <p className="empty-inline">这个版本还没有历史声音。</p>}
        <div className="unit-history-list">{[...visibleHistory].reverse().map((result, index, list) => {
          const number = list.length - index, selected = result.selected && using;
          return <section className={"unit-history-item" + (selected ? " is-current" : "")} key={result.id} aria-label={"声音 " + number}>
            <div className="section-heading"><h3>声音 {number}</h3><span className={selected ? "success-text" : "hint"}>{result.available === false ? "文件不可用" : selected ? "当前使用" : result.selected ? "当前保留" : result.matched ? "可直接使用" : "旧设置 · 需核对"}</span></div>
            {(result.createdAt || result.duration) && <p className="hint">{result.createdAt && new Date(result.createdAt).toLocaleString("zh-CN")}{!!result.duration && " · " + result.duration.toFixed(1) + " 秒"}</p>}
            <div className="button-row"><button className="button secondary small" disabled={!connected || result.available === false} onClick={() => play(result.id, "历史声音 " + number, true)}>{playingId===result.id?"暂停声音":"试听声音"} {number}</button>
              {selected ? <span className="hint">已用于整章试听与导出</span> : result.matched ? <button className="button secondary small" disabled={editLocked || pending || relatedDraft || !!editingEvent} onClick={() => void run(async () => { setPending(true); try { await action(result.selected ? "unit.switch" : "unit.select-result", { ...payload, mode, ...(result.selected ? {} : { audioId: result.id }) }); await refresh(); } finally { if (active.current) setPending(false); } }, "history/" + result.id, "已选用这份声音，请试听后检查。")}>使用声音 {number}</button> : <button className="button secondary small" disabled={editLocked || pending || relatedDraft || !!editingEvent || result.available === false} onClick={() => previewRestore(result.id, "history/" + result.id)}>核对并恢复声音 {number}</button>}
            </div>
            <AudioProvenance record={result} original={history.find(audio => audio.id === result.originalAudioId)} connected={connected} locked={editLocked || pending || relatedDraft || !!editingEvent} playingId={playingId}
              preview={id => play(id, "清理前声音", true)} useOriginal={audio => {
                if (!audio.matched) { previewRestore(audio.id, "history/" + result.id); return; }
                void run(async () => { setPending(true); try { await action("unit.select-result", { ...payload, mode, audioId: audio.id }); await refresh(); } finally { if (active.current) setPending(false); } }, "history/" + result.id, "已选用清理前的声音，请重新试听检查。");
              }} />
            {feedback("history/" + result.id)}
            {result.available === false && <p className="warning">音频文件已损坏或缺失，无法试听或恢复；请找回文件或制作新版。</p>}
            {result.prompt && <details className="unit-history-prompt"><summary>查看当时的生成要求</summary><pre className="prompt-text">{result.prompt}</pre></details>}
          </section>;
        })}</div>
      </details>
      {mode === "scene" && <section className="task-panel-section unit-background-presence"><Field label="下一次生成的背景存在感"><Select label="背景存在感" value={controller.draft.backgroundPresence} options={[{value:"clear",label:"清楚"},{value:"natural",label:"自然"},{value:"subtle",label:"轻"},{value:"unspecified",label:"未指定"}]} disabled={editLocked||pending||!!editingEvent||controller.frozen} onChange={backgroundPresence=>controller.edit({backgroundPresence:backgroundPresence as NonNullable<typeof variant.backgroundPresence>})}/>{!needsPresenceTemplate && effectiveTemplate!=='scene-v4-presence-1'&&<button className="button secondary small" disabled={editLocked || pending || !!editingEvent || controller.composing || controller.frozen} onClick={() => previewTemplate("scene-v4-presence-1")}>查看并切换到 v4</button>}</Field>{!!unit.sceneConflicts?.length&&<div className="warning" role="alert"><h3>背景要求存在矛盾</h3>{unit.sceneConflicts.map((conflict,index)=><p key={index}>{conflict}</p>)}<p>请修改声音描述或共同要求，再生成新版。</p></div>}{!!unit.scenePresenceWarnings?.length&&<div className="hint" role="status"><h3>背景要求待确认</h3>{unit.scenePresenceWarnings.map((warning,index)=><p key={index}>{warning}</p>)}</div>}</section>}
      <section className="task-panel-section unit-member-context"><h3>{unit.kind === "group" ? "适用这段对话" : "适用这句台词"}</h3><p className="unit-member-range">覆盖第 {unit.members.map(id => (chapter.segments.find(segment => segment.id === id)?.order ?? -1) + 1).join("、")} 句 · 共 {unit.members.length} 句</p><details><summary>查看全文、角色与声音</summary><Members ids={unit.members} chapter={chapter} roles={roles} voices={state.voices} open={open} /></details></section>
      <details className="unit-edit-settings" open={!unknown || !!editingEvent}><summary><ChevronRight className="unit-disclosure-icon" aria-hidden="true" size={18} />{mode === "scene" ? "编辑下一版的背景与表演" : "编辑下一版的表演"}</summary>
      {singleDry ? <button className="button secondary" onClick={() => open(unit.members[0])}>修改这句的文字与表演</button> : <Field label={mode === "scene" ? "希望场景怎样呈现？" : "共同表演要求"}><textarea rows={3} value={controller.draft.guidance} disabled={editLocked || pending || !!editingEvent || controller.frozen} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event => controller.edit({ guidance: event.target.value })} /></Field>}

      {mode === "scene" && <section className="task-panel-section">
        <div className="section-heading"><h3>加入这次场景的声音</h3><button className="button secondary small" disabled={!enabled || editLocked || pending || !!editingEvent} onClick={() => openEvent("new")}>添加声音</button></div>
        {editingEvent === "new" && <EventEditor key="new" unit={eventUnit} chapter={eventChapter} descriptionMax={state.sceneContract?.descriptionMax} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} close={() => setEditingEvent(null)} created={(event, warning, selection) => { if (active.current) { setCreatedEvent(event); setEditingEvent(event.id); setEventSelection(selection); if (warning) setError(warning); } }} />}
        {!visibleEvents.length && editingEvent !== "new" && <p className="empty-inline">还没有声音背景，可添加声音或让 AI 提建议。</p>}
        {visibleEvents.map(event => <section className="task-event-card" key={event.id}>
          <div className="section-heading"><h3>{({ environment: "环境", effect: "音效", music: "音乐" })[event.kind]}</h3><span>{event.state === "removed" ? "已移除" : event.validity === "needsReview" ? "位置需要复核" : event.state === "adopted" ? "加入本次场景" : "仅保存，未采用"}</span></div>
          <p>{event.description}</p><p className="hint">第 {(chapter.segments.find(segment => segment.id === (event.startMemberId || event.memberId))?.order ?? -1) + 1} 句{positions.find(position => position.value === (event.startPosition || event.position))?.label}{event.endMemberId && "，持续至第 " + ((chapter.segments.find(segment => segment.id === event.endMemberId)?.order ?? -1) + 1) + " 句"} · {event.evidence.kind}</p>
          {!!event.diagnostics?.length && <p className="warning">{event.diagnostics.join("；")}</p>}
          {editingEvent === event.id ? <EventEditor key={event.id} event={event} unit={eventUnit} chapter={eventChapter} descriptionMax={state.sceneContract?.descriptionMax} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} resumeSelection={eventSelection} close={() => setEditingEvent(null)} created={() => {}} /> : <div className="button-row">
            <button className="button secondary small" disabled={!!editingEvent || pending} onClick={() => openEvent(event.id)}>编辑</button>
            {event.state !== "removed" && <><button className="button secondary small" disabled={editLocked || pending} onClick={() => void run(async () => { await action("event.update", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision, state: event.state === "adopted" ? "draft" : "adopted" }); await refresh(); }, event.id, "已更新下一次生成的背景配置；已有音频保持原样。") }>{event.state === "adopted" ? "暂不使用" : "加入场景"}</button>{event.validity === "needsReview" && <button className="button secondary small" disabled={editLocked} onClick={() => void run(async () => { await action("event.reconfirm", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision }); await refresh(); }, event.id) }>位置已核对</button>}<button className="button secondary small warning" disabled={editLocked || pending} onClick={() => void run(async () => { await action("event.remove", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision }); await refresh(); }, event.id) }>移除</button></>}
          </div>}
          {feedback(event.id)}
        </section>)}
        {createdEvent?.id === editingEvent && !events.some(event => event.id === editingEvent) && <EventEditor key={createdEvent.id} event={createdEvent} unit={eventUnit} chapter={eventChapter} descriptionMax={state.sceneContract?.descriptionMax} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} resumeSelection={eventSelection} close={() => setEditingEvent(null)} created={() => {}} />}
        <SceneSuggestions unit={unit} chapter={chapter} contextRevision={state.projects.find(project => project.id === chapter.projectId)?.contextRevision || 0} model={state.settings.textModel} enabled={enabled && !locked && !pending && !editingEvent} refresh={refresh} savedBase={async () => { await flushSettings(); return { revision: draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision), entityRevision: confirmed.current.revision }; }} />
      </section>}
      {feedback("settings")}
      </details>
      {!singleDry && <><ObjectDraftTools inline controller={controller} title="表演要求" onError={failure => { setFeedbackScope("draft-tools"); setError(failure); }} render={value => <p>{value.guidance}</p>} />{feedback("draft-tools")}</>}
      {enabled && <details className="unit-submit-authorization" open={!unknown}><summary>生成权限与剩余次数</summary><TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label={mode === "scene" ? "制作这份带背景声" : "制作这段声音"} steps={["unit-generate"]} model={state.settings.model} voiceIds={voiceIds} onReady={setGrantId} disabled={pending || editLocked} /></details>}
      <details className="task-panel-section unit-advanced"><summary>高级设置与请求记录</summary>
        <Field label="下一次生成的提示模板" hint={targetTemplate !== currentTemplate ? "尚未应用，请先查看模板差异。" : undefined}><Select label="提示模板" value={targetTemplate} options={[...(currentTemplate && !templates.some(template => template.id === currentTemplate) ? [{ value: currentTemplate, label: currentTemplate + " · 已保存" }] : []), ...templates.map(template => ({ value: template.id, label: template.name + (mode === "scene" ? template.id === "scene-v4-presence-1" ? " · 默认" : " · 旧版" : "") }))]} onChange={setTargetTemplate} /></Field>
        <button className="button secondary small" disabled={editLocked || pending || !!editingEvent || controller.composing || controller.frozen || !targetTemplate || targetTemplate === currentTemplate || unitHasDraft(unit, events, mode)} onClick={() => previewTemplate(targetTemplate, "advanced")}>查看模板差异</button>
        <details><summary>本次目标完整要求</summary><pre className="prompt-text">{status.prompt}</pre></details>
        {variant.resolvedCompilerId&&<p className="hint">历史模板：{variant.template} · 精确编译版本：{variant.resolvedCompilerId}</p>}
        <details className="unit-request-records"><summary>生成请求记录 · {jobs.length} 条</summary>
          {!jobs.length && <p className="empty-inline">还没有生成请求记录。</p>}
          {jobs.filter(item => !["queued", "running"].includes(item.status)).slice(0, 5).map(item => <div className="unit-request-record" key={item.id}><strong>{labels[item.status] || item.status}</strong><span className="hint">{new Date(item.createdAt).toLocaleString("zh-CN")}</span>{item.error && <p className="warning">{item.error}</p>}</div>)}
        </details>
        {unit.kind === "group" && unit.state !== "dissolved" && <button className="button secondary small warning" disabled={locked} onClick={() => void run(async () => { const result = await api<{ arrangement: number; items: NonNullable<Preview["items"]> }>("/enhancement-preview", { kind: "dissolve", ...payload }); setPreview({ ...result, kind: "dissolve", base: { revision: payload.revision, entityRevision: payload.entityRevision, arrangement: result.arrangement } }); }, "advanced")}>取消一起演绎…</button>}
        {feedback("advanced")}
      </details>
      {!enabled && !invalid && <p className="warning">此版本的新生成已关闭，历史声音与已有版本仍可查看。</p>}
    </>}
    {showHelp && <Dialog title={mode === "scene" ? "声音背景 · 操作说明" : "纯人声 · 操作说明"} onClose={() => setShowHelp(false)}>
      <div className="unit-help-content">
        <section><h3>试听与选用</h3><p>试听不改变整章使用的声音。选用已有声音用于整章试听与导出，不会重新生成或产生费用。显示“正在使用…”时，已选用，无需再次点击。</p></section>
        <section><h3>听评与生成</h3><p>检查通过只记录人工听评；标记重做保留原声音，需要你另行点击生成。授权限定本次制作范围与请求次数，不会自动发送。结果不明时先查看记录，再决定是否重试。</p></section>
        <section><h3>历史声音</h3><p>设置一致可直接使用；旧设置先核对差异，再恢复。恢复不重新生成，也不会撤销后来修改的台词、角色、参考声音或数值设置。新版生成后仍保留旧音频和历史。请求记录与可试听的历史声音分别查看。</p></section>
        {mode === "scene" ? <>
          <section><h3>背景存在感</h3><p>默认选择清楚；轻、自然、清楚会同时用于 AI 声音建议与下一次旁白、背景联合生成。已有音频保持原样。声音描述与存在感矛盾时，需要先修改描述或共同要求，不会将两种要求一同发送。首次使用且没有旧模板或场景历史时，默认使用 v4；已保存的旧模板仍保留。点“查看并切换到 v4”比较提示，再点“使用这个模板”。核对与启用免费，确认后仍须点击生成新版。实际背景效果仍需试听检查。</p></section>
          <section><h3>加入场景的声音</h3><p>AI 建议只分析，不改台词或自动制作；选中后加入场景。分析只建议新增声音，不重复建议已加入或已明确移除的声音；没有新增建议时，已有背景与共同要求保留，也可手工添加声音。需要重新使用旧建议时，打开“历史建议”，选择记录、勾选声音，再点“重新加入选中的…个声音”；曾加入后又移除的声音也可免费重新加入，不调用AI或生成音频。当前已加入的相同声音不会重复添加，原台词或位置失效会单独提示。只有“加入场景”的环境、音效和音乐用于下一次生成；暂不使用或移除后仍保留历史。位置是创作意图，生成后仍需试听检查。音乐转折需使用存在感模板，并按真实台词定位；音乐发展与音量变化分别填写，不填音量变化不会自动淡出。</p></section>
        </> : <section><h3>表演与模板</h3><p>表演要求描述怎样说，不改写台词。修改要求或模板用于下一次生成，已有音频保持原样；核对模板差异不会发送声音请求。</p></section>}
      </div>
    </Dialog>}
  </Dialog>;
}
function EventEditor({ event, unit, chapter, locked, refresh, close, created, onSaved, resumeSelection, descriptionMax=1500 }: { descriptionMax?:number; event?: SoundEvent; unit: GenerationUnit; chapter: ChapterDetail; locked: boolean; refresh: () => Promise<void>; close: () => void; created: (event: SoundEvent, warning?: string, selection?: TextSelection) => void; onSaved: (event: SoundEvent) => void; resumeSelection?: TextSelection }) {
  const [error, setError] = useState(""), [finishing, setFinishing] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (resumeSelection && text.current) { text.current.focus(); text.current.setSelectionRange(resumeSelection.start, resumeSelection.end); } }, []);
  const savedEvent = useRef<SoundEvent | undefined>(event);
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const value = { kind: event?.kind || "effect" as SoundEvent["kind"], description: event?.description || "", memberId: event?.startMemberId || event?.memberId || unit.members[0], position: event?.startPosition || event?.position || "after" as SoundEvent["position"], endMemberId: event?.endMemberId || "", endPosition: event?.endPosition || "after" as SoundEvent["position"], state: event?.state || "draft" as SoundEvent["state"], transitionEnabled:!!event?.transition, transition:event?.transition||{memberId:unit.members[0],quote:"",occurrence:1,development:"",volumeChange:""}, chapterRevision: chapter.revision, unitRevision: unit.revision };
  const controller = useObjectDraft("sound-event", event?.id || "new-" + unit.id, value, event?.revision || 0, {
    scope: "chapter:" + chapter.id, chapterRevision: chapter.revision, dependencies: ["events:" + unit.id], deferUnmounted: !event, locked,
    coupled: [["kind", "memberId", "position", "endMemberId", "endPosition", "transitionEnabled", "transition"]],
    validate: data => {
      if (!data.description.trim()) return "声音描述为空，尚未应用。";
      if(Array.from(data.description).length>descriptionMax)return `声音描述超过${descriptionMax}字符（按Unicode代码点计数），请精简后再采用；原稿仍保留。`;
      if(data.transitionEnabled){
        const anchor=data.transition,text=chapter.segments.find(segment=>segment.id===anchor.memberId)?.text||"";
        if(data.kind!=="music"||!anchor.quote||!Number.isSafeInteger(anchor.occurrence)||anchor.occurrence<1||text.split(anchor.quote).length-1<anchor.occurrence)return "音乐转折需要真实短引文及出现序号，请核对对应台词。";
        if(!anchor.development.trim()||Array.from(anchor.development).length>500||Array.from(anchor.volumeChange||"").length>200)return "请填写500字符以内的音乐发展；音量变化最多200字符，可以不填。";
      }
      if (!unit.members.includes(data.memberId) || (data.endMemberId && !unit.members.includes(data.endMemberId))) return "声音位置已变化，请重新选择台词。";
      const start = unit.members.indexOf(data.memberId) * 3 + positions.findIndex(position => position.value === data.position);
      const end = unit.members.indexOf(data.endMemberId || data.memberId) * 3 + positions.findIndex(position => position.value === data.endPosition);
      return data.kind !== "effect" && data.endMemberId && end < start ? "结束位置早于开始，请调整声音范围。" : null;
    },
    persist: async (data, expected, context) => {
      const range = data.kind !== "effect" && !!data.endMemberId;
      const { chapterRevision: _chapterRevision, unitRevision, transitionEnabled, transition, ...fields } = data;
      const existing = event || savedEvent.current;
      const saved = await saveAction<SoundEvent>(existing ? "event.update" : "event.create", { chapterId: chapter.id, revision: context.chapterRevision, unitId: unit.id, id: existing?.id, entityRevision: unitRevision, ...(existing ? { eventRevision: expected } : {}), ...fields, transition:transitionEnabled&&data.kind==='music'?transition:null, startMemberId: range ? data.memberId : "", startPosition: range ? data.position : "", endMemberId: range ? data.endMemberId : "", endPosition: range ? data.endPosition : "", evidence: existing?.evidence || { kind: "用户创作选择", reason: "手工添加声音背景" } }, context.operationId, context.replay);
      savedEvent.current = saved;
      onSaved(saved);
      return { value: { kind: saved.kind, description: saved.description, memberId: saved.startMemberId || saved.memberId, position: saved.startPosition || saved.position, endMemberId: saved.endMemberId || "", endPosition: saved.endPosition || "after", state: saved.state, transitionEnabled:!!saved.transition, transition:saved.transition||{memberId:unit.members[0],quote:"",occurrence:1,development:"",volumeChange:""}, chapterRevision: saved.chapterRevision!, unitRevision: saved.unitRevision! }, revision: saved.revision!, chapterRevision: saved.chapterRevision, ...(!event && expected === 0 ? { targetId: saved.id } : {}), changes: ["events:" + unit.id] };
    },
  });
  useEffect(() => {
    if (!event && controller.targetId && active.current) {
      const selection = document.activeElement === text.current && text.current ? { start: text.current.selectionStart, end: text.current.selectionEnd } : undefined;
      if (savedEvent.current) created(savedEvent.current, controller.error || undefined, selection);
      void refresh().catch(() => {});
    }
  }, [controller.targetId]);
  const memberOptions = unit.members.map(id => ({ value: id, label: "第 " + ((chapter.segments.find(segment => segment.id === id)?.order ?? -1) + 1) + " 句 · " + (chapter.segments.find(segment => segment.id === id)?.text.slice(0, 25) || "成员缺失") }));
  return <section className="task-inline-editor">
    <div className="section-heading"><h3>{event ? "编辑声音" : "添加声音"}</h3><button className="button secondary small" disabled={finishing || locked || controller.composing} onClick={() => { setFinishing(true); void controller.flush().then(async () => { await refresh(); close(); }).catch(failure => { if (active.current) setError(failure.message); }).finally(() => { if (active.current) setFinishing(false); }); }}>{finishing ? "正在保存…" : "完成编辑"}</button></div>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Field label="声音类型"><Select label="声音类型" value={controller.draft.kind} options={[{ value: "environment", label: "持续环境" }, { value: "effect", label: "一次音效" }, { value: "music", label: "音乐" }]} disabled={locked || controller.frozen} onChange={kind => controller.edit({ kind: kind as SoundEvent["kind"] })} /></Field>
    <Field label="声音描述" hint={`${Array.from(controller.draft.description).length} / ${descriptionMax} 字符（Unicode代码点）`}><textarea ref={text} rows={3} value={controller.draft.description} disabled={locked || controller.frozen} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event => controller.edit({ description: event.target.value })} placeholder="例如：轻敲木门两下，远处传来回声。" /></Field>
    <Field label="在哪句开始"><Select label="开始台词" value={controller.draft.memberId} options={memberOptions} disabled={locked || controller.frozen} onChange={memberId => controller.edit({ memberId })} /></Field>
    <Field label="开始时机"><Select label="开始时机" value={controller.draft.position} options={positions} disabled={locked || controller.frozen} onChange={position => controller.edit({ position: position as SoundEvent["position"] })} /></Field>
    {controller.draft.kind !== "effect" && <><Field label="持续至"><Select label="结束台词" value={controller.draft.endMemberId} options={[{ value: "", label: "同一个位置" }, ...memberOptions]} disabled={locked || controller.frozen} onChange={endMemberId => controller.edit({ endMemberId })} /></Field>{controller.draft.endMemberId && <Field label="结束时机"><Select label="结束时机" value={controller.draft.endPosition} options={positions} disabled={locked || controller.frozen} onChange={endPosition => controller.edit({ endPosition: endPosition as SoundEvent["position"] })} /></Field>}</>}
    {controller.draft.kind==='music'&&<details><summary>指定音乐转折（可选）</summary><label className="check-label"><input type="checkbox" checked={controller.draft.transitionEnabled} disabled={locked||controller.frozen} onChange={event=>controller.edit({transitionEnabled:event.target.checked})}/>加入一个明确转折</label>{controller.draft.transitionEnabled&&<>
      <Field label="转折台词"><Select label="转折台词" value={controller.draft.transition.memberId} options={memberOptions} disabled={locked||controller.frozen} onChange={memberId=>controller.edit({transition:{...controller.draft.transition,memberId}})}/></Field>
      <Field label="真实短引文"><input value={controller.draft.transition.quote} disabled={locked||controller.frozen} onChange={event=>controller.edit({transition:{...controller.draft.transition,quote:event.target.value}})} placeholder="复制对应台词中实际出现的一段"/></Field>
      <Field label="这段引文第几次出现"><input type="number" min={1} step={1} value={controller.draft.transition.occurrence} disabled={locked||controller.frozen} onChange={event=>controller.edit({transition:{...controller.draft.transition,occurrence:Number(event.target.value)}})}/></Field>
      <Field label="音乐怎样发展"><textarea rows={2} value={controller.draft.transition.development} disabled={locked||controller.frozen} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event=>controller.edit({transition:{...controller.draft.transition,development:event.target.value}})} placeholder="例如：从紧张转为宁静，旋律继续可辨"/></Field>
      <Field label="音量怎样变化（可空）"><input value={controller.draft.transition.volumeChange||''} disabled={locked||controller.frozen} onChange={event=>controller.edit({transition:{...controller.draft.transition,volumeChange:event.target.value}})} placeholder="例如：保持存在感，不淡出"/></Field>
    </>}</details>}
    <label className="check-label"><input type="checkbox" checked={controller.draft.state === "adopted"} disabled={locked || controller.frozen} onChange={event => controller.edit({ state: event.target.checked ? "adopted" : "draft" })} />加入这次场景（现在不生成声音）</label>
    {event?.validity === "needsReview" && <p className="warning">此声音位置需要复核。完成编辑后核对当前台词，再点击“位置已核对”；仅改描述不能完成复核。</p>}
    <ObjectDraftTools inline controller={controller} title="这份声音" onError={setError} render={data => <p>{data.description}</p>} />
    <button className="button secondary small" onClick={close}>返回，保留未完成编辑</button>
  </section>;
}
