import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../server/index.mjs';
import { uid } from '../server/store.mjs';

function wav(frames,channels=1) {
  const bytes=Buffer.alloc(44+frames*channels*2);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(channels,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(48000*channels*2,28);bytes.writeUInt16LE(channels*2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*channels*2,40);for(let at=44;at<bytes.length;at+=2)bytes.writeInt16LE((at*7919)%60001-30000,at);return bytes;
}

test('媒体下载反复取消关闭真实ReadStream/FD，Range/HEAD/416和参考读取释放保持正确',async t=>{
  const directory=fs.mkdtempSync(join(tmpdir(),'dubbing-media-abort-')),app=await startServer({port:0,directory,config:{key:''}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();fs.rmSync(directory,{recursive:true,force:true});});
  app.store.put('settings',{id:'project-folders',enabled:true});const project=app.domain.mutate('project.create',{name:'取消流夹具'}),masterId=uid(),voiceId=uid(),masterFile=join(directory,'masters/large.wav'),voiceFile=join(directory,'voices/reference.wav'),bytes=wav(4*1024*1024),reference=wav(48000*25,2);
  fs.mkdirSync(join(directory,'masters'));fs.mkdirSync(join(directory,'voices'));fs.writeFileSync(masterFile,bytes);fs.writeFileSync(voiceFile,reference);app.store.put('masters',{id:masterId,path:'masters/large.wav'});app.store.put('voices',{id:voiceId,name:'合成参考',state:'active',path:'voices/reference.wav',revision:1});
  const reads=[],create=fs.createReadStream,mock=t.mock.method(fs,'createReadStream',(file,options)=>{
    const stream=create(file,{...options,highWaterMark:1024});
    if([masterFile,voiceFile].includes(String(file))){const entry={stream,file:String(file),fd:null,released:false};stream.once('open',fd=>{entry.fd=fd;});entry.closed=new Promise(resolve=>stream.once('close',()=>{try{fs.fstatSync(entry.fd);}catch(error){entry.released=error.code==='EBADF';}resolve();}));reads.push(entry);}return stream;
  });syncBuiltinESMExports();t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});
  const native=globalThis.fetch;t.mock.method(globalThis,'fetch',(url,options)=>{assert.ok(String(url).startsWith(base+'/'),'测试不得向外发模型请求');return native(url,options);});
  const hold=path=>new Promise((resolve,reject)=>{const request=http.get(base+path,{headers:{Range:'bytes=0-'}},response=>{response.on('error',()=>{});response.once('data',chunk=>{response.pause();resolve({request,response,bytes:chunk.length});});});request.once('error',reject);});
  const closed=async entry=>{let timer;try{await Promise.race([entry.closed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('取消后文件流没有关闭')),1500);timer.unref();})]);}finally{clearTimeout(timer);}assert.equal(entry.stream.closed,true);assert.equal(entry.stream.fd,null);assert.equal(entry.released,true,'操作系统文件描述符应已关闭');};
  for(let index=0;index<12;index++){const before=reads.length,pending=await hold('/api/media/masters/'+masterId);assert.ok(pending.bytes>0);pending.response.destroy();pending.request.destroy();assert.equal(reads.length,before+1);await closed(reads[before]);assert.ok(reads[before].stream.bytesRead<bytes.length,'取消后不应读完大文件');}
  const range=await fetch(base+'/api/media/masters/'+masterId,{headers:{Range:'bytes=17-1033'}});assert.equal(range.status,206);assert.equal(range.headers.get('content-range'),`bytes 17-1033/${bytes.length}`);assert.ok(Buffer.from(await range.arrayBuffer()).equals(bytes.subarray(17,1034)));await closed(reads.at(-1));
  const beforeHead=reads.length,head=await fetch(base+'/api/media/masters/'+masterId,{method:'HEAD'});assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),bytes.length);assert.equal((await head.arrayBuffer()).byteLength,0);assert.equal(reads.length,beforeHead,'HEAD不打开音频读取流');
  const bad=await fetch(base+'/api/media/masters/'+masterId,{headers:{Range:`bytes=${bytes.length}-`}});assert.equal(bad.status,416);await bad.arrayBuffer();assert.equal(reads.length,beforeHead);
  const missing=await fetch(base+'/api/media/masters/'+uid());assert.equal(missing.status,404);await missing.arrayBuffer();
  const beforeVoice=reads.length,voice=await hold('/api/media/voices/'+voiceId),rename=()=>fetch(base+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'project.rename',id:project.id,entityRevision:app.store.get('projects',project.id).revision??1,name:'取消后可编辑'})});
  try{const blocked=await rename();assert.equal(blocked.status,409);await blocked.arrayBuffer();}finally{voice.response.destroy();voice.request.destroy();}await closed(reads[beforeVoice]);const released=await rename();assert.equal(released.status,200);await released.arrayBuffer();assert.ok(fs.existsSync(voiceFile),'参考原文件保持');
  const voiceHeadReads=reads.length,voiceHead=await fetch(base+'/api/media/voices/'+voiceId,{method:'HEAD'});assert.equal(voiceHead.status,200);assert.equal(reads.length,voiceHeadReads);assert.equal((await voiceHead.arrayBuffer()).byteLength,0);
  assert.equal((await fetch(base+'/api/state')).status,200,'取消流后服务继续正常响应');assert.equal(app.store.all('attempts').length,0);
});
