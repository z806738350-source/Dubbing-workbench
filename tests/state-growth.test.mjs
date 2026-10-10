import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';

test('200章大型原文仅在单章详情读取，连续状态刷新保持metadata及旧活动任务；后台重记录不全载',t=>{
  const directory=mkdtempSync(join(tmpdir(),'state-growth-')),store=openStore(directory),domain=createDomain(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const project=domain.mutate('project.create',{name:'200章自拟验证'}),source='大型来源与标点完整保留。'.repeat(4000),chapters=[];
  for(let i=0;i<200;i++){const chapter={id:uid(),projectId:project.id,title:'自拟第'+i+'章',order:i,source,importedSource:source+'\r\n',sourceFilename:'自拟.txt',revision:2,arrangement:3,sourceVersion:1,gap:.5,renderRevision:4};store.put('chapters',chapter,project.id);chapters.push(chapter);}
  const activeJob={id:uid(),kind:'master',chapterId:chapters[0].id,status:'queued',createdAt:'2026-10-01T00:00:00Z'};store.put('jobs',activeJob,chapters[0].id);
  const unknownJob={id:uid(),kind:'generate',chapterId:chapters[0].id,status:'unknown'},recoveryJob={id:uid(),kind:'generate',chapterId:chapters[0].id,status:'failed'},attempt=uid();store.put('jobs',unknownJob,chapters[0].id);store.put('jobs',recoveryJob,chapters[0].id);store.put('attempts',{id:attempt,jobId:recoveryJob.id,status:'failed',phase:'localRecoveryPending'},recoveryJob.id);
  for(let i=0;i<205;i++)store.put('jobs',{id:uid(),kind:'master',chapterId:chapters[1].id,status:i===204?'unknown':'success',createdAt:'2026-10-01T00:00:01Z',renderRows:[{a:{input:{text:source}}}]},chapters[1].id);
  const voice={id:uid(),name:'测试引用',state:'active'};store.put('voices',voice);store.put('audios',{id:uid(),input:{voiceId:voice.id,text:source},prompt:source},chapters[0].id);
  const raw=store.db.prepare('SELECT data FROM chapters ORDER BY rowid').all(),oldBytes=Buffer.byteLength(JSON.stringify(chapters)),all=store.all.bind(store);
  const forbid=t.mock.method(store,'all',(table,parent)=>{assert.ok(!['jobs','audios','chapters'].includes(table),'状态不能将全量'+table+'记录JSON.parse');return all(table,parent);});
  let bytes;
  for(let n=0;n<5;n++){const state=domain.snapshot();bytes=Buffer.byteLength(JSON.stringify(state));assert.equal(state.chapters.length,200);assert.equal(state.jobs.length,104);assert.equal(state.jobs[0].status,'unknown');assert.equal(state.jobs.find(job=>job.id===activeJob.id).status,'queued');assert.equal(state.jobs.find(job=>job.id===unknownJob.id).status,'unknown');assert.deepEqual(state.jobs.find(job=>job.id===recoveryJob.id).localRecoveryAttemptIds,[attempt]);assert.equal(state.chapters[0].productionStatus,'排队中');assert.equal(state.voices.find(row=>row.id===voice.id).tested,true);for(const c of state.chapters){assert.equal(Object.hasOwn(c,'source'),false);assert.equal(Object.hasOwn(c,'importedSource'),false);assert.equal(c.renderRevision,4);assert.equal(c.revision,2);assert.equal(c.arrangement,3);}}
  forbid.mock.restore();assert.ok(bytes<150000,bytes);assert.ok(oldBytes>50_000_000,oldBytes);assert.deepEqual(store.db.prepare('SELECT data FROM chapters ORDER BY rowid').all(),raw);
  const detail=domain.chapter(chapters[199].id);assert.equal(detail.source,source);assert.equal(detail.importedSource,source+'\r\n');assert.equal(store.get('jobs',activeJob.id).status,'queued');t.diagnostic(JSON.stringify({chapters:200,oldChapterBytes:oldBytes,snapshotBytes:bytes,refreshes:5}));
});

test('200条在途任务都保留进度，另保留最近100条历史且无重型快照或重复ID',t=>{
  const directory=mkdtempSync(join(tmpdir(),'state-long-queue-')),store=openStore(directory),domain=createDomain(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const project=domain.mutate('project.create',{name:'长队列夹具'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'长队列',source:'',segment:false}),history=[],active=[];
  for(let i=0;i<130;i++){const id=uid();history.push(id);store.put('jobs',{id,chapterId:chapter.id,kind:'master',status:'success',createdAt:'2026-10-01T00:00:00Z'},chapter.id);}
  for(let i=0;i<200;i++){const target=i?domain.mutate('chapter.create',{projectId:project.id,title:'队列第'+i+'章',source:'',segment:false}):chapter,id=uid();active.push(id);store.put('jobs',{id,chapterId:target.id,kind:'generate',status:i%2?'running':'queued',done:0,total:1,createdAt:'2026-10-01T00:00:01Z',request:{text:'自拟隐私正文'},renderRows:[{s:{text:'自拟隐私正文'}}]},target.id);}
  const state=domain.snapshot();assert.equal(state.jobs.length,300);assert.equal(new Set(state.jobs.map(job=>job.id)).size,300);for(const id of active)assert.ok(state.jobs.find(job=>job.id===id));for(const id of history.slice(-100))assert.ok(state.jobs.find(job=>job.id===id));for(const id of history.slice(0,30))assert.equal(state.jobs.some(job=>job.id===id),false);assert.equal(JSON.stringify(state).includes('自拟隐私正文'),false);assert.equal(store.all('jobs').length,330);
});

test('候选会话snapshot按会话查最小job字段，不解析100份巨大无关快照；未知/输入/归属与详情保留',t=>{
  const directory=mkdtempSync(join(tmpdir(),'state-voice-session-')),store=openStore(directory),domain=createDomain(store);t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const first=domain.mutate('voice-session.create',{description:'自拟第一种声音'}),other=domain.mutate('voice-session.create',{description:'自拟另一种声音'}),marker='FORBIDDEN_UNRELATED_RENDER_PAYLOAD',heavy=marker.repeat(3000),unrelated=[];
  for(let i=0;i<100;i++){const job={id:uid(),kind:'master',status:'success',renderRows:[{s:{text:heavy}}],request:{source:heavy},confirmation:{reviewItems:[{text:heavy}]},outputRecords:{master:{mapping:[{text:heavy}]}}};store.put('jobs',job);unrelated.push(job);}
  const rows=[{sessionId:first.id,status:'unknown',error:'结果未明'},{target:{sessionId:first.id},status:'failed',error:'保留本地结果'},{sessionId:other.id,target:{sessionId:first.id},status:'success'}].map((extra,index)=>{
    const job={id:uid(),kind:'voice-create',...extra,renderRows:[{text:heavy}]},attempt={id:uid(),jobId:job.id,status:extra.status,phase:index===1?'localRecoveryPending':extra.status,input:{targetKind:'candidate',sessionId:index===2?other.id:first.id,description:'完整候选描述',text:'自拟完整试音正文。'},prompt:'完整历史提示保持。',adopted:index===1?false:true,discarded:index===2};store.put('jobs',job);store.put('attempts',attempt,job.id);return{job,attempt};
  });
  const raw=store.db.prepare('SELECT data FROM jobs ORDER BY rowid').all(),all=store.all.bind(store),parse=JSON.parse;
  const noFullJobs=t.mock.method(store,'all',(table,parent)=>{assert.notEqual(table,'jobs','增强状态不得退回全jobs读取');return all(table,parent);}),noHeavyParse=t.mock.method(JSON,'parse',(text,...args)=>{assert.ok(!String(text).includes(marker),'任何无关重job都不能进入JSON.parse');return parse(text,...args);});
  const state=domain.snapshot();noHeavyParse.mock.restore();noFullJobs.mock.restore();
  const candidates=state.voiceSessions.find(session=>session.id===first.id).candidates;assert.deepEqual(candidates.map(candidate=>candidate.id),rows.slice(0,2).map(row=>row.attempt.id));
  for(const [index,candidate]of candidates.entries()){assert.equal(candidate.jobId,rows[index].job.id);assert.equal(candidate.status,rows[index].attempt.status);assert.equal(candidate.error,rows[index].job.error);assert.deepEqual(candidate.input,rows[index].attempt.input);assert.equal(candidate.prompt,rows[index].attempt.prompt);}assert.equal(candidates[1].late,true);
  assert.deepEqual(state.jobs.find(job=>job.id===rows[1].job.id).localRecoveryAttemptIds,[rows[1].attempt.id]);assert.equal(state.voiceSessions.find(session=>session.id===other.id).candidates[0].discarded,true);
  assert.deepEqual(store.db.prepare('SELECT data FROM jobs ORDER BY rowid').all(),raw);assert.deepEqual(store.get('jobs',unrelated[0].id),unrelated[0]);assert.deepEqual(store.get('jobs',rows[0].job.id),rows[0].job);
});
