import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';
import {fail,uid} from '../server/store.mjs';

test('真实HTTP错误分类和持久操作回执元数据：授权失效零供应商，冲突/服务不可用/500恢复不同',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-error-metadata-')),config={key:'synthetic-error-key',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'};
  const app=await startServer({port:0,directory,config}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const native=globalThis.fetch;let providerCalls=0;t.mock.method(globalThis,'fetch',(url,init)=>{if(String(url).startsWith(base+'/'))return native(url,init);providerCalls++;throw Error('本测试禁止供应商请求');});
  const request=async(path,p,headers={})=>{const response=await fetch(base+'/api'+path,p===undefined?{headers}:{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(p)});return {status:response.status,data:await response.json()};};
  const forbidden=await request('/state',undefined,{origin:'https://outside.invalid'});assert.equal(forbidden.status,403);assert.equal(forbidden.data.code,'permission-denied');assert.equal(forbidden.data.retryClass,'review-permission');assert.equal(forbidden.data.scope.path,'/api/state');
  const project=app.domain.mutate('project.create',{name:'错误恢复夹具'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'自拟的一句。',segment:true});
  const conflict=await request('/action',{action:'chapter.update',chapterId:chapter.id,revision:0,title:'过期更新'});assert.equal(conflict.status,409);assert.equal(conflict.data.code,'state-conflict');assert.equal(conflict.data.retryClass,'refresh-and-review');
  const {data:deniedGrant}=await request('/experience/grant',{grantId:uid(),projectId:project.id,chapterId:chapter.id,steps:['director'],materials:['text'],textLimit:2,audioLimit:0});
  app.store.put('settings',{...app.store.get('settings',deniedGrant.id),revoked:true});
  const denied=await request('/operations',{operationId:uid(),kind:'prepareChapter',chapterId:chapter.id,revision:chapter.revision,grantId:deniedGrant.grantId});assert.equal(denied.status,200);assert.equal(denied.data.errorStatus,403);assert.equal(denied.data.code,'permission-denied');assert.equal(denied.data.retryClass,'review-permission');assert.equal(denied.data.scope.operationId,denied.data.operationId);
  for(const reason of ['revoked','expired','route']){
    const {data:g}=await request('/experience/grant',{grantId:uid(),projectId:project.id,chapterId:chapter.id,steps:['director'],materials:['text'],textLimit:2,audioLimit:0});
    const stored=app.store.get('settings',g.id);if(reason==='revoked')stored.revoked=true;if(reason==='expired')stored.expiresAt='2000-01-01T00:00:00.000Z';if(reason==='route')stored.routes.text='https://changed.invalid';app.store.put('settings',stored);
    const result=await request('/operations',{operationId:uid(),kind:'prepareChapter',chapterId:chapter.id,revision:chapter.revision,grantId:g.grantId});assert.equal(result.data.errorStatus,403,reason);assert.equal(result.data.retryClass,'review-permission',reason);
  }
  const snapshot=app.domain.snapshot;app.domain.snapshot=()=>fail('服务暂时不可用',503);
  const unavailable=await request('/state');assert.equal(unavailable.status,503);assert.equal(unavailable.data.code,'service-unavailable');assert.equal(unavailable.data.retryClass,'wait-for-service');
  app.domain.snapshot=()=>{throw Error('synthetic-internal-detail');};const interrupted=await request('/state');assert.equal(interrupted.status,500);assert.equal(interrupted.data.code,'operation-result-unconfirmed');assert.equal(interrupted.data.retryClass,'check-existing-operation');assert.ok(!JSON.stringify(interrupted.data).includes('synthetic-internal-detail'));
  app.domain.snapshot=()=>fail('已有对象问题',409,{code:'audio-stale',scope:{unitId:'actual-unit',mode:'scene'},retryClass:'refresh-and-review'});const scoped=await request('/state');assert.equal(scoped.data.code,'audio-stale');assert.equal(scoped.data.scope.unitId,'actual-unit');
  app.domain.snapshot=snapshot;assert.equal(providerCalls,0);assert.equal(app.store.all('jobs').length,0);
  const unknownId=uid(),jobId=uid(),attemptId=uid();app.store.put('jobs',{id:jobId,kind:'generate',status:'unknown',chapterId:chapter.id},chapter.id);app.store.put('attempts',{id:attemptId,jobId,chapterId:chapter.id,status:'unknown'},jobId);
  app.store.put('settings',{id:'ux-operation:'+unknownId,operationId:unknownId,kind:'generateSelection',outcome:'processing',steps:{enqueued:jobId},jobIds:[jobId],createdObjectIds:[],result:{}});
  const unknown=await request('/operations/'+unknownId);assert.equal(unknown.data.outcome,'unknown');assert.equal(unknown.data.code,'request-unknown');assert.equal(unknown.data.retryClass,'explicit-retry-unknown');assert.equal(app.store.get('attempts',attemptId).status,'unknown');assert.equal(providerCalls,0);
});
