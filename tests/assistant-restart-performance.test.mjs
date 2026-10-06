import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';
import {uid} from '../server/store.mjs';

async function until(fn){for(let n=0;n<300&&!fn();n++)await new Promise(r=>setTimeout(r,5));assert.ok(fn(),'state did not settle');}

test('real server close/restart registers received PG locally before task continuation; no new text/assistant calls or approval',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'assistant-pg-restart-')),config={key:'mock-restart',baseUrl:'https://restart.invalid/v1',model:'seed-audio-1.0'};
  let app,textCalls=0,assistantCalls=0,restarting=false;
  t.after(async()=>{if(app?.server.listening)await app.close();rmSync(directory,{recursive:true,force:true});});
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    assert.equal(url,config.baseUrl+'/chat/completions');textCalls++;assert.equal(restarting,false,'received analysis must not be sent again on restart');
    const request=JSON.parse(options.body),input=JSON.parse(request.messages[1].content);
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:input.segments.map(row=>({segmentId:row.id,performance:'平静叙述，句末自然收住。',evidence:'创作建议',evidenceRefs:[],uncertain:false}))})}}]});
  });
  const assistantFetchImpl=async()=>{
    assistantCalls++;assert.equal(restarting,false,'local PG recovery needs no new assistant decision');
    return Response.json({choices:[{message:{content:JSON.stringify({reply:'开始安排本章表演。',steps:[{capabilityId:'operation.prepareChapter',input:{analysisKind:'director',performanceMode:'fillMissing',autoApply:true}}]})}}]});
  };
  app=await startServer({port:0,directory,config,assistantFetchImpl});
  const project=app.domain.mutate('project.create',{name:'重启自拟'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'收到响应的本章',source:'她展开信纸。\n明早集合。',segment:true}),original=app.domain.list(chapter.id).map(row=>structuredClone(row));
  app.assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'restart-mock',credentialSource:'audio',vision:false});
  const session=app.assistant.create({projectId:project.id,chapterId:chapter.id}).session;
  await app.assistant.send(session.id,{messageId:uid(),text:'只补齐本章每段表演指导，不生成音频。',mode:'task',approved:true,limits:{assistant:1,analysis:2,audio:0}});
  await until(()=>app.store.all('suggestions',chapter.id).some(r=>r.status==='applied'));
  await until(()=>!app.assistant.active);
  const run=app.store.get('assistantRuns',app.assistant.get(session.id).runs[0].id),analysis=app.store.all('suggestions',chapter.id)[0],step=app.store.all('assistantSteps',run.id)[0];
  assert.equal(textCalls,1);assert.equal(assistantCalls,1);
  // Persist the exact received response at the crash window before local parsing
  // and field registration. Then use the real server shutdown/reopen lifecycle.
  for(const row of original)app.store.put('segments',row,chapter.id);
  analysis.status='running';analysis.batches[0].status='sending';analysis.batches[0].attempts.at(-1).status='received';analysis.appliedItemIds=[];delete analysis.performanceReceipt;delete analysis.automation;
  app.store.put('suggestions',analysis,chapter.id);step.state='waitingJobs';step.resultRefs={analysisId:analysis.id};app.store.put('assistantSteps',step,run.id);run.state='waitingJobs';delete run.error;app.store.put('assistantRuns',run,session.id);
  await app.close();restarting=true;
  app=await startServer({port:0,directory,config,assistantFetchImpl});
  await until(()=>!app.assistant.active);
  await app.assistant.tick();await until(()=>!app.assistant.active);
  const final=app.assistant.get(session.id),restored=app.store.get('suggestions',analysis.id);
  assert.equal(restored.status,'applied',restored.automation?.error);assert.ok(app.domain.list(chapter.id).every(row=>row.performance==='平静叙述，句末自然收住。'));
  assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(final.runs[0].delivery.coverage.coveredCount,2);assert.equal(final.runs[0].budget.used.assistant,1);assert.equal(final.runs[0].budget.used.analysis,1);
  assert.equal(textCalls,1);assert.equal(assistantCalls,1);assert.equal(app.store.all('assistantDecisions').length,0);assert.equal(app.store.all('jobs').length,0);
});
