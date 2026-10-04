import { useEffect, useRef, useState } from 'react';
import { AudioLines, BookOpen, Check, ChevronRight, Play, Search, Upload } from 'lucide-react';
import { api } from './api';
import { Dialog, Field, Form, Status } from './components';
import { listAllDrafts, recoverDraft, discardDraft, clearDraft } from './drafts';
import type { DraftRecord } from './drafts';
import { withSavedDrafts, draftScopeRevision, hasLiveDraft } from './autosave';
import { submitOperation } from './taskOperations';
import VoiceCreation from './VoiceCreation';
import TaskAuthorization from './TaskAuthorization';
import type { VoiceTarget } from './VoiceCreation';
import type { ChapterDetail, GenerationPlan, Role, Segment, State, Voice } from './types';

export type WorkspaceIssue = { key:string; code?:string; scope?:{unitId?:string;mode?:'dry'|'scene';ids:string[]}; resolution?:string; title:string; detail:string; kind:'structure'|'configuration'|'identity'|'voice'|'request'|'audio'|'advice'; ids:string[]; roleId?:string; unitId?:string; mode?:'dry'|'scene' };
export function configurationDecided(segment:Segment,field?:'role'|'identity'):boolean {
  if(!field&&segment.configurationDecided!==undefined)return segment.configurationDecided;
  return (field?[field]:['role','identity'] as const).every(key=>{
    const decision=segment.decisions?.[key],values=key==='role'?[segment.roleId,segment.type]:[segment.roleId,segment.voiceId,segment.voiceSource];
    return !!segment[key==='role'?'roleConfirmed':'identityConfirmed']&&(!decision||decision.state==='accepted'&&JSON.stringify(decision.values)===JSON.stringify(values));
  });
}
export function playbackIdentity(items:ChapterDetail['playbackItems']|undefined):string {
  return JSON.stringify(items?.map(({id,unitId,members,mode,audioId,basis,validity})=>({id,unitId,members,mode,audioId,basis,validity})));
}
export function chapterMemberState(chapter:ChapterDetail,segment:Segment){
  const item=chapter.playbackItems.find(item=>item.id===segment.id||item.members?.includes(segment.id));
  const unit=chapter.units?.find(unit=>unit.id===(item?.unitId||item?.id))||chapter.units?.find(unit=>unit.kind==='single'&&unit.members.includes(segment.id));
  const pending=chapter.units?.filter(unit=>unit.state==='pending'&&unit.members.includes(segment.id))||[];
  const requestIssues=[...(unit?[unit]:[]),...pending].flatMap(unit=>(['dry','scene'] as const).flatMap(mode=>{
    const variant=unit.variants[mode],unknown=!!variant.outstandingAttemptIds?.length||variant.latest==='unknown';
    return unknown||variant.latest==='failed'?[{unit,mode,status:unknown?'unknown':'failed'}]:[];
  }));
  if(!unit&&['unknown','failed'].includes(segment.latest))requestIssues.push({unit:undefined as never,mode:'dry',status:segment.latest});
  return {...segment,...item,latest:requestIssues.some(issue=>issue.status==='unknown')?'unknown':requestIssues.length?'failed':(item as {latest?:string}|undefined)?.latest||segment.latest,requestIssues};
}
export function chapterIssues(chapter:ChapterDetail, roles:Role[], voices:Voice[]):WorkspaceIssue[] {
  const issues:WorkspaceIssue[]=[];
  if(chapter.arrangementIssues?.length) issues.push({key:'structure',kind:'structure',title:'编排需要修复',detail:chapter.arrangementIssues.join('；'),ids:[],unitId:chapter.units?.find(u=>u.diagnostics?.length)?.id});
  if(!chapter.coverage.valid) issues.push({key:'coverage',kind:'structure',title:'原文尚未完整覆盖',detail:`未覆盖 ${chapter.coverage.gaps} 字，重复覆盖 ${chapter.coverage.overlaps} 字。请查看原文及标注。`,ids:[]});
  for(const roleId of new Set(chapter.segments.filter(s=>!s.excluded).map(s=>s.roleId))){
    const segments=chapter.segments.filter(s=>!s.excluded&&s.roleId===roleId), role=roles.find(r=>r.id===roleId), name=role?.name||'未分配角色';
    const unknown=segments.filter(s=>!configurationDecided(s,'role'));
    if(unknown.length) issues.push({key:'identity:'+roleId,kind:'identity',title:`核对${name}的说话人归属`,detail:`${unknown.length} 条需要判断。先查看原文，再确认或改绑角色。`,ids:unknown.map(s=>s.id),roleId});
    const missing=segments.filter(s=>!s.voiceId || !voices.some(v=>v.id===s.voiceId&&['active','archived'].includes(v.state)&&!v.deletePending));
    const generationMissing=missing.filter(s=>{const status=chapterMemberState(chapter,s);return status.validity!=='matched'||status.review==='rework';});
    if(missing.length)issues.push({key:'voice:'+roleId,code:'reference_unavailable',kind:generationMissing.length?'voice':'advice',title:generationMissing.length?`为${name}选声音`:`${name}的参考已停用`,detail:generationMissing.length?`${generationMissing.length} 句的新生成需要可用参考。可应用到本章沿用默认声音的台词。`:'已有匹配声音仍可试听和导出；下一次生成前请改选可用参考。',ids:missing.map(s=>s.id),roleId});
    const pendingIdentity=segments.filter(s=>configurationDecided(s,'role')&&s.voiceId&&!configurationDecided(s,'identity'));
    if(pendingIdentity.length)issues.push({key:'sound-identity:'+roleId,kind:'identity',title:`核对${name}使用的声音`,detail:`${pendingIdentity.length} 条声音身份尚未确认。明确选用声音后继续。`,ids:pendingIdentity.map(s=>s.id),roleId});
  }
  const playing=new Set(chapter.playbackItems.map(item=>item.unitId||item.id));
  const units=(chapter.units||[]).filter(unit=>playing.has(unit.id)||unit.state==='pending'&&unit.members.some(id=>chapter.segments.some(s=>s.id===id&&!s.excluded)));
  const represented=new Set(units.flatMap(unit=>unit.members));
  for(const unit of units){
    const blockers=unit.readiness?.generate.blockers.filter(issue=>issue.code==='prompt-invalid')||[];
    if(blockers.length)issues.push({key:'prompt:'+unit.id,code:'prompt-invalid',kind:'configuration',title:'这段生成要求需要处理',detail:[...new Set(blockers.map(issue=>issue.message))].join('；'),ids:unit.members,unitId:unit.id,mode:unit.mode,resolution:'edit_prompt'});
  }
  for(const unit of units) for(const mode of ['dry','scene'] as const){
    const latest=unit.variants[mode].outstandingAttemptIds?.length?'unknown':unit.variants[mode].latest;
    if(!['unknown','failed'].includes(latest))continue;
    const matching=chapter.playbackItems.some(item=>item.audioId&&item.validity==='matched'&&(item.unitId===unit.id||(item.members||[item.id]).some(id=>unit.members.includes(id))));
    const name=mode==='scene'?'声音背景':unit.kind==='group'?'对戏':'声音';
    issues.push({key:`${latest}:${unit.id}:${mode}`,code:latest==='unknown'?'outstanding_attempt':'generation_failed',scope:{unitId:unit.id,mode,ids:unit.members},resolution:'inspect_attempt',kind:'request',title:latest==='unknown'?`${name}新结果待核对`:`${name}生成失败`,detail:(latest==='unknown'?`${unit.members.length} 条的新结果待核对，可能已计费。先核对这次任务；只有明确再次发送时才重试。`:`${unit.members.length} 条的最新生成失败，已有音频和历史保留。`)+(matching?' 原有匹配声音仍可试听。':''),ids:unit.members,unitId:unit.id,mode});
  }
  const unknown=chapter.segments.filter(s=>!s.excluded&&!represented.has(s.id)&&s.latest==='unknown');
  if(unknown.length)issues.push({key:'unknown',kind:'request',title:'有生成请求结果不明',detail:`${unknown.length} 条可能已经计费。先检查任务记录；只有明确再发送时才重试。`,ids:unknown.map(s=>s.id)});
  const failed=chapter.segments.filter(s=>!s.excluded&&!represented.has(s.id)&&s.latest==='failed');
  if(failed.length)issues.push({key:'failed',kind:'request',title:'部分声音生成失败',detail:`${failed.length} 条失败，已有音频和历史保留。`,ids:failed.map(s=>s.id)});
  const rework=chapter.playbackItems.filter(s=>s.review==='rework');
  if(rework.length)issues.push({key:'rework',kind:'audio',title:'有试听后标记的返工',detail:`${rework.length} 个声音单元需重做。修改后只生成受影响范围。`,ids:rework.flatMap(s=>s.members||[s.id])});
  const suggestions=chapter.suggestions as {id:string;status:string;kind:string;items:{id:string;segmentId?:string;text:string;reason?:string;performance?:string}[];automation?:{pendingItemIds?:string[];needsDecision:number}}[];
  const latest=suggestions.filter(d=>d.kind!=='scene').at(-1);
  const pending=latest?.items.filter(item=>latest.automation?.pendingItemIds?.includes(item.id))||[];
  if(pending.length)issues.push({key:'ai-advice',kind:'advice',title:'AI有表演建议等待选择',detail:`${pending.length} 项需判断，保持当前表演也可以继续制作。可查看建议与原文依据后一次采用。`,ids:pending.flatMap(i=>i.segmentId?[i.segmentId]:[])});
  return issues.map(issue=>({...issue,code:issue.code||issue.key.split(':')[0],scope:issue.scope||{unitId:issue.unitId,mode:issue.mode,ids:issue.ids},resolution:issue.resolution||({structure:'repair_structure',configuration:'edit_prompt',identity:'confirm_configuration',voice:'choose_reference',request:'inspect_attempt',audio:'redo_rejected',advice:'inspect_advice'})[issue.kind]}));
}
export function IssueCenter({chapter,roles,voices,onClose,onLocate,onVoice,onSource,onUnit,onTasks,onConfirm,onAI}:{chapter:ChapterDetail;roles:Role[];voices:Voice[];onClose:()=>void;onLocate:(id:string)=>void;onVoice:(roleId:string)=>void;onSource:()=>void;onUnit:(id:string,mode?:'dry'|'scene')=>void;onTasks:()=>void;onConfirm:(ids:string[])=>Promise<unknown>;onAI:()=>void}){
  const [error,setError]=useState(''),[pending,setPending]=useState(false);
  const issues=chapterIssues(chapter,roles,voices);
  return <Dialog title="需要你处理" presentation="sidepanel" onClose={onClose}>
    <p className="task-panel-summary">同一角色的问题集中处理。常规安排由 AI 完成，声音效果仍需要试听。</p>
    {!issues.length&&<div className="task-outcome"><Check size={20}/><h3>制作条件已就绪</h3><p>可以生成待办或试听现有声音。</p></div>}
    {issues.map(issue=><article className="issue-card" key={issue.key}><span className="eyebrow">{({structure:'内容与编排',configuration:'生成要求',identity:'需要判断',voice:'选择声音',request:'任务结果',audio:'试听返工',advice:'可选创作建议'})[issue.kind]}</span><h3>{issue.title}</h3><p>{issue.detail}</p>
      {issue.kind!=='identity'&&issue.ids.length>0&&<blockquote>{chapter.segments.find(s=>s.id===issue.ids[0])?.text}</blockquote>}
      <div className="button-row">
        {issue.kind==='voice'||issue.code==='reference_unavailable'||issue.key.startsWith('sound-identity:') ? <button className="button primary" onClick={()=>issue.roleId&&onVoice(issue.roleId)}>选声音</button> : issue.kind==='advice' ? <button className="button secondary" onClick={onAI}>查看AI建议</button> : issue.unitId ? <button className="button primary" onClick={()=>onUnit(issue.unitId!,issue.mode)}>{issue.kind==='request'?'核对生成任务':issue.kind==='configuration'?'修改生成要求':'修复编排'}</button> : issue.kind==='request' ? <button className="button secondary" onClick={onTasks}>查看任务</button> : issue.ids.length ? <button className="button secondary" onClick={()=>onLocate(issue.ids[0])}>定位并修改</button> : <button className="button secondary" onClick={onSource}>查看原文</button>}

      </div>
      {issue.kind==='identity'&&issue.key.startsWith('identity:')&&issue.ids.map(id=><div className="issue-judgment" key={id}><span className="eyebrow">第 {(chapter.segments.find(s=>s.id===id)?.order||0)+1} 条</span><p className="spoken-text">{chapter.segments.find(s=>s.id===id)?.text}</p><div className="button-row"><button className="button small" onClick={()=>onLocate(id)}>修改这一句</button><button className="text-button" disabled={pending} onClick={()=>void(async()=>{setPending(true);setError('');try{await onConfirm([id]);}catch(e){setError((e as Error).message);}finally{setPending(false);}})()}>这一句归属正确</button></div></div>)}
      </article>)}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}
export function ProjectOverview({state,projectId,onPick,onClose,onImport,onHelp}:{state:State;projectId:string;onPick:(id:string)=>void;onClose:()=>void;onImport:()=>void;onHelp:()=>void}){
  const chapters=state.chapters.filter(c=>c.projectId===projectId).sort((a,b)=>a.order-b.order);
  return <Dialog title={state.projects.find(p=>p.id===projectId)?.name||'项目总览'} wide onClose={onClose}>
    <div className="project-overview-head"><div><span className="eyebrow">继续制作</span><h3>每章的下一步，一眼可见</h3></div><button className="button primary" onClick={onImport}>导入章节</button></div>
    <div className="project-chapters">{chapters.map((c,i)=><button className="project-chapter" key={c.id} onClick={()=>onPick(c.id)}><BookOpen size={22}/><span><strong>{c.title}</strong><small>{c.productionStatus||'打开章节，检查制作条件'}</small></span><span className="chapter-index">{String(i+1).padStart(2,'0')}</span><ChevronRight size={18}/></button>)}</div>
    {!chapters.length&&<p className="empty-inline">先导入文字，再让 AI 安排剧本和角色。</p>}
    <button className="text-button" onClick={onHelp}>查看四步入门</button>
  </Dialog>;
}
export function VoicePicker({state,chapter,roles,initialTarget,onClose,onRefresh,play,playingId,onUsed}:{state:State;chapter:ChapterDetail;roles:Role[];initialTarget:{roleId?:string;segmentId?:string;tab?:'create';sessionId?:string};onClose:()=>void;onRefresh:()=>Promise<void>;play:(kind:string,id:string,title:string)=>void;playingId?:string;onUsed:()=>void}){
  const [basis,setBasis]=useState(()=>({chapter,roles}));
  const segment=basis.chapter.segments.find(s=>s.id===initialTarget.segmentId),role=basis.roles.find(r=>r.id===(initialTarget.roleId||segment?.roleId));
  const initialVoice=segment?.voiceId||(role&&Object.hasOwn(basis.chapter.roleVoices||{},role.id)?basis.chapter.roleVoices?.[role.id]:role?.voiceId)||'';
  const [scope,setScope]=useState<'chapter'|'single'>(segment?'single':'chapter'),[tab,setTab]=useState(initialTarget.tab||'library'),[query,setQuery]=useState(''),[picked,setPicked]=useState(initialVoice);
  const [error,setError]=useState(''),[pending,setPending]=useState(false),[uploadName,setUploadName]=useState(role?.name?role.name+'的参考声音':'');
  const [uploaded,setUploaded]=useState<Voice|null>(null);
  const live=useRef({chapter,roles,scope});live.current={chapter,roles,scope};
  const active=useRef(true);useEffect(()=>()=>{active.current=false;},[]);
  const affected=scope==='single'&&segment?[segment]:basis.chapter.segments.filter(s=>!s.excluded&&s.roleId===role?.id&&s.voiceSource!=='override');
  const needsReview=chapter.id!==basis.chapter.id||draftScopeRevision('chapter:'+basis.chapter.id,chapter.revision)!==draftScopeRevision('chapter:'+basis.chapter.id,basis.chapter.revision)||
    (role&&roles.find(r=>r.id===role.id)?.revision!==role.revision)||!!(segment&&!chapter.segments.some(s=>s.id===segment.id&&!s.excluded));
  const target:VoiceTarget={projectId:basis.chapter.projectId,chapterId:basis.chapter.id,revision:basis.chapter.revision,roleId:scope==='chapter'?role?.id:undefined,segmentId:scope==='single'?segment?.id:undefined,entityRevision:role?.revision||1,apply:true,scope,chapterOnly:true,firstDefault:scope==='chapter'&&!role?.voiceId,dependencies:affected.map(s=>'segment:'+s.id).concat(role?'role:'+role.id:[]),needsReview:!!needsReview,label:scope==='single'?`第 ${(segment?.order||0)+1} 条`:role?.name};
  const use=async(voiceId:string)=>{
    setPending(true);setError('');
    try{
      await withSavedDrafts('chapter:'+basis.chapter.id,target.dependencies,async()=>{
        const current=live.current,revision=draftScopeRevision('chapter:'+basis.chapter.id,basis.chapter.revision);
        if(current.chapter.id!==basis.chapter.id||current.scope!==scope||draftScopeRevision('chapter:'+basis.chapter.id,current.chapter.revision)!==revision||(role&&current.roles.find(r=>r.id===role.id)?.revision!==role.revision))throw new Error('应用范围已经变化，请重新核对受影响台词。');
        const receipt=await submitOperation('use-voice:'+(target.segmentId||target.roleId),{kind:'useVoice',chapterId:target.chapterId,revision,roleId:target.roleId,segmentId:target.segmentId,entityRevision:target.entityRevision,apply:true,chapterOnly:true,voiceId},state.jobs);
        if(receipt.error)throw new Error(receipt.error);await onRefresh();
      });
      if(active.current)onUsed();
    }catch(e){if(active.current)setError((e as Error).message);}finally{if(active.current)setPending(false);}
  };
  return <Dialog title={`为${target.label||'当前角色'}选声音`} presentation="sidepanel" onClose={onClose} footer={tab!=='create'&&<button className="button primary" disabled={!picked||pending||!affected.length||!!needsReview||!(scope==='single'?segment:role)} onClick={()=>void use(picked)}>{pending?'正在保存并应用…':'用这个声音'}</button>}>
    {!!needsReview&&<section className="warning" role="alert"><p>章节或角色在选择期间发生了变化。你的声音选择仍保留，请重新核对范围后再应用。</p><button className="button secondary" disabled={pending} onClick={()=>{setBasis({chapter,roles});setError('');}}>重新核对当前范围</button></section>}
    <section className="voice-scope"><h3>应用范围</h3><div className="tabs"><button disabled={pending} aria-pressed={scope==='chapter'} onClick={()=>setScope('chapter')}>角色在本章</button>{segment&&<button disabled={pending} aria-pressed={scope==='single'} onClick={()=>setScope('single')}>仅这一句</button>}</div><p className="hint">{affected.length} 条将使用所选声音。{scope==='chapter'?'只更新本章，保留已经单独指定声音的台词。'+(target.firstDefault?'首次绑定也设为未来新片段的角色默认。':''):'这句单独指定，其他台词继续沿用角色声音。'}</p><details><summary>查看受影响台词</summary>{affected.map(s=><p className="original-excerpt" key={s.id}>第 {s.order+1} 条 · {s.text}</p>)}</details></section>
    <div className="tabs task-tabs" aria-label="声音来源">{[['library','已有声音'],['upload','上传参考'],['create','描述创建']].map(([id,label])=><button key={id} disabled={pending} className={tab===id?'active':''} aria-pressed={tab===id} onClick={()=>setTab(id)}>{label}</button>)}</div>
    {tab==='library'&&<><div className="search-field"><Search size={16}/><input aria-label="查找声音" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索声音名称"/></div><div className="voice-choice-list">{state.voices.filter(v=>v.state==='active'&&v.name.includes(query)).map(v=><article className={'voice-choice '+(picked===v.id?'selected':'')} key={v.id}><button className="voice-choice-main" onClick={()=>setPicked(v.id)} aria-pressed={picked===v.id}><strong>{v.name}</strong><small>{Math.round(v.duration)} 秒参考 · {v.sourceCandidateId?'描述创建':'参考录音'}{picked===v.id?' · 已选':''}</small></button><button className="icon" aria-label={'试听'+v.name} onClick={()=>play('voices',v.id,v.name)}><Play size={16}/></button></article>)}</div>{!state.voices.some(v=>v.state==='active')&&<p className="empty-inline">还没有声音。上传参考录音，或描述你想要的声音。</p>}</>}
    {tab==='upload'&&<Form label={uploaded?'已保存参考声音':'保存参考声音'} busy={pending||!!uploaded} onSubmit={async f=>{
      const file=f.get('audio') as File;if(!file?.size)throw new Error('请选择参考录音');if(file.size>10*1024*1024)throw new Error('参考录音不能超过10 MB');
      setPending(true);
      try{
      const uploadKey='voice-upload/'+(sessionStorage.getItem('draft-owner')||'page')+'/'+basis.chapter.projectId+'/'+(segment?.id||role?.id);
      const signature=JSON.stringify({name:uploadName,filename:file.name,size:file.size,lastModified:file.lastModified});
      const prior=localStorage.getItem(uploadKey),record=prior?JSON.parse(prior) as {id:string;signature:string}:null;
      if(record&&record.signature!==signature)throw new Error('上一次上传回执尚未确认，请先重试同一份录音和名称。');
      const uploadId=record?.id||crypto.randomUUID();localStorage.setItem(uploadKey,JSON.stringify({id:uploadId,signature}));
      const data=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('读取录音失败'));reader.readAsDataURL(file);});
      let voice:Voice;
      try{voice=await api<Voice>('/voices',{uploadId,name:uploadName,filename:file.name,data});}
      catch(error){const status=(error as {status?:number}).status;if(status){if(status>=400&&status<500&&status!==409)localStorage.removeItem(uploadKey);throw error;}try{voice=await api<Voice>('/voices/'+uploadId);}catch{throw error;}}
      localStorage.removeItem(uploadKey);if(active.current){setUploaded(voice);setPicked(voice.id);}await onRefresh();
      }finally{if(active.current)setPending(false);}
    }}><Field label="参考声音名称"><input value={uploadName} onChange={e=>setUploadName(e.target.value)} required maxLength={100}/></Field><label className="upload-zone"><Upload size={20}/><strong>选择一段清楚的参考录音</strong><span>保存到本机；制作时才按授权发送</span><input name="audio" type="file" accept=".wav,.mp3" required/></label>{uploaded&&<p className="hint">{uploaded.name}已保存，点击下方“用这个声音”应用。</p>}</Form>}
    {tab==='create'&&<VoiceCreation key={scope+':'+(target.segmentId||target.roleId)} initialSessionId={initialTarget.sessionId} model={state.settings.model} sessions={state.voiceSessions||[]} voices={state.voices} jobs={state.jobs} enabled={state.settings.features?.voiceCreation!==false} configured={state.settings.configured} audioTools={state.settings.audioTools} routeBlocked={state.settings.routeBlocked} playingId={playingId} play={(id,title)=>play('audios',id,title)} refresh={onRefresh} target={target} onUsed={onUsed}/>}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}
export type RecoveryTarget = {kind:'import'|'segment'|'unit'|'event'|'new-group'|'voice-session'|'voice-context'|'role'|'unknown';label:string;chapterId?:string;projectId?:string;segmentId?:string;unitId?:string;eventId?:string;mode?:'dry'|'scene';voiceSessionId?:string;roleId?:string;contextKey?:string;ids?:string[]};
export function RecoveryCenter({chapter,state,onClose,onRecovered}:{chapter:ChapterDetail|null;state:State;onClose:()=>void;onRecovered:(id:string,target:RecoveryTarget)=>void|Promise<void>}){
  const [records,setRecords]=useState<{id:string;entry:DraftRecord<unknown>}[]>([]),[chapters,setChapters]=useState<ChapterDetail[]>(chapter?[chapter]:[]),[error,setError]=useState(''),[loading,setLoading]=useState(true),[pending,setPending]=useState(false);
  const reload=async()=>{
    setLoading(true);setError('');
    try{
      setRecords(await listAllDrafts());
      const loaded=await Promise.allSettled(state.chapters.map(c=>api<ChapterDetail>('/chapters/'+c.id)));
      setChapters(loaded.flatMap(result=>result.status==='fulfilled'?[result.value]:[]));
      if(loaded.some(result=>result.status==='rejected'))setError('部分章节资料未能读取，相关暂存仍保留。恢复连接后请刷新。');
    }catch(e){setError((e as Error).message);}finally{setLoading(false);}
  };
  useEffect(()=>{void reload();},[]);
  const targetFor=(id:string,entry:DraftRecord<unknown>):RecoveryTarget=>{
    const unknown:RecoveryTarget={kind:'unknown',label:'尚未定位的暂存 · '+id},parts=id.split('/'),type=parts.shift()!,raw=parts[0]||id;
    if(entry.compatible===false)return {kind:'unknown',label:(entry.workspaceIdentity?'其他工作区的暂存':'旧版归属未确认的暂存')+' · '+id};
    if(type==='import-chapter'&&state.projects.some(project=>project.id===raw))return {kind:'import',label:state.projects.find(project=>project.id===raw)!.name+' · 未完成的章节导入',projectId:raw};
    const local=entry.data?.draft as {value?:{ids?:string[]}}|undefined;
    const segmentId=type==='segment-v1'?raw:id;
    for(const c of chapters){const segment=c.segments.find(s=>s.id===segmentId);if(segment)return {kind:'segment',label:`${c.title} · 第 ${segment.order+1} 条 · ${segment.text.slice(0,24)}`,chapterId:c.id,projectId:c.projectId,segmentId};}
    if(type==='unit-v1'){
      const newChapter=chapters.find(c=>raw==='new-'+c.id);
      if(newChapter)return {kind:'new-group',label:newChapter.title+' · 未完成的共同演绎',chapterId:newChapter.id,projectId:newChapter.projectId,ids:local?.value?.ids};
      for(const c of chapters){const unit=c.units?.find(u=>u.id===raw&&u.state!=='dissolved');if(unit)return {kind:'unit',label:c.title+' · '+(unit.kind==='group'?'共同演绎':'单句')+(parts[1]==='scene'?'声音背景':'表演指导'),chapterId:c.id,projectId:c.projectId,unitId:unit.id,mode:parts[1]==='scene'?'scene':'dry'};}
    }
    if(type==='sound-event-v1')for(const c of chapters){
      const event=c.events?.find(e=>e.id===raw),unit=c.units?.find(u=>u.id===(event?.unitId||raw.replace(/^new-/,''))&&u.state!=='dissolved');
      if(unit&&(event||raw==='new-'+unit.id))return {kind:'event',label:c.title+' · '+(event?.description.slice(0,24)||'未完成的声音背景'),chapterId:c.id,projectId:c.projectId,unitId:unit.id,eventId:event?.id,mode:'scene'};
    }
    if(type==='voice-session-v1'){
      const session=state.voiceSessions?.find(s=>s.id===raw);if(session)return {kind:'voice-session',label:'声音描述 · '+session.description.slice(0,24),voiceSessionId:session.id};
      if(raw==='new-voice-context'){
        const context=parts[1],contextKey='voice-context/'+context;
        if(context==='library')return {kind:'voice-context',label:'声音库 · 未完成的声音描述',contextKey};
        for(const c of chapters){const segment=c.segments.find(s=>s.id===context);if(segment)return {kind:'voice-context',label:c.title+' · 第 '+(segment.order+1)+' 条的声音描述',chapterId:c.id,projectId:c.projectId,segmentId:segment.id,roleId:segment.roleId,contextKey};}
        const role=state.roles.find(r=>r.id===context);if(role)return {kind:'voice-context',label:role.name+'的声音描述',projectId:role.projectId,roleId:role.id,contextKey};
        const c=chapters.find(c=>c.id===context);if(c)return {kind:'voice-context',label:c.title+' · 声音描述',chapterId:c.id,projectId:c.projectId,contextKey};
        const project=state.projects.find(p=>p.id===context);if(project)return {kind:'voice-context',label:project.name+' · 声音描述',projectId:project.id,contextKey};
      }
    }
    return unknown;
  };
  return <Dialog title="本机暂存与恢复" presentation="sidepanel" onClose={onClose}>
    <p className="task-panel-summary">暂存仍在本机。其他页面正在编辑的内容，需要回到原页面处理。</p><button className="text-button" disabled={pending||loading} onClick={()=>void reload()}>刷新暂存列表</button>
    {loading&&<p className="hint">正在定位章节与未完成编辑…</p>}{!loading&&!records.length&&<p className="empty-inline">没有未保存的暂存。</p>}
    {records.map(({id,entry})=>{const target=targetFor(id,entry);return <article className="issue-card" key={entry.key}><h3>{target.label}</h3><Status kind={entry.status==='active'?'warning':'neutral'}>{entry.status==='active'?'其他页面正在编辑':entry.status==='orphan'?'关闭页面遗留':'本页暂存'}</Status><details><summary>查看暂存内容</summary><pre className="draft-preview">{JSON.stringify(entry.data?.draft,null,2)}</pre></details>{entry.error&&<p className="error-inline">{entry.error}</p>}{!loading&&target.kind==='unknown'&&<p className="hint">对应对象已不在当前资料中，或暂存格式尚不支持定位。原内容仍保留，可查看并复制。</p>}<div className="button-row">
      {!entry.error&&<button className="button" disabled={pending||loading||entry.status==='active'||target.kind==='unknown'} onClick={()=>void(async()=>{setPending(true);setError('');try{if(entry.status==='orphan'){if(hasLiveDraft(id))throw new Error('本页还有未完成编辑或待确认保存，请先处理，不能覆盖。');await recoverDraft(id,entry);}await onRecovered(id,target);}catch(e){setError((e as Error).message);await reload();}finally{setPending(false);}})()}>{entry.status==='current'?'返回编辑':'恢复并返回编辑'}</button>}
      <button className="text-button" disabled={pending||entry.status==='active'} onClick={()=>void(async()=>{setPending(true);setError('');try{if(entry.status==='current'){if(!clearDraft(id,entry.raw,true))throw new Error('暂存已变化，请重新查看');}else await discardDraft(id,entry);await reload();}catch(e){setError((e as Error).message);}finally{setPending(false);}})()}>放弃这份暂存</button></div></article>;})}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}
export function GeneratePlan({plan,chapter,model,concurrency,grantId,unknown,routeBlocked,retryUnknown,resumeRoute,busy,onGrant,onRetryUnknown,onResumeRoute,onGenerate,onRecheck,onEdit,onClose}:{plan:GenerationPlan;chapter:ChapterDetail;model?:string;concurrency?:import('react').ReactNode;grantId:string|null;unknown:boolean;routeBlocked:boolean;retryUnknown:boolean;resumeRoute:boolean;busy:boolean;onGrant:(id:string|null)=>void;onRetryUnknown:(value:boolean)=>void;onResumeRoute:(value:boolean)=>void;onGenerate:()=>Promise<void>;onRecheck:()=>Promise<void>;onEdit:(id:string)=>void;onClose:()=>void}){
  const [invalid,setInvalid]=useState(false),[pending,setPending]=useState(false),[error,setError]=useState(''),[updated,setUpdated]=useState(false);
  const execute=async(recheck:boolean)=>{
    if(pending||busy||!recheck&&invalid)return;
    setPending(true);setError('');
    try{if(recheck){await onRecheck();setInvalid(false);setUpdated(true);}else await onGenerate();}
    catch(e){if((e as {status?:number}).status===409)setInvalid(true);else setError((e as Error).message);}
    finally{setPending(false);}
  };
  return <Dialog title="生成这次待办" presentation="sidepanel" onClose={onClose} footer={invalid
    ? <button className="button primary" disabled={busy||pending} onClick={()=>void execute(true)}>{pending?'正在重新核对…':'重新核对生成范围'}</button>
    : plan.audioRequests===0 ? <button className="button primary" disabled={busy||pending} onClick={onClose}>完成核对</button>
    : <button className="button primary" disabled={busy||pending||!grantId||(routeBlocked&&!resumeRoute)||(unknown&&!retryUnknown)} onClick={()=>void execute(false)}>{pending?'正在提交…':`开始生成 ${plan.audioRequests} 个声音`}</button>}>
    {invalid&&<div className="task-outcome" role="alert"><h3>内容已变化，本次未发送</h3><p>先免费重新核对生成范围。更新后的范围会在这里展示，再由你决定开始生成。</p></div>}
    {!invalid&&updated&&<p className="hint" role="status">已按当前内容重新核对，请查看下面的范围后再开始生成。</p>}
    <p className="task-panel-summary">{invalid?'之前核对的范围：':'本次覆盖 '}{plan.memberIds.length} 条台词，其中 {plan.units.filter(u=>u.reuse).length} 个已有声音直接复用；实际发送 {plan.audioRequests} 次音频请求。</p>
    <div className="task-member-list">{plan.units.map(unit=><p key={unit.unitId}>{unit.members.length>1?'一起演绎':'单句'} · 第 {unit.members.map(id=>{const segment=chapter.segments.find(s=>s.id===id);return segment?segment.order+1:'已移除';}).join('、')} 条 · {unit.mode==='scene'?'声音背景':'纯人声'} · {unit.reuse?'复用已有声音':'生成新声音'}</p>)}</div>
    {!invalid&&plan.units.filter(unit=>!unit.reuse).map(unit=>{
      const members=chapter.segments.filter(s=>unit.members.includes(s.id)),length=members.reduce((total,s)=>total+Array.from(s.text||'').length,0);
      if(length<=350*(1+(members[0]?.config?.speech_rate||0)/100))return null;
      return <div className="warning section-rule" key={unit.unitId} role="note"><p>第 {members.map(s=>s.order+1).join('、')} 条共 {length} 字符，可能超过单次 120 秒。建议按语义拆短正文；字数不是精确时长预测{unit.members.length>1?'，一起演绎需先缩小整段范围':''}。</p><button className="text-button" disabled={busy||pending} onClick={()=>onEdit(unit.members[0])}>返回编辑</button></div>;
    })}
    {!invalid&&plan.audioRequests>0&&<>
      {concurrency}
      <TaskAuthorization projectId={chapter.projectId} chapterId={chapter.id} label="生成所列台词" steps={["unit-generate"]} model={model} requests={plan.audioRequests} voiceIds={[...new Set(chapter.segments.filter(s=>plan.memberIds.includes(s.id)).flatMap(s=>s.voiceId?[s.voiceId]:[]))]} onReady={onGrant} disabled={busy||pending}/>
      {unknown&&<label className="check-label warning"><input type="checkbox" checked={retryUnknown} disabled={busy||pending} onChange={e=>onRetryUnknown(e.target.checked)}/>上次结果不明，可能已计费；明确再发送上述请求。</label>}
      {routeBlocked&&<label className="check-label warning"><input type="checkbox" checked={resumeRoute} disabled={busy||pending} onChange={e=>onResumeRoute(e.target.checked)}/>已核对接口权限与额度，恢复本次声音请求。</label>}
    </>}
    {!invalid&&plan.audioRequests===0&&<p className="hint">当前范围已有匹配声音，可以直接复用，无需发送新的配音请求。</p>}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}
export function QuickHelp({onClose,onDemo,onImport,configured,onAssistant}:{onClose:()=>void;onDemo:()=>void;onImport:()=>void;configured:boolean;onAssistant?:()=>void}){
  return <Dialog title="四步完成一章配音" onClose={onClose}><ol className="quick-start"><li><strong>导入文字</strong><p>新建项目，按章节导入 TXT、Markdown，或直接粘贴原文。</p></li><li><strong>让 AI 准备</strong><p>选择“AI先安排”，常规分段和表演建议自动进入初稿。只处理说话人疑点，为角色试听并选声音。</p></li><li><strong>试听与修改</strong><p>生成待办，逐条或整章试听。选两条连续对白可“一起演绎”；“声音背景”集中设置环境、音效、音乐。</p></li><li><strong>导出成品</strong><p>确认实际试听结果，导出 WAV 或 MP3。导出使用同一母版，不重复调用配音模型。</p></li></ol><p className="hint">有效输入自动保存。空正文或输入到一半的数字先保留本机；“本机暂存”可以找回。AI安排不代表声音已听评通过。</p>{!configured&&<p className="warning">当前声音接口未配置。你仍可免费试听演示，再从“设置与连接”完成配置。</p>}<div className="button-row">{onAssistant&&<button className="button" onClick={onAssistant}>问助手</button>}<button className="button" onClick={onDemo}><Play size={16}/>免费试听演示</button><button className="button primary" onClick={onImport}>开始导入</button></div><p className="hint">演示使用本机语音，供体验播放器，不代表 Seed Audio 的生成效果。</p></Dialog>;
}
