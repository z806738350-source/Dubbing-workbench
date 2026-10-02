import { useRef, useState } from "react";
import { api, action } from "./api";
import { hasDraft } from "./drafts";
import { Dialog, Field, Form, Select, Status } from "./components";
import { ObjectDraftTools, objectDraftId, useObjectDraft } from "./ObjectDraft";
import SceneSuggestions from "./SceneSuggestions";
import type { ChapterDetail, GenerationUnit, Job, Role, SoundEvent, State } from "./types";

const labels: Record<string,string> = {invalid:"需修复", missing:"待生成", stale:"待更新", matched:"音频匹配", broken:"文件不可用", pending:"待检查", passed:"已通过", rework:"需返工", queued:"排队中", running:"生成中", failed:"生成失败", unknown:"结果不明", stopped:"已停止"};
const message = (conflict: unknown) => typeof conflict === "string" ? conflict : (conflict as {message?:string;reason?:string})?.message || (conflict as {reason?:string})?.reason || "成员配置不一致，请核对成员";
export function unitHasDraft(unit: GenerationUnit, events: SoundEvent[]) {
  return unit.members.some(id=>hasDraft(id)) || ["dry","scene"].some(mode=>hasDraft(objectDraftId("unit", unit.id + "/" + mode))) ||
    hasDraft(objectDraftId("sound-event", "new-" + unit.id)) || events.some(e=>e.unitId === unit.id && hasDraft(objectDraftId("sound-event", e.id)));
}
function Members({ids, chapter, roles, open}: {ids:string[];chapter:ChapterDetail;roles:Role[];open:(id:string)=>void}) {
  return <ol className="unit-member-list">{ids.map(id=>{
    const s = chapter.segments.find(s=>s.id === id);
    return <li key={id}>{s ? <><strong>第 {s.order+1} 条 · {roles.find(r=>r.id === s.roleId)?.name || "未分配"}</strong><p className="original-excerpt">{s.text}</p>
      {hasDraft(id) && <button className="text-button" onClick={()=>open(id)}>打开这条片段处理草稿</button>}</> : "成员已不存在，请核对"}</li>;
  })}</ol>;
}
export function CreateGroup({chapter, ids, roles, enabled, refresh, close, open, created}: {
  chapter:ChapterDetail;ids:string[];roles:Role[];enabled:boolean;refresh:()=>Promise<void>;close:()=>void;open:(id:string)=>void;created:(unit:GenerationUnit,warning?:string)=>void;
}) {
  const controller = useObjectDraft("unit", "new-" + chapter.id, {ids:chapter.segments.filter(s=>ids.includes(s.id)).map(s=>s.id), guidance:"",chapterRevision:chapter.revision}, 0);
  const [preview,setPreview] = useState<{conflicts:unknown[];prompt?:string} | null>(null);
  const [error,setError] = useState("");
  const run = async(fn:()=>Promise<unknown>)=>{setError("");try{await fn();}catch(e){setError((e as Error).message);}};
  return <Dialog title="创建多人干声对戏组 · 实验" onClose={close} wide>
    <p className="hint">成员须按真实章节顺序连续。建组保留现有单条编排，不产生费用；生成成功后才启用整组。组内一句修改将影响整组。</p>
    <Members ids={controller.draft.ids} chapter={chapter} roles={roles} open={open}/>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Field label="共同表演指导"><textarea rows={3} value={controller.draft.guidance} onChange={e=>{controller.edit({guidance:e.target.value});setPreview(null);}}/></Field>
    <ObjectDraftTools controller={controller} title="建组方案" onError={setError} render={v=><><Members ids={v.ids} chapter={chapter} roles={roles} open={open}/><p>{v.guidance}</p></>}/>
    {controller.base !== 0 && <p className="warning">这份建组草稿已取得创建回执，不能重复建组。原内容仍保留，请到对戏组列表核对后明确处理。</p>}
    {controller.draft.ids.some(id=>hasDraft(id)) && <p className="warning">成员有未保存的片段草稿，请通过上方入口处理后再预检。</p>}
    <button className="button secondary" disabled={!enabled} onClick={()=>void run(async()=>{
      if(controller.draft.ids.some(id=>hasDraft(id)))throw new Error("先处理成员草稿");
      setPreview(await api("/enhancement-preview", {kind:"group",chapterId:chapter.id,revision:controller.draft.chapterRevision,ids:controller.draft.ids,guidance:controller.draft.guidance}));
    })}>核对连续成员与配置冲突</button>
    {preview && <section className="inspector-section">
      {preview.conflicts?.length ? <><h3>需先处理的冲突</h3>{preview.conflicts.map((c,i)=><p className="warning" key={i}>{message(c)}</p>)}</> : <p className="hint">成员与配置预检通过。取消或关闭不改变原编排。</p>}
      {preview.prompt && <details><summary>查看实际组提示</summary><pre className="prompt-text">{preview.prompt}</pre></details>}
      <button className="button primary" disabled={!enabled || controller.saving || !!preview.conflicts?.length || controller.base !== 0} onClick={()=>void run(async()=>{
        let record: GenerationUnit | undefined;
        try { await controller.save(async(value)=>{
          const unit = await action<GenerationUnit>("unit.create", {chapterId:chapter.id,revision:value.chapterRevision,ids:value.ids,guidance:value.guidance});
          record=unit;
          return {value:{guidance:unit.variants.dry.guidance || "",ids:unit.members,chapterRevision:unit.chapterRevision!},revision:unit.revision,targetId:unit.id + "/dry"};
        }); } catch(error) {
          if(record)created(record,"组已创建，续写仍保留在建组草稿；本机移交失败，请查看原内容后明确处理。");
          throw error;
        }
        if(record)created(record);
        await refresh();
      })}>保存待生成组</button>
    </section>}
  </Dialog>;
}

type UnitPanelProps = {
  unit:GenerationUnit;chapter:ChapterDetail;roles:Role[];state:State;locked:boolean;connected:boolean;refresh:()=>Promise<void>;close:()=>void;open:(id:string)=>void;play:(id:string,title:string,historical?:boolean)=>void;
};
export default function UnitPanel(props:UnitPanelProps) {
  const [mode,setMode]=useState<"dry"|"scene">(props.unit.mode);
  return <UnitDetails key={props.unit.id + "/" + mode} {...props} mode={mode} setMode={setMode}/>;
}
function UnitDetails({unit, chapter, roles, state, locked, connected, refresh, close, open, play, mode, setMode}: UnitPanelProps & {mode:"dry"|"scene";setMode:(mode:"dry"|"scene")=>void}) {
  const controller = useObjectDraft("unit", unit.id + "/" + mode, {guidance:unit.variants[mode].guidance || "",chapterRevision:chapter.revision}, unit.revision);
  const [error,setError] = useState("");
  const [accepted,setAccepted] = useState(false);
  const [pending,setPending] = useState(false);
  const [newEvent,setNewEvent] = useState(false);
  const [editingEvent,setEditingEvent] = useState<string|null>(null);
  const [createdEvent,setCreatedEvent] = useState<SoundEvent|null>(null);
  const [preview,setPreview] = useState<{kind:"dissolve"|"restore"|"template";base:{revision:number;entityRevision:number;arrangement?:number};audioId?:string;items?:{id:string;mode:"dry";audioId:string|null;validity:string;review:string;diagnostics:string[]}[];differences?:unknown[];events?:SoundEvent[];before?:string;after?:string;to?:string} | null>(null);
  const [restoreConfirmed,setRestoreConfirmed] = useState(false);
  const command = useRef({id:crypto.randomUUID(),signature:""});
  const events = (chapter.events || []).filter(e=>e.unitId === unit.id);
  const eventFallback = createdEvent?.id === editingEvent && !events.some(e=>e.id === editingEvent) ? createdEvent : null;
  const variant = unit.variants[mode], status = variant.status;
  const currentTemplate = status.input?.template || variant.template || (unit.kind === "single" && mode === "dry" ? chapter.segments.find(s=>s.id === unit.id)?.template : "") || "";
  const templates = (state.enhancementTemplates || []).filter(t=>mode === "scene" ? t.mode === "scene" : unit.kind === "group" ? t.scope === "group" : t.scope === "single" && t.mode === "dry");
  const [targetTemplate,setTargetTemplate] = useState(currentTemplate);
  const flags = state.settings.features;
  const invalid = !!unit.diagnostics?.length;
  const enabled = !invalid && unit.state !== "dissolved" && (unit.kind !== "group" || flags?.groups !== false) && (mode !== "scene" || flags?.scenes !== false);
  const editLocked = locked || invalid || unit.state === "dissolved";
  const job = state.jobs.find(j=>["queued","running"].includes(j.status) && (j.unitId === unit.id || j.unitIds?.includes(unit.id)));
  const run = async(fn:()=>Promise<unknown>)=>{setError("");try{await fn();}catch(e){setError((e as Error).message);}};
  const payload = {chapterId:chapter.id,revision:chapter.revision,id:unit.id,entityRevision:unit.revision};
  return <Dialog title={(unit.kind === "group" ? "多人对戏组 · 实验" : "单条声音版本") + (unit.state === "dissolved" ? " · 已解除" : "")} onClose={close} wide>
    <p className="hint">{unit.state === "pending" ? "待生成组尚未启用，原编排保留。" : unit.state === "dissolved" ? "历史组保留供查看，当前编排已使用单条。" : "当前已启用"} · 当前编排使用{unit.mode === "scene" ? "场景" : "干声"}。一次生成覆盖以下全部成员，不裁切为逐句独立音频。</p>
    {invalid && <div className="error-inline" role="alert"><p>本单元需修复：{unit.diagnostics!.join("；")}</p><p>{unit.kind === "group" && unit.state !== "dissolved" ? "请先查看解除分组预览并明确解除，再处理剩余单条。" : "请先核对并修复成员资料。"}历史结果仍保留，不能用于确认当前编排。</p></div>}
    <Members ids={unit.members} chapter={chapter} roles={roles} open={open}/>
    {error && <p className="error-inline" role="alert">{error}</p>}
    {unit.kind === "single" && mode === "dry" ? <p className="hint">单条干声的表演指导在片段编辑区保存。<button className="text-button" onClick={()=>open(unit.members[0])}>打开片段表演指导</button></p> :
      <Field label={mode === "scene" ? "场景版本共同指导" : "共同表演指导"}><textarea rows={3} disabled={editLocked} value={controller.draft.guidance} onChange={e=>controller.edit({guidance:e.target.value})}/></Field>}
    <ObjectDraftTools controller={controller} title="单元表演指导" onError={setError} render={v=><p className="original-excerpt">{v.guidance}</p>}/>
    <button className="button small" disabled={editLocked || !controller.dirty || controller.saving || (unit.kind === "single" && mode === "dry")} onClick={()=>void run(async()=>{
      await controller.save(async(value,revision)=>{
        const saved = await action<GenerationUnit>("unit.update", {...payload,revision:value.chapterRevision,mode,entityRevision:revision,guidance:value.guidance});
        return {value:{guidance:saved.variants[mode].guidance || "",chapterRevision:saved.chapterRevision!},revision:saved.revision};
      });await refresh();
    })}>保存共同表演指导</button>
    <div className="tabs enhancement-mode-tabs">
      <button aria-pressed={mode === "dry"} className={mode === "dry" ? "active" : ""} onClick={()=>{setMode("dry");setAccepted(false);}}>干声版本</button>
      <button aria-pressed={mode === "scene"} className={mode === "scene" ? "active" : ""} onClick={()=>{setMode("scene");setAccepted(false);}}>场景版本 · 实验</button>
    </div>
    <section className="unit-panel">
      <Status kind={status.review === "passed" ? "success" : status.validity === "stale" ? "warning" : ""}>{labels[status.validity] || status.validity} · {labels[status.review] || status.review}</Status>
      {!!status.promptIssues?.length && <p className="error-inline">{status.promptIssues.join("；")}</p>}
      <details><summary>查看本次目标完整提示</summary><pre className="prompt-text">{status.prompt}</pre></details>
      <details><summary>有效模板 · {templates.find(t=>t.id === currentTemplate)?.name || currentTemplate || "需核对"}</summary>
        <p className="hint">普通改字或重跑沿用已保存模板。明确切换只改变这个声音版本，旧音频和旧模板记录仍保留。</p>
        <Select label="本版本提示模板" value={targetTemplate} options={[...(currentTemplate && !templates.some(t=>t.id === currentTemplate) ? [{value:currentTemplate,label:currentTemplate + " · 已保存模板"}] : []),...templates.map(t=>({value:t.id,label:t.name}))]} onChange={setTargetTemplate}/>
        <button className="button small" disabled={editLocked || !targetTemplate || targetTemplate === currentTemplate || unitHasDraft(unit,events)} onClick={()=>void run(async()=>{const result=await api<{before:string;after:string;to:string}>("/enhancement-preview",{kind:"template",...payload,mode,template:targetTemplate});setPreview({...result,kind:"template",base:{revision:payload.revision,entityRevision:payload.entityRevision}});setRestoreConfirmed(false);})}>查看模板提示差异</button>
      </details>
      <div className="button-row">
        <button className="button small" disabled={!variant.current || !connected || locked || status.validity === "broken"} onClick={()=>play(variant.current!, (unit.kind === "group" ? "整组" : "单条") + (mode === "scene" ? "场景" : "干声") + (status.validity !== "matched" ? " · 旧版" : ""),invalid || unit.state === "dissolved")}>试听{unit.state === "dissolved" ? "历史" : status.validity !== "matched" ? "旧版" : "当前"}音频</button>
        <button className="button small" disabled={editLocked || unit.mode === mode || status.validity !== "matched" || unitHasDraft(unit,events)} onClick={()=>void run(async()=>{await action("unit.switch",{...payload,mode});await refresh();})}>本地切换到{mode === "scene" ? "场景" : "干声"}</button>
        <button className="button small" disabled={editLocked || !connected || status.validity !== "matched" || unitHasDraft(unit,events)} onClick={()=>void run(async()=>{await action("unit.review",{...payload,mode,audioId:variant.current,basis:status.basis,state:"passed"});await refresh();})}>确认已试听并检查通过</button>
        <button className="text-button warning" disabled={editLocked || !connected || status.validity !== "matched"} onClick={()=>void run(async()=>{await action("unit.review",{...payload,mode,audioId:variant.current,basis:status.basis,state:"rework"});await refresh();})}>标记整单元需返工</button>
      </div>
      <div className="button-row">{([[variant.previous,"上一版"],[variant.approved,"最近通过版"]] as const).map(([id,label])=><button key={label} className="text-button" disabled={!id || editLocked} onClick={()=>void run(async()=>{
        const result=await api<{differences:unknown[]}>("/enhancement-preview",{kind:"restore",...payload,mode,audioId:id});
        setPreview({...result,kind:"restore",audioId:id!,base:{revision:payload.revision,entityRevision:payload.entityRevision}});setRestoreConfirmed(false);
      })}>查看并恢复{label}</button>)}</div>
      {!!variant.history?.length && <details><summary>本单元{mode === "scene" ? "场景" : "干声"}历史结果 · {variant.history.length} 份</summary>
        {variant.history.map((result,i)=><section className="voice-card" key={result.id}>
          <h3>结果 {i+1} · {result.selected ? "当前版本" : result.matched ? "与当前实际请求匹配" : "旧输入结果"}</h3>
          <button className="text-button" onClick={()=>play(result.id,"本单元" + (mode === "scene" ? "场景" : "干声") + "历史结果 " + (i+1),true)}>试听这份历史结果</button>
          {result.matched && !result.selected && <button className="button small" disabled={editLocked || unitHasDraft(unit,events)} onClick={()=>void run(async()=>{await action("unit.select-result",{...payload,mode,audioId:result.id});await refresh();})}>明确选用并启用，重新检查</button>}
          {result.prompt && <details><summary>查看这次实际提示</summary><pre className="prompt-text">{result.prompt}</pre></details>}
        </section>)}
      </details>}
      {!enabled && !invalid && <p className="warning">该实验的新生成已关闭，已有版本仍可查看和本地切换。</p>}
      <p className="hint">{mode === "scene" ? "只生成所选场景版本，保留已有干声，不会自动补生成干声。" : "只生成本单元干声，保留已有场景版本。"}一次请求覆盖以上 {unit.members.length} 条，产生调用费用；结果不明时重新提交可能重复计费。</p>
      {unitHasDraft(unit,events) && <p className="warning">本单元或成员有本机草稿。成员入口在上方，指导与事件草稿入口在各编辑区，请先处理后生成。</p>}
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>我已核对全部成员、表演及采用事件，确认本次费用与重复计费风险</label>
      <button className="button primary" disabled={!enabled || !state.settings.configured || locked || pending || !accepted || controller.dirty} onClick={()=>void run(async()=>{
        if(unitHasDraft(unit,events))throw new Error("先处理本单元及成员的所有草稿");
        const data={kind:"unit-generate",chapterId:chapter.id,revision:chapter.revision,unitIds:[unit.id],mode,retryUnknown:true,resumeRoute:true};
        const signature=JSON.stringify(data);
        if(command.current.signature !== signature || state.jobs.some(j=>j.commandId === command.current.id && !["queued","running"].includes(j.status)))command.current={id:crypto.randomUUID(),signature};
        setPending(true);try{await api("/jobs",{...data,commandId:command.current.id});command.current={id:crypto.randomUUID(),signature:""};setAccepted(false);await refresh();}finally{setPending(false);}
      })}>{job ? "正在生成本单元…" : mode === "scene" ? "生成场景版本并启用" : unit.kind === "group" ? unit.state === "pending" ? "生成并启用本组" : "重跑本组干声" : "生成单条干声版本"}</button>
      {job && <button className="text-button" onClick={()=>void run(async()=>{await action("job.stop",{id:job.id});await refresh();})}>停止尚未发送的生成</button>}
    </section>
    {mode === "scene" && <section className="inspector-section">
      <h3>声音事件 · 场景实验</h3><p className="hint">事件只是生成意图，不能替代正文，也不是精确时间轴。已采用但失效的事件须复核或明确移除。</p>
      <button className="button small" disabled={!enabled || locked} onClick={()=>setNewEvent(true)}>添加声音事件</button>
      <button className="text-button" onClick={()=>setNewEvent(true)}>查看新事件本机草稿</button>
      {events.map(event=><section className="voice-card" key={event.id}>
        <h3>{({environment:"环境",effect:"音效",music:"音乐"})[event.kind]} · {event.state === "removed" ? "已移除" : event.state === "adopted" ? "已采用" : "尚未采用"}{event.validity === "needsReview" ? " · 待复核" : ""}</h3>
        <p className="original-excerpt">{event.description}</p><p className="hint">对应第 {(chapter.segments.find(s=>s.id === (event.startMemberId || event.memberId))?.order ?? -1)+1} 条 · {({before:"之前",during:"期间",after:"之后"})[event.startPosition || event.position]}{event.endMemberId ? "，持续到第 " + ((chapter.segments.find(s=>s.id === event.endMemberId)?.order ?? -1)+1) + " 条" : ""} · {event.evidence.kind}</p>
        {event.evidence.quote && <p className="original-excerpt">{event.evidence.quote}</p>}{event.evidence.reason && <p className="hint">{event.evidence.reason}</p>}
        {!!event.diagnostics?.length && <p className="error-inline">{event.diagnostics.join("；")}</p>}
        <button className="text-button" onClick={()=>setEditingEvent(event.id)}>编辑 / 查看本机草稿</button>
        {event.state !== "removed" && <div className="button-row">
          {event.state === "draft" && <button className="text-button" disabled={editLocked} onClick={()=>void run(async()=>{await action("event.update",{...payload,unitId:unit.id,id:event.id,eventRevision:event.revision,state:"adopted"});await refresh();})}>明确采用此事件</button>}
          {event.validity === "needsReview" && <button className="text-button" disabled={editLocked} onClick={()=>void run(async()=>{await action("event.reconfirm",{...payload,unitId:unit.id,id:event.id,eventRevision:event.revision});await refresh();})}>已核对当前成员，重新确认</button>}
          <button className="text-button warning" disabled={editLocked} onClick={()=>void run(async()=>{await action("event.remove",{...payload,unitId:unit.id,id:event.id,eventRevision:event.revision});await refresh();})}>明确移除此事件</button>
        </div>}
      </section>)}
      <SceneSuggestions unit={unit} chapter={chapter} contextRevision={state.projects.find(p=>p.id === chapter.projectId)?.contextRevision || 0} model={state.settings.textModel} enabled={enabled && !locked} refresh={refresh}/>
    </section>}
    {unit.kind === "group" && unit.state !== "dissolved" && <button className="text-button warning" disabled={locked} onClick={()=>void run(async()=>{
      const result=await api<{arrangement:number;items:{id:string;mode:"dry";audioId:string|null;validity:string;review:string;diagnostics:string[]}[];events?:SoundEvent[]}>("/enhancement-preview",{kind:"dissolve",...payload});setPreview({...result,kind:"dissolve",base:{revision:payload.revision,entityRevision:payload.entityRevision,arrangement:result.arrangement}});
    })}>查看解除分组预览</button>}
    {preview && <Dialog title={preview.kind === "dissolve" ? "解除分组预览" : preview.kind === "template" ? "明确切换模板预览" : "恢复旧版本设置预览"} onClose={()=>setPreview(null)}>
      {preview.kind === "dissolve" ? <>
        <p className="hint">恢复原单条干声，保留历史组；缺音不会裁切或自动付费补录。</p>
        {preview.items?.map(item=><p key={item.id}>{chapter.segments.some(s=>s.id === item.id) ? "第 " + (chapter.segments.find(s=>s.id === item.id)!.order+1) + " 条" : "成员记录缺失"} · 单条干声 · {labels[item.validity] || item.validity} · {labels[item.review] || item.review}{!item.audioId ? " · 需明确补生成" : ""}{!!item.diagnostics?.length && " · " + item.diagnostics.join("；")}</p>)}
        <p className="warning">本组场景声音将退出当前编排；未恢复的缺音将阻止整章试听和正式导出。</p>
        <button className="button primary" onClick={()=>void run(async()=>{await action("unit.dissolve",{...payload,...preview.base});await refresh();setPreview(null);close();})}>确认解除分组</button>
      </> : preview.kind === "template" ? <>
        <h3>当前提示</h3><pre className="prompt-text">{preview.before}</pre><h3>目标模板提示</h3><pre className="prompt-text">{preview.after}</pre>
        <label className="check-label"><input type="checkbox" checked={restoreConfirmed} onChange={e=>setRestoreConfirmed(e.target.checked)}/>我已查看差异，明确切换这个版本的模板</label>
        <button className="button primary" disabled={!restoreConfirmed || locked} onClick={()=>void run(async()=>{await action("unit.template",{...payload,...preview.base,mode,template:preview.to,confirm:true});await refresh();setPreview(null);})}>确认本地切换模板</button>
      </> : <>
        <p className="hint">只恢复变体指导、事件和模板；不会静默撤销后来纠正的正文或角色。不能安全恢复时需手工核对。</p>
        {Array.isArray(preview.differences) ? preview.differences.map((diff,i)=><p className="warning" key={i}>{message(diff)}</p>) : preview.differences ? <p className="warning">旧版本实际输入与当前目标不同，请核对完整提示及当前成员。</p> : null}
        <label className="check-label"><input type="checkbox" checked={restoreConfirmed} onChange={e=>setRestoreConfirmed(e.target.checked)}/>我已核对旧设置及当前成员，明确恢复</label>
        <button className="button primary" disabled={!restoreConfirmed} onClick={()=>void run(async()=>{await action("unit.restore",{...payload,...preview.base,mode,audioId:preview.audioId,restoreSettings:true});await refresh();setPreview(null);})}>恢复这版设置与音频</button>
      </>}
    </Dialog>}
    {(newEvent || editingEvent) && <EventEditor key={editingEvent || "new"} event={events.find(e=>e.id === editingEvent) || eventFallback || undefined} unit={eventFallback?.unitRevision ? {...unit,revision:eventFallback.unitRevision} : unit} chapter={eventFallback?.chapterRevision ? {...chapter,revision:eventFallback.chapterRevision} : chapter} locked={editLocked} refresh={refresh} close={()=>{setEditingEvent(null);setNewEvent(false);}} created={(event,warning)=>{setCreatedEvent(event);setEditingEvent(event.id);setNewEvent(false);if(warning)setError(warning);}}/>}
  </Dialog>;
}

function EventEditor({event, unit, chapter, locked, refresh, close, created}: {event?:SoundEvent;unit:GenerationUnit;chapter:ChapterDetail;locked:boolean;refresh:()=>Promise<void>;close:()=>void;created:(event:SoundEvent,warning?:string)=>void}) {
  const value={kind:event?.kind || "effect" as SoundEvent["kind"],description:event?.description || "",memberId:event?.startMemberId || event?.memberId || unit.members[0],position:event?.startPosition || event?.position || "after" as SoundEvent["position"],
    endMemberId:event?.endMemberId || "",endPosition:event?.endPosition || "after" as SoundEvent["position"],state:event?.state || "draft" as SoundEvent["state"],chapterRevision:chapter.revision,unitRevision:unit.revision};
  const controller=useObjectDraft("sound-event",event?.id || "new-" + unit.id,value,event?.revision || 0);
  const [error,setError]=useState("");
  const memberOptions=unit.members.map(id=>({value:id,label:"第 " + ((chapter.segments.find(s=>s.id === id)?.order ?? -1)+1) + " 条 · " + chapter.segments.find(s=>s.id === id)?.text.slice(0,25)}));
  const positions=[{value:"before",label:"之前"},{value:"during",label:"期间"},{value:"after",label:"之后"}];
  const save=async()=>{
    let record: SoundEvent | undefined;
    let receiptHandled=false;
    setError("");try{
      const result=await controller.save(async(data,expected)=>{
        const range=data.kind !== "effect" && !!data.endMemberId;
        const {chapterRevision,unitRevision,...fields}=data;
        const saved=await action<SoundEvent>(event ? "event.update" : "event.create",{chapterId:chapter.id,revision:chapterRevision,unitId:unit.id,id:event?.id,entityRevision:unitRevision,...(event ? {eventRevision:expected} : {}),...fields,
          startMemberId:range ? data.memberId : "",startPosition:range ? data.position : "",endMemberId:range ? data.endMemberId : "",endPosition:range ? data.endPosition : "",
          evidence:event?.evidence || {kind:"用户创作选择",reason:"用户手工添加"}});
        if(!event)record=saved;
        return {value:{kind:saved.kind,description:saved.description,memberId:saved.startMemberId || saved.memberId,position:saved.startPosition || saved.position,endMemberId:saved.endMemberId || "",endPosition:saved.endPosition || "after",state:saved.state,chapterRevision:saved.chapterRevision!,unitRevision:saved.unitRevision!},revision:saved.revision!,...(!event ? {targetId:saved.id} : {})};
      });
      receiptHandled=true;
      if(record){if(result?.dirty)created(record);else close();}
      await refresh();
    }catch(e){if(record && !receiptHandled)created(record,"事件已创建，续写仍保留在新事件草稿；本机移交失败，请查看原内容后明确处理。");setError((e as Error).message);}
  };
  return <Dialog title={event ? "编辑声音事件" : "新声音事件"} onClose={close}>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Select label="声音事件类型" value={controller.draft.kind} options={[{value:"environment",label:"持续环境"},{value:"effect",label:"一次音效"},{value:"music",label:"音乐背景"}]} disabled={locked} onChange={v=>controller.edit({kind:v as SoundEvent["kind"]})}/>
    <Field label="声音事件描述"><textarea value={controller.draft.description} rows={3} disabled={locked} onChange={e=>controller.edit({description:e.target.value})}/></Field>
    <Select label="事件对应台词" value={controller.draft.memberId} options={memberOptions} disabled={locked} onChange={v=>controller.edit({memberId:v})}/>
    <Select label="事件开始时机" value={controller.draft.position} options={positions} disabled={locked} onChange={v=>controller.edit({position:v as SoundEvent["position"]})}/>
    {controller.draft.kind !== "effect" && <><Select label="持续背景结束台词" value={controller.draft.endMemberId} options={[{value:"",label:"同一语义锚点"},...memberOptions]} disabled={locked} onChange={v=>controller.edit({endMemberId:v})}/>
      <Select label="事件结束时机" value={controller.draft.endPosition} options={positions} disabled={locked} onChange={v=>controller.edit({endPosition:v as SoundEvent["position"]})}/></>}
    <p className="hint">不会删改上述台词，也不跨生成单元延续背景。手工新事件标为用户创作选择。</p>
    {event?.validity === "needsReview" && <p className="warning">描述修改不会完成锚点复核。请保存后回单元面板核对当前成员，再明确重新确认或移除。</p>}
    <label className="check-label"><input type="checkbox" checked={controller.draft.state === "adopted"} disabled={locked} onChange={e=>controller.edit({state:e.target.checked ? "adopted" : "draft"})}/>我已核对锚点并明确采用到场景请求</label>
    <ObjectDraftTools controller={controller} title="声音事件" onError={setError} render={v=><p className="original-excerpt">{v.description}</p>}/>
    {!event && controller.base !== 0 && <p className="warning">这份新事件草稿已取得创建回执，不能再次创建。原内容仍保留，请核对事件列表后明确处理。</p>}
    <button className="button primary" disabled={locked || controller.saving || (!controller.dirty && !!event) || (!event && controller.base !== 0)} onClick={()=>void save()}>{controller.draft.state === "adopted" ? "保存并采用声音事件" : "保存为未采用事件"}</button>
  </Dialog>;
}
