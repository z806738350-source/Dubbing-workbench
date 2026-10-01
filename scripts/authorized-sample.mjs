// Paid smoke test. User authorized first two chapters + provided voices to Kunpo.
import {writeFile,mkdir} from 'node:fs/promises';
const base='http://127.0.0.1:4318/api';
async function req(path,body){const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);const d=await r.json();if(!r.ok)throw new Error(d.error);return d;}
const state=await req('/state');
const original=state.projects.find(p=>p.name==='不要乱碰瓷 · 测试制作');
const source=state.chapters.find(c=>c.projectId===original.id&&c.title==='第1章').source;
let project=state.projects.find(p=>p.name==='不要乱碰瓷 · 小样验证');
if(!project)project=await req('/action',{action:'project.create',name:'不要乱碰瓷 · 小样验证'});
let c=state.chapters.find(c=>c.projectId===project.id);
if(!c)c=await req('/action',{action:'chapter.create',projectId:project.id,title:'第一章 · 开篇旁白小样',source:source.split('\n').slice(1,3).join('\n'),segment:true});
c=await req('/chapters/'+c.id);
const voice=state.voices.find(v=>v.name==='砸锅-里皮');
for(const s of c.segments){if(s.validity==='matched'||s.latest==='unknown')continue;c=await req('/chapters/'+c.id);await req('/action',{action:'segment.update',chapterId:c.id,revision:c.revision,id:s.id,voiceId:voice.id,roleConfirmed:true,identityConfirmed:true,performance:'平静叙述，字句清楚，不添加音效。'});}
c=await req('/chapters/'+c.id);const ids=c.segments.filter(s=>s.validity!=='matched'&&s.latest!=='unknown').map(s=>s.id);
if(ids.length){const j=await req('/jobs',{kind:'generate',chapterId:c.id,revision:c.revision,ids,whole:true,commandId:crypto.randomUUID()});console.log('已提交用户素材小样',j.id);}
await mkdir('data/live-smoke',{recursive:true});await writeFile('data/live-smoke/authorized-sample.json',JSON.stringify({projectId:project.id,chapterId:c.id,voiceId:voice.id,source:'用户授权的第一章前两段与砸锅-里皮参考声音',at:new Date().toISOString()},null,2));
