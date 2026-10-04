import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { openStore, uid } from '../server/store.mjs';

function wav() {
  const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);
  for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}
async function until(check) {
  const end=Date.now()+5000;while(!check()){if(Date.now()>end)assert.fail('condition did not become true');await new Promise(r=>setTimeout(r,5));}
}
async function server(t) {
  const directory=mkdtempSync(join(tmpdir(),'scheduler-http-'));
  const app=await startServer({port:0,directory,config:{key:'fixture',model:'seed-audio-1.0',audioUrl:'https://example.invalid/audio',audioConcurrency:3,routeConcurrencyCap:3,audioStartIntervalMs:0,callLimit:6,usageScope:'integration'}});
  let closed=false;
  const close=async()=>{if(!closed){closed=true;await app.close();}};
  t.after(async()=>{await close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`, fetchHTTP=globalThis.fetch;
  const request=(path,body,method='POST',headers={})=>fetchHTTP(base+path,body===undefined?undefined:{method,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  return {app,directory,base,request,close};
}
function chapter(app,directory) {
  const {domain:d,store}=app,p=d.mutate('project.create',{name:'并发集成'}),c=d.mutate('chapter.create',{projectId:p.id,title:'测试',source:'第一句。第二句。第三句。第四句。第五句。第六句。',segment:true});
  const voice={id:uid(),path:'reference.wav',state:'active'};writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);
  const r=store.all('roles',p.id)[0];d.mutate('role.update',{id:r.id,entityRevision:r.revision??1,voiceId:voice.id,chapterId:c.id,revision:c.revision});
  d.mutate('segment.confirm',{chapterId:c.id,revision:store.get('chapters',c.id).revision,ids:d.list(c.id).map(s=>s.id)});
  return {p,c};
}

test('scheduler HTTP采用版本比较，用户不能改账号cap，跨来源请求不写设置',async t=>{
  const {app,request}=await server(t);
  let result=await (await request('/api/scheduler')).json();assert.equal(result.revision,0);assert.equal(result.effectiveAudioConcurrency,3);
  let response=await request('/api/scheduler',{revision:0,desiredAudioConcurrency:4},'PUT');assert.equal(response.status,200);result=await response.json();
  assert.equal(result.revision,1);assert.equal(result.desiredAudioConcurrency,4);assert.equal(result.effectiveAudioConcurrency,3);
  assert.equal((await request('/api/scheduler',{revision:0,desiredAudioConcurrency:2},'PUT')).status,409);
  assert.equal((await request('/api/scheduler',{revision:1,desiredAudioConcurrency:4,routeConcurrencyCap:4},'PUT')).status,400);
  assert.equal((await request('/api/scheduler',{revision:1,desiredAudioConcurrency:2},'PUT',{Origin:'https://untrusted.example'})).status,403);
  assert.equal(app.store.get('settings','scheduler').revision,1);
  const state=await (await request('/api/state')).json();assert.equal(state.settings.scheduler.revision,1);assert.equal(state.settings.scheduler.routeConcurrencyCap,3);
});

test('三段在途时迁移被拒；服务器关闭等待回执及本地整理，已付费结果全部保存',async t=>{
  const {app,directory,request,close}=await server(t),{c}=chapter(app,directory);
  const requests=[],originalFetch=globalThis.fetch;
  t.mock.method(globalThis,'fetch',(url,options)=>String(url).startsWith('https://example.invalid/')?new Promise(resolve=>requests.push(()=>resolve(new Response(wav(),{headers:{'Content-Type':'audio/wav'}})))):originalFetch(url,options));
  const response=await request('/api/jobs',{kind:'unit-generate',chapterId:c.id,revision:app.store.get('chapters',c.id).revision,
    unitIds:app.domain.list(c.id).map(s=>s.id),mode:'dry',commandId:uid()});assert.equal(response.status,200);const job=await response.json();
  await until(()=>requests.length===3);
  const move=await request('/api/workspace/move',{source:directory,directory:directory+'-moved'});assert.equal(move.status,409);assert.equal(existsSync(directory+'-moved'),false);
  let done=false;const stopping=close().then(()=>done=true);await new Promise(r=>setTimeout(r,20));assert.equal(done,false);
  requests.forEach(release=>release());await stopping;assert.equal(done,true);assert.equal(existsSync(join(directory,'runtime.json')),false);
  const saved=openStore(directory);
  try {
    assert.deepEqual(saved.all('attempts',job.id).map(a=>a.status),['success','success','success','stopped','stopped','stopped']);
    assert.equal(saved.all('audios').length,3);assert.equal(saved.get('settings','audio-usage:integration').used,3);assert.equal(saved.get('settings','audio-usage:integration').reserved,0);
    for(const audio of saved.all('audios'))assert.deepEqual(readFileSync(join(directory,audio.path)),wav());
  }finally{saved.close();}
});
