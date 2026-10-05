import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, ImagePlus, MessageSquare, Plus, Settings2, X } from 'lucide-react';
import { api } from './api';
import { readDraft, writeDraft, clearDraft, draftWorkspace } from './drafts';
import { Dialog, Field, Select } from './components';
import type { State } from './types';
import { attachmentURL, assistantLabel, assistantPreviewRows, assistantState, assistantTerminal, checkAssistantFiles, newAssistantDraft } from './assistantClient';
import type { Attachment, AssistantConfig, AssistantDetail, AssistantDraft, AssistantRun, Session, UIAction } from './assistantClient';

type Props = {state:State;projectId:string;chapterId:string;selectedSegmentIds:string[];selectedUnitId?:string;pane:string;draftStatus?:string;connected:boolean;initialPrompt?:{id:string;text:string};onClose:()=>void;onNavigate:(binding:{projectId:string|null;chapterId:string|null})=>void;onUIAction:(action:UIAction)=>Promise<void>;withSavedScope:(binding:{projectId:string|null;chapterId:string|null},work:()=>Promise<void>)=>Promise<void>;refresh:()=>Promise<unknown>};
const messageError = (error:unknown) => error instanceof Error ? error.message : '操作未完成，请保留输入后再试';
const draftKey = (id:string) => 'assistant:'+id;
const storedDraft = (id:string,workspace:string) => readDraft<AssistantDraft>(draftKey(id),workspace)?.draft || newAssistantDraft();

export default function AssistantPanel(props:Props) {
  const {state,projectId,chapterId,connected}=props;
  const workspace = state.settings.workspaceIdentity || draftWorkspace();
  const [detail,setDetail]=useState<AssistantDetail|null>(null), [sessions,setSessions]=useState<Session[]>([]), [config,setConfig]=useState<AssistantConfig|null>(null);
  const [draft,setDraft]=useState<AssistantDraft>(newAssistantDraft), [settings,setSettings]=useState(false), [busy,setBusy]=useState(false), [uploading,setUploading]=useState(false), [error,setError]=useState(''), [loading,setLoading]=useState(true), [zoom,setZoom]=useState<Attachment|null>(null), [newMessages,setNewMessages]=useState(false), [stopAudio,setStopAudio]=useState(false);
  const [deleting,setDeleting]=useState<AssistantDetail|null>(null);
  const current=useRef<string|null>(null), mounted=useRef(true), switching=useRef(0), sending=useRef(false), uploadingRef=useRef(false), draftRef=useRef(draft), scroll=useRef<HTMLDivElement>(null), follow=useRef(true), input=useRef<HTMLTextAreaElement>(null), files=useRef<HTMLInputElement>(null), handledPrompt=useRef('');
  const revisions=useRef(new Map<string,number>()),deleted=useRef(new Set<string>());
  draftRef.current=draft;
  const resolve=(value:string)=>state.projects.find(p=>p.id===value)?.name || state.chapters.find(c=>c.id===value)?.title || state.voices.find(v=>v.id===value)?.name || state.roles.find(r=>r.id===value)?.name || assistantLabel(value);
  const updateDraft=(next:AssistantDraft,id=current.current)=>{
    if(!id||deleted.current.has(id))return;
    writeDraft(draftKey(id),next,1,workspace);
    if(mounted.current&&current.current===id){draftRef.current=next;setDraft(next);}
  };
  const apply=(next:AssistantDetail)=>{
    if(!mounted.current||current.current!==next.session.id)return;
    if(next.session.revision<(revisions.current.get(next.session.id)||0))return;
    revisions.current.set(next.session.id,next.session.revision);
    setDetail(next);
    if(next.session.contentDeletion){deleted.current.add(next.session.id);clearDraft(draftKey(next.session.id),undefined,false,workspace);draftRef.current=newAssistantDraft();setDraft(draftRef.current);return;}
    const held=storedDraft(next.session.id,workspace);
    if(held.pending && next.messages.some(m=>m.id===held.pending?.messageId)) updateDraft({...held,text:'',attachments:[],pending:undefined},next.session.id);
  };
  const list=async()=>{const rows=await api<Session[]>('/assistant/sessions');if(mounted.current)setSessions(rows);return rows;};
  const open=async(id:string)=>{
    const turn=++switching.current; current.current=id;setLoading(true);setError('');setDetail(null);setDraft(storedDraft(id,workspace));follow.current=true;
    writeDraft('assistant-current',{id},1,workspace);
    try{const next=await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(id));if(mounted.current&&turn===switching.current)apply(next);}
    catch(e){if(mounted.current&&turn===switching.current)setError(messageError(e));}
    finally{if(mounted.current&&turn===switching.current)setLoading(false);}
  };
  const create=async()=>{
    if(sending.current||!connected)return;
    sending.current=true;setBusy(true);setError('');
    try{const next=await api<AssistantDetail>('/assistant/sessions',{projectId:projectId||null,chapterId:chapterId||null});await list();if(mounted.current)await open(next.session.id);}
    catch(e){if(mounted.current)setError(messageError(e));}
    finally{sending.current=false;if(mounted.current)setBusy(false);}
  };
  useEffect(()=>{
    mounted.current=true;
    revisions.current.clear();deleted.current.clear();
    void Promise.all([api<AssistantConfig>('/assistant/config'),api<Session[]>('/assistant/sessions')]).then(async([settings,rows])=>{
      if(!mounted.current)return;setConfig(settings);setSessions(rows);
      const remembered=readDraft<{id:string}>('assistant-current',workspace)?.draft.id;
      const id=rows.find(s=>s.id===remembered)?.id || rows.find(s=>s.projectId===projectId&&s.chapterId===chapterId)?.id;
      if(id)await open(id);else setLoading(false);
    }).catch(e=>{if(mounted.current){setError(messageError(e));setLoading(false);}});
    return()=>{mounted.current=false;switching.current++;};
  },[workspace]);
  useEffect(()=>{
    if(!detail||!connected)return;
    let live=true,pending=false;
    const poll=async()=>{if(pending)return;pending=true;try{const next=await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(detail.session.id));if(live)apply(next);}catch(e){if(live)setError(messageError(e));}finally{pending=false;}};
    const timer=window.setInterval(()=>void poll(),1800);
    return()=>{live=false;window.clearInterval(timer);};
  },[detail?.session.id,connected]);
  useEffect(()=>{
    if(!props.initialPrompt||!detail||handledPrompt.current===props.initialPrompt.id)return;
    handledPrompt.current=props.initialPrompt.id;
    if(!draftRef.current.text&&!draftRef.current.pending)updateDraft({...draftRef.current,text:props.initialPrompt.text});
  },[props.initialPrompt,detail?.session.id]);
  const messageStamp=detail?.messages.map(m=>m.id).join(',');
  useEffect(()=>{const el=scroll.current;if(!el)return;if(follow.current){el.scrollTop=el.scrollHeight;setNewMessages(false);}else setNewMessages(true);},[messageStamp,detail?.steps.length]);
  const run=detail?.runs.find(r=>!assistantTerminal(r.state));
  const runnable=!run||run.state==='awaitingUser';
  const writable=detail?.session.state==='active';
  const needsListening=(id:string)=>!!detail?.steps.some(s=>s.runId===id&&s.state==='proposed'&&['segment.review','unit.review'].includes(s.capabilityId)&&s.input?.state==='passed');
  const changesReading=(id:string)=>!!detail?.steps.some(s=>s.runId===id&&s.state==='proposed'&&s.preview?.effects?.readingRange);
  const sameChapter=detail?.session.chapterId=== (chapterId||null) && detail?.session.projectId===(projectId||null);
  const perform=async(work:()=>Promise<void>)=>{if(sending.current||!connected)return;sending.current=true;setBusy(true);setError('');try{await work();}catch(e){if(mounted.current)setError(messageError(e));}finally{sending.current=false;if(mounted.current)setBusy(false);}};
  const confirmDelete=(id:string)=>void perform(async()=>{const selected=await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(id));if(mounted.current)setDeleting(selected);});
  const removeContent=()=>void perform(async()=>{
    const selected=deleting?.session;if(!selected)return;
    const next=await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(selected.id)+'/content-delete',{sessionId:selected.id,revision:selected.revision,confirmed:true});
    deleted.current.add(selected.id);revisions.current.set(selected.id,next.session.revision);
    clearDraft(draftKey(selected.id),undefined,false,workspace);
    if(mounted.current){setDeleting(null);setZoom(held=>held?.sessionId===selected.id?null:held);if(current.current===selected.id){setDraft(newAssistantDraft());draftRef.current=newAssistantDraft();apply(next);}}
    await list();
  });
  const send=()=>void perform(async()=>{
    const bound=detail?.session;if(!bound||!writable||!runnable||uploadingRef.current)return;
    let submitted=draftRef.current.pending;
    if(!submitted){
      const d=draftRef.current;if(!d.text.trim()&&!d.attachments.length)return;
      if(d.attachments.length&&!config?.vision)throw Error('发送截图前，请在连接设置中启用图片输入');
      if(d.voicePolicy==='chooseFromApprovedSet'&&!d.allowedVoiceIds.length)throw Error('请先选择允许助手使用的音色');
      submitted={messageId:crypto.randomUUID(),text:d.text,attachmentIds:d.attachments.map(a=>a.id),view:{page:'chapter',pane:props.pane,draftStatus:d.mode==='task'?'saved':props.draftStatus||'saved',selectedSegmentIds:props.selectedSegmentIds,selectedUnitId:props.selectedUnitId},approved:true,mode:d.mode,workflowKinds:d.workflowKinds||['dry'],stepLimit:d.stepLimit||40,completionTarget:d.completionTarget||'requested-actions',limits:d.mode==='task'?d.limits:{assistant:3,analysis:0,audio:0},voicePolicy:d.voicePolicy,allowedVoiceIds:d.allowedVoiceIds,materials:[...new Set([...d.materials,...(d.attachments.length?['image']:[])])],textMutationPolicy:d.textMutationPolicy};
      updateDraft({...d,pending:submitted},bound.id);
    }
    const command=submitted;let sent=false;
    const work=async()=>{sent=true;const next=await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(bound.id)+'/messages',command);apply(next);};
    try{if(command.mode==='task')await props.withSavedScope(bound,work);else await work();}
    catch(e){if(!sent || (e as {notApplied?:boolean;status?:number}).notApplied || [400,403,409,413].includes((e as {status?:number}).status||0)){const held=storedDraft(bound.id,workspace);updateDraft({...held,pending:undefined},bound.id);}throw e;}
  });
  const decide=(r:AssistantRun,accepted:boolean)=>void perform(async()=>{
    const work=async()=>{const next=await api<AssistantDetail>('/assistant/runs/'+encodeURIComponent(r.id)+'/decision',{decisionId:`${r.id}:${r.revision}:${accepted?'yes':'no'}`,revision:r.revision,accepted});apply(next);await props.refresh();};
    if(accepted)await props.withSavedScope(r.binding,work);else await work();
  });
  const control=(r:AssistantRun,action:'pause'|'resume'|'stop')=>void perform(async()=>{
    const work=async()=>{apply(await api<AssistantDetail>('/assistant/runs/'+encodeURIComponent(r.id)+'/control',{action,revision:r.revision,...(action==='stop'?{stopAudio}:{})}));await props.refresh();};
    if(action==='resume')await props.withSavedScope(r.binding,work);else await work();
  });
  const upload=async(selected:File[])=>{
    const id=current.current;if(!id||!selected.length||uploadingRef.current||draftRef.current.pending||!connected)return;
    uploadingRef.current=true;setUploading(true);setError('');
    try{checkAssistantFiles(selected,draftRef.current.attachments);for(const file of selected){
      const bitmap=await createImageBitmap(file);const valid=bitmap.width*bitmap.height<=16000000;bitmap.close();if(!valid)throw Error('图片超过 1600 万像素，请先裁剪');
      const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(Error('截图未读取完成，请重选'));reader.readAsDataURL(file);});
      const attachment=await api<Attachment>('/assistant/attachments',{sessionId:id,mime:file.type,dataBase64:data});
      const held=storedDraft(id,workspace);checkAssistantFiles([],[...held.attachments,attachment]);updateDraft({...held,attachments:[...held.attachments,attachment]},id);
    }}catch(e){if(mounted.current&&current.current===id)setError(messageError(e));}
    finally{uploadingRef.current=false;if(mounted.current)setUploading(false);}
  };
  return <section className="assistant-panel" aria-label="AI 助手">
    <header className="assistant-heading"><div><MessageSquare size={18}/><strong>AI 助手</strong></div><div className="button-row"><button className="icon" aria-label="关闭 AI 助手" onClick={props.onClose}><X size={18}/></button></div></header>
    <div className="assistant-binding"><div className="assistant-session-row"><Select label="助手会话" value={detail?.session.id||''} disabled={!connected||busy} onChange={id=>void open(id)} options={sessions.map(s=>({value:s.id,label:s.title+' · '+(s.chapterId?resolve(s.chapterId):'工作区')+(s.state!=='active'?'（已归档）':'')}))}/><button className="icon" aria-label="在当前章节新建对话" disabled={!connected||busy} onClick={()=>void create()}><Plus size={18}/></button><button className="icon" aria-label="助手连接设置" onClick={()=>setSettings(true)}><Settings2 size={17}/></button></div>
      {detail&&<><p>任务绑定：<strong>{detail.session.projectId?resolve(detail.session.projectId):'工作区'}{detail.session.chapterId?' / '+resolve(detail.session.chapterId):''}</strong></p>{!sameChapter&&<button className="text-button" onClick={()=>props.onNavigate(detail.session)}>回到任务章节</button>}</>}
      {props.draftStatus&&props.draftStatus!=='saved'&&<p className="hint">当前编辑内容尚未保存。问答只读取已保存版本；执行前会先保存相关内容。</p>}
    </div>
    {error&&<div className="assistant-error" role="alert">{error}<button className="text-button" onClick={()=>setError('')}>收起</button></div>}
    {!connected&&<p className="warning" role="status">工作区连接中断，输入已保留。</p>}
    <div className="assistant-conversation" ref={scroll} onScroll={()=>{const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}} aria-busy={loading}>
      {loading?<p role="status">正在读取对话…</p>:!detail?<div className="assistant-empty"><MessageSquare size={28}/><h3>想先做什么？</h3><p>问操作、看截图，或把一章交给助手安排。制作前会先给你任务卡。</p><button className="button primary" disabled={!connected||busy} onClick={()=>void create()}>在当前章节开始</button></div>:<>
        {detail.session.state!=='active'&&<p className="hint" role="status">{detail.session.contentDeletion?'对话内容已永久删除，保留执行账本。':'此会话已归档，聊天、截图和执行记录可只读查看。'}{detail.runs.some(r=>r.reconciliation?.assistantRequest||r.reconciliation?.steps.length)?'仍有结果未确认的请求；归档或删除没有撤销已提交的生成和费用。':''}</p>}
        {!detail.messages.length&&writable&&<div className="assistant-empty"><h3>从一句话开始</h3><p>例如：“这个页面怎么用？”或“帮我准备这一章，缺少音色时问我”。也可粘贴或拖入截图。</p></div>}
        {detail.messages.map(m=><article key={m.id} className={'assistant-message '+(m.role==='user'?'from-user':'from-assistant')}><strong>{m.role==='user'?'你':'助手'}</strong><p>{m.content}</p><div className="assistant-images">{m.attachmentIds.map(id=>detail.attachments.find(a=>a.id===id)).filter((a):a is Attachment=>!!a).map(a=><button key={a.id} aria-label="放大消息截图" onClick={()=>setZoom(a)}><img src={attachmentURL(a)} alt="本条消息发送的截图"/></button>)}</div></article>)}
        {detail.runs.map(r=><section key={r.id} className="assistant-task-card" aria-label="助手任务卡"><div className="assistant-card-head"><strong>{r.mode==='task'?'委托任务':'本次问答'}</strong><span role="status" data-state={r.state}>{assistantState[r.state]||r.state}</span></div><p>{r.objective}</p><p className="hint">范围：{r.binding.projectId?resolve(r.binding.projectId):'工作区'}{r.binding.chapterId?' / '+resolve(r.binding.chapterId):''}</p>
          <div className="assistant-budget">{(['assistant','analysis','audio'] as const).map(key=><span key={key}>{({assistant:'助手',analysis:'整理',audio:'声音'})[key]} {r.budget.used[key]} / {r.budget.limits[key]} 次</span>)}</div>
          {r.state==='awaitingApproval'&&<p className="hint">{r.mode==='task'?'批准后，助手会在本任务范围和次数上限内继续常规步骤。':'只执行下面待确认步骤。'}{changesReading(r.id)?'下面提案将改变朗读范围，仅批准才实施。':r.textMutationPolicy==='preserveExact'?'保留原文。':'允许本次明确指定的正文修改。'}试听检查仍由你完成。</p>}
          {detail.steps.filter(s=>s.runId===r.id).map((s,stepIndex)=><details key={s.id} className="assistant-step" open={s.state==='proposed'?true:undefined}><summary>{stepIndex+1}. {s.description} <span>{assistantState[s.state]||s.state}</span></summary>
            <dl className="assistant-change-list">{assistantPreviewRows(s.input,resolve).map((row,i)=><div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
            {!!s.preview?.preview&&<details><summary>影响与处理范围</summary><dl className="assistant-change-list">{assistantPreviewRows(s.preview.preview,resolve).map((row,i)=><div key={i}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl></details>}
            {!!s.preview?.effects?.voiceAssignments.length&&<div className="assistant-actual-effects"><strong>实际音色变更</strong><dl className="assistant-change-list">{s.preview.effects.voiceAssignments.map((effect,i)=><div key={i}><dt>{resolve(effect.roleId)}{effect.segmentId||effect.segmentText?' · 台词 '+(effect.segmentText||resolve(effect.segmentId||'')):effect.source==='role-default'?' · 角色默认音色':' · 本章角色音色'}</dt><dd>{effect.before?resolve(effect.before):'未指定'} → {effect.after?resolve(effect.after):'未指定'}</dd></div>)}</dl></div>}
            {s.preview?.effects?.readingRange&&<details className="assistant-reading-change"><summary className="warning">朗读范围将改变，请核对原文与拟朗读内容</summary><dl className="assistant-change-list"><div><dt>原朗读文字</dt><dd>{s.preview.effects.readingRange.before.text||'（空）'}</dd></div><div><dt>拟朗读文字</dt><dd>{s.preview.effects.readingRange.after.text||'（空）'}</dd></div></dl></details>}
            {s.error&&<p className="warning">{s.error}</p>}{s.resultRefs?.uiAction&&<button className="button small" disabled={!connected} onClick={()=>{if(s.resultRefs!.uiAction!.type==='navigate'&&s.resultRefs!.uiAction!.target==='assistant-settings')setSettings(true);else void perform(()=>props.onUIAction(s.resultRefs!.uiAction!));}}>{s.resultRefs.uiAction.type==='play'?'试听结果':'打开操作位置'}</button>}{s.resultRefs?.jobIds?.length?<p className="hint">已提交 {s.resultRefs.jobIds.length} 个制作任务，可在顶部“任务”查看。</p>:null}
          </details>)}
          {r.questions?.length?<ul>{r.questions.map((q,i)=><li key={i}>{q}</li>)}</ul>:null}{r.error&&<p className="warning">{r.error}</p>}
          {r.delivery&&<div className="assistant-delivery"><strong>整章试听已就绪 · 待检查</strong><button className="button small" disabled={!connected||busy} onClick={()=>void perform(()=>props.onUIAction({type:'play',kind:'masters',id:r.delivery!.masterId,chapterId:r.delivery!.chapterId}))}>试听整章</button></div>}
          {needsListening(r.id)&&<p className="warning">试听检查须由你在原试听界面完成。请先不执行这张提案，再打开对应声音检查。</p>}
          {writable&&r.state==='awaitingApproval'&&<div className="button-row"><button className="button primary" disabled={busy||!connected||needsListening(r.id)} onClick={()=>decide(r,true)}>批准并开始</button><button className="button" disabled={busy||!connected} onClick={()=>decide(r,false)}>不执行</button></div>}
          {writable&&!assistantTerminal(r.state)&&r.state!=='awaitingApproval'&&<div className="assistant-controls"><div className="button-row">{['planning','executing','waitingJobs'].includes(r.state)&&<button className="button small" disabled={busy||!connected} onClick={()=>control(r,'pause')}>暂停后续步骤</button>}{r.state==='paused'&&<button className="button small" disabled={busy||!connected} onClick={()=>control(r,'resume')}>恢复任务</button>}<button className="button small" disabled={busy||!connected} onClick={()=>control(r,'stop')}>停止任务</button></div><label><input type="checkbox" checked={stopAudio} onChange={e=>setStopAudio(e.target.checked)}/>停止时同时取消本任务的声音请求</label></div>}
          {writable&&['paused','awaitingUser','needsReconciliation'].includes(r.state)&&<AssistantMandate key={r.id+':'+r.revision} run={r} stepCount={detail.steps.filter(s=>s.runId===r.id).length} voices={state.voices} connected={connected} busy={busy} previewVoice={id=>perform(()=>props.onUIAction({type:'play',kind:'voices',id}))} amend={body=>perform(async()=>props.withSavedScope(r.binding,async()=>{apply(await api<AssistantDetail>('/assistant/runs/'+encodeURIComponent(r.id)+'/control',{action:'amend',revision:r.revision,decisionId:crypto.randomUUID(),...body}));await props.refresh();}))}/>}
          {writable&&(r.state==='needsReconciliation'||['paused','awaitingUser'].includes(r.state)&&(r.reconciliation?.assistantRequest?.state==='unknown'||!!r.reconciliation?.steps.length))&&<AssistantReconciliation run={r} connected={connected} busy={busy} reconcile={body=>perform(async()=>props.withSavedScope(r.binding,async()=>{apply(await api<AssistantDetail>('/assistant/runs/'+encodeURIComponent(r.id)+'/control',{action:'reconcile',revision:r.revision,decisionId:crypto.randomUUID(),...body}));await props.refresh();}))}/>}
        </section>)}
        <details className="assistant-session-tools"><summary>会话管理</summary><p className="hint">归档保留聊天、截图和执行记录，停止后续助手步骤。已提交的制作任务和费用不会撤销。</p>{sessions.map(s=><div key={s.id} data-session-id={s.id} className="assistant-session-item"><span>{s.title}<small>{s.chapterId?resolve(s.chapterId):'工作区'}{s.id===detail.session.id?' · 当前会话':''}{s.state!=='active'?' · 只读':''}</small></span><div className="button-row">{s.state==='active'&&<button className="button small" aria-label={'归档会话 '+s.title} disabled={busy||uploading||!connected} onClick={()=>void perform(async()=>{await api('/assistant/sessions/'+encodeURIComponent(s.id),undefined,'DELETE');await list();if(current.current===s.id)apply(await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(s.id)));})}>归档</button>}{!s.contentDeletion&&<button className="text-button" aria-label={'删除对话内容 '+s.title} disabled={busy||uploading||!connected} onClick={()=>confirmDelete(s.id)}>删除对话内容</button>}</div></div>)}</details>
      </>}
    </div>
    {newMessages&&<button className="assistant-new button small" onClick={()=>{follow.current=true;const el=scroll.current;if(el)el.scrollTop=el.scrollHeight;setNewMessages(false);}}><ArrowDown size={14}/>查看新消息</button>}
    {detail&&writable&&<div className="assistant-composer" onDragOver={e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();}} onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();void upload(Array.from(e.dataTransfer.files));}}}>
      <div className="assistant-mode"><label><input type="radio" name="assistant-mode" checked={draft.mode==='ask'} disabled={busy||!!draft.pending||!!run} onChange={()=>updateDraft({...draft,mode:'ask'})}/>问一问</label><label><input type="radio" name="assistant-mode" checked={draft.mode==='task'} disabled={busy||!!draft.pending||!!run} onChange={()=>updateDraft({...draft,mode:'task'})}/>交给助手做</label></div>
      {draft.mode==='task'&&!run&&<details className="assistant-mandate"><summary>任务范围与请求上限</summary><Field label="完成目标"><Select label="完成目标" value={draft.completionTarget||"requested-actions"} disabled={busy||!!run||!!draft.pending} onChange={value=>updateDraft({...draft,completionTarget:value as AssistantDraft["completionTarget"]})} options={[{value:"requested-actions",label:"完成我指定的操作"},{value:"chapter-master",label:"整章制作到待试听母版"}]}/></Field><div className="assistant-limit-inputs">{(['assistant','analysis','audio'] as const).map(key=><label key={key}>{({assistant:'助手',analysis:'AI 整理',audio:'生成声音'})[key]}<input type="number" min={0} max={key==='assistant'?40:key==='analysis'?100:10000} value={draft.limits[key]} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,limits:{...draft.limits,[key]:Number(e.target.value)}})}/></label>)}</div><label>本任务步骤上限<input type="number" min={1} max={200} value={draft.stepLimit||40} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,stepLimit:Number(e.target.value)})}/></label><label><input type="checkbox" checked={draft.workflowKinds?.includes('group')||false} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,workflowKinds:e.target.checked?[...(draft.workflowKinds||['dry']),'group']:(draft.workflowKinds||['dry']).filter(k=>k!=='group')})}/>允许一起演绎</label><label><input type="checkbox" checked={draft.workflowKinds?.includes('scene')||false} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,workflowKinds:e.target.checked?[...(draft.workflowKinds||['dry']),'scene']:(draft.workflowKinds||['dry']).filter(k=>k!=='scene')})}/>允许场景制作</label><p className="hint">按请求次数控制，不是金额报价；费用以服务商账单为准。</p><Field label="音色选择"><Select label="音色选择" value={draft.voicePolicy} disabled={busy||!!run||!!draft.pending} onChange={value=>updateDraft({...draft,voicePolicy:value as AssistantDraft['voicePolicy']})} options={[{value:"askMissing",label:"缺少音色时询问我"},{value:"chooseFromApprovedSet",label:"从我批准的音色中选择"}]}/></Field>{draft.voicePolicy==='chooseFromApprovedSet'&&<div className="assistant-voice-options">{state.voices.filter(v=>v.state==='active').map(v=><label key={v.id}><input type="checkbox" checked={draft.allowedVoiceIds.includes(v.id)} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,allowedVoiceIds:e.target.checked?[...draft.allowedVoiceIds,v.id]:draft.allowedVoiceIds.filter(id=>id!==v.id)})}/>{v.name}</label>)}</div>}<label><input type="checkbox" checked={draft.materials.includes('reference')} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,materials:e.target.checked?[...draft.materials,'reference']:draft.materials.filter(m=>m!=='reference')})}/>允许生成时使用参考音频</label><label><input type="checkbox" checked={draft.textMutationPolicy==='explicitSpecifiedEdit'} disabled={busy||!!run||!!draft.pending} onChange={e=>updateDraft({...draft,textMutationPolicy:e.target.checked?'explicitSpecifiedEdit':'preserveExact'})}/>允许我在本任务中明确指定的正文修改</label></details>}
      <div className="assistant-images">{draft.attachments.map(a=><div key={a.id}><button aria-label="预览待发送截图" onClick={()=>setZoom(a)}><img src={attachmentURL(a)} alt="待发送截图"/></button><button className="icon" aria-label="移除截图" disabled={busy||!!draft.pending} onClick={()=>updateDraft({...draft,attachments:draft.attachments.filter(x=>x.id!==a.id)})}><X size={14}/></button></div>)}</div>
      <textarea ref={input} aria-label="给助手的消息" placeholder="输入问题，或粘贴截图…" value={draft.text} maxLength={20000} disabled={!!draft.pending||busy||loading} onChange={e=>updateDraft({...draft,text:e.target.value})} onPaste={e=>{const images=Array.from(e.clipboardData.files);if(images.length){e.preventDefault();void upload(images);}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing&&!busy&&!uploading&&runnable){e.preventDefault();send();}}}/>
      <input ref={files} type="file" hidden multiple accept="image/png,image/jpeg,image/webp" onChange={e=>{void upload(Array.from(e.target.files||[]));e.target.value='';}}/>
      <div className="assistant-send-row"><button className="button small" disabled={!connected||busy||uploading||!!draft.pending||draft.attachments.length>=2} onClick={()=>files.current?.click()}><ImagePlus size={16}/>{uploading?'正在读取…':'添加截图'}</button><button className="button primary small" disabled={!connected||busy||uploading||!runnable||!config?.enabled||!config.configured||(!draft.text.trim()&&!draft.attachments.length)||!!draft.attachments.length&&!config.vision} onClick={send}><ArrowUp size={16}/>{busy?'正在提交…':draft.pending?'核对后重试原消息':'发送'}</button></div>
      {draft.pending&&<p className="warning">上一条消息回执未确认，已保留原发送内容。<button className="text-button" disabled={busy||!connected} onClick={()=>void perform(async()=>apply(await api<AssistantDetail>('/assistant/sessions/'+encodeURIComponent(detail.session.id))))}>核对现有记录</button></p>}
      {!!draft.attachments.length&&!config?.vision&&<p className="hint assistant-image-hint" role="status">请在顶部连接设置中启用图片输入。</p>}
    </div>}
    {settings&&<AssistantConnection config={config} connected={connected} onSaved={setConfig} onClose={()=>setSettings(false)}/>}
    {deleting&&<Dialog title="删除对话内容" onClose={()=>{if(!busy)setDeleting(null);}}><p>删除“{deleting.session.title}”的对话内容？</p><p>范围：{deleting.session.projectId?resolve(deleting.session.projectId):'工作区'}{deleting.session.chapterId?' / '+resolve(deleting.session.chapterId):''}，仅此会话。</p><p>将永久清除全部聊天、截图、模型原回复、读取材料和提案详情，以及本浏览器内此会话的未发送草稿。当前有 {deleting.messages.length} 条消息、{deleting.attachments.length} 张截图和 {deleting.steps.length} 条提案。无法恢复；其他会话不受影响。</p><p className="hint">会停止后续助手操作，并保留请求状态、使用次数、时间和结果引用等执行账本。已写入的制作设置、生成结果及其操作记录不会删除，已提交的生成和费用不会撤销；结果未确认的请求仍按未确认记录保留。</p><div className="button-row"><button className="button" disabled={busy} onClick={()=>setDeleting(null)}>保留对话</button><button className="button danger" disabled={busy||!connected} onClick={removeContent}>永久删除此会话内容</button></div></Dialog>}
    {zoom&&<Dialog title="截图预览" wide onClose={()=>setZoom(null)}><img className="assistant-zoom" src={attachmentURL(zoom)} alt="将发送给助手的实际截图"/><p className="hint">{zoom.width} × {zoom.height} · {(zoom.bytes/1024).toFixed(0)} KB。请在发送前确认截图中没有密钥或不需外发的内容。</p></Dialog>}
  </section>;
}

export function AssistantConnection({config,connected,onSaved,onClose}:{config:AssistantConfig|null;connected:boolean;onSaved:(config:AssistantConfig)=>void;onClose:()=>void}){
  const [form,setForm]=useState<AssistantConfig|null>(config),[key,setKey]=useState(''),[clearKey,setClearKey]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const sending=useRef(false),live=useRef(true);
  useEffect(()=>{live.current=true;if(!form)void api<AssistantConfig>('/assistant/config').then(c=>{if(live.current)setForm(c);}).catch(e=>{if(live.current)setError(messageError(e));});return()=>{live.current=false;};},[]);
  const change=(patch:Partial<AssistantConfig>)=>{if(form)setForm({...form,...patch});};
  const save=async()=>{if(!form||sending.current)return;sending.current=true;setBusy(true);setError('');try{const saved=await api<AssistantConfig>('/assistant/config',{revision:form.revision,enabled:form.enabled,baseUrl:form.baseUrl,model:form.model,credentialSource:form.credentialSource,vision:form.vision,...(key?{apiKey:key}:{}),...(clearKey?{clearKey:true}:{})},'PUT');if(live.current){setForm(saved);onSaved(saved);setKey('');setClearKey(false);}}catch(e){if(live.current)setError(messageError(e));}finally{sending.current=false;if(live.current)setBusy(false);}};
  return <Dialog title="助手连接" onClose={onClose}>{!form?<p>正在读取连接…</p>:<div className="assistant-settings">{error&&<p className="warning" role="alert">{error}</p>}<label><input disabled={busy} type="checkbox" checked={form.enabled} onChange={e=>change({enabled:e.target.checked})}/>启用 AI 助手</label><Field label="接口地址"><input disabled={busy} value={form.baseUrl} placeholder="https://服务地址/v1" onChange={e=>change({baseUrl:e.target.value})}/></Field><Field label="助手模型"><input disabled={busy} value={form.model} placeholder="claude-sonnet-5-5" onChange={e=>change({model:e.target.value})}/></Field><Field label="连接凭据"><Select label="连接凭据" value={form.credentialSource} disabled={busy} onChange={value=>change({credentialSource:value as AssistantConfig['credentialSource']})} options={[{value:"audio",label:"复用同服务的配音凭据"},{value:"separate",label:"使用独立凭据"}]}/></Field>{form.credentialSource==='separate'&&<><Field label={form.hasKey?'更新凭据（已保存，不回显）':'API Key'}><input disabled={busy} type="password" autoComplete="new-password" value={key} onChange={e=>setKey(e.target.value)}/></Field>{form.hasKey&&<label><input disabled={busy} type="checkbox" checked={clearKey} onChange={e=>setClearKey(e.target.checked)}/>移除已保存的独立凭据</label>}</>}<label><input disabled={busy} type="checkbox" checked={form.vision} onChange={e=>change({vision:e.target.checked})}/>此模型支持图片输入</label><button className="button primary" disabled={!connected||busy} onClick={()=>void save()}>{busy?'处理中…':'保存连接'}</button></div>}</Dialog>;
}


export function AssistantMandate({run,voices,connected,busy,amend,previewVoice,stepCount=0}:{run:AssistantRun;stepCount?:number;voices:State['voices'];connected:boolean;busy:boolean;previewVoice?:(id:string)=>Promise<void>;amend:(body:Record<string,unknown>)=>Promise<void>}) {
  const [workflowKinds,setWorkflowKinds]=useState(run.workflowKinds||['dry']),[stepLimit,setStepLimit]=useState(run.stepLimit||40),[limits,setLimits]=useState(run.budget.limits),[allowed,setAllowed]=useState(run.allowedVoiceIds||[]),[voicePolicy,setVoicePolicy]=useState(run.voicePolicy||'askMissing'),[reference,setReference]=useState(run.materials?.includes('reference')||false),[connection,setConnection]=useState(false),[productionConnection,setProductionConnection]=useState(false),[choices,setChoices]=useState<Record<string,string>>({});
  return <details className="assistant-mandate"><summary>调整任务范围与音色</summary><div className="assistant-limit-inputs">{(['assistant','analysis','audio'] as const).map(key=><label key={key}>{({assistant:'助手','analysis':'AI 整理',audio:'声音'})[key]}<input disabled={busy} type="number" min={run.budget.used[key]} max={key==='assistant'?40:key==='analysis'?100:10000} value={limits[key]} onChange={e=>setLimits({...limits,[key]:Number(e.target.value)})}/></label>)}</div><p className="hint">这是本任务总上限，包含已经使用的次数。</p><label>本任务步骤上限<input disabled={busy} type="number" min={Math.max(1,stepCount)} max={200} value={stepLimit} onChange={e=>setStepLimit(Number(e.target.value))}/></label>{(['group','scene'] as const).map(kind=><label key={kind}><input disabled={busy} type="checkbox" checked={workflowKinds.includes(kind)} onChange={e=>setWorkflowKinds(e.target.checked?[...workflowKinds,kind]:workflowKinds.filter(k=>k!==kind))}/>{kind==='group'?'允许一起演绎':'允许场景制作'}</label>)}
    {run.voiceQuestions?.map(q=><div className="assistant-role-choice" key={q.roleId}><Field label={q.roleName+' · '+q.segmentIds.length+' 条台词'}><Select label={q.roleName+'使用音色'} value={choices[q.roleId]||''} disabled={busy} onChange={value=>setChoices({...choices,[q.roleId]:value})} options={[{value:"",label:"请选择音色"},...voices.filter(v=>v.state==='active'&&q.availableVoiceIds.includes(v.id)).map(v=>({value:v.id,label:v.name}))]}/></Field>{choices[q.roleId]&&previewVoice&&<button className="button small" disabled={!connected||busy} onClick={()=>void previewVoice(choices[q.roleId])}>试听所选声音</button>}</div>)}
    <Field label="后续缺少音色时"><Select label="后续缺少音色时" value={voicePolicy} disabled={busy} onChange={setVoicePolicy} options={[{value:"askMissing",label:"继续询问我"},{value:"chooseFromApprovedSet",label:"从批准集合选择"}]}/></Field>
    {voicePolicy==='chooseFromApprovedSet'&&<div className="assistant-voice-options">{voices.filter(v=>v.state==='active').map(v=><label key={v.id}><input disabled={busy} type="checkbox" checked={allowed.includes(v.id)} onChange={e=>setAllowed(e.target.checked?[...allowed,v.id]:allowed.filter(id=>id!==v.id))}/>{v.name}</label>)}</div>}
    <label><input disabled={busy} type="checkbox" checked={reference} onChange={e=>setReference(e.target.checked)}/>允许生成使用参考音频</label><label><input disabled={busy} type="checkbox" checked={connection} onChange={e=>setConnection(e.target.checked)}/>连接已修改，批准此任务使用当前助手连接</label><label><input disabled={busy} type="checkbox" checked={productionConnection} onChange={e=>setProductionConnection(e.target.checked)}/>使用当前配音和 AI 整理连接（已有用量保留）</label><p className="hint">保存不会立即执行；结果不明的请求须先核对，随后可恢复任务。</p><button className="button small" disabled={busy||!connected||!Number.isSafeInteger(stepLimit)||stepLimit<Math.max(1,stepCount)||stepLimit>200||Object.entries(limits).some(([key,n])=>!Number.isSafeInteger(n)||n<run.budget.used[key as keyof typeof limits])} onClick={()=>void amend({limits,workflowKinds,stepLimit,voicePolicy,allowedVoiceIds:allowed,materials:[...new Set(['text',...(run.materials?.includes('image')?['image']:[]),...(reference?['reference']:[])])],...(Object.values(choices).some(Boolean)?{roleVoiceChoices:Object.fromEntries(Object.entries(choices).filter(([,v])=>!!v))}:{}),...(connection?{acceptCurrentConnection:true}:{}),...(productionConnection?{acceptCurrentProductionConnection:true}:{})})}>保存本次任务范围</button>
  </details>;
}


export function AssistantReconciliation({run,connected,busy,reconcile}:{run:AssistantRun;connected:boolean;busy:boolean;reconcile:(body:Record<string,unknown>)=>Promise<void>}) {
  const [approved,setApproved]=useState<Record<string,boolean>>({});
  const request=run.reconciliation?.assistantRequest;
  const items=[...(request?[{id:request.id,title:'助手回复未确认',canRetry:true,body:{assistantRequestId:request.id},attempts:[]}]:[]),...(run.reconciliation?.steps||[]).map(step=>({id:step.stepId,title:step.description,canRetry:step.canRetry,body:{stepId:step.stepId,acknowledgedAttemptIds:step.attempts.map(a=>a.id)},attempts:step.attempts}))];
  return <section className="assistant-reconcile"><strong>核对结果不明的请求</strong><p className="hint">先查看已有结果。不会自动重发；重新发送可能再次计费。保留已有结果不会把未完成步骤标为成功。</p>{items.map(item=><div key={item.id}><p>{item.title}</p>{item.attempts.map(a=><p className="hint" key={a.id}>请求 {a.id.slice(0,8)} · {a.status==='unknown'?'结果不明':a.status==='failed'?'未完成':a.status==='success'?'已完成':a.status}</p>)}{item.canRetry&&<label><input type="checkbox" checked={!!approved[item.id]} onChange={e=>setApproved({...approved,[item.id]:e.target.checked})}/>我已核对已有结果，同意再次发送并可能再次计费</label>}<div className="button-row">{item.canRetry&&<button className="button small" disabled={!connected||busy||!approved[item.id]} onClick={()=>{if(approved[item.id])void reconcile({...item.body,resolution:'retry'});}}>批准重新发送</button>}<button className="button small" disabled={!connected||busy} onClick={()=>void reconcile({...item.body,resolution:'keep-results'})}>保留已有结果</button></div></div>)}{!items.length&&<p className="hint">请到顶部“任务”查看详细请求记录。核对入口将在记录可用后显示。</p>}<p className="hint">核对后仍保持暂停，由你选择是否恢复任务。</p></section>;
}
