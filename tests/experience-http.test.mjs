import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';
import {uid} from '../server/store.mjs';

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
