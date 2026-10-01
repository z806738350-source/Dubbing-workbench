// Local-only checks on the explicit self-authored API test project. No paid calls.
import assert from 'node:assert/strict';
import {writeFile,mkdir,readFile} from 'node:fs/promises';
import {inspect} from '../server/audio.mjs';
import {basisOf} from '../server/domain.mjs';
const base='http://127.0.0.1:4318/api';
async function req(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const d=await r.json();if(!r.ok)throw new Error(d.error);return d;}
async function wait(id){for(;;){const j=(await req('/state')).jobs.find(j=>j.id===id);if(!['running','queued'].includes(j.status)){assert.equal(j.status,'success',j.error);return j;}await new Promise(r=>setTimeout(r,300));}}
const state=await req('/state'),p=state.projects.find(p=>p.name==='自拟样章 · 接口验收');assert.ok(p);
const report=[];
for(const chapter of state.chapters.filter(c=>c.projectId===p.id)){
 let c=await req('/chapters/'+chapter.id);
 for(const format of ['wav','mp3']){
  const j=await req('/jobs',{kind:'export',chapterId:c.id,revision:c.revision,arrangement:c.arrangement,format,confirm:true,reviewItems:c.segments.filter(s=>!s.excluded).map(s=>({id:s.id,audioId:s.current,basis:basisOf(s)})),commandId:crypto.randomUUID()});await wait(j.id);
  c=await req('/chapters/'+chapter.id);const ex=c.exports.at(-1),m=c.masters.find(m=>m.id===ex.masterId);
  const meta=await inspect('data/'+ex.path);const expected=c.segments.reduce((n,s)=>n+s.audio.duration,0)+(c.segments.length-1)*c.gap;
  assert.ok(Math.abs(m.duration-expected)<1/48000+0.00001);assert.equal(meta.sampleRate,48000);
  if(format==='wav')assert.deepEqual(await readFile('data/'+m.path),await readFile('data/'+ex.path));
  const response=await fetch(base+'/media/exports/'+ex.id,{headers:{Range:'bytes=0-43'}});assert.equal(response.status,206);assert.equal((await response.arrayBuffer()).byteLength,44);
  report.push({chapter:c.title,format,path:ex.path,duration:meta.duration,masterFrames:m.frames,sampleRate:meta.sampleRate,fromSameMaster:true});
 }
}
const blocked=await fetch(base+'/state',{headers:{Origin:'https://example.invalid'}});assert.equal(blocked.status,403);
await mkdir('data/live-smoke',{recursive:true});await writeFile('data/live-smoke/exports.json',JSON.stringify({at:new Date().toISOString(),purpose:'工程检查记录，批量通过只用于自拟测试项目，不代表人工听感验收',report,originIsolation:true},null,2));console.log(report);
