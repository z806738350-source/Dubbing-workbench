import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createExperience } from '../server/experience.mjs';
import { createAssistant } from '../server/assistant/service.mjs';
import { ffmpeg } from '../server/audio.mjs';

async function idle(assistant) { for(let n=0;n<300&&assistant.active;n++)await new Promise(done=>setTimeout(done,5));assert.equal(assistant.active,0); }
function fixture(t,fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:'{"reply":"已了解这条私有说明。"}'}}]}))) {
  const directory=mkdtempSync(join(tmpdir(),'assistant-archive-')),store=openStore(directory),domain=createDomain(store);
  const config={baseUrl:'https://fixture.example/v1',key:'fixture-secret'},worker={},analysis={},experience=createExperience(store,domain,worker,analysis,config);
  const assistant=createAssistant({store,domain,worker,analysis,experience,config,fetchImpl});
  assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'fixture',credentialSource:'audio',vision:true});
  const session=assistant.create({title:'待归档私有对话'}).session,other=assistant.create({title:'其他对话'}).session;
  t.after(async()=>{await assistant.close();store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,store,domain,assistant,session,other};
}
const send=(f,extra={})=>f.assistant.send(f.session.id,{messageId:uid(),text:'私有说明，请解释。',approved:true,materials:['text'],...extra});
async function screenshot(f,id=f.session.id) {
  const file=join(f.directory,uid()+'.png');execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','color=c=blue:s=40x40','-frames:v','1',file]);
  return f.assistant.attachments.create({sessionId:id,mime:'image/png',dataBase64:readFileSync(file).toString('base64')});
}

test('归档保留真实聊天、截图、调用原回复，只读阻止继续发送',async t=>{
  const f=fixture(t),image=await screenshot(f);await send(f,{attachmentIds:[image.id],materials:['text','image']});await idle(f.assistant);
  const before=f.assistant.get(f.session.id),pixels=await f.assistant.attachments.read(image.id,f.session.id),calls=f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:'));
  const archived=await f.assistant.archive(f.session.id);
  assert.equal(archived.session.state,'archived');assert.deepEqual(archived.messages,before.messages);assert.deepEqual(archived.steps,before.steps);assert.deepEqual(archived.attachments,before.attachments);
  assert.deepEqual((await f.assistant.attachments.read(image.id,f.session.id)).data,pixels.data);assert.deepEqual(f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:')),calls);
  await assert.rejects(send(f),e=>e.status===409);await assert.rejects(screenshot(f),e=>e.status===409);assert.equal(f.assistant.get(f.other.id).session.state,'active');
});

test('永久删除只接受具体会话与当前版本确认，清材料而保留其他会话',async t=>{
  const f=fixture(t),image=await screenshot(f),otherImage=await screenshot(f,f.other.id);
  await send(f,{attachmentIds:[image.id],materials:['text','image']});await idle(f.assistant);
  const before=f.assistant.get(f.session.id),file=f.store.get('assistantAttachments',image.id);
  await assert.rejects(f.assistant.removeContent(f.session.id,{sessionId:f.session.id,revision:before.session.revision}),e=>e.status===403);
  await assert.rejects(f.assistant.removeContent(f.session.id,{sessionId:f.other.id,revision:before.session.revision,confirmed:true}),e=>e.status===403);
  await assert.rejects(f.assistant.removeContent(f.session.id,{sessionId:f.session.id,revision:before.session.revision-1,confirmed:true}),e=>e.status===409);
  assert.deepEqual(f.assistant.get(f.session.id),before);
  const run=before.runs[0],step={id:uid(),runId:run.id,operationId:uid(),ordinal:0,capabilityId:'segment.update',state:'completed',description:'私有提案',input:{text:'私有正文'},preview:{private:'私有预览'},approvedEffects:{voiceAssignments:[{segmentText:'私有音色台词'}],readingRange:{before:{text:'私有原朗读文字'},after:{text:'私有拟朗读文字'}}},resultRefs:{audioId:'existing-audio'}};
  f.store.put('assistantSteps',step,run.id);f.store.put('assistantDecisions',{id:uid(),runId:run.id,request:{instructions:'私有决定'},actor:'human',at:new Date().toISOString()},run.id);
  const request={sessionId:f.session.id,scope:f.assistant.deletionPlan(f.session.id).scope,confirmed:true},deleted=await f.assistant.removeContent(f.session.id,request);
  assert.deepEqual(deleted,{sessionId:f.session.id,deleted:true});
  assert.equal(f.store.all('assistantMessages',f.session.id).length,0);assert.equal(f.store.all('assistantAttachments',f.session.id).length,0);assert.equal(existsSync(join(f.directory,file.path)),false);assert.equal(existsSync(join(f.directory,file.sourcePath)),false);
  assert.ok(f.store.get('assistantSessions',f.session.id).contentDeletion);assert.equal(f.store.get('assistantRuns',run.id).budget.used.assistant,1);
  assert.equal(f.store.get('assistantSteps',step.id).input,undefined);assert.deepEqual(f.store.get('assistantSteps',step.id).resultRefs,{audioId:'existing-audio'});
  assert.equal(f.store.get('assistantSteps',step.id).approvedEffects,undefined);assert.ok(!JSON.stringify([deleted,f.store.get('assistantSteps',step.id)]).includes('私有'));
  assert.ok(f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:')).every(s=>!s.response&&!s.messageIds&&!s.materials));assert.ok(f.store.all('assistantDecisions',run.id).every(s=>!s.request));
  assert.equal(f.assistant.get(f.other.id).session.state,'active');assert.ok(await f.assistant.attachments.read(otherImage.id,f.other.id));
  assert.ok(!f.assistant.list().some(s=>s.id===f.session.id));assert.throws(()=>f.assistant.get(f.session.id),e=>e.status===404);
  assert.deepEqual(await f.assistant.removeContent(f.session.id,request),deleted,'相同已完成确认可幂等核对');
});

test('归档收束在途助手响应，保存原回执而不续跑提案',async t=>{
  let resolve,started;const ready=new Promise(done=>{started=done;});let calls=0;
  const f=fixture(t,async()=>{calls++;started();return new Promise(done=>{resolve=done;});});
  await send(f);await ready;const archiving=f.assistant.archive(f.session.id);assert.equal(f.assistant.get(f.session.id).session.state,'archived');
  resolve(new Response(JSON.stringify({choices:[{message:{content:'{"reply":"迟到的私有回复","reads":[{"capabilityId":"read.workspace","input":{}}]}'}}]})));
  const archived=await archiving;await f.assistant.tick();assert.equal(calls,1);assert.equal(archived.runs[0].state,'cancelled');assert.equal(archived.messages.length,1);assert.equal(archived.steps.length,0);
  const receipt=f.store.all('settings').find(s=>s.id.startsWith('assistant-call:'));assert.match(receipt.response,/迟到的私有回复/);assert.equal(receipt.state,'received');
  assert.throws(()=>f.assistant.control(archived.runs[0].id,{action:'resume',revision:archived.runs[0].revision}),e=>e.status===409);
});

test('删除未知结果会话保留费用计数、unknown账本和已生成声音',async t=>{
  const f=fixture(t,async()=>new Response('私有供应商报错',{status:502}));await send(f);await idle(f.assistant);
  const before=f.assistant.get(f.session.id),run=before.runs[0];assert.equal(run.reconciliation.assistantRequest.state,'unknown');
  const audioPath='existing-provider-original.wav';
  execFileSync(ffmpeg,['-nostdin','-v','error','-f','lavfi','-i','sine=frequency=440:duration=0.1','-c:a','pcm_s16le',join(f.directory,audioPath)]);
  f.store.put('audios',{id:'existing-audio',state:'ready',path:audioPath,provenance:'provider-original'});f.store.put('jobs',{id:'existing-job',status:'success',resultAudioId:'existing-audio'});
  const original=f.store.get('audios','existing-audio'),originalBytes=readFileSync(join(f.directory,audioPath));
  const deleted=await f.assistant.removeContent(f.session.id,{sessionId:f.session.id,scope:f.assistant.deletionPlan(f.session.id).scope,confirmed:true});
  assert.deepEqual(deleted,{sessionId:f.session.id,deleted:true});assert.equal(f.store.get('assistantRuns',run.id).budget.used.assistant,1);
  assert.equal(f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:')&&s.runId===run.id&&s.state==='unknown').length,1);
  assert.deepEqual(f.store.get('audios','existing-audio'),original);assert.equal(f.store.get('jobs','existing-job').status,'success');
  assert.deepEqual(readFileSync(join(f.directory,audioPath)),originalBytes);
  const kept=f.store.get('assistantRuns',run.id);assert.equal(kept.request.state,'unknown');assert.equal(kept.request.error,undefined);assert.equal(kept.request.response,undefined);
  await f.assistant.tick();f.assistant.recover();assert.throws(()=>f.assistant.get(f.session.id),e=>e.status===404);assert.ok(!f.assistant.list().some(s=>s.id===f.session.id));
});

test('永久删除收束迟到回复后隐藏旧入口，重发与恢复不复活内容或账本费用',async t=>{
  const response=Promise.withResolvers(),started=Promise.withResolvers();let calls=0;
  const f=fixture(t,async()=>{calls++;started.resolve();return response.promise;});
  const messageId=uid(),image=await screenshot(f),originalFile=f.store.get('assistantAttachments',image.id);
  await send(f,{messageId,attachmentIds:[image.id],materials:['text','image']});await started.promise;
  const before=f.assistant.get(f.session.id),run=before.runs[0],request={sessionId:f.session.id,scope:f.assistant.deletionPlan(f.session.id).scope,confirmed:true};
  const deleting=f.assistant.removeContent(f.session.id,request);
  response.resolve(Response.json({choices:[{message:{content:JSON.stringify({reply:'绝不重新出现的迟到回复',steps:[{capabilityId:'project.create',input:{name:'迟到禁止创建'}}]})}}]}));
  assert.deepEqual(await deleting,{sessionId:f.session.id,deleted:true});
  assert.throws(()=>f.assistant.get(f.session.id),e=>e.status===404);assert.ok(!f.assistant.list().some(s=>s.id===f.session.id));
  assert.ok(f.assistant.list().some(s=>s.id===f.other.id));assert.equal(f.store.all('projects').length,0);
  assert.equal(f.store.all('assistantMessages',f.session.id).length,0);assert.equal(f.store.all('assistantAttachments',f.session.id).length,0);
  assert.equal(existsSync(join(f.directory,originalFile.path)),false);assert.equal(existsSync(join(f.directory,originalFile.sourcePath)),false);
  const kept=f.store.get('assistantRuns',run.id),ledger=f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:'));
  assert.equal(kept.state,'cancelled');assert.equal(kept.budget.used.assistant,1);assert.equal(ledger.length,1);assert.equal(ledger[0].response,undefined);assert.equal(ledger[0].materials,undefined);
  await assert.rejects(send(f,{messageId}),e=>[404,409].includes(e.status));await assert.rejects(screenshot(f),e=>[404,409].includes(e.status));
  assert.throws(()=>f.assistant.control(run.id,{action:'resume',revision:kept.revision}),e=>[404,409].includes(e.status));
  assert.throws(()=>f.assistant.approve(run.id,{decisionId:uid(),revision:kept.revision,accepted:true}),e=>[404,409].includes(e.status));
  await f.assistant.tick();f.assistant.recover();await idle(f.assistant);
  assert.equal(calls,1);assert.deepEqual(f.store.get('assistantRuns',run.id),kept);assert.deepEqual(f.store.all('settings').filter(s=>s.id.startsWith('assistant-call:')),ledger);
  assert.equal(f.store.all('assistantSteps',run.id).length,0);assert.deepEqual(await f.assistant.removeContent(f.session.id,request),{sessionId:f.session.id,deleted:true});
  const reopened=openStore(f.directory),domain=createDomain(reopened),config={baseUrl:'https://fixture.example/v1',key:'fixture-secret'},worker={},analysis={};
  const next=createAssistant({store:reopened,domain,config,worker,analysis,experience:createExperience(reopened,domain,worker,analysis,config),fetchImpl:()=>assert.fail('重开已删除会话不得请求模型')});
  try{
    next.recover();await next.tick();assert.throws(()=>next.get(f.session.id),e=>e.status===404);assert.ok(!next.list().some(s=>s.id===f.session.id));
    assert.equal(next.get(f.other.id).session.state,'active');assert.deepEqual(reopened.get('assistantRuns',run.id),kept);
    assert.deepEqual(reopened.all('settings').filter(s=>s.id.startsWith('assistant-call:')),ledger);
    await assert.rejects(next.send(f.session.id,{messageId,text:'私有说明，请解释。',approved:true}),e=>[404,409].includes(e.status));
  }finally{await next.close();reopened.close();}
});
