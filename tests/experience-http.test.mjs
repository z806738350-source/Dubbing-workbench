import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';
import {uid} from '../server/store.mjs';

test('状态轮询在JSON解析前投影后台快照，任务/未知回执保留且数据库与按需操作记录不变',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-state-projection-')),app=await startServer({port:0,directory,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});app.worker.close();
  const native=globalThis.fetch;let providerCalls=0;t.mock.method(globalThis,'fetch',(url,init)=>{if(String(url).startsWith(base+'/'))return native(url,init);providerCalls++;throw Error('状态投影不能发供应商请求');});
  const project=app.domain.mutate('project.create',{name:'轮询投影夹具'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'自拟一句。',segment:true}),segment=app.domain.list(chapter.id)[0],heavy='后台快照自拟内容'.repeat(16000),rows=[];
  const session=app.domain.mutate('voice-session.create',{description:'存在候选会话时也不应全读后台任务'});
  for(const [index,status] of ['success','failed','unknown'].entries()){
    const id=uid(),attemptId=uid(),row={id,chapterId:chapter.id,kind:index===1?'export':'master',status,done:index===0?1:0,total:1,stop:false,createdAt:`2026-10-09T10:00:0${index}Z`,commandId:uid(),masterId:'master-'+index,...(index===1?{exportId:'export-one',format:'mp3'}:{}),result:{masterId:'master-'+index,renderRevision:2},scope:{kind:'attempt',ids:[attemptId]},retryClass:'check-existing-operation',acknowledgedAttemptIds:[attemptId],counts:{unknown:index===2?1:0},localOutputPending:index===1,
      items:[{text:'RAW_JOB_ITEM_NOT_FOR_POLLING'.repeat(10000)}],targetScopes:[{text:heavy}],renderRows:[{s:{text:heavy},a:{input:{text:heavy},prompt:heavy}}],outputRecords:{master:{mapping:[{text:heavy}]}},request:{kind:'master',text:heavy},confirmation:{reviewItems:[{basis:{text:heavy}}]}};
    app.store.put('jobs',row,chapter.id);app.store.put('attempts',{id:attemptId,jobId:id,segmentId:segment.id,status,phase:index===1?'localRecoveryPending':status,deliveryVersion:1,input:{members:[{id:segment.id,text:heavy}]}},id);rows.push(app.store.get('jobs',id));
  }
  const rawBefore=app.store.db.prepare('SELECT data FROM jobs ORDER BY rowid').all(),all=app.store.all.bind(app.store),parse=JSON.parse,projection=t.mock.method(app.store,'all',(table,parent)=>{assert.notEqual(table,'jobs','快照应在SQLite中剔除重字段后才JSON.parse');return all(table,parent);}),noItemsParse=t.mock.method(JSON,'parse',(text,...args)=>{assert.ok(!String(text).includes('RAW_JOB_ITEM_NOT_FOR_POLLING'),'冻结逐段正文不能进入状态JSON解析');return parse(text,...args);});try{app.domain.snapshot();}finally{projection.mock.restore();noItemsParse.mock.restore();}
  const response=await fetch(base+'/api/state');assert.equal(response.status,200);const body=await response.text(),state=JSON.parse(body);assert.ok(body.length<20000,'后台快照不能全量进入状态响应');assert.ok(!body.includes(heavy));assert.deepEqual(state.jobs.map(j=>j.id),rows.map(j=>j.id).reverse());
  assert.deepEqual(state.voiceSessions.find(row=>row.id===session.id).candidates,[]);
  for(const raw of rows){const item=state.jobs.find(j=>j.id===raw.id);for(const key of ['renderRows','outputRecords','request','confirmation','items','targetScopes'])assert.equal(Object.hasOwn(item,key),false,key);for(const key of ['status','commandId','masterId','result','scope','retryClass','acknowledgedAttemptIds','counts','localOutputPending'])assert.deepEqual(item[key],raw[key],key);assert.equal(item.attempts[0].submitted,true);assert.deepEqual(item.attempts[0].memberNumbers,[1]);}
  assert.equal(state.jobs.find(j=>j.status==='unknown').unknown,1);assert.equal(state.jobs.find(j=>j.status==='failed').failed,1);assert.equal(state.jobs.find(j=>j.status==='success').done,1);assert.equal(state.jobs.find(j=>j.kind==='export').exportId,'export-one');assert.equal(state.jobs.find(j=>j.status==='failed').localRecoveryAttemptIds.length,1);
  assert.deepEqual(app.store.db.prepare('SELECT data FROM jobs ORDER BY rowid').all(),rawBefore);
  const operationId=uid();app.store.put('settings',{id:'ux-operation:'+operationId,operationId,request:{kind:'generateSelection',chapterId:chapter.id},jobIds:[rows[0].id],createdObjectIds:[],steps:{enqueued:rows[0].id},result:{job:rows[0]},outcome:'processing'});
  const receipt=await(await fetch(base+'/api/operations/'+operationId)).json();assert.equal(receipt.outcome,'completed');assert.deepEqual(receipt.result.job,rows[0],'按需回执仍读取完整原记录，不能破坏恢复');assert.equal(providerCalls,0);
});

test('UX HTTP合同：策略/授权/保存回执及上传查询，零供应商请求且不外露配置凭据',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-experience-http-'));
  const key='synthetic-private-fixture',app=await startServer({port:0,directory,config:{key,model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const native=globalThis.fetch;let providerCalls=0;
  t.mock.method(globalThis,'fetch',(url,init)=>{if(String(url).startsWith(base+'/'))return native(url,init);providerCalls++;throw Error('供应商请求不属于本测试');});
  const api=async(path,p)=>{const r=await fetch(base+'/api'+path,p?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}:{});const body=await r.text();assert.ok(!body.includes(key));assert.equal(r.status,200,body);return JSON.parse(body);};
  const project=app.domain.mutate('project.create',{name:'HTTP夹具'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'自拟一句。',segment:true});
  const policy=await api('/experience/policy',{projectId:project.id,revision:0,mode:'review'});assert.equal(policy.revision,1);
  const grant=await api('/experience/grant',{grantId:uid(),projectId:project.id,chapterId:chapter.id,steps:['director'],materials:['text'],textLimit:2,audioLimit:0});assert.equal(grant.textReserved,0);assert.deepEqual(grant.voiceIds,[]);
  const snapshot=await api('/projects/'+project.id+'/experience');assert.equal(snapshot.grants.length,1);assert.equal(snapshot.grants[0].request,undefined);
  const plan=await api('/operations/plan',{kind:'prepareChapter',chapterId:chapter.id,revision:chapter.revision});assert.equal(plan.kind,'director');assert.equal(plan.textRequests,1);
  const operationId=uid(),segment=app.domain.list(chapter.id)[0],op=await api('/operations',{operationId,kind:'save',action:'segment.update',data:{chapterId:chapter.id,revision:chapter.revision,id:segment.id,performance:'自然'}});assert.equal(op.outcome,'completed');assert.deepEqual((await api('/operations/'+operationId)).result,op.result);
  const uploadId=uid(),b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);
  const voice=await api('/voices',{uploadId,name:'HTTP参考',filename:'fixture.wav',data:b.toString('base64')});assert.equal(voice.id,uploadId);assert.deepEqual(await api('/voices/'+uploadId),voice);assert.equal(providerCalls,0);
});

test('删除项目只等待本项目在途操作；删除后的迟到保存不留下孤儿回执',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-delete-http-'));
  const app=await startServer({port:0,directory,config:{key:'',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const post=async(path,p)=>{const r=await fetch(base+'/api'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:r.status,body:await r.json()};};
  const project=app.domain.mutate('project.create',{name:'正在预检'}),other=app.domain.mutate('project.create',{name:'可直接删除'});
  const chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'样本',source:'自拟一句。',segment:true}),segment=app.domain.list(chapter.id)[0];
  let entered,release;const started=new Promise(resolve=>{entered=resolve;}),paused=new Promise(resolve=>{release=resolve;});
  t.mock.method(app.worker,'submit',async()=>{entered();await paused;throw Object.assign(Error('仅暂停预检，不发送请求'),{status:400});});
  const operation=post('/operations',{operationId:uid(),kind:'generateSelection',chapterId:chapter.id,revision:chapter.revision,ids:[segment.id]});
  await started;
  const blocked=await post('/action',{action:'project.delete',id:project.id});assert.equal(blocked.status,409);assert.ok(app.store.maybe('projects',project.id));
  const unrelated=await post('/action',{action:'project.delete',id:other.id,scope:app.domain.deletionPlan({id:other.id}).scope});assert.equal(unrelated.status,200);assert.equal(app.store.maybe('projects',other.id),null);
  release();assert.equal((await operation).status,200);
  const deleted=await post('/action',{action:'project.delete',id:project.id,scope:app.domain.deletionPlan({id:project.id}).scope});assert.equal(deleted.status,200);assert.equal(app.store.maybe('chapters',chapter.id),null);
  const lateId=uid(),late=await post('/operations',{operationId:lateId,kind:'save',action:'segment.update',data:{chapterId:chapter.id,revision:chapter.revision,id:segment.id,text:'迟到内容'}});
  assert.equal(late.status,404);assert.equal(app.store.maybe('settings',`ux-operation:${lateId}`),null);
  const nested=await post('/operations',{operationId:uid(),kind:'save',action:'project.delete',data:{id:project.id}});assert.equal(nested.status,400);
});

test('人工HTTP生成直接发送当前一次请求，耗尽或过期旧授权不影响，回执重放不重复发送',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-direct-generation-http-')),config={key:'fixture-only',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'},app=await startServer({port:0,directory,config}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);
  let calls=0;const native=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,init)=>{if(String(url).startsWith(base+'/'))return native(url,init);assert.equal(String(url),config.audioUrl,'本测试仅允许Mock音频响应');calls++;return Promise.resolve(new Response(bytes,{headers:{'content-type':'audio/wav'}}));});
  const api=async(path,p)=>{const response=await fetch(base+'/api'+path,p?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)}:{});const body=await response.json();assert.equal(response.status,200,JSON.stringify(body));return body;};
  const d=app.domain,store=app.store,project=d.mutate('project.create',{name:'人工点击夹具'}),chapter=d.mutate('chapter.create',{projectId:project.id,title:'无次数填写',source:'自拟一句。',segment:true}),voice={id:uid(),name:'合成参考',path:'reference.wav',state:'active',revision:1};writeFileSync(join(directory,voice.path),bytes);store.put('voices',voice);
  const role=store.all('roles',project.id)[0];d.mutate('role.update',{id:role.id,entityRevision:role.revision??1,chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,voiceId:voice.id});const segment=d.list(chapter.id)[0];d.mutate('segment.confirm',{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:[segment.id]});
  await api('/experience/policy',{projectId:project.id,revision:0,mode:'smart'});
  const grant=await api('/experience/grant',{grantId:uid(),projectId:project.id,chapterId:chapter.id,steps:['unit-generate'],materials:['text','reference'],voiceIds:[voice.id],textLimit:0,audioLimit:1}),expired={...store.get('settings',grant.id),audioUsed:1,expiresAt:new Date(Date.now()-1000).toISOString()};store.put('settings',expired);
  const request=()=>({operationId:uid(),kind:'generateSelection',chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,ids:[segment.id],actionKind:'forceRegenerate'});
  const explicit=await api('/operations',{...request(),grantId:grant.grantId});assert.equal(explicit.errorStatus,403);assert.match(explicit.error,/到期/);assert.equal(calls,0);
  const firstRequest=request(),first=await api('/operations',firstRequest);assert.equal(first.error,undefined);assert.equal(first.jobIds.length,1);await app.worker.tick();const receipt=await api('/operations/'+firstRequest.operationId);assert.equal(receipt.outcome,'completed');assert.equal(calls,1);assert.equal(store.get('jobs',first.jobIds[0]).request.requireGrant,false);
  assert.deepEqual((await api('/operations',firstRequest)).jobIds,first.jobIds);await app.worker.tick();assert.equal(calls,1);
  const second=await api('/operations',request());assert.equal(second.error,undefined);await app.worker.tick();assert.equal(calls,2);assert.equal(store.get('jobs',second.jobIds[0]).status,'success');assert.deepEqual(store.get('settings',grant.id),expired);assert.equal((await api('/projects/'+project.id+'/experience')).grants.length,1);
});
