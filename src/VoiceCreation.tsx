import { useRef, useState } from "react";
import { api, action } from "./api";
import { hasDraft } from "./drafts";
import { Field, Form, Status } from "./components";
import { ObjectDraftTools, objectDraftId, useObjectDraft } from "./ObjectDraft";
import type { Job, Voice, VoiceSession } from "./types";

const labels: Record<string, string> = {queued:"排队中", running:"生成中", success:"已生成 · 待验证", failed:"生成失败", unknown:"结果不明 · 可能已计费", stopped:"未提交已停止"};
const sample = "清晨的风吹过窗边，我把桌上的书合上，准备出门。";
export default function VoiceCreation({sessions, voices, jobs, enabled, configured, audioTools, routeBlocked, playingId, play, refresh, bind}: {
  sessions: VoiceSession[]; voices: Voice[]; jobs: Job[]; enabled: boolean; configured: boolean; audioTools: boolean;
  routeBlocked: boolean; playingId?: string; play: (id:string, title:string)=>void; refresh:()=>Promise<void>; bind?:()=>void;
}) {
  const [selected, setSelected] = useState(sessions[0]?.id || "new");
  const [createdSession,setCreatedSession] = useState<VoiceSession|null>(null);
  const [creationWarning,setCreationWarning] = useState("");
  const session = sessions.find(s => s.id === selected) || (createdSession?.id === selected ? createdSession : undefined);
  return <section className="voice-creation">
    <div className="section-heading"><h3>描述声音</h3><button className="button small" disabled={!enabled} onClick={()=>setSelected("new")}>新建声音描述</button></div>
    <p className="hint">生成一份短候选，试听后命名保存为参考音色。声音设计不会修改角色事实；跨句复用仍需听辨。</p>
    {creationWarning && <p className="warning" role="alert">{creationWarning}</p>}
    {!enabled && <p className="warning">声音创建已关闭，已有会话、候选和音色仍可查看。</p>}
    <div className="enhancement-session-list" aria-label="声音描述会话">
      {sessions.map(s => <button className={"text-button " + (s.id === selected ? "selected" : "")} key={s.id} onClick={()=>setSelected(s.id)}>{s.description.slice(0, 32)}{s.state === "abandoned" ? " · 已放弃" : ""} · {s.candidates.length} 份候选</button>)}
    </div>
    {(session || selected === "new") && <SessionEditor key={selected} session={session} enabled={enabled} configured={configured} audioTools={audioTools}
      routeBlocked={routeBlocked} voices={voices} jobs={jobs} playingId={playingId} play={play} refresh={refresh} bind={bind} created={(s,warning)=>{setCreatedSession(s);setSelected(s.id);setCreationWarning(warning || "");}}/>}
  </section>;
}

function SessionEditor({session, enabled, configured, audioTools, routeBlocked, voices, jobs, playingId, play, refresh, bind, created}: {
  session?:VoiceSession; enabled:boolean; configured:boolean; audioTools:boolean; routeBlocked:boolean; voices:Voice[]; jobs:Job[];
  playingId?:string; play:(id:string,title:string)=>void; refresh:()=>Promise<void>; bind?:()=>void; created:(session:VoiceSession,warning?:string)=>void;
}) {
  const draft = useObjectDraft("voice-session", session?.id || "new", {description:session?.description || ""}, session?.revision || 0);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const command = useRef({id:crypto.randomUUID(), signature:""});
  const [pending, setPending] = useState(false);
  const currentJob = jobs.find(j => j.sessionId === session?.id && ["queued", "running"].includes(j.status));
  const run = async (fn:()=>Promise<unknown>) => { setError(""); try { await fn(); } catch(e) { setError((e as Error).message); } };
  const save = () => run(async () => {
    let createdRecord: VoiceSession | undefined;
    try { await draft.save(async (value, revision) => {
      const result = await action<VoiceSession>(session ? "voice-session.update" : "voice-session.create", session ?
        {id:session.id, entityRevision:revision, description:value.description} : {description:value.description});
      if(!session)createdRecord={...result,candidates:result.candidates || []};
      return {value:{description:result.description}, revision:result.revision,...(!session ? {targetId:result.id} : {})};
    }); } catch(error) {
      if(createdRecord)created(createdRecord,"会话已创建，续写仍保留在新建声音草稿；本机移交失败，请查看原内容后明确处理。");
      throw error;
    }
    if (createdRecord) created(createdRecord);
    await refresh();
  });
  const generate = () => run(async () => {
    if (!session) throw new Error("请先保存声音描述");
    if (hasDraft(objectDraftId("voice-session", session.id))) throw new Error("声音描述有本机草稿，请在下方查看并保存或放弃后生成");
    if (!accepted) throw new Error("请先确认本次生成费用及结果不明的重复计费风险");
    setPending(true);
    try {
      const payload = {kind:"voice-create", sessionId:session.id, entityRevision:session.revision, retryUnknown:true, resumeRoute:true};
      const signature = JSON.stringify(payload);
      if (command.current.signature !== signature || jobs.some(j=>j.commandId === command.current.id && !["queued","running"].includes(j.status)))
        command.current = {id:crypto.randomUUID(), signature};
      await api("/jobs", {...payload, commandId:command.current.id});
      command.current = {id:crypto.randomUUID(), signature:""}; setAccepted(false); await refresh();
    } finally { setPending(false); }
  });
  return <>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Field label="声音描述" hint="年龄感、声线、口音和气质；这些是创作选择，不是角色事实。">
      <textarea rows={4} maxLength={1800} value={draft.draft.description} disabled={!enabled || session?.state === "abandoned"}
        onChange={e=>draft.edit({description:e.target.value})} placeholder="例如：成年人的中低声线，温和清楚，略带颗粒感，吐字自然。"/>
    </Field>
    <p className="hint">固定样文</p><p className="original-excerpt">{session?.text || sample}</p>
    <ObjectDraftTools controller={draft} title="声音描述" onError={setError} render={value=><p className="original-excerpt">{value.description}</p>}/>
    {!session && draft.base !== 0 && <p className="warning">这份新建草稿已取得创建回执，不能再次创建。请核对会话列表与保留的原内容后明确处理。</p>}
    {draft.base !== (session?.revision || 0) && <p className="warning">保存基准与当前显示资料不同，原草稿仍保留。请核对后处理。</p>}
    <div className="button-row">
      <button className="button small" disabled={draft.saving || !enabled || session?.state === "abandoned" || (!draft.dirty && !!session) || (!session && draft.base !== 0)} onClick={()=>void save()}>{draft.saving ? "保存中…" : session ? "保存描述" : "保存声音描述"}</button>
      {session?.state === "active" && <button className="text-button warning" disabled={draft.saving} onClick={()=>void run(async()=>{
        await action("voice-session.abandon", {id:session.id, entityRevision:session.revision}); await refresh();
      })}>放弃会话</button>}
    </div>
    {session?.state === "active" && <section className="inspector-section">
      {!configured && <p className="warning">请先在设置与连接配置配音接口。</p>}
      {!audioTools && <p className="warning">请先配置音频处理程序。</p>}
      <p className="hint">每次仅生成一份候选，产生一次调用费用。结果不明时再次生成可能重复计费。{routeBlocked ? "本次确认会重新启用已暂停的音频接口。" : ""}</p>
      <label className="check-label"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>我已核对描述和样文，确认本次付费生成及重复计费风险</label>
      <button className="button primary" disabled={!enabled || !configured || !audioTools || pending || !!currentJob || draft.dirty || !accepted} onClick={()=>void generate()}>{currentJob ? "正在生成候选…" : "生成一份声音候选"}</button>
      {currentJob && <button className="text-button" onClick={()=>void run(async()=>{await action("job.stop", {id:currentJob.id}); await refresh();})}>停止尚未发送的生成</button>}
    </section>}
    <h3>候选历史</h3>
    {!session?.candidates.length && <p className="hint">生成后可在这里试听、比较、保存；关闭页面不会丢失任务结果。</p>}
    <div className="voice-grid">
      {session?.candidates.map((candidate, index) => <section className="voice-card" key={candidate.id}>
        <h3>候选 {index + 1}{candidate.discarded ? " · 已放弃，历史保留" : candidate.late ? " · 旧描述结果，历史保留" : ""}</h3><Status kind={candidate.status === "success" ? "success" : ["unknown","failed"].includes(candidate.status) ? "warning" : ""}>{labels[candidate.status] || candidate.status}</Status>
        {candidate.input?.description && <p className="hint">本次实际声音描述：{candidate.input.description}</p>}
        {candidate.error && <p className="error-inline">{candidate.error}</p>}
        {candidate.audioId && <button className="button small" onClick={()=>play(candidate.audioId!, "声音候选 " + (index + 1))}>{playingId === candidate.audioId ? "暂停候选" : "试听候选"}</button>}
        {candidate.status === "success" && candidate.referenceEligible === false && <p className="warning">候选不符合参考素材的时长或大小要求，保留供试听，不能直接入库。请明确重新生成较短候选。</p>}
        {candidate.savedVoiceId ? <><p>已入库：{voices.find(v=>v.id === candidate.savedVoiceId)?.name || "参考音色"}</p>{bind && <button className="text-button" onClick={bind}>到角色档案绑定</button>}</> :
          !candidate.discarded && candidate.audioId && candidate.status === "success" && candidate.referenceEligible !== false && <Form label="保存此候选到音色库" onSubmit={async f=>{
            await api("/voices/candidate", {audioId:candidate.audioId, name:f.get("name")}); await refresh();
          }}><Field label={"候选 " + (index + 1) + " 的音色名称"}><input name="name" maxLength={100} placeholder="例如：温和旁白"/></Field><p className="hint">保存不产生模型费用，也不会自动绑定角色。</p></Form>}
        {!candidate.discarded && !candidate.savedVoiceId && <button className="text-button warning" onClick={()=>void run(async()=>{
          await action("voice-candidate.discard",{id:candidate.id,sessionId:session.id,entityRevision:session.revision});await refresh();
        })}>放弃此候选</button>}
        {candidate.prompt && <details><summary>查看本次实际提示</summary><pre className="prompt-text">{candidate.prompt}</pre></details>}
      </section>)}
    </div>
  </>;
}
