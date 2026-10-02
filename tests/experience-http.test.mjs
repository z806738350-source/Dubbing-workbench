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
