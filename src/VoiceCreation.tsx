import { useEffect, useRef, useState } from "react";
import { action } from "./api";
import { Field, Status } from "./components";
import { ObjectDraftTools, useObjectDraft } from "./ObjectDraft";
import { saveAction, draftScopeRevision, withSavedDrafts } from "./autosave";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import type { Job, Voice, VoiceCandidate, VoiceSession } from "./types";

const labels: Record<string, string> = { queued: "排队中", running: "生成中", success: "已生成，尚未听评", failed: "生成失败", unknown: "结果不明，可能已计费", stopped: "已停止" };
const sample = "清晨的风吹过窗边，我把桌上的书合上，准备出门。";
export type VoiceTarget = { projectId?: string; chapterId?: string; revision?: number; roleId?: string; segmentId?: string; entityRevision?: number; label?: string; apply?: boolean; scope?: "chapter" | "single" | "library"; chapterOnly?: boolean; firstDefault?: boolean; dependencies?: string[]; needsReview?: boolean };
type Selection = { start: number | null; end: number | null };
type VoiceCreationProps = {
  sessions: VoiceSession[]; voices: Voice[]; jobs: Job[]; enabled: boolean; configured: boolean; audioTools: boolean; routeBlocked: boolean;
  playingId?: string; play: (id: string, title: string) => void; refresh: () => Promise<void>; bind?: () => void;
  target?: VoiceTarget; projectId?: string; chapterId?: string; model?: string; initialSessionId?: string; onUsed?: (voiceId: string) => void | Promise<void>; onBack?: () => void;
};
export default function VoiceCreation(props: VoiceCreationProps) {
  const { sessions, target, enabled } = props;
  const contextKey = "voice-context/" + (target?.segmentId || target?.roleId || target?.chapterId || props.projectId || "library");
  const [selected, setSelected] = useState(() => props.initialSessionId || localStorage.getItem(contextKey) || "new");
  const [createdSession, setCreatedSession] = useState<VoiceSession | null>(null), [warning, setWarning] = useState("");
  const [selection, setSelection] = useState<Selection | undefined>();
  const session = sessions.find(session => session.id === selected) || (createdSession?.id === selected ? createdSession : undefined);
  const choose = (id: string) => { setSelected(id); setSelection(undefined); localStorage.setItem(contextKey, id); };
  return <section className="voice-creation">
    <div className="section-heading"><h3>{target?.label ? "为" + target.label + "创建声音" : "描述创建声音"}</h3>{props.onBack && <button className="text-button" onClick={props.onBack}>返回声音选择</button>}</div>
    <p className="task-panel-summary">描述想要的声音，生成一个候选后试听。选用时自动保存并应用到当前范围。</p>
    {!enabled && <p className="warning">声音创建已关闭，候选和历史仍可查看。</p>}
    {warning && <p className="warning" role="alert">{warning}</p>}
    <SessionEditor key={selected} {...props} session={session} draftId={selected === "new" ? "new-" + contextKey : selected} resumeSelection={selection} created={(session, warning, resume) => {
      setCreatedSession(session); setSelected(session.id); setWarning(warning || ""); setSelection(resume); localStorage.setItem(contextKey, session.id);
    }} />
    <details className="task-panel-section"><summary>其他描述与历史候选</summary>
      <button className="button secondary small" disabled={!enabled} onClick={() => choose("new")}>新建声音描述</button>
      <div className="enhancement-session-list">{sessions.map(session => <button className={"text-button " + (session.id === selected ? "selected" : "")} key={session.id} onClick={() => choose(session.id)}>{session.description.slice(0, 40) || "声音描述"} · {session.candidates.length} 份候选{session.state === "abandoned" && " · 已放弃"}</button>)}</div>
    </details>
  </section>;
}
function SessionEditor({ session, draftId, enabled, configured, audioTools, routeBlocked, voices, jobs, playingId, play, refresh, bind, target, projectId, chapterId, model, onUsed, resumeSelection, created }: VoiceCreationProps & {
  session?: VoiceSession; draftId: string; resumeSelection?: Selection; created: (session: VoiceSession, warning?: string, selection?: Selection) => void;
}) {
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [grantId, setGrantId] = useState<string | null>(null), [retryUnknown, setRetryUnknown] = useState(false), [resumeRoute,setResumeRoute]=useState(false);
  const text = useRef<HTMLTextAreaElement>(null), active = useRef(true), savedSession = useRef<VoiceSession | undefined>(session);
  useEffect(() => () => { active.current = false; }, []);
  useEffect(() => { if (resumeSelection && text.current) { text.current.focus(); text.current.setSelectionRange(resumeSelection.start || 0, resumeSelection.end || 0); } }, []);
  const draft = useObjectDraft("voice-session", draftId, { description: session?.description || "" }, session?.revision || 0, {
    scope: "voice-session:" + draftId, locked: !enabled || session?.state === "abandoned",
    validate: value => !value.description.trim() ? "请先描述想要的声音，空白内容只保留在本机。" : null,
    persist: async (value, expected, context) => {
      const existing = session || savedSession.current;
      const result = await saveAction<VoiceSession>(existing ? "voice-session.update" : "voice-session.create", existing ? { id: existing.id, entityRevision: expected, description: value.description } : { description: value.description }, context.operationId, context.replay);
      savedSession.current = { ...result, candidates: result.candidates || [] };
      return { value: { description: result.description }, revision: result.revision, ...(!session && expected === 0 ? { targetId: result.id } : {}) };
    },
  });
  useEffect(() => {
    if (!session && draft.targetId && savedSession.current && active.current) {
      const resume = document.activeElement === text.current ? { start: text.current?.selectionStart ?? null, end: text.current?.selectionEnd ?? null } : undefined;
      created(savedSession.current, draft.error || undefined, resume); void refresh().catch(() => {});
    }
  }, [draft.targetId]);
  const currentJob = session?.id ? jobs.find(job => job.sessionId === session.id && ["queued", "running"].includes(job.status)) : undefined;
  const latestJob = session?.id ? jobs.filter(job => job.sessionId === session.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] : undefined;
  const unknown = latestJob?.status === "unknown";
  const actualProject = target?.projectId || projectId, actualChapter = target?.chapterId || chapterId;
  useEffect(()=>{setResumeRoute(false);},[actualProject,actualChapter,target?.roleId,target?.segmentId,target?.scope,model,routeBlocked]);
  const generate = async () => {
    if(routeBlocked&&!resumeRoute){setError("请先核对接口权限与额度，再明确恢复本次声音请求。");return;}
    setPending(true); setError("");
    try {
      const saved = await draft.flush();
      if(!active.current)return;
      const id = session?.id || saved.targetId || savedSession.current?.id;
      if (!id || saved.dirty) throw new Error("描述仍有未保存修改，请稍后再生成。");
      const operation = await submitOperation("voice-candidate:" + id, { kind: "voiceCandidate", projectId: actualProject, ...(actualChapter ? { chapterId: actualChapter, revision: target?.revision } : {}), sessionId: id, entityRevision: saved.revision, grantId, ...(unknown && retryUnknown ? { retryUnknown: true } : {}), ...(resumeRoute?{resumeRoute:true}:{}) }, jobs);
      if (operation.error) throw new Error(operation.error);
      if (active.current) setRetryUnknown(false);
      await refresh();
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) {setResumeRoute(false);setPending(false);} }
  };
  return <>
    {error && <p className="error-inline" role="alert">{error}</p>}
    <Field label="想要怎样的声音？" hint="年龄感、声线、口音和气质是创作选择，不会更改角色事实。"><textarea ref={text} rows={4} maxLength={1800} value={draft.draft.description} disabled={!enabled || pending || draft.frozen || session?.state === "abandoned"} onCompositionStart={draft.compositionStart} onCompositionEnd={draft.compositionEnd} onChange={event => draft.edit({ description: event.target.value })} placeholder="例如：成年人的中低声线，温和清楚，略带颗粒感，吐字自然。" /></Field>
    <ObjectDraftTools inline controller={draft} title="声音描述" onError={setError} render={value => <p>{value.description}</p>} />
    <details><summary>候选使用的样文</summary><p className="original-excerpt">{session?.text || sample}</p></details>
    {session?.state !== "abandoned" && <section className="task-panel-section">
      <p className="task-request-summary">每次生成 1 个候选 · 1 次音频请求 · 历史候选保留</p>
      {actualProject ? <TaskAuthorization projectId={actualProject} chapterId={actualChapter} label={target?.label ? "为" + target.label + "创建声音候选" : "创建声音候选"} steps={["voice-create"]} model={model} onReady={setGrantId} disabled={pending || !!currentJob} /> : <p className="warning">请从当前项目的角色或台词进入声音选择，再描述创建声音，以确定授权范围。</p>}
      {unknown && <label className="check-label warning"><input type="checkbox" checked={retryUnknown} onChange={event => setRetryUnknown(event.target.checked)} />上次结果不明，可能已计费；本次明确再发送 1 次请求。</label>}
      {routeBlocked&&<label className="check-label warning"><input type="checkbox" checked={resumeRoute} disabled={pending||!!currentJob} onChange={event=>setResumeRoute(event.target.checked)}/>已核对接口权限与额度，恢复本次声音请求。</label>}
      <button className="button primary" disabled={!enabled || !configured || !audioTools || !actualProject || pending || !!currentJob || draft.composing || !grantId || target?.needsReview || (!!unknown && !retryUnknown) || (routeBlocked&&!resumeRoute)} onClick={() => void generate()}>{currentJob ? labels[currentJob.status] + "…" : pending ? "正在保存与准备…" : "生成一个候选"}</button>
      {currentJob && <button className="text-button" onClick={() => void (async () => { try { await action("job.stop", { id: currentJob.id }); await refresh(); } catch (failure) { setError((failure as Error).message); } })()}>停止后续请求</button>}
      {!configured && <p className="warning">请先打开设置与连接，配置声音接口。</p>}{!audioTools && <p className="warning">音频处理不可用，请打开设置与连接检查。</p>}{routeBlocked && <p className="warning">声音接口已暂停。核对权限与额度后，勾选上方恢复选项，再点击生成；已有授权可继续使用。</p>}
    </section>}
    <section className="task-panel-section"><h3>试听并选用</h3>
      {!session?.candidates.length && <p className="empty-inline">候选完成后出现在这里。关闭面板不会取消已发送请求，结果仍可找回。</p>}
      <div className="voice-grid">{session?.candidates.map((candidate, index) => <CandidateCard key={candidate.id} candidate={candidate} index={index} session={session} voices={voices} playingId={playingId} play={play} refresh={refresh} bind={bind} target={target} onUsed={onUsed} />)}</div>
    </section>
    {session?.state === "active" && <details><summary>描述会话管理</summary><p className="hint">放弃只停止继续使用本描述，已有声音与候选历史保留。</p><button className="text-button warning" disabled={draft.saving || pending || !!currentJob} onClick={() => void (async () => { try { await action("voice-session.abandon", { id: session.id, entityRevision: session.revision }); await refresh(); } catch (failure) { setError((failure as Error).message); } })()}>放弃这份描述</button></details>}
  </>;
}
function CandidateCard({ candidate, index, session, voices, playingId, play, refresh, bind, target, onUsed }: {
  candidate: VoiceCandidate; index: number; session: VoiceSession; voices: Voice[]; playingId?: string; play: (id: string, title: string) => void;
  refresh: () => Promise<void>; bind?: () => void; target?: VoiceTarget; onUsed?: (voiceId: string) => void | Promise<void>;
}) {
  const existing = candidate.savedVoiceId ? voices.find(voice => voice.id === candidate.savedVoiceId) : undefined;
  const [name, setName] = useState(existing?.name || (target?.label ? target.label + "的声音" : "声音候选 " + (index + 1)));
  const [error, setError] = useState(""), [pending, setPending] = useState(false), [savedVoice, setSavedVoice] = useState<Voice | undefined>(existing);
  const active = useRef(true); useEffect(() => () => { active.current = false; }, []);
  const currentTarget = useRef(target); currentTarget.current = target;
  const applying = !!(target?.segmentId || target?.roleId);
  const use = async () => {
    setPending(true); setError("");
    try {
      const next = async () => {
        if(!active.current)throw new Error("声音选用已取消，原候选与编辑仍保留。");
        if (applying && (currentTarget.current?.needsReview || JSON.stringify(currentTarget.current) !== JSON.stringify(target))) throw new Error("应用范围已变化，请重新核对后选用声音。");
        return submitOperation<{ voice?: Voice; target?: unknown }>("use-voice:" + candidate.id + "/" + (target?.segmentId || target?.roleId || "library"), {
          kind: "useVoice", ...(applying ? { chapterId: target?.chapterId, revision: draftScopeRevision("chapter:" + target!.chapterId, target!.revision!), roleId: target?.roleId, segmentId: target?.segmentId, entityRevision: target?.entityRevision, apply: target?.segmentId ? true : target?.apply !== false, chapterOnly: target?.chapterOnly !== false } : { scope: "library" }),
          ...(savedVoice?.id || existing?.id ? { voiceId: savedVoice?.id || existing?.id } : { audioId: candidate.audioId, name }),
        });
      };
      const operation = applying ? await withSavedDrafts("chapter:" + target!.chapterId, target?.dependencies || ["segment:" + target?.segmentId, "role:" + target?.roleId], next) : await next();
      const voice = operation.result?.voice;
      if (active.current && voice) setSavedVoice(voice);
      await refresh();
      if (operation.error) throw new Error((voice ? "声音已保存，尚未应用。" : "") + operation.error);
      if (applying && voice && active.current) await onUsed?.(voice.id);
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { if (active.current) setPending(false); }
  };
  return <section className="voice-card task-candidate-card">
    <div className="section-heading"><h3>候选 {index + 1}</h3><Status kind={candidate.status === "success" ? "success" : ["unknown", "failed"].includes(candidate.status) ? "warning" : ""}>{labels[candidate.status] || candidate.status}</Status></div>
    {candidate.discarded && <p className="hint">已放弃，历史保留。</p>}{candidate.late && <p className="hint">这是旧描述生成的结果，请试听比较后选用。</p>}
    {candidate.audioId && <button className="button secondary" onClick={() => play(candidate.audioId!, "声音候选 " + (index + 1))}>{playingId === candidate.audioId ? "暂停候选" : "试听候选"}</button>}
    {candidate.error && <p className="error-inline">{candidate.error}</p>}{error && <p className="error-inline" role="alert">{error}</p>}
    {candidate.status === "success" && candidate.referenceEligible === false && <p className="warning">候选不符合参考素材要求，可以试听；选用前需要明确生成较短候选。</p>}
    {(savedVoice || existing) && <p className="hint">已保存：{(savedVoice || existing)?.name}。{applying ? "仅在应用成功后改变目标声音。" : "可从声音选择器复用。"}</p>}
    {!candidate.discarded && candidate.audioId && candidate.status === "success" && candidate.referenceEligible !== false && <>
      {!savedVoice && !existing && <Field label="声音名称"><input maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field>}
      <p className="hint">{applying ? "用于" + (target?.label || (target?.segmentId ? "当前这句" : "当前角色")) + (target?.segmentId ? "，只改这句。" : target?.apply === false ? "，保存为角色默认声音；已有台词保持当前选择。" : "；只更新本章沿用角色声音的台词，单句指定保持不变。" + (target?.firstDefault ? "首次绑定也作为未来新片段的角色默认。" : "")) : "保存到我的声音，不产生模型费用。"}</p>
      {(applying || (!savedVoice && !existing)) && <button className="button primary" disabled={pending || target?.needsReview || (!name.trim() && !savedVoice && !existing)} onClick={() => void use()}>{pending ? "正在保存与应用…" : applying ? "用这个声音" : "保存到我的声音"}</button>}
      {!applying && (savedVoice || existing) && bind && <button className="text-button" onClick={bind}>返回角色声音选择</button>}
    </>}
    <details><summary>生成依据与历史操作</summary>{candidate.input?.description && <p>{candidate.input.description}</p>}{candidate.prompt && <pre className="prompt-text">{candidate.prompt}</pre>}{!candidate.discarded && !candidate.savedVoiceId && !savedVoice && <button className="text-button warning" onClick={() => void (async () => { try { await action("voice-candidate.discard", { id: candidate.id, sessionId: session.id, entityRevision: session.revision }); await refresh(); } catch (failure) { setError((failure as Error).message); } })()}>放弃此候选</button>}</details>
  </section>;
}
