import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {revealOutput} from '../server/workspace.mjs';
import { updateAudioRange, resolveAudioRange } from '../server/audio-range.mjs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
function wav(){const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b;}
function setup(t){
 const directory=mkdtempSync(join(tmpdir(),'output-receipts-')),store=openStore(directory),domain=createDomain(store),config={key:'fixture',model:'seed-audio-1.0',audioUrl:'https://fixture.invalid/audio',baseUrl:'https://fixture.invalid'};
 const project=domain.mutate('project.create',{name:'成品回执隔离'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'第一句。第二句。',segment:true});
 const role=store.all('roles',project.id)[0],voice={id:uid(),name:'自拟参考',state:'active',path:'reference.wav'};writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);
 domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id});domain.mutate('segment.confirm',{chapterId:chapter.id,revision:domain.chapter(chapter.id).revision,ids:domain.list(chapter.id).map(s=>s.id)});
 for(const s of domain.list(chapter.id)){const a={id:uid(),path:voice.path,input:inputOf(s)},review={audioId:a.id,basis:basisOf(s),state:'passed'};store.put('audios',a,chapter.id);store.put('segments',{...s,current:a.id,latest:'success',approved:a.id,review},chapter.id);}
 let worker=createWorker(store,domain,config);t.mock.method(globalThis,'fetch',async()=>assert.fail('本地成品处理不得调用模型'));
 t.after(async()=>{await worker.close();store.close();rmSync(directory,{recursive:true,force:true});});
 const submit=async(kind,format)=>{const c=domain.chapter(chapter.id),job=await worker.submit({kind,chapterId:c.id,revision:c.revision,arrangement:c.arrangement,commandId:uid(),...(format?{format,reviewItems:c.reviewItems,confirm:false}:{})});await worker.tick();return store.get('jobs',job.id);};
 return {directory,store,domain,chapter,project,submit,get worker(){return worker;},next:()=>worker=createWorker(store,domain,config)};
}
test('裁剪保存后WAV与MP3引用新母版与真实范围签名，恢复全长复用旧母版且模型basis不变',async t=>{
 const f=setup(t),before=f.domain.chapter(f.chapter.id),legacy=await f.submit('master'),target=before.playbackItems[0];
 const range=await resolveAudioRange(f.store,target.unitId,'dry',target.audioId);
 const saved=await updateAudioRange(f.store,{operationId:uid(),unitId:target.unitId,mode:'dry',audioId:target.audioId,expectedRevision:0,startFrame:37,endFrame:4079,sourceHash:range.range.sourceHash,decodeProfile:range.range.decodeProfile});
 const clipped=f.domain.chapter(f.chapter.id);assert.equal(clipped.arrangement,before.arrangement);assert.equal(clipped.revision,before.revision);assert.deepEqual(clipped.playbackItems.map(i=>i.basis),before.playbackItems.map(i=>i.basis));assert.equal(clipped.playbackItems[0].review,'pending');assert.equal(clipped.playbackItems[1].review,'passed');
 f.domain.mutate('unit.review',{chapterId:clipped.id,revision:clipped.revision,entityRevision:clipped.units.find(u=>u.id===target.unitId).revision,id:target.unitId,mode:'dry',audioId:target.audioId,basis:target.basis,rangeContentKey:clipped.reviewItems[0].rangeContentKey,state:'passed'});
 const wav=await f.submit('export','wav'),mp3=await f.submit('export','mp3');assert.equal(wav.status,'success',wav.error);assert.equal(mp3.status,'success',mp3.error);assert.notEqual(wav.masterId,legacy.masterId);assert.equal(wav.masterId,mp3.masterId);
 const master=f.store.get('masters',wav.masterId);assert.equal(master.mapping[0].endFrame-master.mapping[0].startFrame,4042);assert.equal(master.mapping[0].clipStartFrame,37);assert.equal(master.mapping[0].clipEndFrame,4079);assert.equal(master.renderSignature,clipped.renderSignature);assert.equal(wav.result.renderSignature,clipped.renderSignature);
 const outputs=f.domain.outputs({chapterId:clipped.id});assert.ok(outputs.items.find(o=>o.id===legacy.masterId&&!o.current));assert.ok(outputs.items.filter(o=>o.kind==='export').every(o=>o.current&&o.renderSignature===clipped.renderSignature));
 await updateAudioRange(f.store,{operationId:uid(),unitId:target.unitId,mode:'dry',audioId:target.audioId,expectedRevision:saved.range.revision,startFrame:0,endFrame:range.range.sourceFrames});assert.equal(f.domain.chapter(clipped.id).renderSignature,before.renderSignature);const restored=await f.submit('master');assert.equal(restored.masterId,legacy.masterId);
});
test('连续范围变化合并排队母版，冻结旧构建只入历史，后来的播放范围不被旧结果覆盖',async t=>{
 const f=setup(t),c=f.domain.chapter(f.chapter.id),target=c.playbackItems[0],scope={unitId:target.unitId,mode:'dry',audioId:target.audioId};
 const range=await resolveAudioRange(f.store,scope.unitId,'dry',scope.audioId);
 const write=async(startFrame,endFrame,expectedRevision)=>updateAudioRange(f.store,{...scope,operationId:uid(),startFrame,endFrame,expectedRevision});
 await write(20,4700,0);const first=await f.worker.submit({kind:'master',chapterId:c.id,revision:c.revision,commandId:uid()});
 await write(100,4600,1);const last=await f.worker.submit({kind:'master',chapterId:c.id,revision:c.revision,commandId:uid()});assert.equal(f.store.get('jobs',first.id).status,'stopped');assert.equal(f.store.all('jobs').filter(j=>j.status==='queued').length,1);
 const original=fsPromises.appendFile;let changed=false;
 t.mock.method(fsPromises,'appendFile',async(...args)=>{if(!changed){changed=true;await write(200,4500,2);}return original(...args);});syncBuiltinESMExports();
 t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports();});await f.worker.tick();const old=f.store.get('jobs',last.id);assert.equal(old.status,'failed');assert.ok(f.store.get('masters',old.masterId).superseded);assert.equal(f.store.get('masters',old.masterId).mapping[0].clipStartFrame,100);assert.equal(f.domain.outputs({chapterId:c.id}).items.find(o=>o.id===old.masterId).current,false);
 const latest=await f.submit('master');assert.equal(latest.status,'success',latest.error);assert.equal(f.store.get('masters',latest.masterId).mapping[0].clipStartFrame,200);assert.equal(f.domain.chapter(c.id).playbackItems[0].clipStartFrame,200);assert.equal(range.range.sourceFrames,4800);
});
test('actual master and WAV/MP3 export receipts expose their real IDs, reuse the master and preserve source audio',async t=>{
 const f=setup(t),sources=f.store.all('audios'),master=await f.submit('master');assert.equal(master.status,'success');assert.ok(master.masterId);assert.equal(master.result.masterId,master.masterId);
 for(const format of ['wav','mp3']){const job=await f.submit('export',format);assert.equal(job.status,'success');assert.equal(job.masterId,master.masterId);assert.equal(job.result.format,format);const output=f.store.get('exports',job.exportId);assert.equal(output.masterId,master.masterId);assert.ok(existsSync(join(f.directory,output.path)));const found=f.domain.outputs({chapterId:f.chapter.id,jobId:job.id});assert.ok(found.items.some(o=>o.exportId===job.exportId&&o.masterId===master.masterId&&o.current&&o.available));}
 assert.equal(f.store.all('masters').length,1);assert.deepEqual(f.store.all('audios'),sources);
 const reused=await f.submit('master');assert.equal(reused.masterId,master.masterId);assert.equal(f.store.all('masters').length,1);
});
test('complete output whose record registration failed recovers the same file and IDs without another render',async t=>{
 const f=setup(t),put=f.store.put;let failed=false;f.store.put=(table,...args)=>{if(table==='exports'&&!failed){failed=true;throw Error('fixture registry interruption');}return put(table,...args);};
 const job=await f.submit('export','wav');assert.equal(job.status,'failed');assert.equal(job.localOutputPending,true);assert.equal(f.store.all('exports').length,0);const path=join(f.directory,job.outputRecords.export.path),before=readFileSync(path),mtime=statSync(path).mtimeMs;f.store.put=put;
 await f.next().recover();const recovered=f.store.get('jobs',job.id);assert.equal(recovered.status,'success');assert.equal(recovered.exportId,job.exportId);assert.equal(f.store.all('exports').length,1);assert.deepEqual(readFileSync(path),before);assert.equal(statSync(path).mtimeMs,mtime);
 const stable=f.store.get('jobs',job.id);await f.next().recover();assert.deepEqual(f.store.get('jobs',job.id),stable);
});
test('同签名但当前朗读失配时queued母版和导出不能构建或复用为当前，旧声音与文件保留',async t=>{
 for(const kind of ['master','export'])for(const cached of [false,true])await t.test(kind+' '+(cached?'cached':'new'),async t=>{
  const f=setup(t),old=cached?await f.submit('master'):null,c=f.domain.chapter(f.chapter.id),audios=f.store.all('audios'),previous=old&&f.store.get('masters',old.masterId),bytes=previous&&readFileSync(join(f.directory,previous.path));
  const job=await f.worker.submit({kind,chapterId:c.id,revision:c.revision,arrangement:c.arrangement,commandId:uid(),...(kind==='export'?{format:'wav',reviewItems:c.reviewItems,confirm:false}:{})});
  const target=f.domain.list(c.id)[0];f.store.put('segments',{...target,performance:'按改变后的语境自然读出。'},c.id);const changed=f.domain.chapter(c.id);
  assert.equal(changed.revision,c.revision);assert.equal(changed.renderSignature,c.renderSignature);assert.equal(changed.playbackItems[0].validity,'stale');if(previous)assert.equal(changed.masters.find(m=>m.id===previous.id).current,false);
  await f.worker.tick();assert.equal(f.store.get('jobs',job.id).status,'failed');assert.equal(f.store.all('exports').length,0);assert.equal(f.store.all('masters').length,cached?1:0);assert.deepEqual(f.store.all('audios'),audios);assert.equal(f.store.get('segments',target.id).current,target.current);assert.equal(f.store.all('attempts').length,0);
  if(previous){assert.deepEqual(readFileSync(join(f.directory,previous.path)),bytes);assert.equal(f.domain.outputs({chapterId:c.id}).items.find(item=>item.id===previous.id).current,false);}
 });
});
test('本地成品登记中断后语境失效，同签名恢复只留历史且不再渲染或请求',async t=>{
 const f=setup(t),put=f.store.put;let interrupted=false;f.store.put=(table,...args)=>{if(table==='exports'&&!interrupted){interrupted=true;throw Error('fixture registry interruption');}return put(table,...args);};
 const job=await f.submit('export','wav');f.store.put=put;assert.equal(job.localOutputPending,true);const path=join(f.directory,job.outputRecords.export.path),bytes=readFileSync(path),mtime=statSync(path).mtimeMs,target=f.domain.list(f.chapter.id)[0];f.store.put('segments',{...target,performance:'引用语境已经变化。'},f.chapter.id);
 await f.next().recover();const recovered=f.store.get('jobs',job.id);assert.equal(recovered.status,'stopped');assert.equal(recovered.exportId,job.exportId);assert.equal(f.store.get('masters',recovered.masterId).superseded,true);assert.equal(f.store.get('exports',recovered.exportId).superseded,true);assert.deepEqual(readFileSync(path),bytes);assert.equal(statSync(path).mtimeMs,mtime);assert.equal(f.store.all('attempts').length,0);assert.ok(f.domain.outputs({chapterId:f.chapter.id}).items.every(item=>!item.current&&item.available));
});
test('只改标题或听评不使声音失配，queued本地成品继续复用原母版',async t=>{
 for(const kind of ['master','export'])await t.test(kind,async t=>{
  const f=setup(t),old=await f.submit('master'),c=f.domain.chapter(f.chapter.id),job=await f.worker.submit({kind,chapterId:c.id,revision:c.revision,arrangement:c.arrangement,commandId:uid(),...(kind==='export'?{format:'wav',reviewItems:c.reviewItems,confirm:false}:{})});
  f.store.put('chapters',{...f.store.get('chapters',c.id),title:'只改标题',revision:c.revision+1},c.projectId);const target=f.domain.list(c.id)[0];f.store.put('segments',{...target,review:{...target.review,state:'pending'}},c.id);assert.ok(f.domain.chapter(c.id).playbackItems.every(item=>item.validity==='matched'));
  await f.worker.tick();const done=f.store.get('jobs',job.id);assert.equal(done.status,'success',done.error);assert.equal(done.masterId,old.masterId);assert.equal(f.store.all('attempts').length,0);
 });
});
test('legacy null签名与旧单句fallback也要求当前有可听行，空章不复用或恢复旧母版',async t=>{
 const f=setup(t),chapter=f.store.get('chapters',f.chapter.id);f.store.put('chapters',{...chapter,renderProfile:'legacy-mono-v1'},chapter.projectId);
 const worker=createWorker(f.store,{...f.domain,enhancement:undefined},{key:''});try{
 const submit=()=>worker.submit({kind:'master',chapterId:chapter.id,revision:chapter.revision,commandId:uid()});const first=await submit();await worker.tick();const complete=f.store.get('jobs',first.id);assert.equal(complete.status,'success',complete.error);assert.equal(complete.renderSignature,null);const old=f.store.get('masters',complete.masterId),bytes=readFileSync(join(f.directory,old.path)),queued=await submit();
 for(const s of f.domain.list(chapter.id))f.store.put('segments',{...s,excluded:true},chapter.id);const empty=f.domain.chapter(chapter.id);assert.equal(empty.playbackItems.length,0);assert.equal(empty.renderSignature,null);assert.equal(empty.masters.find(m=>m.id===old.id).current,false);await worker.tick();assert.equal(f.store.get('jobs',queued.id).status,'failed');
 f.store.put('jobs',{...complete,status:'running',localOutputPending:true},chapter.id);await worker.recover();assert.equal(f.store.get('jobs',first.id).status,'stopped');assert.equal(f.store.get('masters',old.id).superseded,true);assert.deepEqual(readFileSync(join(f.directory,old.path)),bytes);assert.equal(f.store.all('attempts').length,0);
 }finally{worker.close();await worker.drain();}
});
test('historical unique receipts restore missing fields, ambiguity never guesses, and missing files stay unavailable',async t=>{
 const f=setup(t),master=await f.submit('master'),reused=await f.submit('master'),strip=job=>{for(const key of ['masterId','result','outputRecords','localOutputPending'])delete job[key];f.store.put('jobs',job,f.chapter.id);};strip({...reused});await f.next().recover();assert.equal(f.store.get('jobs',reused.id).masterId,master.masterId);
 const same=f.store.get('masters',master.masterId);f.store.put('masters',{...same,id:uid(),jobId:uid()},f.chapter.id);strip(f.store.get('jobs',reused.id));await f.next().recover();assert.equal(f.store.get('jobs',reused.id).masterId,undefined);
 const file=join(f.directory,same.path);rmSync(file);const found=f.domain.outputs({chapterId:f.chapter.id});assert.ok(found.items.every(o=>!o.available&&!o.current));
 assert.throws(()=>f.domain.outputs({chapterId:f.chapter.id,jobId:'another-chapter-job'}),/不属于当前章节/);assert.throws(()=>f.domain.outputs({chapterId:f.chapter.id,projectId:'another-project'}),/不属于当前项目/);
});
test('output location accepts a stored scoped ID and rejects arbitrary path or missing output',async t=>{
 const f=setup(t),job=await f.submit('export','wav'),calls=[];
 if(process.platform==='darwin'){await revealOutput(f.store,'export',job.exportId,async(...args)=>calls.push(args));assert.equal(calls.length,1);assert.equal(calls[0][0],'/usr/bin/open');assert.equal(calls[0][1][0],'-R');}
 else await assert.rejects(revealOutput(f.store,'export',job.exportId),/macOS/);
 const output=f.store.get('exports',job.exportId),outside=join(tmpdir(),'outside-'+uid()+'.wav');writeFileSync(outside,wav());t.after(()=>rmSync(outside,{force:true}));f.store.put('exports',{...output,path:outside},f.chapter.id);
 await assert.rejects(revealOutput(f.store,'export',job.exportId),/工作区/);assert.equal(f.domain.outputs({chapterId:f.chapter.id}).items.find(o=>o.id===job.exportId).available,false);
 f.store.put('exports',{...output,path:'missing.wav'},f.chapter.id);await assert.rejects(revealOutput(f.store,'export',job.exportId),/不存在/);
});

test('explicit basic reading is a free stable operation: keeps nonempty human guidance, input and arrangement, and protects the empty field',async t=>{
 const f=setup(t),{createExperience}=await import('../server/experience.mjs'),rows=f.domain.list(f.chapter.id);
 f.domain.mutate('segment.update',{chapterId:f.chapter.id,revision:f.domain.chapter(f.chapter.id).revision,id:rows[1].id,performance:'已有人工的克制指导。'});
 const before=f.domain.chapter(f.chapter.id),inputs=f.domain.list(f.chapter.id).map(inputOf),e=createExperience(f.store,f.domain,{}, {},{}),request={operationId:uid(),kind:'save',action:'segment.performance-basic',data:{chapterId:f.chapter.id,revision:before.revision,ids:rows.map(s=>s.id)}};
 const op=await e.run(request);assert.equal(op.outcome,'completed');assert.equal(op.result.changedIds.length,1);assert.deepEqual(op.result.preservedIds,[rows[1].id]);
 assert.equal(f.store.get('segments',rows[0].id).performance,'');assert.equal(f.store.get('segments',rows[0].id).decisions.performance.waivedBasic,true);assert.ok(f.store.get('segments',rows[0].id).protectedFields.includes('performance'));
 assert.equal(f.store.get('segments',rows[1].id).performance,inputs[1].performance);assert.deepEqual(f.domain.list(f.chapter.id).map(inputOf),inputs);assert.equal(f.domain.chapter(f.chapter.id).arrangement,before.arrangement);assert.deepEqual(f.domain.chapter(f.chapter.id).performanceCoverage.waivedBasicIds,[rows[0].id]);
 const revision=f.domain.chapter(f.chapter.id).revision;assert.deepEqual(await e.run(request),op);assert.equal(f.domain.chapter(f.chapter.id).revision,revision);assert.equal(f.store.all('jobs').length,0);
});

test('assistant exports real WAV and MP3, returns both receipts to the next model turn, and reuses one master without audio calls',async t=>{
 let assistant;t.after(async()=>{await assistant?.close();});
 const f=setup(t),{createAssistant}=await import('../server/assistant/service.mjs'),{createExperience}=await import('../server/experience.mjs'),config={key:'fixture',model:'seed-audio-1.0',baseUrl:'https://assistant-output.invalid/v1'},requests=[];
 const experience=createExperience(f.store,f.domain,f.worker,{},config);assistant=createAssistant({store:f.store,domain:f.domain,worker:f.worker,analysis:{},experience,config,fetchImpl:async(_url,options)=>{requests.push(JSON.parse(options.body));const format=requests.length===1?'wav':'mp3';return Response.json({choices:[{message:{content:JSON.stringify(requests.length<3?{reply:'正在导出。',steps:[{capabilityId:'operation.export',input:{format}}]}:{reply:'两个格式已导出。',complete:true})}}]});}});
 assistant.model.save({revision:0,enabled:true,baseUrl:config.baseUrl,model:'output-mock',credentialSource:'audio',vision:false});const session=assistant.create({projectId:f.project.id,chapterId:f.chapter.id}).session;
 const idle=async()=>{for(let n=0;n<300&&assistant.active;n++)await new Promise(r=>setTimeout(r,5));assert.equal(assistant.active,0);};
 await assistant.send(session.id,{messageId:uid(),text:'把当前已听评通过的这一章导出WAV和MP3，使用现有音频，不生成新音频。',mode:'task',approved:true,completionTarget:'requested-actions',limits:{assistant:4,analysis:0,audio:0}});await idle();
 for(let n=0;n<4&&assistant.get(session.id).runs[0].state!=='completed';n++){await f.worker.tick();await assistant.tick();await idle();}
 const final=assistant.get(session.id),exports=f.store.all('exports',f.chapter.id);assert.equal(final.runs[0].state,'completed',final.runs[0].error);assert.equal(exports.length,2);assert.equal(f.store.all('masters',f.chapter.id).length,1);assert.equal(exports[0].masterId,exports[1].masterId);assert.deepEqual(exports.map(e=>e.format),['wav','mp3']);assert.equal(f.store.all('assistantDecisions').length,0);
 for(let i=0;i<2;i++){const output=exports[i],nextRequest=JSON.stringify(requests[i+1]);assert.ok(nextRequest.includes(output.id));assert.ok(nextRequest.includes(output.masterId));assert.ok(nextRequest.includes(output.format));assert.ok(final.steps[i].resultRefs.outputs.some(o=>o.exportId===output.id&&o.available&&o.current));}
 assert.ok(f.store.all('jobs').every(j=>j.kind==='export'));assert.equal(requests.length,3);
});

test('HTTP output location rejects cross-chapter/project IDs and arbitrary paths before any OS action',async t=>{
 const {startServer}=await import('../server/index.mjs'),{request}=await import('node:http'),directory=mkdtempSync(join(tmpdir(),'scoped-output-http-'));let app;
 t.after(async()=>{await app?.close();rmSync(directory,{recursive:true,force:true});});app=await startServer({port:0,directory,config:{key:'fixture',baseUrl:'https://http-output.invalid',audioUrl:'https://http-output.invalid'}});
 const project=app.domain.mutate('project.create',{name:'成品作用域'}),otherProject=app.domain.mutate('project.create',{name:'另项目'}),chapter=app.domain.mutate('chapter.create',{projectId:project.id,title:'甲章',source:'甲。'}),other=app.domain.mutate('chapter.create',{projectId:project.id,title:'乙章',source:'乙。'}),masterId=uid(),exportId=uid();
 app.store.put('masters',{id:masterId,chapterId:chapter.id,path:'missing.wav',arrangement:chapter.arrangement},chapter.id);app.store.put('exports',{id:exportId,chapterId:chapter.id,path:'missing.wav',masterId,format:'wav',arrangement:chapter.arrangement},chapter.id);
 const post=(path,data)=>new Promise((resolve,reject)=>{const body=JSON.stringify(data),req=request({hostname:'127.0.0.1',port:app.server.address().port,path,method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{let result='';res.on('data',chunk=>result+=chunk);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(result)}));});req.on('error',reject);req.end(body);});
 for(const [kind,id]of [['master',masterId],['export',exportId]]){
  assert.equal((await post(`/api/outputs/${kind}/${id}/reveal`,{chapterId:other.id})).status,403);
  assert.equal((await post(`/api/outputs/${kind}/${id}/reveal`,{chapterId:chapter.id,projectId:otherProject.id})).status,403);
  assert.equal((await post(`/api/outputs/${kind}/${id}/reveal`,{chapterId:chapter.id,path:'/private/unknown.wav'})).status,400);
  assert.notEqual((await post(`/api/outputs/${kind}/${id}/reveal`,{chapterId:chapter.id})).status,200);
 }
 assert.equal(app.store.all('jobs').length,0);
});
