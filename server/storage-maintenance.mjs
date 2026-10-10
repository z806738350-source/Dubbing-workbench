import { existsSync, statSync, unlinkSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { buildMaster } from './audio.mjs';
import { audioDigest } from './audio-delivery.mjs';
import { renderIdentity, renderMatches, renderProfileOf } from './audio-range.mjs';
import { assertMasterRecipe, deletionPath, historicalMasterRows, projectFile, recordFiles, verifyRebuiltMaster } from './workspace.mjs';
import { fail, same, uid } from './store.mjs';

const fingerprint=file=>{const s=statSync(file);if(!s.isFile())fail('历史母版不是普通文件',409);return [s.dev,s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');};
const audioProof=(audio,range)=>range?.sourceHash || audio.processing?.resultSha256 || audio.delivery?.rawSha256;

export function createStorageMaintenance(store,{currentRows}={}) {
  const reads=new Map(),restoring=new Map();
  let cleanupCursor=0;
  const normalized=file=>resolve(store.directory,file);
  function acquireRead(file) {
    const key=normalized(file);reads.set(key,(reads.get(key)||0)+1);let released=false;
    return ()=>{if(released)return;released=true;const count=reads.get(key)-1;if(count)reads.set(key,count);else reads.delete(key);};
  }
  function masterFile(master) {
    if(!master.path || !/(^|\/)masters\/[^/]+\.wav$/.test(master.path) || basename(master.path)!==master.id+'.wav')fail('历史母版路径不属于母版目录',409);
    return deletionPath(store,master.path);
  }
  function protectedMasters(masters,ownRestoreId) {
    const protectedIds=new Map(),paths=new Set(),add=(id,reason)=>{if(id)protectedIds.set(id,reason);};
    const refs=value=>{if(!value || typeof value!=='object')return;if(value.masterId)add(value.masterId,'助手或恢复引用');if(value.kind==='master')add(value.id,'助手成品引用');for(const child of Object.values(value))if(child&&typeof child==='object')refs(child);};
    for(const chapter of store.all('chapters')) {
      const chapterMasters=masters.filter(m=>m.chapterId===chapter.id&&!m.invalid);
      let identity;try{identity=renderIdentity(store,chapter.id,currentRows?.(chapter.id));}catch{}
      for(const master of chapterMasters)if(!master.superseded&&master.arrangement===chapter.arrangement&&(!identity || renderMatches(master,identity)))add(master.id,'当前母版');
      chapterMasters.filter(m=>m.path&&existsSync(normalized(m.path))).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||'')||b.id.localeCompare(a.id)).slice(0,2).forEach(m=>add(m.id,'每章最近两个版本'));
    }
    for(const exported of store.all('exports'))add(exported.masterId,'导出依赖');
    for(const attachment of store.all('assistantAttachments')){refs(attachment);for(const file of recordFiles(attachment))paths.add(normalized(file));}
    for(const step of store.all('assistantSteps'))refs(step.resultRefs);
    for(const run of store.all('assistantRuns'))refs(run.delivery);
    const attempts=store.all('attempts');
    const jobs=store.db.prepare("SELECT json_remove(data,'$.renderRows','$.request','$.confirmation','$.outputRecords.master.mapping') AS data FROM jobs").all().map(row=>JSON.parse(row.data));
    for(const job of jobs) {
      const pending=['queued','running','unknown'].includes(job.status)||job.localOutputPending||attempts.some(a=>a.jobId===job.id&&(a.status==='unknown'||a.phase==='localRecoveryPending'));
      if(!pending)continue;
      const ids=[job.masterId,job.result?.masterId,job.outputRecords?.master?.id,job.outputRecords?.export?.masterId].filter(Boolean);
      ids.forEach(id=>add(id,'在途或未知恢复'));
      for(const output of Object.values(job.outputRecords||{}))for(const file of recordFiles(output))paths.add(normalized(file));
      if(!ids.length&&['master','export'].includes(job.kind))masters.filter(m=>m.chapterId===job.chapterId).forEach(m=>add(m.id,'未定位的成品恢复'));
    }
    for(const [id]of restoring)if(id!==ownRestoreId)add(id,'正在本地重建');
    for(const master of masters)if(reads.has(normalized(master.path||''))||paths.has(normalized(master.path||'')))add(master.id,'正在读取或附件路径依赖');
    // Other records sharing a path still own those bytes, even after a result was superseded.
    for(const table of ['audios','voices','exports'])for(const row of store.all(table))for(const file of recordFiles(row))paths.add(normalized(file));
    const owners=new Map();for(const master of masters)owners.set(master.path,(owners.get(master.path)||0)+1);
    for(const master of masters)if(paths.has(normalized(master.path||''))||owners.get(master.path)>1)add(master.id,'共用文件依赖');
    return protectedIds;
  }
  function recipeSources(master) {
    assertMasterRecipe(master);masterFile(master);
    const job=master.jobId&&store.maybe('jobs',master.jobId);
    return master.mapping.map((mapping,index)=>{
      const current=store.maybe('audios',mapping.audioId),frozen=job?.renderRows?.[index];
      if(!current?.path || current.invalid || !existsSync(deletionPath(store,current.path)))fail('原音缺失或损坏，保留历史母版',409);
      const audio=frozen?.a?.id===mapping.audioId?{...current,...frozen.a,path:current.path}:current;
      const range=mapping.sourceHash?{sourceHash:mapping.sourceHash}:null,proof=audioProof(audio,range);
      if(!proof)fail('原音没有既有字节凭据，保留历史母版',409);
      if(mapping.sourceHash && (!mapping.decodeProfile || !store.maybe('units',mapping.unitId||mapping.segmentId)))fail('历史裁剪归属或解码版本缺失，保留历史母版',409);
      return {audio,proof,file:deletionPath(store,current.path)};
    });
  }
  function planMasterCleanup() {
    const masters=store.all('masters'),protectedIds=protectedMasters(masters),candidates=[],retained=[],skipped=[];
    for(const master of masters) {
      if(protectedIds.has(master.id)){retained.push({id:master.id,reason:protectedIds.get(master.id)});continue;}
      try {
        const file=masterFile(master);if(!existsSync(file))continue;
        if(master.invalid)fail('母版已标记无效，保留以便核对',409);
        recipeSources(master);const info=statSync(file);if(!info.isFile())fail('母版不是普通文件',409);
        candidates.push({id:master.id,chapterId:master.chapterId,path:master.path,bytes:info.size});
      }catch(error){skipped.push({id:master.id,reason:error.message});}
    }
    return {candidates,retained,skipped,bytes:candidates.reduce((sum,item)=>sum+item.bytes,0)};
  }
  async function verifySources(master,checks=new Map(),signal) {
    const versions=[];
    for(const {file,proof}of recipeSources(master)) {
      signal?.throwIfAborted();
      const version=fingerprint(file),key=file+':'+version;
      if(!checks.has(key))checks.set(key,audioDigest(file,{signal}));
      const digest=await checks.get(key);
      signal?.throwIfAborted();
      if(digest.sha256!==proof || fingerprint(file)!==version)fail('原音字节已变化，保留历史与原配方',409);
      versions.push([file,version]);
    }
    return ()=>{for(const [file,version]of versions)if(fingerprint(file)!==version)fail('原音在本地处理期间已变化，保留历史',409);};
  }
  async function temporaryMaster(master,signal) {
    signal?.throwIfAborted();
    const rows=await historicalMasterRows(store,master,{signal}),id=uid(),file=deletionPath(store,projectFile(store,master.chapterId,'masters',id+'.wav'));let rebuilt;
    try {signal?.throwIfAborted();rebuilt=await buildMaster(store,rows,master.gapFrames/48000,id,renderProfileOf(master),{signal});signal?.throwIfAborted();verifyRebuiltMaster(master,rebuilt);return {rebuilt,file:deletionPath(store,rebuilt.path)};}
    catch(error){await rm(file,{force:true});await rm(file+'.part',{force:true});throw error;}
  }
  async function ensureMasterFile(id) {
    if(restoring.has(id)){await restoring.get(id);return ensureMasterFile(id);}
    const master=store.get('masters',id);
    if(master.path&&existsSync(deletionPath(store,master.path)))return master;
    const pending=(async()=>{
      const unchanged=await verifySources(master),temporary=await temporaryMaster(master);
      try {
        unchanged();const current=store.get('masters',id);
        if(!same(current,master))fail('历史母版记录已变化，稍后按原编号重试',409);
        await rename(temporary.file,masterFile(master));
        return current;
      }finally{await rm(temporary.file,{force:true});}
    })();
    restoring.set(id,pending);try{return await pending;}finally{restoring.delete(id);}
  }
  async function cleanupMasters({limit=Infinity,signal}={}) {
    if(!(limit===Infinity || Number.isSafeInteger(limit)&&limit>=0))fail('母版回收数量无效');
    const result={reclaimed:[],skipped:[],bytes:0},checks=new Map();let attempted=0;
    if(!limit)return result;
    if(signal?.aborted)return {...result,aborted:true};
    const positions=new Map(store.db.prepare('SELECT id,rowid FROM masters ORDER BY rowid').all().map(row=>[row.id,row.rowid]));
    const candidates=planMasterCleanup().candidates,start=candidates.findIndex(item=>positions.get(item.id)>cleanupCursor);
    const ordered=start>0?[...candidates.slice(start),...candidates.slice(0,start)]:candidates;
    for(const candidate of ordered) {
      if(attempted>=limit || signal?.aborted)break;
      if(restoring.has(candidate.id))continue;
      attempted++;cleanupCursor=positions.get(candidate.id);
      const master=store.get('masters',candidate.id);
      const pending=(async()=>{
        let temporary;
        try {
          signal?.throwIfAborted();
          const file=masterFile(master),version=fingerprint(file),unchanged=await verifySources(master,checks,signal);
          temporary=await temporaryMaster(master,signal);
          const [original,rebuilt]=await Promise.all([audioDigest(file,{signal}),audioDigest(temporary.file,{signal})]);
          signal?.throwIfAborted();
          if(original.bytes!==rebuilt.bytes || original.sha256!==rebuilt.sha256)fail('本地重建与历史 WAV 字节不一致，保留原文件',409);
          unchanged();
          // Ignore our own rebuild lock; freshly acquired reads and new output references still protect the file.
          const protectedIds=protectedMasters(store.all('masters'),master.id);
          if(protectedIds.has(master.id)||!same(store.get('masters',master.id),master)||fingerprint(file)!==version)fail('母版现在仍被使用，保留文件',409);
          signal?.throwIfAborted();
          store.put('masters',{...master,fileReclaimedAt:new Date().toISOString()},master.chapterId);
          try{unlinkSync(file);}catch(error){store.put('masters',master,master.chapterId);throw error;}
          result.reclaimed.push(candidate);result.bytes+=original.bytes;
        }catch(error){if(!signal?.aborted)result.skipped.push({id:master.id,reason:error.message});}
        finally{if(temporary)await rm(temporary.file,{force:true});}
      })();
      restoring.set(master.id,pending);try{await pending;}finally{restoring.delete(master.id);}
    }
    if(signal?.aborted)result.aborted=true;
    return result;
  }
  return {planMasterCleanup,cleanupMasters,ensureMasterFile,acquireRead,get readPaths(){return [...reads.keys()];},get restoringCount(){return restoring.size;}};
}
