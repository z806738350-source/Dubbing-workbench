import { api } from "./api";
import type { Job } from "./types";

export type TaskOperation<T = Record<string, unknown>> = {
  operationId: string;
  kind: string;
  outcome: "completed" | "prepared" | "needsInput" | "processing" | "unknown";
  steps: Record<string, unknown>;
  jobIds: string[];
  createdObjectIds: string[];
  result: T;
  error?: string;
  errorStatus?: number;
  code?:string;
  scope?:Record<string,unknown>;
  retryClass?:string;
};

// The current draft owner survives reloads and stays distinct in copied tabs.
const storageKey = (key: string) => "workbench-operation/" + encodeURIComponent(sessionStorage.getItem("workbench-workspace")||'') + "/" + (sessionStorage.getItem("draft-owner") || "page") + "/" + key;
const failedWithoutEffects = (receipt: TaskOperation<unknown>) => receipt.outcome === "needsInput" && receipt.errorStatus === 409 &&
  Array.isArray(receipt.jobIds) && !receipt.jobIds.length && Array.isArray(receipt.createdObjectIds) && !receipt.createdObjectIds.length &&
  !!receipt.steps && typeof receipt.steps === "object" && !Object.keys(receipt.steps).length &&
  (!receipt.result || typeof receipt.result === "object" && Object.keys(receipt.result).every(key => key === "plan"));

type OperationRecord = {operationId:string;payload:Record<string,unknown>;receipt?:TaskOperation<unknown>;compactReceipt?:boolean;updatedAt?:number};
const activeRecords=new Map<string,number>();
const analysisOf = (receipt?:TaskOperation<unknown>) => (receipt?.result as {analysis?:{status:string;batches?:{status:string}[];performanceRepairs?:{status:string}[]}}|undefined)?.analysis;
const unknownResult = (receipt?:TaskOperation<unknown>) => receipt?.outcome === 'unknown' || analysisOf(receipt)?.status === 'unknown' ||
  !!analysisOf(receipt)?.batches?.some(batch=>batch.status==='unknown') || !!analysisOf(receipt)?.performanceRepairs?.some(batch=>batch.status==='unknown');
function compactRecord(record:OperationRecord):OperationRecord {
  if(!record.receipt)return record;
  const {operationId,kind,outcome,jobIds,createdObjectIds,errorStatus,code,retryClass}=record.receipt;
  const analysis=analysisOf(record.receipt),result=record.receipt.result;
  return {...record,compactReceipt:true,receipt:{operationId,kind,outcome,jobIds,createdObjectIds,errorStatus,code,retryClass,
    steps:Object.fromEntries(Object.keys(record.receipt.steps).map(key=>[key,true])),
    result:result&&typeof result==='object' ? Object.fromEntries(Object.keys(result).map(key=>[key,key==='analysis'&&analysis ? {
      status:analysis.status,batches:analysis.batches?.map(batch=>({status:batch.status})),performanceRepairs:analysis.performanceRepairs?.map(batch=>({status:batch.status}))
    }:true])) : result ? {value:true} : result,
  }};
}

// Full receipts remain in the server database; browser records only guard recovery and duplicate requests.
export async function compactOperationStorage(preserveKey?:string,refreshJobs=false) {
  const owner=sessionStorage.getItem('draft-owner')||'page',workspace=sessionStorage.getItem('workbench-workspace')||'';
  const workspacePrefix='workbench-operation/'+encodeURIComponent(workspace)+'/',signal=refreshJobs?AbortSignal.timeout(2500):undefined;
  const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter((key):key is string=>!!key?.startsWith('workbench-operation/'));
  const owners=[...new Set(keys.map(key=>key.split('/')[2]))].sort((a,b)=>Number(b===owner)-Number(a===owner));
  let completedBytes=0;
  for(const page of owners){
    const compact=async()=>{
      const records=keys.filter(key=>key.split('/')[2]===page&&key!==preserveKey&&!activeRecords.has(key)).flatMap(key=>{
        const raw=localStorage.getItem(key);
        try{
          const record:OperationRecord=JSON.parse(raw!);
          if(!record?.operationId||!record.payload||typeof record.payload!=='object'||Array.isArray(record.payload)||!record.receipt||record.receipt.operationId!==record.operationId||
            !['completed','prepared','needsInput','processing','unknown'].includes(record.receipt.outcome)||!record.receipt.steps||
            typeof record.receipt.steps!=='object'||!Array.isArray(record.receipt.jobIds)||!Array.isArray(record.receipt.createdObjectIds))return [];
          const next=JSON.stringify(compactRecord(record)),terminal=record.receipt.outcome==='completed'&&!unknownResult(record.receipt)&&analysisOf(record.receipt)?.status!=='running';
          return [{key,raw,record,next,terminal}];
        }catch{return [];}
      }).sort((a,b)=>(b.record.updatedAt||0)-(a.record.updatedAt||0));
      for(const item of records){
        const {key,raw,record}=item;
        if(signal&&!signal.aborted&&key.startsWith(workspacePrefix)&&record.receipt!.outcome==='processing'&&
          record.receipt!.jobIds.length&&typeof record.payload.chapterId==='string'&&!unknownResult(record.receipt)&&analysisOf(record.receipt)?.status!=='running'&&
          (sessionStorage.getItem('workbench-workspace')||'')===workspace&&!activeRecords.has(key)){
          try{
            let successful=true;
            for(const id of record.receipt!.jobIds){
              if(typeof id!=='string'){successful=false;break;}
              const job=await api<{id:string;chapterId:string;workspaceIdentity:string;status:string}>('/jobs/'+encodeURIComponent(id)+'/progress',undefined,undefined,{signal});
              if(job.id!==id||job.chapterId!==record.payload.chapterId||job.workspaceIdentity!==workspace||job.status!=='success'){successful=false;break;}
            }
            if((sessionStorage.getItem('workbench-workspace')||'')!==workspace)continue;
            if(successful){record.receipt!.outcome='completed';item.next=JSON.stringify(compactRecord(record));item.terminal=true;}
          }catch{/* Unconfirmed jobs retain their recovery guard; quota recovery never resends them. */}
        }
        if(localStorage.getItem(key)!==raw||activeRecords.has(key))continue;
        const {next,terminal}=item;
        if(terminal){
          const bytes=2*(key.length+next.length);
          if(completedBytes+bytes>1024**2){localStorage.removeItem(key);continue;}
          completedBytes+=bytes;
        }
        if(next.length<raw!.length)try{localStorage.setItem(key,next);}catch{/* Keep the existing recovery record if storage is unavailable. */}
      }
    };
    if(page===owner)await compact();
    else if(typeof navigator!=='undefined'&&navigator.locks)await navigator.locks.request('workbench-drafts-'+page,{ifAvailable:true},async lock=>{if(lock)await compact();});
  }
}
let compacted=false;

export async function submitOperation<T>(key: string, payload: Record<string, unknown>, jobs: Job[] = []): Promise<TaskOperation<T>> {
  const workspaceIdentity=sessionStorage.getItem("workbench-workspace")||'',recordKey = storageKey(key);
  activeRecords.set(recordKey,(activeRecords.get(recordKey)||0)+1);
  try {
  if(!compacted){await compactOperationStorage(recordKey);compacted=true;}
  let savedRaw = localStorage.getItem(recordKey);
  let record:OperationRecord|null = savedRaw ? JSON.parse(savedRaw) : null;
  const persist=async()=>{
    const next=JSON.stringify(compactRecord(record!));
    const unchanged=()=>localStorage.getItem(recordKey)===savedRaw;
    if(!unchanged())throw Object.assign(new Error('本地操作记录已更新，请恢复最新操作后继续。'),{retryClass:'check-existing-operation'});
    try{localStorage.setItem(recordKey,next);}
    catch(error){
      await compactOperationStorage(recordKey,(error as {name?:string}).name==='QuotaExceededError');
      if(!unchanged())throw Object.assign(new Error('本地操作记录已更新，请恢复最新操作后继续。'),{retryClass:'check-existing-operation'});
      try{localStorage.setItem(recordKey,next);}
      catch{throw Object.assign(new Error('浏览器本地存储空间不足或不可用，操作编号未能保存。已有草稿和待恢复操作已保留，请释放浏览器存储后重试。'),{storageFailure:true});}
    }
    savedRaw=next;
  };
  const acknowledge=async(receipt:TaskOperation<T>)=>{
    record!.receipt=receipt;record!.compactReceipt=true;record!.updatedAt=Date.now();
    try{await persist();}
    catch(error){
      // The initial durable ID is enough to recover a known server success when the summary cannot fit.
      if(!(error as {storageFailure?:boolean}).storageFailure||!savedRaw||localStorage.getItem(recordKey)!==savedRaw||JSON.parse(savedRaw).operationId!==record!.operationId)throw error;
    }
    window.dispatchEvent(new Event('workbench-operation'));
    return receipt;
  };
  const changed = !!record && JSON.stringify(record.payload) !== JSON.stringify(payload);
  let refreshed = false;
  if (record && (!record.receipt || record.compactReceipt || changed || record.payload.kind === "prepareChapter")) {
    const incomplete=record.compactReceipt;
    try {
      const receipt=await api<TaskOperation<T>>("/operations/" + record.operationId);
      if(receipt.operationId!==record.operationId)throw new Error('操作回执编号不一致');
      await acknowledge(receipt);
      refreshed = true;
    } catch (error) {
      if((error as {retryClass?:string}).retryClass==='check-existing-operation')throw error;
      const explicitRetry=unknownResult(record.receipt)&&payload.retryUnknown===true;
      const completed=record.receipt?.outcome==='completed'&&!unknownResult(record.receipt);
      if (changed && (!record.receipt || incomplete&&!explicitRetry&&!completed&&!unknownResult(record.receipt))) throw new Error("上一次操作回执尚未确认，请先恢复该次操作，再修改范围或授权。");
    }
  }
  const analysis = analysisOf(record?.receipt);
  const unknown = unknownResult(record?.receipt);
  const finished = (!!record?.receipt?.jobIds?.length && record.receipt.jobIds.every(id => jobs.some(job => job.id === id && !["queued", "running", "unknown"].includes(job.status)))) || (refreshed && !!analysis && !unknown && analysis.status !== "running");
  if (unknown && payload.retryUnknown !== true) throw new Error("上一次结果不明，可能已计费；请先明确决定是否再次发送请求。");
  if (changed && record?.receipt?.outcome === "processing" && !finished) throw new Error("上一次操作仍在处理中，请先查看结果，再发起新的制作。");
  if (changed && record?.payload.kind === "groupAndGenerate" && record.receipt?.createdObjectIds.length && !finished) {
    if(record.compactReceipt&&!refreshed)throw new Error('上一次操作回执尚未确认，请先恢复该次操作，再修改范围或授权。');
    return record.receipt as TaskOperation<T>;
  }
  if((sessionStorage.getItem("workbench-workspace")||'')!==workspaceIdentity)throw new Error("工作区已变化，原操作仍保留在原工作区；请重新打开目标后继续。");
  if (!record || changed || finished || (unknown && payload.retryUnknown === true)) {
    record = { operationId: crypto.randomUUID(), payload };
    await persist();
  }
  if((sessionStorage.getItem("workbench-workspace")||'')!==workspaceIdentity)throw new Error("工作区已变化，原操作仍保留在原工作区；请重新打开目标后继续。");
  let receipt:TaskOperation<T>;
  try {
    receipt = await api<TaskOperation<T>>("/operations", { ...record.payload, operationId: record.operationId });
  } catch (error) {
    // A lost response may follow a committed write. Query that operation before offering a retry.
    const info=error as {status?:number;retryClass?:string;notApplied?:boolean};
    const conflict=info.status===409 && (info.notApplied===true || ["refresh","refresh-and-review"].includes(info.retryClass||""));
    if (!info.status || info.retryClass==='check-existing-operation' || conflict) {
      const unchangedWorkspace=()=>sessionStorage.getItem("workbench-workspace")===workspaceIdentity || !workspaceIdentity&&!sessionStorage.getItem("workbench-workspace");
      const discardUnsent=()=>{
        if(!unchangedWorkspace() || record.receipt&&!failedWithoutEffects(record.receipt) || localStorage.getItem(recordKey)!==savedRaw)return false;
        localStorage.removeItem(recordKey);return true;
      };
      if(!unchangedWorkspace())throw Object.assign(error as Error,{retryClass:'check-existing-operation'});
      let recovered:TaskOperation<T>|undefined;
      try {
        recovered = await api<TaskOperation<T>>("/operations/" + record.operationId);
      } catch (readError) {
        if(conflict && (readError as {status?:number;retryClass?:string}).status===404 && (readError as {retryClass?:string}).retryClass!=='check-existing-operation' && discardUnsent())throw error;
        if(conflict)throw Object.assign(error as Error,{retryClass:'check-existing-operation'});
      }
      if(recovered){
        if(!unchangedWorkspace() || recovered.operationId!==record.operationId)throw Object.assign(error as Error,{retryClass:'check-existing-operation'});
        if(conflict&&failedWithoutEffects(recovered)){
          if(!discardUnsent())throw Object.assign(error as Error,{retryClass:'check-existing-operation'});
          return recovered;
        }
        return acknowledge(recovered);
      }
    }
    throw error;
  }
  return acknowledge(receipt);
  } finally {
    const count=activeRecords.get(recordKey)!;
    if(count>1)activeRecords.set(recordKey,count-1);else activeRecords.delete(recordKey);
  }
}
