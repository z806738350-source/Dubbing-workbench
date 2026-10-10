import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {startServer} from '../../server/index.mjs';
import {uid} from '../../server/store.mjs';
import {compile} from '../../server/templates.mjs';
import {buildMaster} from '../../server/audio.mjs';
import {renderIdentity} from '../../server/audio-range.mjs';
const directory=mkdtempSync(join(tmpdir(),'dubbing-commercial-pressure-')),frames=48000,bytes=Buffer.alloc(44+frames*4);
bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);for(let i=0;i<frames;i++){bytes.writeInt16LE(Math.round(1800*Math.sin(i*.025)),44+i*4);bytes.writeInt16LE(Math.round(1400*Math.sin(i*.038)),46+i*4);}
let providerCalls=0;globalThis.fetch=async()=>{providerCalls++;throw Error('夹具禁止全部服务端模型/网络请求');};
const app=await startServer({directory,port:0,config:{key:'fixture-only',model:'seed-audio-1.0',baseUrl:'https://fixture.invalid/v1',audioUrl:'https://fixture.invalid/audio'},assistantFetchImpl:async()=>{providerCalls++;throw Error('夹具禁止助手连接');}}),{store,domain}=app;
const project=domain.mutate('project.create',{name:'200章持续可靠 · 纯合成夹具'}),voice={id:uid(),name:'合成参考',path:'reference.wav',state:'active',revision:1};writeFileSync(join(directory,voice.path),bytes);store.put('voices',voice);const role=store.all('roles',project.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id});
const chapters=[],largeImported='自拟原始来源，仅验证全文不进入状态轮询。'.repeat(4000);
for(let n=0;n<200;n++){
  const source=Array.from({length:6},(_,i)=>`自拟第${n+1}章第${i+1}句，测试波形、导航、播放与断点恢复。`).join('\n');
  const c=domain.mutate('chapter.create',{projectId:project.id,title:`第${n+1}章 · 长期夹具`,source,importedSource:largeImported,segment:true});
  domain.mutate('segment.confirm',{chapterId:c.id,revision:store.get('chapters',c.id).revision,ids:domain.list(c.id).map(s=>s.id)});
  for(const s of domain.list(c.id)){s.performance='语气平稳，句尾自然收住。';store.put('segments',s,c.id);const unit=domain.enhancement.getUnit(s.id),input=domain.enhancement.input(unit,'dry'),basis=domain.enhancement.basis(unit,'dry'),audio={id:uid(),chapterId:c.id,path:voice.path,input,basis,prompt:compile(input),duration:1,sampleRate:48000,channels:2,format:'wav',model:input.model};store.put('audios',audio,c.id);s.current=audio.id;s.latest='success';s.review={audioId:audio.id,basis,state:'passed'};store.put('segments',s,c.id);domain.enhancement.syncLegacySegment(s);}
  const rows=domain.enhancement.resolve(c.id),id=uid(),master={id,chapterId:c.id,arrangement:store.get('chapters',c.id).arrangement,...renderIdentity(store,c.id,rows),...await buildMaster(store,rows,.5,id),createdAt:new Date().toISOString()};delete master.items;store.put('masters',master,c.id);
  chapters.push({id:c.id,title:c.title,firstSegmentId:domain.list(c.id)[0].id});if((n+1)%25===0)console.log(JSON.stringify({prepared:n+1}));
}
const heavy='自拟后台冻结记录，页面不必读取。'.repeat(200),first=chapters[0];
for(let i=0;i<100;i++)store.put('jobs',{id:uid(),commandId:uid(),kind:'master',chapterId:first.id,status:'success',ids:[],done:6,total:6,createdAt:'2026-10-01T00:00:00.000Z',renderRows:Array.from({length:30},()=>({s:{text:heavy},a:{input:{text:heavy},prompt:heavy}})),request:{source:heavy},outputRecords:{master:{mapping:[{text:heavy}]}}},first.id);
const rawChapterBytes=Buffer.byteLength(JSON.stringify(store.all('chapters'))),rawJobsBytes=Buffer.byteLength(JSON.stringify(store.all('jobs'))),snapshotBytes=Buffer.byteLength(JSON.stringify(domain.snapshot()));assert(rawChapterBytes>30_000_000);assert(snapshotBytes<500_000);
const counters={requests:0,active:0,peak:0,bytes:0,stateRequests:0,stateBytes:0,chapterRequests:0},handler=app.server.listeners('request')[0];app.server.removeAllListeners('request');
app.server.on('request',(req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(readFileSync(new URL('../../dist/index.html',import.meta.url),'utf8').replace('</head>','<script src="/__fixture/client.js"></script></head>'));return;}
  if(req.url==='/__fixture/status'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({providerCalls,pid:process.pid,directory,chapters,rawChapterBytes,rawJobsBytes,snapshotBytes,counters,rss:process.memoryUsage().rss}));return;}
  if(req.url==='/__fixture/client.js'){res.writeHead(200,{'Content-Type':'application/javascript'});res.end(readFileSync(new URL('./commercial-pressure.js',import.meta.url)));return;}
  if(req.url==='/__fixture/result'&&req.method==='POST'){let text='';req.on('data',chunk=>{text+=chunk;});req.on('end',()=>{assert(text.length<100000);writeFileSync(join(directory,'pressure-result.json'),text);res.end('{}');});return;}
  counters.requests++;counters.active++;counters.peak=Math.max(counters.peak,counters.active);let closed=false;res.once('close',()=>{if(!closed){closed=true;counters.active--;}});
  if(req.url==='/api/state')counters.stateRequests++;if(req.url.startsWith('/api/chapters/'))counters.chapterRequests++;
  const end=res.end;res.end=function(data,...args){if(data){const length=Buffer.byteLength(data);counters.bytes+=length;if(req.url==='/api/state')counters.stateBytes+=length;}return end.call(this,data,...args);};
  void handler(req,res);
});
const url='http://127.0.0.1:'+app.server.address().port;console.log(JSON.stringify({url,pid:process.pid,directory,chapters:chapters.length,rawChapterBytes,rawJobsBytes,snapshotBytes}));writeFileSync(join(directory,'pressure-info.json'),JSON.stringify({url,pid:process.pid,directory,chapters:chapters.length,rawChapterBytes,rawJobsBytes,snapshotBytes}));const stop=async()=>{await app.close();process.exit();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
