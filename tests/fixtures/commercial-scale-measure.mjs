import {mkdtempSync,writeFileSync,statSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import assert from 'node:assert/strict';
import {openStore,uid} from '../../server/store.mjs';
import {createDomain} from '../../server/domain.mjs';
import {compile} from '../../server/templates.mjs';
import {renderIdentity,DEFAULT_RENDER_PROFILE} from '../../server/audio-range.mjs';
let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw Error('规模测量禁止模型和网络请求');};
console.warn('高负载隔离测量：历史峰值约3 GB进程内存；仅主动运行此夹具，不用于生产目录。');
const evidenceDirectory=mkdtempSync(join(tmpdir(),'dubbing-commercial-scale-evidence-')),resultPath=join(evidenceDirectory,'scale-measure-result.json');
console.log(JSON.stringify({evidenceDirectory,result:resultPath}));
const result={scope:'isolated actual domain objects; no HTTP transport/browser measurement',createdAt:new Date().toISOString(),providerCalls:0,mediaNote:'All records share one local synthetic WAV. Master placeholders are for JSON inventory measurements, not listening/rebuild validation.',cases:{}};
const bytes=value=>Buffer.byteLength(JSON.stringify(value));
function wav(){const frames=4800,b=Buffer.alloc(44+frames*4);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(2,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(192000,28);b.writeUInt16LE(4,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(frames*4,40);return b;}
function fixture(name){
  const directory=mkdtempSync(join(tmpdir(),'dubbing-scale-'+name+'-'));let store;
  try{store=openStore(directory);const domain=createDomain(store);writeFileSync(join(directory,'synthetic.wav'),wav());return{directory,store,domain};}
  catch(error){try{store?.close();}finally{rmSync(directory,{recursive:true,force:true});}throw error;}
}
function measure(name,work,fields=[]){const begin=performance.now(),data=work(),built=performance.now(),encoded=JSON.stringify(data),finished=performance.now();const stats={buildMs:Math.round((built-begin)*100)/100,stringifyMs:Math.round((finished-built)*100)/100,jsonBytes:Buffer.byteLength(encoded),fields:Object.fromEntries(fields.filter(field=>data[field]!==undefined).map(field=>[field,{jsonBytes:bytes(data[field]),items:Array.isArray(data[field])?data[field].length:undefined}])),heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss};console.log(JSON.stringify({measurement:name,...stats}));return stats;}
try {
const a=fixture('chapter');
try {
const project=a.domain.mutate('project.create',{name:'同章大历史隔离测量'}),voice={id:uid(),name:'合成参考',path:'synthetic.wav',state:'active',revision:1,duration:.1};a.store.put('voices',voice);const role=a.store.all('roles',project.id)[0];a.domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id});
const source=Array.from({length:135},(_,i)=>`自拟第${i+1}段，`+'这条道路旁有风吹过树枝，行人保持脚步继续前行，'.repeat(4)+'句末自然收住。').join('\n');
const chapter=a.domain.mutate('chapter.create',{projectId:project.id,title:'135段历史规模',source,segment:true});assert.equal(a.domain.list(chapter.id).length,135);a.domain.mutate('segment.confirm',{chapterId:chapter.id,revision:a.store.get('chapters',chapter.id).revision,ids:a.domain.list(chapter.id).map(s=>s.id)});
const current=[];
a.store.transaction(()=>{for(const s of a.domain.list(chapter.id)){s.performance='语气平稳，保持语速，句末自然收住。';a.store.put('segments',s,chapter.id);const u=a.domain.enhancement.getUnit(s.id),input=a.domain.enhancement.input(u,'dry'),basis=a.domain.enhancement.basis(u,'dry'),audio={id:uid(),chapterId:chapter.id,path:'synthetic.wav',input,basis,prompt:compile(input),duration:.1,format:'wav',sampleRate:48000,channels:2,model:input.model,review:{basis,state:'passed'}};audio.review.audioId=audio.id;a.store.put('audios',audio,chapter.id);s.current=audio.id;s.approved=audio.id;s.latest='success';s.review=audio.review;a.store.put('segments',s,chapter.id);a.domain.enhancement.syncLegacySegment(s);current.push({s,input,basis,audio});}});
result.cases.chapter={directory:a.directory,sourceChars:source.length,textChars:current[0].input.text.length,promptChars:current[0].audio.prompt.length,baseline:{state:measure('chapter-baseline-state',()=>a.domain.snapshot(),['chapters','jobs','voiceSessions']),chapter:measure('chapter-baseline-detail',()=>a.domain.chapter(chapter.id),['segments','units','masters','suggestions'])}};
const seeding=performance.now();
a.store.transaction(()=>{
 for(const row of current){let previous;for(let version=0;version<99;version++){const audio={...row.audio,id:uid(),createdAt:`2026-01-${String(version%28+1).padStart(2,'0')}T00:00:00.000Z`};a.store.put('audios',audio,chapter.id);previous=audio.id;}const s=a.store.get('segments',row.s.id);s.previous=previous;a.store.put('segments',s,chapter.id);a.domain.enhancement.syncLegacySegment(s);}
 const identity=renderIdentity(a.store,chapter.id),mapping=current.map((row,index)=>({unitId:row.s.id,memberIds:[row.s.id],mode:'dry',audioId:row.audio.id,clipStartFrame:0,clipEndFrame:4800,startFrame:index*28800,endFrame:index*28800+4800,renderProfile:DEFAULT_RENDER_PROFILE,boundaryPolicy:'unit-gap-v1'}));
 for(let version=0;version<200;version++){const id=uid(),jobId=uid(),master={id,jobId,chapterId:chapter.id,path:'synthetic.wav',arrangement:version+1,frames:135*4800+134*24000,gapFrames:24000,channels:2,sampleRate:48000,processing:'pcm_s16le-48000-stereo',renderProfile:DEFAULT_RENDER_PROFILE,mapping,renderSignature:identity.renderSignature,createdAt:'2026-10-01T00:00:00.000Z'};a.store.put('masters',master,chapter.id);a.store.put('jobs',{id:jobId,chapterId:chapter.id,kind:'master',status:'success',masterId:id,done:135,total:135,renderRows:current.map(row=>({s:row.s,a:row.audio})),createdAt:'2026-10-01T00:00:00.000Z'},chapter.id);}
 const items=current.map((row,index)=>({id:index,segmentId:row.s.id,from:row.s.source.start,to:row.s.source.end,text:row.s.text,performance:row.s.performance,roleId:row.s.roleId,type:row.s.type,evidence:'上下文推断',evidenceRefs:[index],reason:'结合当前句子与相邻段落安排。',uncertain:false}));
 for(let version=0;version<500;version++){const record={id:uid(),chapterId:chapter.id,kind:'director',status:'applied',revision:chapter.revision,sourceVersion:1,source,blocks:current.map((row,index)=>({id:index,text:row.s.text})),items,batches:[{id:uid(),status:'received',items,attempts:[{id:uid(),status:'received',response:{choices:[{message:{content:JSON.stringify({items})}}]}}]}],createdAt:'2026-10-01T00:00:00.000Z'};a.store.put('suggestions',record,chapter.id);}
});
console.log(JSON.stringify({phase:'chapter-history-seeded',ms:Math.round(performance.now()-seeding)}));
Object.assign(result.cases.chapter,{counts:{segments:135,audioVersions:13500,masters:200,suggestions:500},databaseBytes:statSync(join(a.directory,'workbench.sqlite')).size,large:{state:measure('chapter-large-state',()=>a.domain.snapshot(),['chapters','jobs','voiceSessions']),chapter:measure('chapter-large-detail',()=>a.domain.chapter(chapter.id),['segments','units','masters','suggestions']),enhancement:measure('chapter-large-enhancement',()=>a.domain.enhancement.snapshot(),['voiceSessions']),outputs20:measure('chapter-outputs-page20',()=>a.domain.outputs({chapterId:chapter.id,limit:20}),['items']),audioById:measure('chapter-audio-by-id',()=>a.store.get('audios',current[0].audio.id))}});
} finally {try{a.store.close();}finally{rmSync(a.directory,{recursive:true,force:true});if(result.cases.chapter)result.cases.chapter.workspaceRemoved=true;}}
writeFileSync(resultPath,JSON.stringify(result,null,2));
const b=fixture('voices');
try {
const sessions=[];
b.store.transaction(()=>{for(let i=0;i<100;i++)sessions.push(b.domain.mutate('voice-session.create',{description:`自拟第${i+1}种声音。`+'成年声音保持清楚、温和、稳定，适合长篇叙事与自然对话。'.repeat(16)}));});
result.cases.voices={directory:b.directory,descriptionChars:sessions[0].description.length,baseline:{state:measure('voices-baseline-state',()=>b.domain.snapshot(),['voiceSessions','jobs']),enhancement:measure('voices-baseline-enhancement',()=>b.domain.enhancement.snapshot(),['voiceSessions'])}};
const voiceSeed=performance.now();b.store.transaction(()=>{for(const session of sessions){const input={targetKind:'candidate',sessionId:session.id,description:session.description,text:session.text,model:session.model,template:session.template,config:session.config,referenceVoiceIds:[]},prompt=compile(input);if(session.id===sessions[0].id)result.cases.voices.promptChars=prompt.length;for(let version=0;version<100;version++){const jobId=uid(),id=uid();b.store.put('jobs',{id:jobId,sessionId:session.id,targetKind:'candidate',kind:'voice-create',status:'success',done:1,total:1,createdAt:'2026-10-01T00:00:00.000Z'});b.store.put('attempts',{id,jobId,targetKind:'candidate',targetId:session.id,status:'success',phase:'registered',input,prompt,adopted:true},jobId);b.store.put('audios',{id,path:'synthetic.wav',targetKind:'candidate',targetId:session.id,input,prompt,model:input.model,duration:.1,format:'wav',sampleRate:48000,channels:2});}}});
console.log(JSON.stringify({phase:'voice-candidates-seeded',ms:Math.round(performance.now()-voiceSeed)}));
Object.assign(result.cases.voices,{counts:{voiceSessions:100,candidates:10000},large:{state:measure('voices-large-state',()=>b.domain.snapshot(),['voiceSessions','jobs']),enhancement:measure('voices-large-enhancement',()=>b.domain.enhancement.snapshot(),['voiceSessions']),audioById:measure('voice-audio-by-id',()=>b.store.get('audios',b.store.db.prepare('SELECT id FROM audios LIMIT 1').get().id))}});
} finally {try{b.store.close();}finally{rmSync(b.directory,{recursive:true,force:true});if(result.cases.voices)result.cases.voices.workspaceRemoved=true;}}
result.providerCalls=providerCalls;assert.equal(providerCalls,0);writeFileSync(resultPath,JSON.stringify(result,null,2));console.log(JSON.stringify({completed:true,result:resultPath,providerCalls}));

} catch(error){result.error={name:error.name,message:error.message};throw error;}
finally{result.providerCalls=providerCalls;writeFileSync(resultPath,JSON.stringify(result,null,2));console.log(JSON.stringify({evidenceDirectory,result:resultPath,providerCalls,failed:!!result.error}));}
