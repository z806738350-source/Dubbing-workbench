import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { draftScopeRevision, withSavedDrafts } from "./autosave";
import { Dialog } from "./components";
import { submitOperation } from "./taskOperations";
import type { ChapterDetail, Job, Segment } from "./types";

type SplitItem = { id:string; segmentId?:string; splitParts?:string[]; splitIssue?:string; splitRequiresPerformanceConfirmation?:boolean; issues?:string[] };
type SplitDraft = {
  id:string; kind:string; splitOnly?:boolean; revision:number; contextRevision:number;
  draftVersion:number; model:string; status:string; error?:string; items:SplitItem[];
  segments?:{id:string}[]; batches?:{id:string;status:string;error?:string}[];
  splitResults?:{segmentId:string;itemId:string;childIds:string[]}[];
};
type SplitPlan = { kind:string; memberIds:string[]; textRequests:number };

export default function SegmentSplitDialog({chapter,segment,defaultModel,contextRevision,stateJobs,locked,onClose,onApplied}: {
  chapter:ChapterDetail; segment:Segment; defaultModel:string; contextRevision:number;
  stateJobs:Job[]; locked:boolean; onClose:()=>void; onApplied:(childId:string,isCurrent:()=>boolean)=>Promise<void>;
}) {
  const scope="chapter:"+chapter.id;
  const [plan,setPlan]=useState<SplitPlan|null>(null);
  const [draft,setDraft]=useState<SplitDraft|null>(()=>(chapter.suggestions as SplitDraft[]).filter(value=>value.splitOnly && value.segments?.some(row=>row.id===segment.id)).at(-1)||null);
  const [pending,setPending]=useState(false), [error,setError]=useState("");
  const [retryUnknown,setRetryUnknown]=useState(false), [recordsOpen,setRecordsOpen]=useState(false), [applyUncertain,setApplyUncertain]=useState(false);
  const [inheritPerformanceConfirmed,setInheritPerformanceConfirmed]=useState(false);
  const alive=useRef(true), intent=useRef(0);
  const base=(revision:number)=>({kind:"prepareChapter",analysisKind:"director",chapterId:chapter.id,revision,ids:[segment.id],splitOnly:true,autoApply:false});
  const item=draft?.items.find(value=>value.segmentId===segment.id);
  const parts=item?.splitParts||[];
  const needsPerformanceConfirmation=parts.length>=2&&item?.splitRequiresPerformanceConfirmation===true;
  const unknown=!!draft?.batches?.some(batch=>batch.status==="unknown");
  const running=draft?.status==="running";
  const currentDraft=!!draft && draft.revision===draftScopeRevision(scope,chapter.revision) && draft.contextRevision===contextRevision;
  const resumable=currentDraft&&!!draft?.batches?.some(batch=>batch.status!=="received");
  const childId=draft?.splitResults?.find(value=>value.segmentId===segment.id)?.childIds[0];
  const close=()=>{alive.current=false;intent.current++;onClose();};
  const readRecord=async(id=draft?.id)=>{
    const fresh=await api<ChapterDetail>("/chapters/"+chapter.id);
    const record=(fresh.suggestions as SplitDraft[]).find(value=>value.id===id);
    if(!record)throw new Error("这次分析记录暂未找到，请稍后查看；不会自动重发。");
    return record;
  };
  useEffect(()=>{
    setInheritPerformanceConfirmed(false);
  },[draft?.id,draft?.draftVersion]);
  useEffect(()=>{
    alive.current=true;
    const token=++intent.current;
    void api<SplitPlan>("/operations/plan",base(draftScopeRevision(scope,chapter.revision))).then(value=>{if(alive.current&&intent.current===token)setPlan(value);}).catch(error=>{if(alive.current&&intent.current===token)setError(error.message);});
    return ()=>{alive.current=false;intent.current++;};
  },[chapter.id,segment.id]);
  useEffect(()=>{
    if(!running || !draft || pending)return;
    let active=true,reading=false;
    const token=intent.current;
    const timer=setInterval(()=>{
      if(reading)return;
      reading=true;
      void readRecord(draft.id).then(value=>{if(active&&alive.current&&intent.current===token)setDraft(value);}).catch(error=>{if(active&&alive.current&&intent.current===token)setError(error.message);}).finally(()=>{reading=false;});
    },1500);
    return ()=>{active=false;clearInterval(timer);};
  },[draft?.id,running,pending]);
  async function prepare(resume=false) {
    if(pending || running || unknown&&!resume&&!retryUnknown)return;
    const token=++intent.current, current=()=>alive.current&&intent.current===token;
    setPending(true);setError("");setApplyUncertain(false);
    try {
      await withSavedDrafts(scope,["segment:"+segment.id],async()=>{
        if(!current())return;
        const revision=draftScopeRevision(scope,chapter.revision);
        if(resume){
          if(!draft || unknown&&!retryUnknown)throw new Error("请先明确是否再次发送结果不明的文本请求。");
          if(!currentDraft)throw new Error("这句或角色资料已改变，旧记录仍保留；请基于当前内容重新安排。");
          await api("/analysis/resume",{id:draft.id,draftVersion:draft.draftVersion,retryUnknown});
          if(!current())return;
          const record=await readRecord(draft.id);
          if(current()){setDraft(record);setRetryUnknown(false);}
        }else{
          const currentPlan=await api<SplitPlan>("/operations/plan",base(revision));
          if(!current())return;
          if(!plan || currentPlan.textRequests!==plan.textRequests || JSON.stringify(currentPlan.memberIds)!==JSON.stringify(plan.memberIds)){
            setPlan(currentPlan);throw new Error("保存后的分析范围已更新，请核对后再次安排。");
          }
          const operation=await submitOperation<{analysis:SplitDraft}>("split:"+chapter.id+":"+segment.id,{...base(revision),model:defaultModel,...(unknown&&retryUnknown?{retryUnknown:true}:{})},stateJobs);
          if(!current())return;
          if(operation.error)throw new Error(operation.error);
          if(!operation.result.analysis)throw new Error("这次分析回执尚未确认，请查看记录；不会自动重发。");
          setDraft(operation.result.analysis);setRetryUnknown(false);
        }
      });
    }catch(error){if(current())setError((error as Error).message);}
    finally{if(current())setPending(false);}
  }
  async function inspect() {
    const token=++intent.current,current=()=>alive.current&&intent.current===token;
    setPending(true);setError("");setRecordsOpen(true);
    try{
      const record=await readRecord();
      if(current()){setDraft(record);setApplyUncertain(false);}
    }catch(error){if(current())setError((error as Error).message);}
    finally{if(current())setPending(false);}
  }
  async function recheck() {
    const token=++intent.current,current=()=>alive.current&&intent.current===token;
    setPending(true);setError("");
    try{const value=await api<SplitPlan>("/operations/plan",base(draftScopeRevision(scope,chapter.revision)));if(current())setPlan(value);}
    catch(error){if(current())setError((error as Error).message);}
    finally{if(current())setPending(false);}
  }
  async function apply() {
    if(!draft || !item || parts.length<2 || !currentDraft || pending || applyUncertain || needsPerformanceConfirmation&&!inheritPerformanceConfirmed)return;
    const token=++intent.current,current=()=>alive.current&&intent.current===token;
    setPending(true);setError("");
    try{
      await withSavedDrafts(scope,["segment:"+segment.id],async()=>{
        if(!current())return;
        const revision=draftScopeRevision(scope,chapter.revision);
        if(revision!==draft.revision)throw new Error("内容已改变，拆分预览仍保留；请重新安排后再应用。");
        let result:SplitDraft;
        try{result=await api<SplitDraft>("/analysis/apply",{id:draft.id,draftVersion:draft.draftVersion,revision,selected:[item.id],...(inheritPerformanceConfirmed?{inheritPerformanceConfirmed:true}:{})});}
        catch(error){
          if((error as {status?:number}).status)throw error;
          if(!current())return;
          try{result=await readRecord(draft.id);}
          catch{if(current())setApplyUncertain(true);throw new Error("拆分回执尚未确认，请先查看这次记录，避免再次应用。");}
          if(result.status!=="applied"){if(current())setApplyUncertain(true);throw new Error("尚未确认拆分是否保存，请先查看这次记录。");}
        }
        if(!current())return;
        setDraft(result);
        const first=result.splitResults?.find(value=>value.segmentId===segment.id)?.childIds[0];
        if(!first)throw new Error("拆分记录尚未完整返回，请查看这次记录。");
        await onApplied(first,current);
        if(current())close();
      });
    }catch(error){if(current())setError((error as Error).message);}
    finally{if(current())setPending(false);}
  }
  async function locateApplied() {
    if(!childId)return;
    const token=++intent.current,current=()=>alive.current&&intent.current===token;
    setPending(true);setError("");
    try{await onApplied(childId,current);if(current())close();}
    catch(error){if(current())setError((error as Error).message);}
    finally{if(current())setPending(false);}
  }
  const busy=pending||locked||!!running;
  return <Dialog title="AI 拆短这条" onClose={close} footer={<div className="semantic-split-actions">
    {childId ? <button className="button primary" disabled={pending} onClick={()=>void locateApplied()}>前往已拆分台词</button>
      : draft?.status==="ready"&&parts.length>=2&&currentDraft ? <button className="button primary" disabled={busy||applyUncertain||needsPerformanceConfirmation&&!inheritPerformanceConfirmed} onClick={()=>void apply()}>应用这 {parts.length} 条</button>
      : unknown ? <button className="button primary" disabled={busy||!retryUnknown} onClick={()=>void prepare(currentDraft)}>再次发送文本请求</button>
      : <button className="button primary" disabled={busy||!plan} onClick={()=>void prepare(draft?.status==="partial"&&resumable)}> {running?"AI 正在安排…":pending?"正在处理…":draft?"重新按语义安排":"让 AI 按语义拆短"}</button>}
    <button className="button secondary" onClick={close}>暂不拆分</button>
  </div>}>
    <p><strong>第 {segment.order+1} 句</strong> · 仅拆分这条台词</p>
    <p className="hint">原文、角色、声音、数值设置和人工表演沿用。只分析文字，不生成声音；应用后这几条需要重新生成，旧声音仍保留。</p>
    {!plan&&!running&&<button className="text-button" disabled={pending} onClick={()=>void recheck()}>重新核对范围</button>}
    <p className="hint">{draft?.status==="ready"&&parts.length>=2&&currentDraft ? "预览已准备。应用拆分不再调用模型，也不产生声音请求。" : `向文本模型发送这句和原文上下文，不发送参考录音。本次预计 ${plan?.textRequests||1} 次文本请求、0 次声音请求。`}</p>
    {unknown&&<div className="warning"><p>这次分析结果尚未确认，可能已计费。原台词和已有声音没有被替换。</p><label className="check-label"><input type="checkbox" checked={retryUnknown} disabled={busy} onChange={event=>setRetryUnknown(event.target.checked)}/>我决定再次发送未完成的文本请求，可能重复计费</label></div>}
    {draft&&!currentDraft&&!childId&&<p className="warning">这句或角色资料已改变，预览仅供查看；请基于当前内容重新安排。</p>}
    {item?.splitIssue&&!childId&&<p className="warning">{item.splitIssue}</p>}
    {needsPerformanceConfirmation&&!childId&&<label className="check-label"><input type="checkbox" checked={inheritPerformanceConfirmed} disabled={busy} onChange={event=>setInheritPerformanceConfirmed(event.target.checked)}/>我已核对下方各条，决定沿用原表演指导：{segment.performance}</label>}
    {!!item?.issues?.length&&<p className="error-inline">{item.issues.join("；")}</p>}
    {parts.length>=2 ? <section className="semantic-split-preview" aria-label="语义拆分预览"><h3>{childId?"已拆分":"将拆为"} {parts.length} 条</h3><ol>{parts.map((text,index)=><li key={index}><p>{text}</p></li>)}</ol><p className="hint">只按语义划分原正文，字数不代表精确音频时长。应用会一次保存全部新台词。</p></section>
      : <p className="original-excerpt">{segment.text}</p>}
    {draft&&!running&&!unknown&&!parts.length&&!item?.splitIssue&&<p className="hint">这次没有可用的拆分建议，当前台词保留。</p>}
    {draft&&<><button className="text-button" disabled={pending} onClick={()=>void inspect()}>查看这次记录</button>{recordsOpen&&<section className="semantic-split-record" aria-label="这次文本分析记录"><p>{draft.model} · {running?"正在分析":unknown?"结果不明":childId?"拆分已应用":draft.status==="ready"?"预览已准备": "尚未完成"}</p>{draft.batches?.map((batch,index)=><p key={batch.id}>第 {index+1} 次请求 · {batch.status==="received"?"已收到结果":batch.status==="unknown"?"结果不明":batch.status==="sending"?"正在请求":"未完成"}{batch.error&&" · "+batch.error}</p>)}</section>}</>}
    {draft?.error&&<p className="error-inline">{draft.error}</p>}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}
