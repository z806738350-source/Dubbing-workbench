import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Web Storage counts UTF-16 keys and values, replaces atomically, and exposes key()/length.
class QuotaStorage {
  constructor(quota=5*1024**2,entries=[]){this.quota=quota;this.values=new Map(entries);this.quotaErrors=0;this.removed=[];}
  get length(){return this.values.size;}
  key(index){return [...this.values.keys()][index]??null;}
  get bytes(){return [...this.values].reduce((total,[key,value])=>total+2*(key.length+value.length),0);}
  getItem(key){return this.values.get(String(key))??null;}
  setItem(key,value){
    key=String(key);value=String(value);const old=this.values.get(key);
    if(this.bytes-(old===undefined?0:2*(key.length+old.length))+2*(key.length+value.length)>this.quota){this.quotaErrors++;throw new DOMException('Quota exceeded','QuotaExceededError');}
    this.values.set(key,value);
  }
  removeItem(key){key=String(key);this.removed.push(key);this.values.delete(key);}
}
const operationKey=key=>'workbench-operation/%2Ffixture/test-page/'+key;
const payload={kind:'generateSelection',chapterId:'fixture-chapter',revision:1,ids:['one']};
const receipt=(operationId,extra={})=>({operationId,kind:payload.kind,outcome:'processing',jobIds:['known-job'],createdObjectIds:[],steps:{},result:{},...extra});
const large='x'.repeat(2*1024**2);
const durable=(operationId,request,result)=>JSON.stringify({operationId,payload:request,receipt:result});
async function setup(t,storage,call){
  const values={localStorage:storage,sessionStorage:new QuotaStorage(),window:{dispatchEvent(){}},navigator:{locks:{request:async(name,_options,callback)=>callback({name}),query:async()=>({held:[],pending:[]})}},taskOperationStorageApi:call};
  for(const [name,value] of Object.entries(values)){
    const before=Object.getOwnPropertyDescriptor(globalThis,name);Object.defineProperty(globalThis,name,{configurable:true,writable:true,value});
    t.after(()=>before?Object.defineProperty(globalThis,name,before):delete globalThis[name]);
  }
  sessionStorage.setItem('draft-owner','test-page');sessionStorage.setItem('workbench-workspace','/fixture');
  const source=readFileSync(new URL('../src/taskOperations.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replace('import { api } from "./api";','const api = globalThis.taskOperationStorageApi;');
  return import('data:text/javascript;base64,'+Buffer.from(compiled+'\n//'+crypto.randomUUID()).toString('base64'));
}

test('4MiB legacy receipt migrates to a small same-key guard; drafts, pending saves and unrecognised records stay byte-for-byte',async t=>{
  const key=operationKey('legacy'),legacy=receipt('legacy-operation',{outcome:'completed',result:{chapter:{source:large}}});
  const preserved=new Map([
    ['draft-workspace/%2Ffixture/segment:one:test-page',JSON.stringify({draft:{text:'保留人工台词'},revision:7})],
    ['pending-save:workspace/%2Ffixture/test-page:segment:one',JSON.stringify({operationId:'save-operation',payload:{text:'保留待提交内容'}})],
    [operationKey('unresolved'),JSON.stringify({operationId:'unresolved-operation',payload:{...payload,revision:2}})],
    [operationKey('malformed'),'{original unreadable record'],
    [operationKey('future'),JSON.stringify({operationId:'future-operation',payload:null,receipt:{future:true}})],
  ]);
  const storage=new QuotaStorage(5*1024**2,[[key,durable(legacy.operationId,payload,legacy)],...preserved]);
  assert.ok(storage.getItem(key).length*2>4*1024**2);assert.equal(storage.length,6);assert.equal(storage.key(0),key);
  const original=storage.getItem(key);assert.throws(()=>storage.setItem(key,original+large),error=>error.name==='QuotaExceededError');assert.equal(storage.getItem(key),original,'failed replacement must be atomic');
  const module=await setup(t,storage,()=>assert.fail('migration is local and sends no API request'));
  await module.compactOperationStorage();
  const compact=JSON.parse(storage.getItem(key));assert.equal(compact.operationId,legacy.operationId);assert.deepEqual(compact.payload,payload);assert.equal(compact.receipt.outcome,'completed');assert.deepEqual(compact.receipt.jobIds,['known-job']);assert.ok(storage.getItem(key).length*2<8192);
  for(const [name,raw] of preserved)assert.equal(storage.getItem(name),raw,name);assert.deepEqual(storage.removed,[]);
});

test('malformed nested analysis arrays do not block startup migration or a fresh operation, and their original records remain untouched',async t=>{
  const preserved=new Map();
  for(const [name,analysis] of [['nonarray-batches',{status:'partial',batches:'future-shape'}],['null-batch',{status:'partial',batches:[null]}],['nonarray-repairs',{status:'partial',performanceRepairs:1}],['null-repair',{status:'partial',performanceRepairs:[null]}]]){
    const operationId=name+'-operation';preserved.set(operationKey(name),durable(operationId,payload,receipt(operationId,{outcome:'completed',jobIds:[],result:{analysis}})));
  }
  const storage=new QuotaStorage(5*1024**2,preserved),calls=[];
  const {compactOperationStorage,submitOperation}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/operations');return receipt(body.operationId);});
  await compactOperationStorage();for(const [key,raw] of preserved)assert.equal(storage.getItem(key),raw);
  const result=await submitOperation('new',payload);assert.equal(result.outcome,'processing');assert.equal(calls.length,1);for(const [key,raw] of preserved)assert.equal(storage.getItem(key),raw);assert.deepEqual(storage.removed,[]);
});

test('a huge acknowledged receipt returns in full after one POST, while only the compact guard is persisted',async t=>{
  const storage=new QuotaStorage(),calls=[];let acknowledged;
  const {submitOperation}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/operations');acknowledged=receipt(body.operationId,{outcome:'completed',result:{chapter:{source:large},marker:'完整服务端结果'}});return acknowledged;});
  const result=await submitOperation('huge',payload);
  assert.equal(result,acknowledged);assert.equal(result.result.chapter.source,large);assert.deepEqual(calls.map(call=>call.path),['/operations']);assert.equal(storage.quotaErrors,0);
  const compact=JSON.parse(storage.getItem(operationKey('huge')));assert.equal(compact.operationId,result.operationId);assert.deepEqual(compact.payload,payload);assert.ok(storage.getItem(operationKey('huge')).length*2<8192);
});

test('receipt persistence reclaims a late legacy receipt on real quota pressure without treating success as a network failure',async t=>{
  const storage=new QuotaStorage(),calls=[];let acknowledged,protectedRaw;
  const {submitOperation}=await setup(t,storage,async(path,body)=>{
    calls.push({path,body});assert.equal(path,'/operations');
    storage.setItem(operationKey('late-legacy'),durable('late-operation',payload,receipt('late-operation',{outcome:'completed',result:{chapter:{source:large}}})));
    const draftKey='draft-protected',remaining=Math.floor((storage.quota-storage.bytes)/2)-draftKey.length;protectedRaw='d'.repeat(remaining);storage.setItem(draftKey,protectedRaw);
    acknowledged=receipt(body.operationId,{outcome:'completed',result:{chapter:{source:large}}});return acknowledged;
  });
  assert.equal(await submitOperation('quota-retry',payload),acknowledged);assert.ok(storage.quotaErrors>=1);assert.equal(calls.length,1);assert.equal(storage.getItem('draft-protected'),protectedRaw);assert.equal(JSON.parse(storage.getItem(operationKey('late-legacy'))).operationId,'late-operation');assert.ok(storage.getItem(operationKey('late-legacy')).length*2<8192);assert.deepEqual(storage.removed,[]);
});

test('unreclaimable initial quota fails before any POST and preserves drafts and pending-save commands',async t=>{
  const preserved=new Map([['draft-protected','d'.repeat(600)],['pending-save:protected',JSON.stringify({operationId:'pending-save',payload:{text:'s'.repeat(500)}})]]),storage=new QuotaStorage(3072,preserved),calls=[];
  const {submitOperation}=await setup(t,storage,async(...args)=>{calls.push(args);assert.fail('must not dispatch without a durable ID');});
  await assert.rejects(submitOperation('too-full',{...payload,text:'p'.repeat(1200)}),/浏览器.*存储.*空间/);
  assert.equal(calls.length,0);assert.equal(storage.getItem(operationKey('too-full')),null);for(const [key,raw] of preserved)assert.equal(storage.getItem(key),raw);assert.deepEqual(storage.removed,[]);
});

test('an acknowledged POST still returns the full receipt when new drafts fill storage; the original durable ID stays and no recovery GET runs',async t=>{
  const pendingRaw=JSON.stringify({operationId:'pending-save',payload:{text:'保留待保存台词'}}),storage=new QuotaStorage(3072,[['pending-save:protected',pendingRaw]]),calls=[];let acknowledged,initialGuard,draftRaw;
  const {submitOperation}=await setup(t,storage,async(path,body)=>{
    calls.push({path,body});assert.equal(path,'/operations');initialGuard=storage.getItem(operationKey('acknowledged'));
    assert.equal(JSON.parse(initialGuard).operationId,body.operationId);
    const key='draft-added-while-requesting';draftRaw='d'.repeat(Math.floor((storage.quota-storage.bytes)/2)-key.length);storage.setItem(key,draftRaw);
    acknowledged=receipt(body.operationId,{outcome:'completed',result:{chapter:{source:large}}});return acknowledged;
  });
  const result=await submitOperation('acknowledged',payload);assert.equal(result,acknowledged);assert.equal(result.result.chapter.source,large);assert.deepEqual(calls.map(call=>call.path),['/operations']);assert.equal(storage.quotaErrors,2,'one failed receipt write plus its single quota retry');
  assert.equal(storage.getItem(operationKey('acknowledged')),initialGuard);assert.deepEqual(JSON.parse(initialGuard).payload,payload);assert.equal(storage.getItem('pending-save:protected'),pendingRaw);assert.equal(storage.getItem('draft-added-while-requesting'),draftRaw);assert.deepEqual(storage.removed,[]);
});

test('same-page quota reclamation skips an operation awaiting its legacy GET, and its finally releases the record for later compaction',async t=>{
  const groupPayload={kind:'groupAndGenerate',chapterId:'fixture-chapter',ids:['one','two']},prepared=receipt('group-operation',{kind:groupPayload.kind,outcome:'prepared',jobIds:[],createdObjectIds:['known-unit'],result:{unit:{id:'known-unit',members:['one','two'],text:large}}}),aKey=operationKey('waiting-group'),aRaw=durable(prepared.operationId,groupPayload,prepared),storage=new QuotaStorage(5*1024**2,[[aKey,aRaw]]),calls=[];let releaseA;
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{
    calls.push({path,body});if(path==='/operations/group-operation'){assert.equal(body,undefined);return new Promise(resolve=>releaseA=()=>resolve(prepared));}
    assert.equal(path,'/operations');assert.equal(body.kind,'generateSelection');return receipt(body.operationId);
  });
  const a=submitOperation('waiting-group',{...groupPayload,revision:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof releaseA,'function');assert.equal(storage.getItem(aKey),aRaw);
  const reclaimKey=operationKey('late-completed');storage.setItem(reclaimKey,durable('completed-operation',payload,receipt('completed-operation',{outcome:'completed',result:{source:'c'.repeat(384*1024)}})));
  const bPayload={...payload,text:'b'.repeat(256*1024)},b=await submitOperation('large-new-operation',bPayload);
  assert.equal(b.outcome,'processing');assert.ok(storage.quotaErrors>=1);assert.equal(storage.getItem(aKey),aRaw,'the first operation still owns the exact raw value used by its CAS');assert.ok(storage.getItem(reclaimKey).length*2<8192);assert.equal(calls.filter(call=>call.body).length,1);
  releaseA();const restored=await a;assert.equal(restored,prepared);assert.equal(restored.result.unit.text,large);assert.deepEqual(JSON.parse(storage.getItem(aKey)).payload,groupPayload);
  storage.setItem(aKey,aRaw);await compactOperationStorage();assert.ok(storage.getItem(aKey).length*2<8192,'after finally, the same key is no longer protected as in-flight');assert.equal(JSON.parse(storage.getItem(aKey)).operationId,prepared.operationId);
});

test('quota recovery may retire an old processing payload only after every original job succeeds in its exact workspace and chapter',async t=>{
  const oldPayload={...payload,text:'p'.repeat(600*1024)},old=receipt('old-operation',{jobIds:['old-one','old-two']}),oldKey=operationKey('old-processing'),storage=new QuotaStorage(2*1024**2,[[oldKey,durable(old.operationId,oldPayload,old)]]),calls=[];
  const {submitOperation}=await setup(t,storage,async(path,body,_method,options)=>{
    calls.push({path,body});if(body){assert.equal(path,'/operations');return receipt(body.operationId);}
    const id=path.split('/').at(-2);assert.ok(old.jobIds.includes(id));assert.equal(options.signal.aborted,false);return {id,status:'success',chapterId:payload.chapterId,workspaceIdentity:'/fixture'};
  });
  const nextPayload={...payload,text:'n'.repeat(500*1024)},result=await submitOperation('new-after-quota',nextPayload);
  assert.equal(result.outcome,'processing');assert.ok(storage.quotaErrors>=1);assert.equal(storage.getItem(oldKey),null);assert.deepEqual(calls.filter(call=>!call.body).map(call=>call.path),['/jobs/old-one/progress','/jobs/old-two/progress']);assert.equal(calls.filter(call=>call.body).length,1);assert.deepEqual(JSON.parse(storage.getItem(operationKey('new-after-quota'))).payload,nextPayload);
});

test('failed, unknown, unavailable or mis-scoped job proofs cannot discard old payloads to make room for a new POST',async t=>{
  for(const reason of ['failed','unknown','404','id','chapter','workspace','second-failed','analysis-unknown','analysis-running','no-chapter','no-jobs']){
    const oldPayload={...payload,text:'p'.repeat(600*1024)};if(reason==='no-chapter')delete oldPayload.chapterId;
    const old=receipt('old-operation',{jobIds:reason==='no-jobs'?[]:reason==='second-failed'?['old-one','old-two']:['old-job'],result:reason.startsWith('analysis-')?{analysis:{status:reason==='analysis-unknown'?'unknown':'running'}}:{}}),oldKey=operationKey('old-processing'),storage=new QuotaStorage(2*1024**2,[[oldKey,durable(old.operationId,oldPayload,old)]]),calls=[];
    const {submitOperation}=await setup(t,storage,async(path,body)=>{
      calls.push({path,body});assert.equal(body,undefined,'unconfirmed quota reclamation must not enable a new POST');
      if(reason==='404')throw Object.assign(Error('original job unavailable'),{status:404});
      const id=path.split('/').at(-2);return {id:reason==='id'?'different-job':id,status:['failed','unknown'].includes(reason)?reason:reason==='second-failed'&&id==='old-two'?'failed':'success',chapterId:reason==='chapter'?'different-chapter':payload.chapterId,workspaceIdentity:reason==='workspace'?'/different':'/fixture'};
    });
    await assert.rejects(submitOperation('new-blocked',{...payload,text:'n'.repeat(500*1024)}),/浏览器.*存储.*空间/);
    const saved=JSON.parse(storage.getItem(oldKey));assert.equal(saved.operationId,old.operationId,reason);assert.deepEqual(saved.payload,oldPayload,reason);assert.equal(saved.receipt.outcome,'processing',reason);assert.equal(storage.removed.includes(oldKey),false,reason);assert.equal(storage.getItem(operationKey('new-blocked')),null,reason);assert.ok(calls.every(call=>!call.body));
    if(reason.startsWith('analysis-')||['no-chapter','no-jobs'].includes(reason))assert.equal(calls.length,0,reason);
  }
});

test('job-confirming reclamation queries only the current workspace and leaves another workspace processing guard intact',async t=>{
  const oldPayload={...payload,text:'p'.repeat(600*1024)},currentKey=operationKey('current-processing'),foreignKey='workbench-operation/%2Fforeign/test-page/foreign-processing',storage=new QuotaStorage(),calls=[];
  storage.setItem(currentKey,durable('current-operation',oldPayload,receipt('current-operation',{jobIds:['current-job']})));storage.setItem(foreignKey,durable('foreign-operation',oldPayload,receipt('foreign-operation',{jobIds:['foreign-job']})));
  const {compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/jobs/current-job/progress');assert.equal(body,undefined);return {id:'current-job',status:'success',chapterId:payload.chapterId,workspaceIdentity:'/fixture'};});
  await compactOperationStorage(undefined,true);assert.equal(calls.length,1);assert.equal(storage.getItem(currentKey),null);const foreign=JSON.parse(storage.getItem(foreignKey));assert.equal(foreign.operationId,'foreign-operation');assert.deepEqual(foreign.payload,oldPayload);assert.equal(foreign.receipt.outcome,'processing');assert.equal(storage.removed.includes(foreignKey),false);
});

test('a successful job proof received after a workspace switch or a newer local guard cannot reclaim the original key',async t=>{
  for(const changed of ['workspace','record']){
    const oldPayload={...payload,text:'p'.repeat(600*1024)},old=receipt('old-operation',{jobIds:['old-job']}),key=operationKey('old-processing'),raw=durable(old.operationId,oldPayload,old),storage=new QuotaStorage(5*1024**2,[[key,raw]]);let release;
    const {compactOperationStorage}=await setup(t,storage,async(path,body)=>{assert.equal(path,'/jobs/old-job/progress');assert.equal(body,undefined);return new Promise(resolve=>release=()=>resolve({id:'old-job',status:'success',chapterId:payload.chapterId,workspaceIdentity:'/fixture'}));});
    const maintenance=compactOperationStorage(undefined,true);await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');
    if(changed==='workspace')sessionStorage.setItem('workbench-workspace','/different');else storage.setItem(key,JSON.stringify({operationId:'newer-operation',payload:{...payload,revision:2}}));
    const kept=storage.getItem(key);release();await maintenance;assert.equal(storage.getItem(key),kept,changed);assert.equal(storage.removed.includes(key),false,changed);
  }
});

test('a workspace switch during quota job lookup cannot POST into the new workspace, even when the original guard can now be saved',async t=>{
  const oldPayload={...payload,text:'p'.repeat(600*1024)},old=receipt('old-operation',{jobIds:['old-job']}),oldKey=operationKey('old-processing'),storage=new QuotaStorage(2*1024**2,[[oldKey,durable(old.operationId,oldPayload,old)],[operationKey('prime'),durable('prime-unknown',payload,receipt('prime-unknown',{outcome:'unknown'}))]]),calls=[];let release;
  const {submitOperation}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(body,undefined);assert.equal(path,'/jobs/old-job/progress');return new Promise(resolve=>release=()=>resolve({id:'old-job',status:'success',chapterId:payload.chapterId,workspaceIdentity:'/fixture'}));});
  await assert.rejects(submitOperation('prime',payload),/结果不明/);assert.equal(calls.length,0);
  const late=JSON.parse(durable('late-completed',payload,receipt('late-completed',{outcome:'completed',result:{source:'c'.repeat(300*1024)}})));late.updatedAt=Date.now()+10000;storage.setItem(operationKey('late-completed'),JSON.stringify(late));
  const nextPayload={...payload,text:'n'.repeat(300*1024)},pending=submitOperation('moving',nextPayload);await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof release,'function');assert.ok(storage.quotaErrors>=1);
  sessionStorage.setItem('workbench-workspace','/different');release();await assert.rejects(pending,/工作区已变化/);
  assert.equal(calls.length,1);assert.equal(calls.filter(call=>call.body).length,0);const saved=JSON.parse(storage.getItem(operationKey('moving')));assert.ok(saved.operationId);assert.deepEqual(saved.payload,nextPayload);assert.equal(storage.getItem('workbench-operation/%2Fdifferent/test-page/moving'),null);assert.deepEqual(JSON.parse(storage.getItem(oldKey)).payload,oldPayload);assert.equal(storage.removed.includes(oldKey),false);
});

test('an operation becoming active while its job proof is waiting stays protected until its own receipt recovery finishes',async t=>{
  const oldPayload={...payload,text:'p'.repeat(600*1024)},old=receipt('old-operation',{jobIds:['old-job']}),key=operationKey('old-processing'),raw=durable(old.operationId,oldPayload,old),storage=new QuotaStorage(5*1024**2,[[key,raw]]),calls=[];let releaseJob,releaseReceipt;
  const {compactOperationStorage,submitOperation}=await setup(t,storage,async(path,body)=>{
    calls.push({path,body});assert.equal(body,undefined);
    if(path==='/jobs/old-job/progress')return new Promise(resolve=>releaseJob=()=>resolve({id:'old-job',status:'success',chapterId:payload.chapterId,workspaceIdentity:'/fixture'}));
    assert.equal(path,'/operations/old-operation');return new Promise(resolve=>releaseReceipt=()=>resolve(old));
  });
  const maintenance=compactOperationStorage(undefined,true);await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof releaseJob,'function');
  const recovering=submitOperation('old-processing',{...oldPayload,revision:2});await new Promise(resolve=>setImmediate(resolve));assert.equal(typeof releaseReceipt,'function');
  releaseJob();await maintenance;assert.equal(storage.getItem(key),raw,'the new in-flight operation invalidates the maintenance snapshot');assert.equal(storage.removed.includes(key),false);
  releaseReceipt();await assert.rejects(recovering,/仍在处理中/);const saved=JSON.parse(storage.getItem(key));assert.equal(saved.operationId,old.operationId);assert.deepEqual(saved.payload,oldPayload);assert.ok(calls.every(call=>!call.body));
});

test('compaction preserves unknown-batch and processing guards, every original ID and payload, and never renews them implicitly',async t=>{
  const unknownPayload={kind:'prepareChapter',chapterId:'fixture-chapter',revision:1},unknown=receipt('unknown-operation',{kind:'prepareChapter',outcome:'needsInput',jobIds:[],result:{analysis:{status:'partial',batches:[{status:'received',raw:large.slice(0,250000)},{status:'unknown',raw:large.slice(0,250000)}]}}});
  const pending=receipt('processing-operation',{result:{audio:{text:large.slice(0,500000)}}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('unknown'),durable(unknown.operationId,unknownPayload,unknown));storage.setItem(operationKey('processing'),durable(pending.operationId,payload,pending));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(body,undefined);return path.endsWith(unknown.operationId)?unknown:pending;});
  await compactOperationStorage();
  for(const [key,request,result] of [['unknown',unknownPayload,unknown],['processing',payload,pending]]){const record=JSON.parse(storage.getItem(operationKey(key)));assert.equal(record.operationId,result.operationId);assert.deepEqual(record.payload,request);assert.deepEqual(record.receipt.jobIds,result.jobIds);assert.equal(record.receipt.outcome,result.outcome);}
  await assert.rejects(submitOperation('unknown',unknownPayload),/结果不明|可能已计费/);
  await assert.rejects(submitOperation('processing',{...payload,revision:2}),/仍在处理中/);
  assert.deepEqual(calls.map(call=>call.path),['/operations/unknown-operation','/operations/processing-operation']);assert.ok(calls.every(call=>!call.body));assert.deepEqual(JSON.parse(storage.getItem(operationKey('processing'))).payload,payload);assert.deepEqual(storage.removed,[]);
});

test('an unknown batch stays guarded after compaction even when its original receipt is unavailable',async t=>{
  const request={kind:'prepareChapter',chapterId:'fixture-chapter',revision:1},unknown=receipt('unknown-operation',{kind:request.kind,outcome:'needsInput',jobIds:[],result:{analysis:{status:'partial',batches:[{status:'unknown',text:large}]}}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('unknown'),durable(unknown.operationId,request,unknown));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/operations/unknown-operation');assert.equal(body,undefined);throw Object.assign(Error('original receipt temporarily absent'),{status:404});});
  await compactOperationStorage();
  for(const next of [request,{...request,revision:2}])await assert.rejects(submitOperation('unknown',next),/结果不明|计费|回执|恢复|确认/);
  assert.equal(calls.length,2);const stored=JSON.parse(storage.getItem(operationKey('unknown')));assert.equal(stored.operationId,unknown.operationId);assert.deepEqual(stored.payload,request);assert.deepEqual(storage.removed,[]);
});

test('an unavailable unknown receipt sends no ordinary retry, but explicit retryUnknown authorises exactly one new operation ID',async t=>{
  const unknown=receipt('unknown-operation',{outcome:'unknown',result:{source:large}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('unknown'),durable(unknown.operationId,payload,unknown));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});if(body)return receipt(body.operationId);assert.equal(path,'/operations/unknown-operation');throw Object.assign(Error('original receipt temporarily absent'),{status:404});});
  await compactOperationStorage();
  await assert.rejects(submitOperation('unknown',payload),/结果不明|计费/);assert.equal(calls.filter(call=>call.body).length,0);assert.equal(JSON.parse(storage.getItem(operationKey('unknown'))).operationId,unknown.operationId);
  const result=await submitOperation('unknown',{...payload,retryUnknown:true});const posts=calls.filter(call=>call.body);assert.equal(posts.length,1);assert.notEqual(posts[0].body.operationId,unknown.operationId);assert.equal(posts[0].body.retryUnknown,true);assert.equal(result.operationId,posts[0].body.operationId);assert.deepEqual(calls.filter(call=>!call.body).map(call=>call.path),['/operations/unknown-operation','/operations/unknown-operation']);
});

test('an explicitly changed non-group action can proceed after a cached completed receipt lookup is temporarily unavailable',async t=>{
  const completed=receipt('completed-operation',{outcome:'completed',result:{source:large}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('completed'),durable(completed.operationId,payload,completed));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});if(body)return receipt(body.operationId);assert.equal(path,'/operations/completed-operation');throw Object.assign(Error('receipt lookup temporarily unavailable'),{status:503});});
  await compactOperationStorage();
  const next={...payload,revision:2},result=await submitOperation('completed',next);assert.equal(calls.filter(call=>call.body).length,1);assert.notEqual(result.operationId,completed.operationId);assert.equal(calls[1].body.revision,2);assert.deepEqual(JSON.parse(storage.getItem(operationKey('completed'))).payload,next);
});

test('another active owner is untouched, while an orphan receipt is compacted only inside its native owner lock',async t=>{
  const heldOwner='11111111-1111-4111-8111-111111111111',orphanOwner='22222222-2222-4222-8222-222222222222',heldKey='workbench-operation/%2Ffixture/'+heldOwner+'/held',orphanKey='workbench-operation/%2Ffixture/'+orphanOwner+'/orphan';
  const heldRaw=durable('held-operation',payload,receipt('held-operation',{result:{source:large}})),orphanRaw=durable('orphan-operation',payload,receipt('orphan-operation',{result:{source:large}})),storage=new QuotaStorage(10*1024**2,[[heldKey,heldRaw],[orphanKey,orphanRaw]]);
  const {compactOperationStorage}=await setup(t,storage,()=>assert.fail('migration must not send requests'));let insideOrphanLock=false,orphanLocks=0;
  navigator.locks.query=async()=>({held:[{name:'workbench-drafts-'+heldOwner}],pending:[]});
  navigator.locks.request=async(name,options,callback)=>{
    assert.equal(options.ifAvailable,true);
    if(name.includes(heldOwner))return callback(null);
    assert.ok(name.includes(orphanOwner));orphanLocks++;insideOrphanLock=true;try{return await callback({name});}finally{insideOrphanLock=false;}
  };
  const set=storage.setItem.bind(storage);storage.setItem=(key,value)=>{if(key===orphanKey)assert.equal(insideOrphanLock,true);if(key===heldKey)assert.fail('active owner must not be rewritten');return set(key,value);};
  await compactOperationStorage();assert.equal(storage.getItem(heldKey),heldRaw);assert.ok(orphanLocks>=1);assert.ok(storage.getItem(orphanKey).length*2<8192);assert.equal(JSON.parse(storage.getItem(orphanKey)).operationId,'orphan-operation');assert.deepEqual(JSON.parse(storage.getItem(orphanKey)).payload,payload);
});

test('completed payload history stays within the shared 1MiB budget, while large pending and nested-unknown payloads remain intact',async t=>{
  const storage=new QuotaStorage(),completed=new Map(),protectedRecords=new Map();
  for(let index=0;index<6;index++){
    const request={...payload,revision:index+1,text:'p'.repeat(160*1024)},operationId='completed-'+index,key=operationKey(operationId);completed.set(key,{operationId,payload:request});
    storage.setItem(key,durable(operationId,request,receipt(operationId,{outcome:'completed',jobIds:[]})));
  }
  for(const [name,extra] of [['pending',{outcome:'processing'}],['unknown',{outcome:'unknown'}],['nested-unknown',{outcome:'completed',jobIds:[],result:{analysis:{status:'partial',performanceRepairs:[{status:'unknown'}]}}}]]){
    const request={...payload,text:'q'.repeat(450*1024)},operationId=name+'-operation',key=operationKey(name);protectedRecords.set(key,{operationId,payload:request});
    storage.setItem(key,durable(operationId,request,receipt(operationId,extra)));
  }
  const {compactOperationStorage}=await setup(t,storage,()=>assert.fail('retention must not send model or operation requests'));await compactOperationStorage();
  const retained=[...completed.keys()].filter(key=>storage.getItem(key)!==null);assert.ok(retained.length>0&&retained.length<completed.size);assert.ok(retained.reduce((bytes,key)=>bytes+2*(key.length+storage.getItem(key).length),0)<=1024**2);
  for(const key of retained){const stored=JSON.parse(storage.getItem(key));assert.equal(stored.operationId,completed.get(key).operationId);assert.deepEqual(stored.payload,completed.get(key).payload,'retained payload is complete rather than truncated');}
  for(const [key,expected] of protectedRecords){const stored=JSON.parse(storage.getItem(key));assert.equal(stored.operationId,expected.operationId);assert.deepEqual(stored.payload,expected.payload);assert.equal(storage.removed.includes(key),false);}
});

test('a compact prepared group restores the complete server result before reuse or scope changes',async t=>{
  const request={kind:'groupAndGenerate',chapterId:'fixture-chapter',ids:['one','two']},prepared=receipt('prepared-operation',{kind:request.kind,outcome:'prepared',jobIds:[],createdObjectIds:['known-unit'],result:{unit:{id:'known-unit',members:['one','two'],text:large}}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('group'),durable(prepared.operationId,request,prepared));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/operations/'+prepared.operationId);assert.equal(body,undefined);return prepared;});
  await compactOperationStorage();const restored=await submitOperation('group',{...request,revision:2});assert.equal(restored,prepared);assert.equal(restored.result.unit.text,large);assert.deepEqual(restored.result.unit.members,['one','two']);assert.equal(calls.length,1);assert.equal(JSON.parse(storage.getItem(operationKey('group'))).operationId,prepared.operationId);
});

test('an unavailable compact group receipt cannot be returned as a partial object or used to dispatch changed scope',async t=>{
  const request={kind:'groupAndGenerate',chapterId:'fixture-chapter',ids:['one','two']},prepared=receipt('prepared-operation',{kind:request.kind,outcome:'prepared',jobIds:[],createdObjectIds:['known-unit'],result:{unit:{id:'known-unit',text:large}}}),storage=new QuotaStorage(),calls=[];
  storage.setItem(operationKey('group'),durable(prepared.operationId,request,prepared));
  const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(body,undefined);throw Object.assign(Error('original receipt unavailable'),{status:404});});
  await compactOperationStorage();await assert.rejects(submitOperation('group',{...request,revision:2}),/回执|恢复|核对|确认/);assert.equal(calls.length,1);const stored=JSON.parse(storage.getItem(operationKey('group')));assert.equal(stored.operationId,prepared.operationId);assert.deepEqual(stored.payload,request);assert.deepEqual(stored.receipt.createdObjectIds,['known-unit']);
});

test('non-plan results or nonempty steps are never reduced into failed-no-effect authority',async t=>{
  for(const effect of ['result','steps']){
    const storage=new QuotaStorage(),calls=[];let submitted,unavailable=false;
    const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{
      calls.push({path,body});if(body){submitted=body;throw Object.assign(Error('known conflict'),{status:409,retryClass:'refresh'});}
      if(unavailable)throw Object.assign(Error('receipt temporarily absent'),{status:404});
      return receipt(submitted.operationId,{outcome:'needsInput',jobIds:[],errorStatus:409,steps:effect==='steps'?{created:{source:large}}:{},result:effect==='result'?{received:{source:large}}:{plan:{}}});
    });
    const result=await submitOperation('effect',payload);assert.equal(result.errorStatus,409);await compactOperationStorage();assert.ok(storage.getItem(operationKey('effect')),'an acknowledged effect must keep its guard');
    unavailable=true;await assert.rejects(submitOperation('effect',{...payload,revision:2}),/回执|恢复|核对|确认/);assert.equal(calls.filter(call=>call.body).length,1);const saved=JSON.parse(storage.getItem(operationKey('effect')));assert.equal(saved.operationId,submitted.operationId);assert.deepEqual(saved.payload,payload);
  }
});

test('a successful response cannot overwrite a newer durable record installed while its POST was in flight',async t=>{
  const storage=new QuotaStorage(),calls=[],newer=JSON.stringify({operationId:'newer-operation',payload:{...payload,revision:2}});
  const {submitOperation}=await setup(t,storage,async(path,body)=>{calls.push({path,body});assert.equal(path,'/operations');storage.setItem(operationKey('same'),newer);return receipt(body.operationId,{outcome:'completed',result:{chapter:{source:large}}});});
  await assert.rejects(submitOperation('same',payload),/操作|记录|变化|更新|暂存/);assert.deepEqual(calls.map(call=>call.path),['/operations']);assert.equal(storage.getItem(operationKey('same')),newer);assert.deepEqual(storage.removed,[]);
});

test('a compact paid job survives a later known conflict plus 404; only a proven no-effect receipt may clear the guard',async t=>{
  for(const paid of [true,false]){
    const storage=new QuotaStorage(),calls=[];let submitted;
    const existing=receipt('original-operation',{result:{chapter:{source:large}}});if(paid)storage.setItem(operationKey('conflict'),durable(existing.operationId,payload,existing));
    const {submitOperation,compactOperationStorage}=await setup(t,storage,async(path,body)=>{
      calls.push({path,body});if(body){submitted=body;throw Object.assign(Error('known conflict before enqueue'),{status:409,retryClass:'refresh'});}
      if(paid&&calls.length===1)return existing;
      if(paid)throw Object.assign(Error('receipt temporarily absent'),{status:404});
      return receipt(submitted.operationId,{outcome:'needsInput',jobIds:[],errorStatus:409,steps:{},result:{plan:{rows:large}}});
    });
    if(paid){await compactOperationStorage();await assert.rejects(submitOperation('conflict',payload),error=>error.retryClass==='check-existing-operation');const record=JSON.parse(storage.getItem(operationKey('conflict')));assert.equal(record.operationId,existing.operationId);assert.deepEqual(record.payload,payload);assert.deepEqual(record.receipt.jobIds,['known-job']);assert.equal(calls.filter(call=>call.body).length,1);assert.equal(submitted.operationId,existing.operationId);}
    else{const result=await submitOperation('conflict',payload);assert.equal(result.errorStatus,409);assert.equal(storage.getItem(operationKey('conflict')),null);assert.equal(calls.filter(call=>call.body).length,1);}
  }
});
