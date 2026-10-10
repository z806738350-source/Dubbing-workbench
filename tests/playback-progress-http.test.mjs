import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../server/index.mjs';
import { uid } from '../server/store.mjs';
import { workspaceIdentity } from '../server/workspace.mjs';

test('断点试听按原任务读取小型进度，不解析冻结正文、不派发或改变原回执', async t => {
  const directory=mkdtempSync(join(tmpdir(),'dubbing-playback-progress-'));
  const app=await startServer({port:0,directory,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  let parseMock;
  t.after(async()=>{parseMock?.mock.restore();await app.close();rmSync(directory,{recursive:true,force:true});});
  t.mock.method(app.worker,'tick',async()=>{});
  const marker='progress-frozen-not-parsed:',id=uid(),chapterId=uid();
  const job={id,chapterId,kind:'master',status:'running',done:0,total:142,arrangement:4,renderRevision:2,renderSignature:'current-range',masterId:uid(),renderRows:[{text:marker+'x'.repeat(3*1024*1024)}],request:{privateText:marker+'private'},ids:Array(142).fill('member')};
  app.store.put('jobs',job,chapterId);
  const original=app.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data;
  const parse=JSON.parse;
  parseMock=t.mock.method(JSON,'parse',(value,...args)=>{assert.ok(!String(value).includes(marker),'只读进度不应将冻结全文解析进页面或服务对象');return parse(value,...args);});
  const response=await fetch(`${base}/api/jobs/${id}/progress`);assert.equal(response.status,200);
  const body=await response.text();assert.ok(Buffer.byteLength(body)<1024);
  assert.deepEqual(JSON.parse(body),{id,chapterId,kind:'master',status:'running',done:0,total:142,masterId:job.masterId,arrangement:4,renderRevision:2,renderSignature:'current-range',error:null,workspaceIdentity:workspaceIdentity(directory)});
  assert.equal(app.store.db.prepare('SELECT data FROM jobs WHERE id=?').get(id).data,original);
  for(const status of ['success','failed','stopped','unknown']){
    app.store.put('jobs',{...job,status,done:status==='success'?142:0,error:status==='success'?null:'原任务未完成'},chapterId);
    const next=await fetch(`${base}/api/jobs/${id}/progress`),value=JSON.parse(await next.text());
    assert.equal(next.status,200);assert.equal(value.status,status);assert.equal(value.id,id);
    if(status==='success')assert.equal(value.error,null);else assert.ok(value.error.startsWith('原任务未完成'));
  }
  const missing=await fetch(`${base}/api/jobs/${uid()}/progress`);assert.equal(missing.status,404);await missing.text();
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count,0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM masters').get().count,0);
});

test('播放核对只读本章版本、范围和活动任务，工作区身份与正常状态一致',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-playback-status-')),app=await startServer({port:0,directory,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  let parseMock;t.after(async()=>{parseMock?.mock.restore();await app.close();rmSync(directory,{recursive:true,force:true});});
  t.mock.method(app.worker,'tick',async()=>{});
  const project=app.domain.mutate('project.create',{name:'定向版本核对'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'当前章',source:'自拟第一句。',segment:true});
  const other=app.domain.mutate('chapter.create',{projectId:project.id,title:'其他章',source:'其他自拟句子。',segment:true});
  const before=app.domain.chapter(chapter.id),normal=await(await fetch(base+'/api/state')).json(),marker='playback-status-no-frozen-parse:';
  const job={id:uid(),chapterId:chapter.id,kind:'master',status:'running',stop:true,createdAt:'2026-10-10T04:00:00.000Z',done:0,total:1,arrangement:before.arrangement,renderRevision:before.renderRevision,renderSignature:before.renderSignature,renderRows:[{text:marker+'x'.repeat(3*1024*1024)}]};
  app.store.put('jobs',job,chapter.id);app.store.put('jobs',{...job,id:uid(),status:'success'},chapter.id);app.store.put('jobs',{...job,id:uid(),chapterId:other.id},other.id);
  const parse=JSON.parse;parseMock=t.mock.method(JSON,'parse',(value,...args)=>{assert.ok(!String(value).includes(marker),'核对不应解析各章冻结任务正文');return parse(value,...args);});
  const response=await fetch(base+'/api/chapters/'+chapter.id+'/playback-status'),value=JSON.parse(await response.text());
  assert.equal(response.status,200);assert.equal(value.chapterId,chapter.id);assert.equal(value.workspaceIdentity,normal.settings.workspaceIdentity);
  for(const key of ['revision','arrangement','renderRevision','renderSignature'])assert.equal(value[key]??null,before[key]??null);
  assert.deepEqual(value.activeJobs.map(j=>[j.id,j.status]),[[job.id,'running']]);assert.equal(value.activeJobs[0].stop,true);assert.equal(value.activeJobs[0].createdAt,job.createdAt);assert.ok(Buffer.byteLength(JSON.stringify(value))<2048);
  const c=app.store.get('chapters',chapter.id);app.store.put('chapters',{...c,arrangement:c.arrangement+1},project.id);
  const changed=JSON.parse(await(await fetch(base+'/api/chapters/'+chapter.id+'/playback-status')).text());assert.equal(changed.arrangement,c.arrangement+1);assert.notEqual(changed.renderSignature,value.renderSignature);
  const missing=await fetch(base+'/api/chapters/'+uid()+'/playback-status');assert.equal(missing.status,404);await missing.text();
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS count FROM attempts').get().count,0);
});
