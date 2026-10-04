import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createWorker } from '../server/worker.mjs';
import { createFairPicker } from '../server/scheduler.mjs';

function wav() {
  const b = Buffer.alloc(44 + 9600);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8,4); b.write('WAVEfmt ',8); b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20); b.writeUInt16LE(1,22); b.writeUInt32LE(48000,24); b.writeUInt32LE(96000,28);
  b.writeUInt16LE(2,32); b.writeUInt16LE(16,34); b.write('data',36); b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<4800;i++) b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);
  return b;
}
function setup(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(),'dubbing-concurrency-')), store = openStore(directory), domain = createDomain(store);
  const config = { key:'test',model:'seed-audio-1.0',audioUrl:'https://example.invalid',audioConcurrency:3,routeConcurrencyCap:3,audioStartIntervalMs:0,...options };
  const worker = createWorker(store,domain,config);
  t.after(async()=>{worker.close();await worker.drain();store.close();rmSync(directory,{recursive:true,force:true});});
  const project = domain.mutate('project.create',{name:'并发测试'}), voice = {id:uid(),path:'reference.wav',state:'active'};
  writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);
  const role=store.all('roles',project.id)[0];
  function chapter(count = 6) {
    const c = domain.mutate('chapter.create',{projectId:project.id,title:'测试章',source:Array.from({length:count},(_,i)=>`第${i+1}句。`).join(''),segment:true});
    if (store.get('roles',role.id).voiceId !== voice.id) domain.mutate('role.update',{id:role.id,entityRevision:store.get('roles',role.id).revision ?? 1,voiceId:voice.id,chapterId:c.id,revision:c.revision});
    domain.mutate('segment.confirm',{chapterId:c.id,revision:store.get('chapters',c.id).revision,ids:domain.list(c.id).map(s=>s.id)});
    return c;
  }
  const enqueue=(c, extra={})=>worker.enqueue({kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,
    unitIds:domain.list(c.id).map(s=>s.id),mode:'dry',commandId:uid(),...extra});
  return {directory,store,domain,worker,project,voice,chapter,enqueue,config};
}
async function until(check) {
  const end=Date.now()+5000;
  while(!check()) { if(Date.now()>end) assert.fail('condition did not become true'); await new Promise(resolve=>setTimeout(resolve,5)); }
}
function heldFetch(t) {
  const calls=[];let inFlight=0,peak=0;
  t.mock.method(globalThis,'fetch',(_,options)=>new Promise(resolve=>{
    inFlight++;peak=Math.max(peak,inFlight);
    calls.push({payload:JSON.parse(options.body),release(status=200){inFlight--;resolve(status===200?new Response(wav(),{headers:{'Content-Type':'audio/wav'}}):new Response('upstream error',{status}));}});
  }));
  return {calls,get peak(){return peak;}};
}

test('VC02/03/07/10/12 同章三槽真实重叠，释放补位，乱序不改变朗读顺序或丢计数', async t=>{
  const {store,domain,worker,chapter,enqueue,directory}=setup(t),c=chapter(),job=enqueue(c),gate=heldFetch(t);
  const pending=worker.tick();await until(()=>gate.calls.length===3);
  assert.equal(gate.peak,3);assert.equal(store.get('jobs',job.id).status,'running');
  await worker.tick();assert.equal(gate.calls.length,3,'重入不得重复领取');
  gate.calls[2].release();await until(()=>gate.calls.length===4);
  gate.calls[0].release();gate.calls[1].release();await until(()=>gate.calls.length===6);
  gate.calls[5].release();gate.calls[3].release();gate.calls[4].release();await pending;
  const attempts=store.all('attempts',job.id);assert.equal(store.get('jobs',job.id).done,6);assert.equal(store.get('jobs',job.id).status,'success');
  assert.deepEqual(attempts.map(a=>a.ordinal),[0,1,2,3,4,5]);assert.equal(new Set(attempts.map(a=>a.ownerToken)).size,6);
  assert.ok(attempts.every(a=>a.generationEpoch===1 && a.phase==='registered'));
  const rows=domain.enhancement.resolve(c.id);assert.deepEqual(rows.map(r=>r.a.id),attempts.map(a=>a.id));
  worker.enqueue({kind:'master',chapterId:c.id,revision:store.get('chapters',c.id).revision,commandId:uid()});await worker.tick();
  assert.deepEqual(store.all('masters',c.id)[0].mapping.map(m=>m.audioId),attempts.map(a=>a.id));
  for(const a of attempts)assert.deepEqual(readFileSync(join(directory,a.path)),wav());
  assert.equal(worker.getActivity().active,false);
});

test('VC04 降并发不取消在途，上调只使用原计划待发目标',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),c=chapter(),job=enqueue(c),gate=heldFetch(t),pending=worker.tick();
  await until(()=>gate.calls.length===3);store.put('settings',{id:'scheduler',desiredAudioConcurrency:1});
  gate.calls[0].release();gate.calls[1].release();await until(()=>store.all('attempts',job.id).filter(a=>a.status==='success').length===2);
  assert.equal(gate.calls.length,3);store.put('settings',{id:'scheduler',desiredAudioConcurrency:3});await worker.tick();
  await until(()=>gate.calls.length===5);gate.calls[2].release();await until(()=>gate.calls.length===6);
  gate.calls.slice(3).forEach(c=>c.release());await pending;assert.equal(store.all('attempts',job.id).length,6);assert.equal(gate.peak,3);
});

test('VC13/16/19 502未知只停未发送项，兄弟合法回执照常登记直到全体收束',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),c=chapter(),job=enqueue(c),gate=heldFetch(t),pending=worker.tick();
  await until(()=>gate.calls.length===3);gate.calls[0].release(502);
  await until(()=>store.all('attempts',job.id)[0].status==='unknown');assert.equal(store.get('jobs',job.id).status,'running');
  gate.calls[1].release();gate.calls[2].release();await pending;
  assert.equal(gate.calls.length,3);assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['unknown','success','success','stopped','stopped','stopped']);
  assert.equal(store.get('jobs',job.id).done,2);assert.equal(store.get('jobs',job.id).status,'unknown');
  assert.equal(store.all('audios').length,2);assert.equal(store.maybe('settings','audio-route')?.blocked,false);
});

test('VC17 403暂停共享路由，已有回执不丢，其他章未发停止',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),first=chapter(),second=chapter(),j1=enqueue(first),j2=enqueue(second),gate=heldFetch(t),pending=worker.tick();
  await until(()=>gate.calls.length===3);gate.calls[0].release(403);await until(()=>store.get('settings','audio-route').blocked);
  gate.calls[1].release();gate.calls[2].release();await pending;
  assert.equal(gate.calls.length,3);assert.equal(store.all('audios').length,2);
  assert.ok([j1,j2].every(j=>!['queued','running'].includes(store.get('jobs',j.id).status)));
});

test('VC14/15/30 停止领取后等待在途和本地写入完成，未发不占用请求',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),job=enqueue(chapter()),gate=heldFetch(t),pending=worker.tick();
  await until(()=>gate.calls.length===3);worker.stopAdmission();let drained=false;const drain=worker.drain().then(()=>drained=true);
  assert.equal(drained,false);assert.equal(worker.getActivity().accepting,false);
  gate.calls.forEach(c=>c.release());await pending;await drain;
  assert.equal(worker.running,false);assert.equal(gate.calls.length,3);
  assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['success','success','success','stopped','stopped','stopped']);
});

test('VC05/06/27 两章和试音共池，先给等待job一个槽，不越账号上限',async t=>{
  const {store,worker,chapter,enqueue,voice}=setup(t),j1=enqueue(chapter()),j2=enqueue(chapter());
  const trial=worker.enqueue({kind:'voice-test',voiceId:voice.id,entityRevision:1,text:'参考试音',commandId:uid()});
  const gate=heldFetch(t),pending=worker.tick();await until(()=>gate.calls.length===3);
  assert.ok([j1,j2,trial].every(j=>store.all('attempts',j.id).some(a=>a.status==='sending')));
  let released=0;while(released<13){await until(()=>gate.calls.length>released);gate.calls[released++].release();}await pending;
  assert.equal(gate.peak,3);assert.ok([j1,j2,trial].every(j=>store.get('jobs',j.id).status==='success'));
});

test('公平选择器交互最多连续两次，两个后台章节轮转，不以名称提权',()=>{
  const pick=createFairPicker(),jobs=[{id:'a',kind:'generate'},{id:'b',kind:'generate'},{id:'c',kind:'voice-test'},{id:'d',kind:'voice-create'}];
  const order=Array.from({length:13},()=>pick(jobs).id);
  assert.deepEqual(order.slice(0,7),['a','c','d','b','c','d','a']);
});

test('无已验证路由cap时即使期望4仍只发送1',async t=>{
  const {worker,chapter,enqueue}=setup(t,{audioConcurrency:4,routeConcurrencyCap:undefined}),gate=heldFetch(t);enqueue(chapter(2));
  const pending=worker.tick();await until(()=>gate.calls.length===1);assert.equal(worker.getActivity().effectiveAudioConcurrency,1);
  gate.calls[0].release();await until(()=>gate.calls.length===2);gate.calls[1].release();await pending;assert.equal(gate.peak,1);
});

test('VC28 原件封存后释放网络槽，本地处理池1及积压数量共同反压',async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{maxPendingAudio:3}),c=chapter(6),job=enqueue(c);
  const fs=(await import('node:fs/promises')).default,{syncBuiltinESMExports}=await import('node:module'),readFile=fs.readFile;
  let release,arrive;const barrier=new Promise(r=>release=r),arrived=new Promise(r=>arrive=r);let held=false;
  const mock=t.mock.method(fs,'readFile',async(file,...args)=>{
    if(!held&&String(file).endsWith('.delivery.json')){held=true;arrive();await barrier;}
    return readFile(file,...args);
  });syncBuiltinESMExports();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  const pending=worker.tick();
  try {
    await arrived;await until(()=>calls===3);await new Promise(r=>setTimeout(r,15));
    assert.equal(calls,3);assert.equal(worker.getActivity().localActive,1);assert.equal(worker.getActivity().attemptsActive,3);
    assert.ok(worker.getActivity().pendingAudioBytes<=300*1024*1024);
  }finally{release();await pending;mock.mock.restore();syncBuiltinESMExports();}
  assert.equal(calls,6);assert.equal(worker.getActivity().localPeak,1);assert.equal(store.get('jobs',job.id).status,'success');
});

test('VC29 参考共享只核验一次，停用仍在最终发送守卫中生效',async t=>{
  const {store,worker,chapter,enqueue,voice}=setup(t),c=chapter(),job=enqueue(c),gate=heldFetch(t),pending=worker.tick();
  await until(()=>gate.calls.length===3);
  const entries=store.all('attempts',job.id).filter(a=>a.createdAt).map(a=>a.referenceAssets[0]);
  assert.equal(new Set(entries.map(a=>a.contentHash)).size,1);assert.equal(worker.getActivity().referenceCacheBytes,Math.ceil(wav().length/3)*4);
  store.put('voices',{...voice,state:'stopped'});gate.calls.forEach(c=>c.release());await pending;
  assert.equal(gate.calls.length,3);assert.equal(store.all('attempts',job.id).filter(a=>a.status==='success').length,3);
  assert.equal(store.all('attempts',job.id).filter(a=>a.status==='stopped').length,3);
});

test('VC21 并发不会扩增授权请求，低于计划额度整批零入队',async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{callLimit:2,usageScope:'parallel-quota'}),c=chapter(3);
  assert.throws(()=>enqueue(c),/额度不足/);assert.equal(store.all('jobs').length,0);assert.equal(store.all('attempts').length,0);
});

test('VC23 同命令重复提交和tick重入只领取原先的attempt一次',async t=>{
  const {store,worker,domain,chapter}=setup(t),c=chapter(3),request={kind:'generate',chapterId:c.id,
    revision:store.get('chapters',c.id).revision,ids:domain.list(c.id).map(s=>s.id),commandId:uid()};
  const job=worker.enqueue(request);assert.equal(worker.enqueue(request).id,job.id);
  const gate=heldFetch(t),pending=worker.tick();await worker.tick();await until(()=>gate.calls.length===3);
  assert.equal(store.all('attempts').length,3);gate.calls.forEach(c=>c.release());await pending;assert.equal(gate.calls.length,3);
});

test('VC05/08/09 候选、组合与场景共池，组仍只发一次，同章不能另开竞争任务',async t=>{
  const {store,domain,worker,chapter}=setup(t),c=chapter(3),rows=domain.list(c.id),rev=()=>store.get('chapters',c.id).revision;
  const group=domain.mutate('unit.create',{chapterId:c.id,revision:rev(),ids:rows.slice(0,2).map(s=>s.id)});
  const single=store.get('units',rows[2].id);
  domain.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:single.id,entityRevision:single.revision,mode:'scene',guidance:'安静室内，保持对白清楚'});
  const scene=store.get('units',single.id);scene.mode='scene';store.put('units',scene,c.id);
  const job=worker.enqueue({kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:[group.id,single.id],commandId:uid()});
  assert.throws(()=>worker.enqueue({kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:[single.id],mode:'dry',commandId:uid()}),/正在|任务|制作/);
  const session=domain.mutate('voice-session.create',{description:'清晰温和的成年女声'});
  const candidate=worker.enqueue({kind:'voice-create',sessionId:session.id,entityRevision:session.revision,commandId:uid()});
  const gate=heldFetch(t),pending=worker.tick();await until(()=>gate.calls.length===3);gate.calls.forEach(c=>c.release());await pending;
  assert.equal(store.all('attempts',job.id).length,2);assert.equal(store.all('attempts',candidate.id).length,1);
  assert.equal(store.get('jobs',job.id).status,'success');assert.equal(store.get('jobs',candidate.id).status,'success');
  assert.deepEqual(domain.enhancement.resolve(c.id).map(row=>row.s.members),[rows.slice(0,2).map(s=>s.id),[single.id]]);
  assert.equal(gate.peak,3);
});

test('VC11 外部真实单元改动仍阻断该发送，合法兄弟可完成',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),c=chapter(3),job=enqueue(c);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  const pending=worker.tick(),first=store.all('attempts',job.id)[0],unit=store.get('units',first.unitId);
  unit.revision++;store.put('units',unit,c.id);await pending;
  assert.equal(calls,2);assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['failed','success','success']);
});

test('VC22 准备参考时撤回授权，所有未发槽最终校验阻断且预留全部释放',async t=>{
  const {createExperience}=await import('../server/experience.mjs');
  const {store,domain,worker,project,chapter,enqueue,config}=setup(t),c=chapter(3),experience=createExperience(store,domain,worker,{},config);
  const grant=experience.grant({grantId:uid(),projectId:project.id,chapterId:c.id,steps:['unit-generate'],textLimit:0,audioLimit:3});
  const job=enqueue(c,{grantId:grant.grantId});let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('撤回后不得发送');});
  const pending=worker.tick();experience.revoke({grantId:grant.grantId});await pending;
  assert.equal(calls,0);assert.equal(store.get('settings',grant.id).audioReserved,0);assert.equal(store.get('settings',grant.id).audioUsed,0);
  assert.ok(store.all('attempts',job.id).every(a=>a.phase==='rejectedNotSent'));
});

test('VC18 429记录重试提示但暂停后续，不自动重发也不声称余额确定耗尽',async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{audioConcurrency:1}),job=enqueue(chapter(2));let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('limit',{status:429,headers:{'Retry-After':'30'}});});
  await worker.tick();await worker.tick();assert.equal(calls,1);
  assert.equal(store.get('settings','audio-route').reason,'rate-or-quota-limit');assert.equal(store.get('settings','audio-route').retryAfterSeconds,30);
  assert.deepEqual(store.all('attempts',job.id).map(a=>a.status),['failed','stopped']);
});

test('已有后台请求很慢时，持续新试音不能绕过两次交互后补后台的约束',()=>{
  const pick=createFairPicker(),background={id:'chapter',kind:'generate',inFlight:true};
  assert.equal(pick([background]).id,'chapter');
  const chosen=[];
  for(let i=0;i<6;i++)chosen.push(pick([background,{id:'trial-'+i,kind:'voice-test',inFlight:false}]).id);
  assert.deepEqual(chosen,['trial-0','trial-1','chapter','trial-3','trial-4','chapter']);
});

test('领取阶段数据库失败不外发，保留队列且暂停新领取，drain不挂住',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),job=enqueue(chapter(2)),put=store.put.bind(store);let injected=false,calls=0;
  const mock=t.mock.method(store,'put',(table,value,...rest)=>{
    if(!injected&&table==='attempts'&&value.phase==='preparing'){injected=true;throw Error('disk write failed');}
    return put(table,value,...rest);
  });
  t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('领取失败不得请求');});
  await worker.tick();mock.mock.restore();assert.equal(injected,true);assert.equal(calls,0);assert.equal(worker.getActivity().storageBlocked,true);
  assert.ok(worker.getActivity().schedulingError);await worker.drain();await worker.tick();
  assert.equal(store.get('jobs',job.id).status,'stopped');assert.ok(store.all('attempts',job.id).every(a=>!a.createdAt));
});

test('领取成功后的任务登记写入失败也回滚领取，drain 不残留幽灵请求',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),job=enqueue(chapter(2)),put=store.put.bind(store);let injected=false,calls=0;
  const mock=t.mock.method(store,'put',(table,value,...rest)=>{
    if(!injected&&table==='jobs'&&value.id===job.id&&value.status==='running'){injected=true;throw Error('job write failed');}
    return put(table,value,...rest);
  });
  t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('任务登记失败不得请求');});
  await worker.tick();mock.mock.restore();assert.equal(injected,true);assert.equal(calls,0);
  assert.equal(worker.getActivity().attemptsActive,0);assert.equal(worker.getActivity().storageBlocked,true);
  assert.ok(store.all('attempts',job.id).every(a=>!a.ownerToken));
  await worker.drain();await worker.tick();assert.equal(store.get('jobs',job.id).status,'stopped');
});

test('VC22 授权在参考准备期间自然到期，最终派发事务停止全部未发槽',async t=>{
  const {createExperience}=await import('../server/experience.mjs');
  const {store,domain,worker,project,chapter,enqueue,config}=setup(t),c=chapter(3),experience=createExperience(store,domain,worker,{},config);
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const grant=experience.grant({grantId:uid(),projectId:project.id,chapterId:c.id,steps:['unit-generate'],textLimit:0,audioLimit:3,expiresAt});
  const job=enqueue(c,{grantId:grant.grantId});let calls=0;t.mock.method(globalThis,'fetch',()=>{calls++;assert.fail('到期后不得发送');});
  const pending=worker.tick();assert.equal(worker.getActivity().attemptsActive,3);
  t.mock.method(Date,'now',()=>Date.parse(expiresAt)+1);await pending;
  assert.equal(calls,0);assert.equal(store.get('settings',grant.id).revoked,false);
  assert.equal(store.get('settings',grant.id).audioReserved,0);assert.equal(store.get('settings',grant.id).audioUsed,0);
  assert.ok(store.all('attempts',job.id).every(a=>a.phase==='rejectedNotSent'));
});

test('恢复未收束混合结果从attempt重建持久done及阶段计数，已关闭批次保持历史',async t=>{
  const {store,worker,chapter,enqueue}=setup(t),job=enqueue(chapter(3)),attempts=store.all('attempts',job.id);
  for(const [i,a] of attempts.entries())store.put('attempts',{...a,status:i===0?'success':i===1?'failed':'queued',phase:i===0?'registered':i===1?'rejectedNotSent':'queued'},job.id);
  const before=store.get('jobs',job.id);before.status='running';before.done=0;before.counts={queued:3,success:0};store.put('jobs',before,before.chapterId);
  await worker.recover();const recovered=store.get('jobs',job.id);assert.equal(recovered.done,1);
  assert.deepEqual(recovered.counts,{queued:0,preparing:0,inFlight:0,local:0,success:1,failed:1,unknown:0,stopped:1});
  const closed=store.get('jobs',job.id);await worker.recover();assert.deepEqual(store.get('jobs',job.id),closed);
});

test('新generationEpoch优先于物理插入顺序；无epoch历史仍保留原先顺序判断',async t=>{
  const {hasNewerAttempt}=await import('../server/scheduler.mjs');
  assert.equal(hasNewerAttempt([{id:'new',generationEpoch:2},{id:'old',generationEpoch:1}],{id:'old',generationEpoch:1},()=>true),true);
  assert.equal(hasNewerAttempt([{id:'new',generationEpoch:2},{id:'old',generationEpoch:1}],{id:'new',generationEpoch:2},()=>true),false);
  assert.equal(hasNewerAttempt([{id:'old'},{id:'new'}],{id:'old'},()=>true),true);
  const {store,worker,chapter,enqueue}=setup(t),c=chapter(1),old=enqueue(c);worker.stopAdmission();await worker.tick();
  const oldAttempt=store.all('attempts',old.id)[0],other=createWorker(store,createDomain(store),{key:'test',model:'seed-audio-1.0',audioUrl:'https://example.invalid'});
  const latest=other.enqueue({kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,unitIds:old.unitIds||[oldAttempt.unitId],mode:'dry',commandId:uid()});
  store.remove('attempts',oldAttempt.id);store.put('attempts',oldAttempt,old.id);
  t.mock.method(globalThis,'fetch',async()=>new Response(wav(),{headers:{'content-type':'audio/wav'}}));await other.tick();
  const latestAttempt=store.all('attempts',latest.id)[0];assert.equal(latestAttempt.generationEpoch,oldAttempt.generationEpoch+1);
  assert.equal(latestAttempt.adopted,true);assert.equal(store.get('units',latestAttempt.unitId).variants.dry.current,latestAttempt.id);
});

for(const phase of ['upstream','receiving'])test(`独立${phase}期限失败保留unknown和已发次数，不重发也不提升part`,async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{audioConcurrency:1,audioResponseTimeoutMs:phase==='upstream'?10:1000,audioReceiveTimeoutMs:10}),job=enqueue(chapter(2));let calls=0;
  t.mock.method(globalThis,'fetch',async(_,options)=>{
    calls++;
    if(phase==='upstream')return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    return new Response(new ReadableStream({start(controller){controller.enqueue(wav().subarray(0,1000));}}),{headers:{'content-type':'audio/wav'}});
  });
  await worker.tick();const [first,second]=store.all('attempts',job.id);
  assert.equal(calls,1);assert.equal(first.status,'unknown');assert.equal(first.timeoutPhase,phase);assert.ok(first.createdAt);assert.equal(second.status,'stopped');assert.equal(store.all('audios').length,0);
  await worker.recover();await worker.tick();assert.equal(calls,1);assert.equal(store.all('audios').length,0);
});

test('响应头与接收体使用独立预算，完整响应后的本地处理不继续消费网络时限',async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{audioConcurrency:1,audioResponseTimeoutMs:30,audioReceiveTimeoutMs:1000}),job=enqueue(chapter(1));
  t.mock.method(globalThis,'fetch',async()=>{await new Promise(r=>setTimeout(r,20));return new Response(new ReadableStream({start(controller){setTimeout(()=>{controller.enqueue(wav());controller.close();},80);}}),{headers:{'content-type':'audio/wav'}});});
  await worker.tick();assert.equal(store.get('jobs',job.id).status,'success');assert.equal(store.all('attempts',job.id)[0].timeoutPhase,undefined);
});

test('提前拒绝响应类型时终止剩余响应体，不遗留已释放槽的下载',async t=>{
  const {store,worker,chapter,enqueue}=setup(t,{audioConcurrency:1}),job=enqueue(chapter(1));let signal;
  t.mock.method(globalThis,'fetch',async(_,options)=>{signal=options.signal;return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1]));}}),{headers:{'content-type':'text/plain'}});});
  await worker.tick();assert.equal(signal.aborted,true);assert.equal(store.get('jobs',job.id).status,'unknown');assert.equal(worker.getActivity().attemptsActive,0);
});
