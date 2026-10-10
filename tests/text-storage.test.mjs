import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore,uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { createAnalysis } from '../server/analysis.mjs';
import { createExperience } from '../server/experience.mjs';
import { createAssistantModel } from '../server/assistant/model.mjs';
import { diskStatus,DISK_SAFETY_BYTES } from '../server/disk-space.mjs';
import { readTextResponse,analysisResponseLimit,ASSISTANT_RESPONSE_BYTES } from '../server/text-response.mjs';

function fixture(t,source='他停步。\n她回头。') {
  const dir=fs.mkdtempSync(join(tmpdir(),'dubbing-text-space-')),store=openStore(dir),domain=createDomain(store),config={key:'fixture',baseUrl:'https://example.invalid/v1'};
  const p=domain.mutate('project.create',{name:'自拟文字空间'}),c=domain.mutate('chapter.create',{projectId:p.id,title:'自拟',source});
  const analysis=createAnalysis(store,domain,config),experience=createExperience(store,domain,{},analysis,config);
  experience.policy({projectId:p.id,revision:0,mode:'smart'});
  const grant=experience.grant({grantId:uid(),projectId:p.id,chapterId:c.id,steps:['extract','director'],materials:['text'],textLimit:10,audioLimit:0});
  t.after(async()=>{await analysis.close();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  const start=(extra={})=>analysis.start({chapterId:c.id,revision:store.get('chapters',c.id).revision,grantId:grant.grantId,includePerformance:false,...extra});
  const get=id=>store.get('suggestions',id);
  return{dir,store,config,c,analysis,grant,start,get};
}
function freeSpace(t,bytes) {
  const state={bytes},mock=t.mock.method(fs,'statfsSync',()=>({bavail:state.bytes,bsize:1}));syncBuiltinESMExports();
  t.after(()=>{mock.mock.restore();syncBuiltinESMExports();});return state;
}
const input=init=>JSON.parse(JSON.parse(init.body).messages[1].content);
function reply(data,performance='自然') {
  return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:data.blocks.map(b=>({from:b.id,to:b.id,roleId:data.roles[0].id,type:'narration',performance,evidence:'原文明示',evidenceRefs:[b.id],reason:'自拟',uncertain:false}))})}}]});
}
function oversized(limit,header=false) {
  let cancelled=false;
  const stream=new ReadableStream({start(c){if(!header){c.enqueue(new Uint8Array(limit));c.enqueue(new Uint8Array(1));}},cancel(){cancelled=true;}});
  return{response:new Response(stream,{headers:header?{'Content-Length':String(limit+1)}:{}}),cancelled:()=>cancelled};
}

test('shared reader拒绝header及流式超限，并实际取消reader而非继续缓冲',async t=>{
  for(const header of [false,true])await t.test(String(header),async()=>{
    const r=oversized(32,header);await assert.rejects(readTextResponse(r.response,32),e=>e.code==='outcome-unknown');assert.equal(r.cancelled(),true);
  });
});

test('分析低空间不dispatch也不消耗textUsed，恢复后同原任务续跑；事务失败释放预留',async t=>{
  const f=fixture(t),free=freeSpace(t,DISK_SAFETY_BYTES+1024);let calls=0;
  t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;return reply(input(init));});
  const started=await f.start();await f.analysis.close();let r=f.get(started.id);
  assert.equal(calls,0);assert.equal(r.batches[0].status,'pending');assert.equal(r.batches[0].attempts.length,0);
  assert.equal(f.store.get('settings','ux-grant:'+f.grant.grantId).textUsed,0);assert.equal(diskStatus(f.dir).reservedBytes,0);
  free.bytes=1024*1024*1024;f.analysis.resume({id:r.id,draftVersion:r.draftVersion});await f.analysis.close();r=f.get(r.id);
  assert.equal(r.status,'ready');assert.equal(calls,1);assert.equal(f.store.get('settings','ux-grant:'+f.grant.grantId).textUsed,1);
  assert.equal(diskStatus(f.dir).reservedBytes,0);
  const native=f.store.transaction,mock=t.mock.method(f.store,'transaction',function(work){if(diskStatus(f.dir).reservedBytes)throw Object.assign(new Error('fixture commit failure'),{status:409});return native.call(this,work);});
  try{const second=await f.start();await f.analysis.close();assert.equal(f.get(second.id).batches[0].attempts.length,0);assert.equal(diskStatus(f.dir).reservedBytes,0);assert.equal(calls,1);}
  finally{mock.mock.restore();}
});

test('分析header/stream超限保留unknown；不会作为已收到的内容错误自动付费重试',async t=>{
  for(const header of [false,true])await t.test(String(header),async t=>{
    const f=fixture(t);freeSpace(t,1024*1024*1024);let calls=0,cancelled;
    t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;const limit=analysisResponseLimit(JSON.parse(init.body),input(init).blocks.length),r=oversized(limit,header);cancelled=r.cancelled;return r.response;});
    const started=await f.start({includePerformance:true});await f.analysis.close();const r=f.get(started.id);
    assert.equal(calls,1);assert.equal(r.batches[0].status,'unknown');assert.equal(r.batches[0].attempts[0].status,'unknown');assert.equal(cancelled(),true);
    assert.equal(r.structuralRetryIds?.length||0,0);f.analysis.recover();assert.equal(calls,1);
    assert.throws(()=>f.analysis.resume({id:r.id,draftVersion:r.draftVersion}),/重复计费/);assert.equal(calls,1);assert.equal(diskStatus(f.dir).reservedBytes,0);
  });
});

test('原legacy长章短行超过2MiB合法标注仍可接收，按实际批次提高安全cap',async t=>{
  const f=fixture(t,'你。\n'.repeat(1200));freeSpace(t,1024*1024*1024);let actualBytes=0,calls=0;
  t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;const response=reply(input(init),'平静'.repeat(333));actualBytes=Buffer.byteLength(await response.clone().text());return response;});
  const started=await f.start();await f.analysis.close();const r=f.get(started.id);
  assert.ok(actualBytes>ASSISTANT_RESPONSE_BYTES);assert.equal(calls,1);assert.equal(r.status,'ready');assert.equal(r.items.length,1200);
});

test('局部补齐容量不足不建付费attempt，原失败repair可按同任务恢复',async t=>{
  const f=fixture(t),free=freeSpace(t,1024*1024*1024);let calls=0;
  t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;const data=input(init);if(!data.targets){free.bytes=DISK_SAFETY_BYTES+1024;return reply(data,'');}
    return Response.json({choices:[{message:{content:JSON.stringify({items:data.targets.map(i=>({targetId:i.targetId,performance:'压低声线，缓缓讲述，句末轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceUncertain:false,performanceAnchors:[]}))})}}]});});
  const started=await f.start({includePerformance:true});await f.analysis.close();let r=f.get(started.id),repair=r.performanceRepairs[0];
  assert.equal(calls,1);assert.equal(repair.status,'failed');assert.equal(repair.attempts.length,0);assert.equal(f.store.get('settings','ux-grant:'+f.grant.grantId).textUsed,1);
  free.bytes=1024*1024*1024;f.analysis.resume({id:r.id,draftVersion:r.draftVersion,repairIds:[repair.id]});await f.analysis.close();r=f.get(r.id);
  assert.equal(calls,2);assert.equal(r.performanceRepairs[0].status,'received');assert.equal(diskStatus(f.dir).reservedBytes,0);
});

test('助手模型共用空间保护并保留既有2MiB cap和outcome-unknown分类',async t=>{
  const f=fixture(t),free=freeSpace(t,DISK_SAFETY_BYTES);let calls=0,cancelled;
  const model=createAssistantModel(f.store,f.config,{fetchImpl:async()=>{calls++;const r=oversized(ASSISTANT_RESPONSE_BYTES);cancelled=r.cancelled;return r.response;}});
  model.save({revision:0,enabled:true,baseUrl:f.config.baseUrl,model:'fixture-model',credentialSource:'audio',vision:false});
  await assert.rejects(model.generate({messages:[{role:'user',content:'自拟'}]}),e=>e.status===507);assert.equal(calls,0);
  free.bytes=1024*1024*1024;await assert.rejects(model.generate({messages:[{role:'user',content:'自拟'}]}),e=>e.code==='outcome-unknown');
  assert.equal(calls,1);assert.equal(cancelled(),true);assert.equal(diskStatus(f.dir).reservedBytes,0);
});
