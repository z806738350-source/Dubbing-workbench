import { useEffect, useRef, useState } from "react";
import { api, action } from "./api";
import { hasDraft } from "./drafts";
import { Dialog, Field, Select, Status } from "./components";
import { ObjectDraftTools, objectDraftId, useObjectDraft } from "./ObjectDraft";
import { saveAction, withSavedDrafts, draftScopeRevision } from "./autosave";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import SceneSuggestions from "./SceneSuggestions";
import type { ChapterDetail, GenerationUnit, Job, Role, SoundEvent, State, Voice } from "./types";

const labels: Record<string, string> = { invalid: "需要修复", missing: "还没有声音", stale: "内容已修改，需要更新声音", matched: "声音已更新", broken: "声音文件不可用", pending: "尚未听评", passed: "已听评通过", rework: "需要重做", queued: "排队中", running: "生成中", failed: "生成失败", unknown: "结果不明，可能已计费", stopped: "已停止", success: "已生成" };
const message = (conflict: unknown) => typeof conflict === "string" ? conflict : (conflict as { message?: string; reason?: string })?.message || (conflict as { reason?: string })?.reason || "成员设置存在冲突，请核对";
const modeLabel = (mode: "dry" | "scene") => mode === "dry" ? "纯人声" : "场景声音";
const positions = [{ value: "before", label: "之前" }, { value: "during", label: "期间" }, { value: "after", label: "之后" }];
type TextSelection = { start: number; end: number };
const dependencies = (unit: GenerationUnit, mode: "dry" | "scene") => ["unit:" + unit.id + "/" + mode, ...unit.members.map(id => "segment:" + id), ...(mode === "scene" ? ["events:" + unit.id] : [])];

export function unitHasDraft(unit: GenerationUnit, events: SoundEvent[], mode = unit.mode) {
  return unit.members.some(id => hasDraft(id)) || hasDraft(objectDraftId("unit", unit.id + "/" + mode)) ||
    (mode === "scene" && (hasDraft(objectDraftId("sound-event", "new-" + unit.id)) || events.some(event => event.unitId === unit.id && event.state !== "removed" && hasDraft(objectDraftId("sound-event", event.id)))));
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
  const controller = useObjectDraft("unit", "new-" + chapter.id, { ids: chapter.segments.filter(segment => ids.includes(segment.id)).map(segment => segment.id), guidance: "", chapterRevision: chapter.revision }, 0, { scope: "chapter:" + chapter.id, dependencies: ["new-group:" + chapter.id] });
  const [preview, setPreview] = useState<{ conflicts: unknown[]; prompt?: string } | null>(null);
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [grantId, setGrantId] = useState<string | null>(null);
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
    setPending(true); setError("");
    let savedUnit: GenerationUnit | undefined, warning: string | undefined, opened = false;
    try {
      await withSavedDrafts("chapter:" + chapter.id, controller.draft.ids.map(id => "segment:" + id), async () => {
        if (controller.draft.ids.some(id => hasDraft(id))) throw new Error("相关台词有其他页面或遗留编辑，请先在上方处理。");
        const receipt = await controller.save(async value => {
          const operation = await submitOperation<{ unit?: GenerationUnit; job?: Job }>("group:" + chapter.id, { kind: "groupAndGenerate", chapterId: chapter.id, revision: draftScopeRevision("chapter:" + chapter.id, chapter.revision), ids: value.ids, guidance: value.guidance, mode: "dry", grantId }, state?.jobs);
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
    finally { if (active.current) setPending(false); }
  };
  const voiceIds = [...new Set(chapter.segments.filter(segment => controller.draft.ids.includes(segment.id)).flatMap(segment => segment.voiceId ? [segment.voiceId] : []))];
  return <Dialog title="一起演绎" presentation="sidepanel" onClose={close} footer={<>
    <p className="task-request-summary">这 {controller.draft.ids.length} 句一起生成 · 1 次音频请求 · 原有声音保留</p>
    <button className="button primary" disabled={!enabled || pending || controller.composing || !grantId || !!preview?.conflicts.length || controller.base !== 0 || state?.settings.configured === false || state?.settings.audioTools === false || state?.settings.routeBlocked} onClick={() => void generate()}>{pending ? "正在准备这段对话…" : "生成这段对话"}</button>
    {state?.settings.routeBlocked && <p className="warning">声音接口已暂停。请在设置与连接中核对后恢复，再生成。</p>}
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
  unit: GenerationUnit; chapter: ChapterDetail; roles: Role[]; state: State; locked: boolean; connected: boolean; initialMode?: "dry" | "scene"; initialEventId?: string;
  refresh: () => Promise<void>; close: () => void; open: (id: string) => void; play: (id: string, title: string, historical?: boolean) => void;
};
type Preview = { kind: "dissolve" | "restore" | "template"; base: { revision: number; entityRevision: number; arrangement?: number }; audioId?: string; items?: { id: string; audioId: string | null; validity: string; review: string; diagnostics: string[] }[]; differences?: unknown[]; before?: string; after?: string; to?: string };
export default function UnitPanel(props: UnitPanelProps) {
  const [mode, setMode] = useState<"dry" | "scene">(props.initialMode || props.unit.mode);
  return <UnitDetails key={props.unit.id + "/" + mode} {...props} mode={mode} setMode={setMode} />;
}
function UnitDetails({ unit, chapter, roles, state, locked, connected, refresh, close, open, play, mode, setMode, initialEventId }: UnitPanelProps & { mode: "dry" | "scene"; setMode: (mode: "dry" | "scene") => void }) {
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [grantId, setGrantId] = useState<string | null>(null);
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
  const variant = unit.variants[mode], status = variant.status;
  const singleDry = unit.kind === "single" && mode === "dry";
  const controller = useObjectDraft("unit", unit.id + "/" + mode, { guidance: variant.guidance || "", chapterRevision: chapter.revision }, unit.revision, {
    scope: "chapter:" + chapter.id, chapterRevision: chapter.revision, dependencies: ["unit:" + unit.id + "/" + mode], locked: editLocked || !!editingEvent || singleDry,
    persist: async (value, expected, context) => {
      const saved = await saveAction<GenerationUnit>("unit.update", { chapterId: chapter.id, revision: context.chapterRevision, id: unit.id, entityRevision: expected, mode, guidance: value.guidance }, context.operationId, context.replay);
      if (saved.revision >= confirmed.current.revision) confirmed.current = { revision: saved.revision, chapterRevision: saved.chapterRevision! };
      void refresh().catch(failure => { if (active.current) setError("要求已保存，界面更新失败：" + failure.message); });
      return { value: { guidance: saved.variants[mode].guidance || "", chapterRevision: saved.chapterRevision! }, revision: saved.revision, chapterRevision: saved.chapterRevision, changes: ["unit:" + unit.id + "/" + mode] };
    },
  });
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const currentTemplate = status.input?.template || variant.template || (singleDry ? chapter.segments.find(segment => segment.id === unit.id)?.template : "") || "";
  const templates = (state.enhancementTemplates || []).filter(template => mode === "scene" ? template.mode === "scene" : unit.kind === "group" ? template.scope === "group" : template.scope === "single" && template.mode === "dry");
  const [targetTemplate, setTargetTemplate] = useState(currentTemplate);
  const enabled = !invalid && unit.state !== "dissolved" && (unit.kind !== "group" || state.settings.features?.groups !== false) && (mode !== "scene" || state.settings.features?.scenes !== false);
  const jobs = state.jobs.filter(job => job.unitId === unit.id || job.unitIds?.includes(unit.id));
  const job = jobs.find(job => ["queued", "running"].includes(job.status));
  const unknown = variant.latest === "unknown";
  const payload = { chapterId: chapter.id, revision: chapter.revision, id: unit.id, entityRevision: unit.revision };
  const run = async (next: () => Promise<unknown>) => { setError(""); try { await next(); } catch (failure) { if (active.current) setError((failure as Error).message); } };
  const generate = async () => {
    setPending(true); setError("");
    const baseRevision = chapter.revision;
    try {
      await withSavedDrafts("chapter:" + chapter.id, dependencies(unit, mode), async () => {
        await controller.flush();
        if (unitHasDraft(unit, events, mode)) throw new Error("还有相关未完成编辑，请通过恢复入口处理；其他页面的编辑不会被覆盖。");
        const revision = draftScopeRevision("chapter:" + chapter.id, baseRevision);
        if (draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision) !== revision) throw new Error("这段声音在准备期间发生了变化，请核对当前内容后再生成。");
        const operation = await submitOperation("unit:" + unit.id + "/" + mode, {
          kind: mode === "scene" ? "sceneAndGenerate" : "generateSelection", chapterId: chapter.id,
          revision,
          ...(mode === "scene" ? { unitId: unit.id, entityRevision: confirmed.current.revision, eventIds: [...confirmedEvents.current.values()].filter(event => event.state === "adopted").map(event => event.id) } : { ids: unit.members, unitId: unit.id, mode, regenerate: true }),
          grantId, ...(unknown && retryUnknown ? { retryUnknown: true } : {}),
        }, state.jobs);
        if (operation.error) setError((operation.outcome === "prepared" ? "设置已保存，声音尚未生成：" : "") + operation.error);
        setRetryUnknown(false); await refresh();
      });
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setPending(false); }
  };
  const openEvent = (id: string) => void run(async () => { await controller.flush(); setEventSelection(undefined); setEditingEvent(id); });
  const eventUnit = { ...unit, revision: confirmed.current.revision }, eventChapter = { ...chapter, revision: draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision) };
  const voiceIds = [...new Set(chapter.segments.filter(segment => unit.members.includes(segment.id)).flatMap(segment => segment.voiceId ? [segment.voiceId] : []))];
  const footer = !preview && <>
    <p className="task-request-summary">{unit.kind === "group" ? "整段 " : ""}{unit.members.length} 句 · 1 次音频请求 · 保留{mode === "scene" ? "纯人声" : "场景"}与历史声音</p>
    {job ? <div role="status"><p>{labels[job.status]} · {job.done} / {job.total}</p><button className="button secondary" onClick={() => void run(async () => { await action("job.stop", { id: job.id }); await refresh(); })}>停止后续请求</button></div> : <>
      {unknown && <label className="check-label warning"><input type="checkbox" checked={retryUnknown} onChange={event => setRetryUnknown(event.target.checked)} />上次结果不明，可能已计费；明确再次发送 1 次请求。</label>}
      <button className="button primary" disabled={!enabled || !state.settings.configured || !state.settings.audioTools || locked || pending || !grantId || !!editingEvent || controller.composing || (!!unknown && !retryUnknown) || state.settings.routeBlocked} onClick={() => void generate()}>{pending ? "正在保存与准备…" : status.validity === "matched" ? "再做一版" : mode === "scene" ? "应用并生成场景" : unit.kind === "group" ? "生成这段对话" : "更新这句声音"}</button>
      {state.settings.routeBlocked && <p className="warning">声音接口已暂停，请在设置与连接中核对后恢复。</p>}
      {!state.settings.configured && <p className="warning">尚未连接声音接口，请打开设置与连接。</p>}
      {!state.settings.audioTools && <p className="warning">音频处理不可用，请打开设置与连接检查。</p>}
    </>}
  </>;
  return <Dialog title={preview ? preview.kind === "dissolve" ? "取消一起演绎" : preview.kind === "template" ? "切换提示模板" : "恢复历史声音" : mode === "scene" ? "声音背景" : unit.kind === "group" ? "一起演绎" : "这句声音"} presentation="sidepanel" onClose={close} onBack={preview ? () => setPreview(null) : undefined} footer={footer}>
    {error && <p className="error-inline" role="alert">{error}</p>}
    {preview ? <section className="task-panel-section">
      {preview.kind === "dissolve" ? <>
        <p>将恢复以下单句纯人声；对话历史保留，不裁切、不自动补生成。</p>
        {preview.items?.map(item => <p key={item.id}>第 {(chapter.segments.find(segment => segment.id === item.id)?.order ?? -1) + 1} 条 · {labels[item.validity] || item.validity} · {labels[item.review] || item.review}{!item.audioId ? " · 需要补生成" : ""}{!!item.diagnostics?.length && " · " + item.diagnostics.join("；")}</p>)}
        <p className="warning">整段场景将退出当前编排；缺少的纯人声会阻止整章试听与导出。</p>
        <button className="button primary" disabled={locked} onClick={() => void run(async () => { await action("unit.dissolve", { ...payload, ...preview.base }); await refresh(); close(); })}>确认取消一起演绎</button>
      </> : preview.kind === "template" ? <>
        <h3>当前提示</h3><pre className="prompt-text">{preview.before}</pre><h3>新模板提示</h3><pre className="prompt-text">{preview.after}</pre>
        <p>只切换此声音版本的模板，原音频与历史设置保留。</p><button className="button primary" disabled={locked} onClick={() => void run(async () => { await action("unit.template", { ...payload, ...preview.base, mode, template: preview.to, confirm: true }); await refresh(); setPreview(null); })}>使用这个模板</button>
      </> : <>
        <p>恢复这份声音与当时的表演、事件和模板；后来改正的台词与角色保持当前设置。</p>
        {Array.isArray(preview.differences) && preview.differences.map((difference, index) => <p className="warning" key={index}>{message(difference)}</p>)}
        <button className="button primary" disabled={locked} onClick={() => void run(async () => { await action("unit.restore", { ...payload, ...preview.base, mode, audioId: preview.audioId, restoreSettings: true }); await refresh(); setPreview(null); })}>恢复这份设置与声音</button>
      </>}
    </section> : <>
      <div className="task-version-summary"><strong>当前播放：{modeLabel(unit.mode)}</strong><p className="hint">{unit.state === "pending" ? "这段对话尚未生成，原单句声音仍在使用。" : unit.state === "dissolved" ? "此对话已取消，以下仅为历史记录。" : "当前编排与待制作设置分开保存。"}{mode !== unit.mode && " 下面正在编辑目标版本，当前播放声音尚未改变。"}</p></div>
      {invalid && <div className="error-inline" role="alert"><p>{unit.diagnostics!.join("；")}</p><p>历史声音仍保留。{unit.kind === "group" ? "请预览并取消一起演绎，再处理缺失成员。" : "请先修复相关台词。"}</p></div>}
      <div className="tabs enhancement-mode-tabs"><button className={mode === "dry" ? "active" : ""} aria-pressed={mode === "dry"} disabled={pending || controller.saving || !!editingEvent} onClick={() => setMode("dry")}>纯人声</button><button className={mode === "scene" ? "active" : ""} aria-pressed={mode === "scene"} disabled={pending || controller.saving || !!editingEvent} onClick={() => setMode("scene")}>声音背景</button></div>
      <section className="task-panel-section"><h3>{unit.kind === "group" ? "这段对话" : "这句台词"}</h3><Members ids={unit.members} chapter={chapter} roles={roles} voices={state.voices} open={open} /></section>
      {singleDry ? <button className="button secondary" onClick={() => open(unit.members[0])}>修改这句的文字与表演</button> : <Field label={mode === "scene" ? "希望场景怎样呈现？" : "共同表演要求"}><textarea rows={3} value={controller.draft.guidance} disabled={editLocked || pending || !!editingEvent || controller.frozen} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event => controller.edit({ guidance: event.target.value })} /></Field>}
      {!singleDry && <ObjectDraftTools inline controller={controller} title="表演要求" onError={setError} render={value => <p>{value.guidance}</p>} />}
      {mode === "scene" && <section className="task-panel-section">
        <div className="section-heading"><h3>加入这次场景的声音</h3><button className="button secondary small" disabled={!enabled || editLocked || pending || !!editingEvent} onClick={() => openEvent("new")}>添加声音</button></div>
        <p className="hint">可同时使用环境、音效和音乐；事件位置是创作意图，实际生成效果仍需试听。</p>
        {editingEvent === "new" && <EventEditor key="new" unit={eventUnit} chapter={eventChapter} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} close={() => setEditingEvent(null)} created={(event, warning, selection) => { if (active.current) { setCreatedEvent(event); setEditingEvent(event.id); setEventSelection(selection); if (warning) setError(warning); } }} />}
        {!events.length && editingEvent !== "new" && <p className="empty-inline">还没有声音背景，可添加声音或让 AI 提建议。</p>}
        {events.map(event => <section className="task-event-card" key={event.id}>
          <div className="section-heading"><h3>{({ environment: "环境", effect: "音效", music: "音乐" })[event.kind]}</h3><span>{event.state === "removed" ? "已移除" : event.validity === "needsReview" ? "位置需要复核" : event.state === "adopted" ? "加入本次场景" : "仅保存，未采用"}</span></div>
          <p>{event.description}</p><p className="hint">第 {(chapter.segments.find(segment => segment.id === (event.startMemberId || event.memberId))?.order ?? -1) + 1} 句{positions.find(position => position.value === (event.startPosition || event.position))?.label}{event.endMemberId && "，持续至第 " + ((chapter.segments.find(segment => segment.id === event.endMemberId)?.order ?? -1) + 1) + " 句"} · {event.evidence.kind}</p>
          {!!event.diagnostics?.length && <p className="warning">{event.diagnostics.join("；")}</p>}
          {editingEvent === event.id ? <EventEditor key={event.id} event={event} unit={eventUnit} chapter={eventChapter} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} resumeSelection={eventSelection} close={() => setEditingEvent(null)} created={() => {}} /> : <div className="button-row">
            <button className="text-button" disabled={!!editingEvent || pending} onClick={() => openEvent(event.id)}>编辑</button>
            {event.state !== "removed" && <><button className="text-button" disabled={editLocked || pending} onClick={() => void run(async () => { await action("event.update", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision, state: event.state === "adopted" ? "draft" : "adopted" }); await refresh(); })}>{event.state === "adopted" ? "暂不使用" : "加入场景"}</button>{event.validity === "needsReview" && <button className="text-button" disabled={editLocked} onClick={() => void run(async () => { await action("event.reconfirm", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision }); await refresh(); })}>位置已核对</button>}<button className="text-button warning" disabled={editLocked} onClick={() => void run(async () => { await action("event.remove", { ...payload, unitId: unit.id, id: event.id, eventRevision: event.revision }); await refresh(); })}>移除</button></>}
          </div>}
        </section>)}
        {createdEvent?.id === editingEvent && !events.some(event => event.id === editingEvent) && <EventEditor key={createdEvent.id} event={createdEvent} unit={eventUnit} chapter={eventChapter} locked={editLocked || pending} refresh={refresh} onSaved={rememberEvent} resumeSelection={eventSelection} close={() => setEditingEvent(null)} created={() => {}} />}
        <SceneSuggestions unit={unit} chapter={chapter} contextRevision={state.projects.find(project => project.id === chapter.projectId)?.contextRevision || 0} model={state.settings.textModel} enabled={enabled && !locked && !pending && !editingEvent} refresh={refresh} savedBase={async () => { await controller.flush(); return { revision: draftScopeRevision("chapter:" + chapter.id, confirmed.current.chapterRevision), entityRevision: confirmed.current.revision }; }} />
      </section>}
      {enabled && <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label={mode === "scene" ? "制作这份声音背景" : "制作这段声音"} steps={["unit-generate"]} model={state.settings.model} voiceIds={voiceIds} onReady={setGrantId} disabled={pending || editLocked} />}
      <section className="task-panel-section">
        <h3>试听与检查</h3><Status kind={status.review === "passed" ? "success" : status.validity === "stale" ? "warning" : ""}>{labels[status.validity] || status.validity} · {labels[status.review] || status.review}</Status>
        {!!status.promptIssues?.length && <p className="warning">{status.promptIssues.join("；")}</p>}
        <div className="button-row"><button className="button secondary" disabled={!variant.current || !connected || status.validity === "broken"} onClick={() => play(variant.current!, modeLabel(mode) + (status.validity !== "matched" ? " · 旧版" : ""), invalid || unit.state === "dissolved")}>试听{status.validity === "matched" ? "这份声音" : "旧版声音"}</button><button className="button secondary" disabled={editLocked || unit.mode === mode || status.validity !== "matched" || unitHasDraft(unit, events, mode)} onClick={() => void run(async () => { await action("unit.switch", { ...payload, mode }); await refresh(); })}>{mode === "dry" ? "切回纯人声" : "使用这份场景"}</button></div>
        {mode === "dry" && !variant.current && <p className="hint">还没有纯人声版本。切换不会生成声音；制作需要 1 次请求。</p>}
        <div className="button-row"><button className="text-button" disabled={editLocked || !connected || status.validity !== "matched" || unitHasDraft(unit, events, mode)} onClick={() => void run(async () => { await action("unit.review", { ...payload, mode, audioId: variant.current, basis: status.basis, state: "passed" }); await refresh(); })}>我已试听，检查通过</button><button className="text-button warning" disabled={editLocked || status.validity !== "matched"} onClick={() => void run(async () => { await action("unit.review", { ...payload, mode, audioId: variant.current, basis: status.basis, state: "rework" }); await refresh(); })}>标记需要重做</button></div>
      </section>
      <details className="task-panel-section"><summary>历史声音与详细设置</summary>
        {jobs.filter(item => !["queued", "running"].includes(item.status)).slice(0, 5).map(item => <div className="task-outcome" key={item.id}><strong>{labels[item.status] || item.status}</strong>{item.error && <p className="warning">{item.error}</p>}{item.resultAudioId && <button className="text-button" onClick={() => play(item.resultAudioId!, "历史生成结果", true)}>试听这次结果</button>}</div>)}
        {([[variant.previous, "上一版"], [variant.approved, "最近通过版"]] as const).map(([id, label]) => <button key={label} className="text-button" disabled={!id || editLocked} onClick={() => void run(async () => { const result = await api<{ differences: unknown[] }>("/enhancement-preview", { kind: "restore", ...payload, mode, audioId: id }); setPreview({ ...result, kind: "restore", audioId: id!, base: { revision: payload.revision, entityRevision: payload.entityRevision } }); })}>恢复{label}</button>)}
        {variant.history?.map((result, index) => <section className="task-outcome" key={result.id}><h3>声音 {index + 1} · {result.selected ? "当前使用" : result.matched ? "与当前设置一致" : "旧设置"}</h3><button className="text-button" onClick={() => play(result.id, "历史声音 " + (index + 1), true)}>试听</button>{result.matched && !result.selected && <button className="text-button" disabled={editLocked || unitHasDraft(unit, events, mode)} onClick={() => void run(async () => { await action("unit.select-result", { ...payload, mode, audioId: result.id }); await refresh(); })}>使用这份，重新检查</button>}{result.prompt && <details><summary>实际生成要求</summary><pre className="prompt-text">{result.prompt}</pre></details>}</section>)}
        <Field label="这份声音的提示模板"><Select label="提示模板" value={targetTemplate} options={[...(currentTemplate && !templates.some(template => template.id === currentTemplate) ? [{ value: currentTemplate, label: currentTemplate + " · 已保存" }] : []), ...templates.map(template => ({ value: template.id, label: template.name }))]} onChange={setTargetTemplate} /></Field>
        <button className="button secondary small" disabled={editLocked || !targetTemplate || targetTemplate === currentTemplate || unitHasDraft(unit, events, mode)} onClick={() => void run(async () => { const result = await api<{ before: string; after: string; to: string }>("/enhancement-preview", { kind: "template", ...payload, mode, template: targetTemplate }); setPreview({ ...result, kind: "template", base: { revision: payload.revision, entityRevision: payload.entityRevision } }); })}>查看模板差异</button>
        <details><summary>本次目标完整要求</summary><pre className="prompt-text">{status.prompt}</pre></details>
        {unit.kind === "group" && unit.state !== "dissolved" && <button className="text-button warning" disabled={locked} onClick={() => void run(async () => { const result = await api<{ arrangement: number; items: NonNullable<Preview["items"]> }>("/enhancement-preview", { kind: "dissolve", ...payload }); setPreview({ ...result, kind: "dissolve", base: { revision: payload.revision, entityRevision: payload.entityRevision, arrangement: result.arrangement } }); })}>取消一起演绎…</button>}
      </details>
      {!enabled && !invalid && <p className="warning">此版本的新生成已关闭，历史声音与已有版本仍可查看。</p>}
    </>}
  </Dialog>;
}
function EventEditor({ event, unit, chapter, locked, refresh, close, created, onSaved, resumeSelection }: { event?: SoundEvent; unit: GenerationUnit; chapter: ChapterDetail; locked: boolean; refresh: () => Promise<void>; close: () => void; created: (event: SoundEvent, warning?: string, selection?: TextSelection) => void; onSaved: (event: SoundEvent) => void; resumeSelection?: TextSelection }) {
  const [error, setError] = useState(""), [finishing, setFinishing] = useState(false);
  const text = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (resumeSelection && text.current) { text.current.focus(); text.current.setSelectionRange(resumeSelection.start, resumeSelection.end); } }, []);
  const savedEvent = useRef<SoundEvent | undefined>(event);
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const value = { kind: event?.kind || "effect" as SoundEvent["kind"], description: event?.description || "", memberId: event?.startMemberId || event?.memberId || unit.members[0], position: event?.startPosition || event?.position || "after" as SoundEvent["position"], endMemberId: event?.endMemberId || "", endPosition: event?.endPosition || "after" as SoundEvent["position"], state: event?.state || "draft" as SoundEvent["state"], chapterRevision: chapter.revision, unitRevision: unit.revision };
  const controller = useObjectDraft("sound-event", event?.id || "new-" + unit.id, value, event?.revision || 0, {
    scope: "chapter:" + chapter.id, chapterRevision: chapter.revision, dependencies: ["events:" + unit.id], locked,
    coupled: [["kind", "memberId", "position", "endMemberId", "endPosition"]],
    validate: data => {
      if (!data.description.trim()) return "声音描述为空，尚未应用。";
      if (!unit.members.includes(data.memberId) || (data.endMemberId && !unit.members.includes(data.endMemberId))) return "声音位置已变化，请重新选择台词。";
      const start = unit.members.indexOf(data.memberId) * 3 + positions.findIndex(position => position.value === data.position);
      const end = unit.members.indexOf(data.endMemberId || data.memberId) * 3 + positions.findIndex(position => position.value === data.endPosition);
      return data.kind !== "effect" && data.endMemberId && end < start ? "结束位置早于开始，请调整声音范围。" : null;
    },
    persist: async (data, expected, context) => {
      const range = data.kind !== "effect" && !!data.endMemberId;
      const { chapterRevision: _chapterRevision, unitRevision, ...fields } = data;
      const existing = event || savedEvent.current;
      const saved = await saveAction<SoundEvent>(existing ? "event.update" : "event.create", { chapterId: chapter.id, revision: context.chapterRevision, unitId: unit.id, id: existing?.id, entityRevision: unitRevision, ...(existing ? { eventRevision: expected } : {}), ...fields, startMemberId: range ? data.memberId : "", startPosition: range ? data.position : "", endMemberId: range ? data.endMemberId : "", endPosition: range ? data.endPosition : "", evidence: existing?.evidence || { kind: "用户创作选择", reason: "手工添加声音背景" } }, context.operationId, context.replay);
      savedEvent.current = saved;
      onSaved(saved);
      return { value: { kind: saved.kind, description: saved.description, memberId: saved.startMemberId || saved.memberId, position: saved.startPosition || saved.position, endMemberId: saved.endMemberId || "", endPosition: saved.endPosition || "after", state: saved.state, chapterRevision: saved.chapterRevision!, unitRevision: saved.unitRevision! }, revision: saved.revision!, chapterRevision: saved.chapterRevision, ...(!event && expected === 0 ? { targetId: saved.id } : {}), changes: ["events:" + unit.id] };
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
    <div className="section-heading"><h3>{event ? "编辑声音" : "添加声音"}</h3><button className="text-button" disabled={finishing || locked || controller.composing} onClick={() => { setFinishing(true); void controller.flush().then(async () => { await refresh(); close(); }).catch(failure => { if (active.current) setError(failure.message); }).finally(() => { if (active.current) setFinishing(false); }); }}>{finishing ? "正在保存…" : "完成编辑"}</button></div>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Field label="声音类型"><Select label="声音类型" value={controller.draft.kind} options={[{ value: "environment", label: "持续环境" }, { value: "effect", label: "一次音效" }, { value: "music", label: "音乐" }]} disabled={locked || controller.frozen} onChange={kind => controller.edit({ kind: kind as SoundEvent["kind"] })} /></Field>
    <Field label="声音描述"><textarea ref={text} rows={3} value={controller.draft.description} disabled={locked || controller.frozen} onCompositionStart={controller.compositionStart} onCompositionEnd={controller.compositionEnd} onChange={event => controller.edit({ description: event.target.value })} placeholder="例如：轻敲木门两下，远处传来回声。" /></Field>
    <Field label="在哪句开始"><Select label="开始台词" value={controller.draft.memberId} options={memberOptions} disabled={locked || controller.frozen} onChange={memberId => controller.edit({ memberId })} /></Field>
    <Field label="开始时机"><Select label="开始时机" value={controller.draft.position} options={positions} disabled={locked || controller.frozen} onChange={position => controller.edit({ position: position as SoundEvent["position"] })} /></Field>
    {controller.draft.kind !== "effect" && <><Field label="持续至"><Select label="结束台词" value={controller.draft.endMemberId} options={[{ value: "", label: "同一个位置" }, ...memberOptions]} disabled={locked || controller.frozen} onChange={endMemberId => controller.edit({ endMemberId })} /></Field>{controller.draft.endMemberId && <Field label="结束时机"><Select label="结束时机" value={controller.draft.endPosition} options={positions} disabled={locked || controller.frozen} onChange={endPosition => controller.edit({ endPosition: endPosition as SoundEvent["position"] })} /></Field>}</>}
    <label className="check-label"><input type="checkbox" checked={controller.draft.state === "adopted"} disabled={locked || controller.frozen} onChange={event => controller.edit({ state: event.target.checked ? "adopted" : "draft" })} />加入这次场景（现在不生成声音）</label>
    {event?.validity === "needsReview" && <p className="warning">此声音位置需要复核。完成编辑后核对当前台词，再点击“位置已核对”；仅改描述不能完成复核。</p>}
    <ObjectDraftTools inline controller={controller} title="这份声音" onError={setError} render={data => <p>{data.description}</p>} />
    <button className="text-button" onClick={close}>返回，保留未完成编辑</button>
  </section>;
}
