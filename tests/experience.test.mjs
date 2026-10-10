import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {createAnalysis} from '../server/analysis.mjs';
import {uploadVoice} from '../server/audio.mjs';
import {compile} from '../server/templates.mjs';
import {createExperience,configurationDecided,reserveGrant,settleGrant} from '../server/experience.mjs';
import {startServer} from '../server/index.mjs';

function wav() {
  const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b;
}
function setup(t,segment=false) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-experience-')),store=openStore(dir),d=createDomain(store);
  const p=d.mutate('project.create',{name:'体验验收'}),c=d.mutate('chapter.create',{projectId:p.id,title:'自拟章',source:'第一句。\n第二句。',segment});
  const v={id:uid(),name:'夹具声音',state:'active',revision:1,path:'reference.wav'};writeFileSync(join(dir,v.path),wav());store.put('voices',v);
  const role=store.all('roles',p.id)[0],rev=()=>store.get('chapters',c.id).revision;
  d.mutate('role.update',{id:role.id,entityRevision:1,chapterId:c.id,revision:rev(),voiceId:v.id});
  if(segment)d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:d.list(c.id).map(s=>s.id)});
  const config={key:'fixture',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/v1/audio/speech'},w=createWorker(store,d,config),a=createAnalysis(store,d,config),e=createExperience(store,d,w,a,config);
  t.after(async()=>{await a.close();w.close();store.close();rmSync(dir,{recursive:true,force:true});});
  const grant=(limits={})=>e.grant({grantId:uid(),projectId:p.id,chapterId:c.id,steps:['extract','director','scene','unit-generate','voice-create'],textLimit:10,audioLimit:10,...limits});
  const smart=()=>e.policy({projectId:p.id,revision:e.project(p.id).policy.revision,mode:'smart'});
  const begin=g=>e.run({operationId:uid(),kind:'prepareChapter',chapterId:c.id,revision:rev(),grantId:g.grantId});
  const response=(init,transform=items=>items)=>{
    const input=JSON.parse(JSON.parse(init.body).messages[1].content);
    const items=input.targets ? input.targets.map(s=>({targetId:s.targetId,performance:'自然',performanceEvidence:{kind:'创作建议',refs:[]},performanceUncertain:false,performanceAnchors:[]})) : input.segments ? input.segments.map(s=>({segmentId:s.id,performance:'自然',evidence:'原文明示',evidenceRefs:[0],uncertain:false,reason:'自拟原文'})) : input.blocks.map(b=>({from:b.id,to:b.id,roleId:input.roles[0].id,type:'narration',performance:'自然',evidence:'原文明示',evidenceRefs:[b.id],uncertain:false,reason:'自拟原文'}));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:transform(items)})}}]});
  };
  return {dir,store,d,p,c,v,role,rev,config,w,a,e,grant,smart,begin,response};
}

test('AR01/AR02/AR10 初稿默认智能安排，来源成立而非人工听验',async t=>{
  const {e,smart,grant,begin,a,d,c,store,response}=setup(t);
  assert.equal(e.project(c.projectId).policy.revision,0);assert.equal(e.project(c.projectId).policy.mode,'smart');
  e.policy({projectId:c.projectId,revision:0,mode:'review'});assert.equal(e.project(c.projectId).policy.mode,'review','已明确选择审阅的策略仍保留');
  smart();const g=grant();t.mock.method(globalThis,'fetch',async(_,init)=>response(init));const op=await begin(g);await a.close();
  const rows=d.list(c.id);assert.equal(rows.map(s=>s.text).join(''),c.source);assert.ok(rows.every(configurationDecided));assert.ok(rows.every(s=>s.decisions.role.source==='policy_ai'&&s.review===null));
  assert.equal(e.get(op.operationId).outcome,'completed');assert.equal(store.get('settings',g.id).textUsed,1);assert.equal(store.get('settings',g.id).textReserved,0);
});
test('AR03/AR06 已制作章保持ID、人工表演与声音，反复准备不替换剧本',async t=>{
  const {smart,grant,begin,a,d,c,rev,response,store}=setup(t);smart();const g=grant();t.mock.method(globalThis,'fetch',async(_,init)=>response(init));await begin(g);await a.close();
  const before=d.list(c.id);d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:before[0].id,performance:'用户指定的低声'});
  await begin(g);await a.close();const after=d.list(c.id);assert.deepEqual(after.map(s=>s.id),before.map(s=>s.id));assert.equal(after[0].performance,'用户指定的低声');assert.ok(after[0].protectedFields.includes('performance'));assert.equal(after[0].voiceId,before[0].voiceId);assert.equal(store.all('roles').length,1);
});
test('AR04/AR05 歧义保持待处理，无效出处不自动应用',async t=>{
  for(const invalid of [false,true])await t.test(String(invalid),async t=>{
    const {smart,grant,begin,a,d,c,store,response,e}=setup(t);smart();const g=grant();
    t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map((s,i)=>i?{...s,...(invalid?{evidenceRefs:[999]}:{uncertain:true})}:s)));
    const op=await begin(g);await a.close();if(invalid)assert.equal(d.list(c.id).length,0);else assert.ok(d.list(c.id).some(s=>!configurationDecided(s)));
    assert.ok(e.get(op.operationId).result.needsDecision>0);assert.equal(store.get('settings',g.id).textUsed,1);
  });
});
test('AR06 策略在响应期间撤回，旧许可不能自动采用',async t=>{
  const {smart,grant,begin,a,d,c,e,p,response}=setup(t);smart();const g=grant();let finish;
  t.mock.method(globalThis,'fetch',(_,init)=>new Promise(resolve=>{finish=()=>resolve(response(init));}));await begin(g);e.policy({projectId:p.id,revision:1,mode:'review'});finish();await a.close();assert.equal(d.list(c.id).length,0);
});
test('AR07 撤销AI安排保留原文与ID；后续人工改动拒绝覆盖',async t=>{
  const {smart,grant,begin,a,d,c,rev,e,response}=setup(t);smart();const g=grant();t.mock.method(globalThis,'fetch',async(_,init)=>response(init));const op=await begin(g);await a.close();const change=e.project(c.projectId).changes[0],rows=d.list(c.id);
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:rows[0].id,performance:'人工新版'});
  assert.throws(()=>e.undo({changeId:change.changeId,revision:rev()}),/已被修改/);assert.equal(d.list(c.id)[0].performance,'人工新版');assert.ok(e.get(op.operationId).result.analysis.id);
});
test('自动准备直接确认已有明确上下文归属的旁白和人物对白',async t=>{
  const {smart,grant,begin,a,d,c,store,role,response}=setup(t);smart();
  const person={...role,id:uid(),name:'路人',narrator:false};store.put('roles',person,c.projectId);
  t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map((item,index)=>({...item,evidence:'上下文推断',uncertain:false,...(index?{type:'dialogue',roleId:person.id}:{})}))));
  await begin(grant());await a.close();const [narration,dialogue]=d.list(c.id);
  assert.equal(narration.roleId,role.id);assert.equal(narration.roleConfirmed,true);assert.equal(narration.decisions.role.state,'accepted');assert.equal(configurationDecided(narration),true);
  assert.equal(dialogue.roleId,person.id);assert.equal(dialogue.roleConfirmed,true);assert.equal(dialogue.decisions.role.state,'accepted');
  assert.equal(d.chapter(c.id).suggestions.at(-1).automation.needsDecision,0);
});
test('已知人物的明确心理独白直接采用，新角色的上下文建议仍保留身份疑点',async t=>{
  const {smart,grant,begin,a,d,c,store,role,response}=setup(t);smart();
  const person={...role,id:uid(),name:'已知人物',narrator:false};store.put('roles',person,c.projectId);
  t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map((item,index)=>({...item,evidence:'上下文推断',type:'thought',uncertain:false,...(index?{roleId:null,newRoleKey:'new_person',newRole:'新人物'}:{roleId:person.id})}))));
  await begin(grant());await a.close();const [known,unknown]=d.list(c.id);
  assert.equal(known.roleConfirmed,true);assert.equal(configurationDecided(known),true);assert.equal(unknown.roleConfirmed,false);
});
test('旁白存在明确归属疑点或人物被标成叙述时，不能自动消除核对',async t=>{
  const {smart,grant,begin,a,d,c,store,role,response}=setup(t);smart();
  const person={...role,id:uid(),name:'人物',narrator:false};store.put('roles',person,c.projectId);
  t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map((item,index)=>({...item,evidence:'上下文推断',...(index?{roleId:person.id}:{uncertain:true})}))));
  await begin(grant());await a.close();assert.ok(d.list(c.id).every(s=>!s.roleConfirmed));
});
test('AR07 无后续冲突的撤销只撤销AI安排，不删除原文和声音',async t=>{
  const {smart,grant,begin,a,d,c,rev,e,response}=setup(t);smart();t.mock.method(globalThis,'fetch',async(_,init)=>response(init));await begin(grant());await a.close();const before=d.list(c.id),change=e.project(c.projectId).changes[0];e.undo({changeId:change.changeId,revision:rev()});
  assert.deepEqual(d.list(c.id).map(s=>s.id),before.map(s=>s.id));assert.equal(d.list(c.id).map(s=>s.text).join(''),c.source);assert.ok(d.list(c.id).every(s=>!configurationDecided(s)));
});
test('AR08 文本和音频独立原子预留；同额度竞争、撤销与路由变化阻止发送',t=>{
  const {store,config,c,grant}=setup(t,true),g=grant({textLimit:1,audioLimit:1});
  const text=[{model:'gemini-3.8-flash'}],audio=[{input:{model:config.model}}];
  store.transaction(()=>reserveGrant(store,config,{chapterId:c.id,kind:'director',grantId:g.grantId},text,'text'));
  assert.throws(()=>store.transaction(()=>reserveGrant(store,config,{chapterId:c.id,kind:'director',grantId:g.grantId},[{model:'gemini-3.8-flash'}],'text')),/额度不足/);
  store.transaction(()=>reserveGrant(store,config,{chapterId:c.id,kind:'unit-generate',grantId:g.grantId},audio));assert.equal(store.get('settings',g.id).audioReserved,1);
  assert.throws(()=>store.transaction(()=>settleGrant(store,{...config,audioUrl:'https://other.invalid'},audio[0],'used')),/模型或接口/);
  const revoked=store.get('settings',g.id);revoked.revoked=true;store.put('settings',revoked);
  assert.throws(()=>store.transaction(()=>settleGrant(store,config,audio[0],'used')),/撤回/);
  store.transaction(()=>{settleGrant(store,config,audio[0],'released');settleGrant(store,config,text[0],'released');});assert.equal(store.get('settings',g.id).audioReserved,0);assert.equal(store.get('settings',g.id).textReserved,0);
});
test('AR09 unknown文本占已用预算，不因刷新或普通继续自动重发',async t=>{
  const {smart,grant,begin,a,e,c,store,rev}=setup(t);smart();const g=grant({textLimit:2});let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('lost');});const op=await begin(g);await a.close();assert.equal(calls,1);assert.equal(store.get('settings',g.id).textUsed,1);assert.equal(e.get(op.operationId).result.analysis.batches[0].status,'unknown');assert.equal(e.get(op.operationId).outcome,'unknown');await e.run({operationId:op.operationId,kind:'prepareChapter',chapterId:c.id,revision:c.revision+1,grantId:g.grantId}).catch(()=>{});assert.equal(calls,1);
  const next=await e.run({operationId:uid(),kind:'prepareChapter',chapterId:c.id,revision:rev(),grantId:g.grantId});assert.match(next.error,/结果不明/);assert.equal(calls,1);assert.equal(store.get('settings',g.id).textUsed,1);
});
test('SV02/SV07/OP01 自动保存临时空值不排除；同ID回执重放且异载荷拒绝',async t=>{
  const {e,d,c,rev}=setup(t,true),s=d.list(c.id)[0];
  const blank=await e.run({operationId:uid(),kind:'save',action:'segment.update',data:{chapterId:c.id,revision:rev(),id:s.id,text:' ',autosave:true}});assert.equal(blank.outcome,'needsInput');assert.equal(blank.errorStatus,400);assert.equal(d.list(c.id)[0].excluded,false);
  const p={operationId:uid(),kind:'save',action:'segment.update',data:{chapterId:c.id,revision:rev(),id:s.id,performance:'自然',autosave:true}},first=await e.run(p),after=rev();assert.equal(first.result.chapterRevision,after);assert.deepEqual((await e.run(p)).result,first.result);assert.equal(rev(),after);assert.deepEqual(e.get(p.operationId).result,first.result);await assert.rejects(e.run({...p,data:{...p.data,performance:'新值'}}),/同一操作/);
  const excluded=await e.run({operationId:uid(),kind:'save',action:'segment.update',data:{chapterId:c.id,revision:rev(),id:s.id,text:' ',excluded:true,autosave:true}});assert.equal(excluded.outcome,'completed');assert.equal(d.list(c.id)[0].excluded,true);
});
test('OP03/OP04 组已保存预算不足，原编排不变；同操作重试复用唯一组',async t=>{
  const {e,d,c,rev,grant,store}=setup(t,true),g=grant({audioLimit:0}),ids=d.list(c.id).map(s=>s.id),p={operationId:uid(),kind:'groupAndGenerate',chapterId:c.id,revision:rev(),grantId:g.grantId,ids,guidance:''};
  const first=await e.run(p);assert.equal(first.outcome,'prepared');assert.equal(first.result.unit.state,'pending');assert.equal(store.all('jobs').length,0);assert.deepEqual(d.enhancement.resolve(c.id).map(r=>r.s.id),ids);
  const second=await e.run(p);assert.equal(second.result.unit.id,first.result.unit.id);assert.equal(store.all('units',c.id).filter(u=>u.kind==='group').length,1);assert.equal(store.get('settings',g.id).audioReserved,0);
  const plan=e.plan({chapterId:c.id,revision:rev(),ids,unitId:first.result.unit.id});assert.deepEqual(plan.unitIds,[first.result.unit.id]);assert.equal(plan.audioRequests,1);
});
test('OP07 活动组按一次解析，明确全成员而非重复发每句',t=>{
  const {d,e,c,rev,store}=setup(t,true),ids=d.list(c.id).map(s=>s.id),u=d.mutate('unit.create',{chapterId:c.id,revision:rev(),ids,guidance:''});u.state='active';store.put('units',u,c.id);
  const plan=e.plan({chapterId:c.id,revision:rev(),ids});assert.deepEqual(plan.memberIds,ids);assert.deepEqual(plan.unitIds,[u.id]);assert.equal(plan.audioRequests,1);
});
test('OP08 音频授权撤回阻止尚未发送，释放预留且零供应商请求',async t=>{
  const {e,w,d,c,rev,grant,store}=setup(t,true),g=grant();let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav());});
  const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids:d.list(c.id).map(s=>s.id)});assert.equal(op.outcome,'processing');e.revoke({grantId:g.grantId});await w.tick();assert.equal(calls,0);assert.equal(store.get('settings',g.id).audioReserved,0);assert.equal(store.get('settings',g.id).audioUsed,0);
});
test('AR08 人工明确发起不受协作策略次数授权限制，助手收费动作仍要求有效授权',async t=>{
  const {e,d,w,c,rev,smart,store}=setup(t,true),ids=d.list(c.id).map(s=>s.id);
  smart();
  const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),ids},{actorKind:'assistant_delegated',runId:uid()});assert.equal(op.errorStatus,403);assert.equal(store.all('jobs').length,0);
  assert.throws(()=>w.enqueue({commandId:uid(),kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:ids,requireGrant:true}),/外发范围/);assert.equal(store.all('jobs').length,0);
  const direct=w.enqueue({commandId:uid(),kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:ids});assert.equal(direct.status,'queued');assert.equal(store.all('jobs').length,1);
});

test('人工生成不用次数授权；显式旧授权到期仍拒绝，普通续跑保留unknown和真实目标决定',async t=>{
  const f=setup(t,true),id=f.d.list(f.c.id)[0].id;f.smart();let calls=0,lost=true;
  t.mock.method(globalThis,'fetch',async()=>{calls++;if(lost)throw Error('mock receipt lost');return new Response(wav(),{headers:{'content-type':'audio/wav'}});});
  const old=f.grant({audioLimit:1});old.audioUsed=1;old.expiresAt=new Date(Date.now()-1000).toISOString();f.store.put('settings',old);
  const request=extra=>({operationId:uid(),kind:'generateSelection',chapterId:f.c.id,revision:f.rev(),ids:[id],actionKind:'forceRegenerate',...extra});
  const expired=await f.e.run(request({grantId:old.grantId}));assert.equal(expired.errorStatus,403);assert.match(expired.error,/到期/);assert.equal(calls,0);
  const firstRequest=request({}),first=await f.e.run(firstRequest);await f.w.tick();assert.equal(calls,1);const unknown=f.store.all('attempts',first.jobIds[0])[0];assert.equal(unknown.status,'unknown');
  assert.deepEqual((await f.e.run(firstRequest)).jobIds,first.jobIds);assert.equal(calls,1);
  const blocked=await f.e.run(request({}));assert.match(blocked.error,/结果不明/);assert.equal(calls,1);
  const forged=await f.e.run(request({retryUnknown:true,acknowledgedAttemptIds:[uid()]}));assert.equal(forged.errorStatus,409);assert.match(forged.error,/范围已变化/);assert.equal(calls,1);
  lost=false;const decided=await f.e.run(request({retryUnknown:true,acknowledgedAttemptIds:[unknown.id]}));assert.equal(decided.error,undefined);await f.w.tick();assert.equal(calls,2);assert.equal(f.store.get('jobs',decided.jobIds[0]).status,'success');assert.deepEqual(f.store.all('attempts',decided.jobIds[0])[0].acknowledgedAttemptIds,[unknown.id]);assert.deepEqual(f.store.get('settings',old.id),old);
});

test('人工AI准备直接完成当前范围，不新建授权或借用耗尽过期旧授权',async t=>{
  const f=setup(t);f.smart();const old=f.grant({textLimit:0});old.expiresAt=new Date(Date.now()-1000).toISOString();f.store.put('settings',old);let calls=0;
  t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;return f.response(init);});
  const op=await f.e.run({operationId:uid(),kind:'prepareChapter',chapterId:f.c.id,revision:f.rev()});assert.equal(op.error,undefined);await f.a.close();const receipt=f.e.get(op.operationId),draft=f.store.get('suggestions',receipt.result.analysis.id);assert.equal(receipt.outcome,'completed');assert.equal(draft.requireGrant,false);assert.equal(draft.grantId,undefined);assert.equal(calls,1);assert.equal(f.e.project(f.p.id).grants.length,1);assert.deepEqual(f.store.get('settings',old.id),old);
});

test('旧人工分析没有新次数授权可续跑，显式grant和助手来源不能借人工入口消除',async t=>{
  for(const scenario of ['manual','explicit','assistant'])await t.test(scenario,async t=>{
    const f=setup(t),g=f.grant({textLimit:1});f.smart();let calls=0,lost=true;
    t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;if(lost)throw Error('mock text receipt lost');return f.response(init);});
    const context=scenario==='assistant'?{actorKind:'assistant_delegated',runId:uid()}:undefined;
    const started=await f.a.start({chapterId:f.c.id,revision:f.rev(),grantId:g.grantId,requireGrant:true,kind:'extract',autoApply:false},context);await f.a.close();const draft=f.store.get('suggestions',started.id);assert.equal(draft.batches[0].status,'unknown');assert.equal(calls,1);
    const old=f.store.get('settings',g.id);old.expiresAt=new Date(Date.now()-1000).toISOString();f.store.put('settings',old);
    assert.throws(()=>f.a.resume({id:draft.id,draftVersion:draft.draftVersion}),/结果不明/);assert.equal(calls,1);
    lost=false;const resume={id:draft.id,draftVersion:draft.draftVersion,retryUnknown:true,...(scenario==='explicit'?{grantId:g.grantId}:{})};
    if(scenario!=='manual'){assert.throws(()=>f.a.resume(resume),/到期/);assert.equal(calls,1);const retained=f.store.get('suggestions',draft.id);assert.equal(retained.requireGrant,true);assert.equal(retained.grantId,g.grantId);}
    else{f.a.resume(resume);await f.a.close();const current=f.store.get('suggestions',draft.id);assert.equal(calls,2);assert.equal(current.requireGrant,false);assert.equal(current.grantId,undefined);assert.equal(current.batches[0].status,'received');assert.deepEqual(f.store.get('settings',g.id),old);}
  });
});
test('AR08 文本免费计划和实际分批一致，授权准确请求数且不含参考录音',async t=>{
  const {store,c,rev,e,grant,smart,begin,a,response}=setup(t);smart();const long=store.get('chapters',c.id);long.source=Array.from({length:130},()=>`${'自拟正文'.repeat(50)}。\n`).join('');store.put('chapters',long,c.projectId);
  let calls=0;t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;return response(init);});const plan=e.plan({kind:'prepareChapter',chapterId:c.id,revision:rev()});assert.ok(plan.textRequests>1);assert.equal(calls,0);
  const g=grant({steps:['extract'],materials:['text'],textLimit:plan.textRequests,audioLimit:0});assert.deepEqual(g.materials,['text']);assert.deepEqual(g.voiceIds,[]);await begin(g);await a.close();assert.equal(calls,plan.textRequests);assert.equal(store.get('settings',g.id).textUsed,plan.textRequests);
});
test('AR08 文本授权不能借音频额度外发参考声音',async t=>{
  const {store,d,c,rev,e,grant}=setup(t,true),g=grant({materials:['text']});let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav());});const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids:d.list(c.id).map(s=>s.id)});assert.equal(op.errorStatus,403);assert.match(op.error,/素材类别/);assert.equal(calls,0);assert.equal(store.get('settings',g.id).audioReserved,0);
});
test('OP05 用声音仅更新本章继承范围，保护单句覆盖和其他章节，身份来源成立',async t=>{
  const {d,c,rev,e,smart,store,v,dir,role,p}=setup(t,true);smart();
  const other=d.mutate('chapter.create',{projectId:p.id,title:'另外章',source:'保留。',segment:true}),otherBefore=d.list(other.id);
  const replacement={...v,id:uid(),name:'新声',path:'another.wav'};writeFileSync(join(dir,replacement.path),wav());store.put('voices',replacement);
  const rows=d.list(c.id);d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:rows[0].id,voiceId:v.id});
  const pending=store.get('segments',rows[1].id);pending.identityConfirmed=false;store.put('segments',pending,c.id);
  const op=await e.run({operationId:uid(),kind:'useVoice',chapterId:c.id,revision:rev(),roleId:role.id,entityRevision:store.get('roles',role.id).revision,voiceId:replacement.id,apply:true});assert.equal(op.outcome,'completed');
  const after=d.list(c.id);assert.equal(after[0].voiceId,v.id);assert.equal(after[0].voiceSource,'override');assert.equal(after[1].voiceId,replacement.id);assert.equal(after[1].identityConfirmed,true);assert.equal(after[1].decisions.identity.source,'inherited');assert.ok(configurationDecided(after[1]));assert.deepEqual(d.list(other.id),otherBefore);
});
test('OP05 成功候选修改描述后仍能补空单句覆盖；仅显式apply补齐并保护真覆盖、外章和未知角色',async t=>{
  const {d,c,rev,e,smart,store,v,dir,role,p}=setup(t,true);smart();
  const remote=t.mock.method(globalThis,'fetch',()=>assert.fail('用已有候选不能产生网络请求'));
  const [blank,inherited]=d.list(c.id),custom=d.mutate('segment.create',{chapterId:c.id,revision:rev(),text:'自拟单句保持原声音。'});
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:custom.id,voiceId:v.id});
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:blank.id,voiceId:null,roleConfirmed:false});
  const undecided=store.get('segments',blank.id);undecided.identityPending=true;store.put('segments',undecided,c.id);
  const protectedCustom=store.get('segments',custom.id),other=d.mutate('chapter.create',{projectId:p.id,title:'外章保持原声',source:'外章自拟一句。',segment:true}),otherBefore=d.list(other.id);
  const session=d.mutate('voice-session.create',{description:'自拟旧描述：温和厚重的声音'}),audioId=uid(),jobId=uid();
  const input={targetKind:'candidate',sessionId:session.id,description:session.description,text:session.text,model:session.model,template:session.template,config:session.config,referenceVoiceIds:[]};
  writeFileSync(join(dir,'finished-candidate.wav'),wav());store.put('jobs',{id:jobId,kind:'voice-create',sessionId:session.id,chapterId:'',status:'success'});store.put('attempts',{id:audioId,jobId,targetKind:'candidate',targetId:session.id,input,basis:{sessionId:session.id,revision:session.contentRevision},status:'success',adopted:true},jobId);store.put('audios',{id:audioId,targetKind:'candidate',path:'finished-candidate.wav',input,prompt:compile(input),model:input.model,duration:.1,sampleRate:48000,channels:1,format:'wav'});
  const beforeDescription=rev();d.mutate('voice-session.update',{id:session.id,entityRevision:session.revision,description:'自拟新描述：明亮清楚的声音'});assert.equal(rev(),beforeDescription);
  const use=apply=>e.run({operationId:uid(),kind:'useVoice',audioId,name:'已有候选',scope:'chapter',chapterId:c.id,revision:rev(),roleId:role.id,entityRevision:store.get('roles',role.id).revision,apply});
  const withoutApply=await use(false);assert.equal(withoutApply.outcome,'completed');assert.equal(store.get('segments',blank.id).voiceId,null);assert.equal(store.get('segments',blank.id).voiceSource,'override');
  d.mutate('role.update',{chapterId:c.id,revision:rev(),id:role.id,entityRevision:store.get('roles',role.id).revision,voiceId:null,apply:true,chapterOnly:true,identityChosen:true});assert.equal(store.get('segments',blank.id).voiceId,null);assert.equal(store.get('segments',blank.id).voiceSource,'override');assert.deepEqual(store.get('segments',custom.id),protectedCustom);
  const result=await use(true);assert.equal(result.outcome,'completed',result.error);assert.equal(result.result.voice.source.description,session.description);
  const filled=store.get('segments',blank.id);assert.equal(filled.voiceId,audioId);assert.equal(filled.voiceSource,'default');assert.equal(filled.identityConfirmed,true);assert.equal(filled.decisions.identity.source,'inherited');assert.equal(filled.roleConfirmed,false);assert.equal(filled.identityPending,true);assert.equal(configurationDecided(filled),false);assert.equal(store.get('segments',inherited.id).voiceId,audioId);
  assert.deepEqual(store.get('segments',custom.id),protectedCustom);assert.deepEqual(d.list(other.id),otherBefore);assert.equal(store.get('roles',role.id).voiceId,v.id);assert.equal(store.get('chapters',c.id).roleVoices[role.id],audioId);assert.equal(store.all('voices').filter(voice=>voice.sourceAudioId===audioId).length,1);assert.equal(store.all('jobs').length,1);assert.equal(store.all('attempts').length,1);assert.equal(remote.mock.calls.length,0);
});
test('OP05 单句用声不替用户确认未知角色，也不改变项目默认声',async t=>{
  const {d,c,rev,e,smart,store,v,role}=setup(t,true);smart();const s=d.list(c.id)[0];s.roleConfirmed=false;s.identityConfirmed=false;store.put('segments',s,c.id);
  const op=await e.run({operationId:uid(),kind:'useVoice',chapterId:c.id,revision:rev(),segmentId:s.id,voiceId:v.id});assert.equal(op.outcome,'completed');const after=store.get('segments',s.id);assert.equal(after.identityConfirmed,true);assert.equal(after.roleConfirmed,false);assert.equal(configurationDecided(after),false);assert.equal(after.decisions.identity.source,'human');assert.equal(store.get('roles',role.id).voiceId,v.id);
});
test('OP05 候选入库后绑定冲突可恢复，重复提交不复制音色',async t=>{
  const {store,dir,e,c,rev,d}=setup(t,true),session=d.mutate('voice-session.create',{description:'自拟温和声'}),id=uid();writeFileSync(join(dir,'candidate.wav'),wav());store.put('audios',{id,path:'candidate.wav',targetKind:'candidate',input:{targetKind:'candidate',sessionId:session.id,description:session.description,text:session.text}});store.put('attempts',{id,status:'success',targetId:session.id,jobId:uid()});
  const request={operationId:uid(),kind:'useVoice',audioId:id,name:'自拟候选',chapterId:c.id,revision:rev()-1,segmentId:d.list(c.id)[0].id};const first=await e.run(request);assert.equal(first.outcome,'prepared');assert.equal(first.errorStatus,409);assert.equal(first.result.voice.id,id);const second=await e.run(request);assert.equal(second.result.voice.id,id);assert.equal(store.all('voices').filter(v=>v.sourceAudioId===id).length,1);assert.notEqual(d.list(c.id)[0].voiceId,id);
  const recovered=await e.run({operationId:uid(),kind:'useVoice',voiceId:id,chapterId:c.id,revision:rev(),segmentId:request.segmentId});assert.equal(recovered.outcome,'completed');assert.equal(d.list(c.id)[0].voiceId,id);
});
test('voiceCandidate回执：真实POST/GET可确认成功后继续候选，unknown保持并不自动重发',async t=>{
  const f=setup(t),session=f.d.mutate('voice-session.create',{description:'自拟初始成年声线'}),grant=f.grant({steps:['voice-create'],textLimit:0,audioLimit:3,materials:['text']}),app=await startServer({port:0,directory:f.dir,config:f.config});
  const base='http://127.0.0.1:'+app.server.address().port,nativeFetch=globalThis.fetch;let modelCalls=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{if(String(url).startsWith(base+'/'))return nativeFetch(url,options);assert.equal(String(url),f.config.audioUrl);modelCalls++;if(modelCalls===3)throw new TypeError('模拟已发送后的回执丢失');return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  const request=()=>({operationId:uid(),kind:'voiceCandidate',projectId:f.p.id,chapterId:f.c.id,revision:app.store.get('chapters',f.c.id).revision,sessionId:session.id,entityRevision:app.store.get('voiceSessions',session.id).revision,grantId:grant.grantId}),post=p=>fetch(base+'/api/operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),get=id=>fetch(base+'/api/operations/'+id);
  try {
    const firstRequest=request(),firstPost=await post(firstRequest),firstGet=await get(firstRequest.operationId),stored=app.store.get('settings','ux-operation:'+firstRequest.operationId);
    assert.deepEqual([firstPost.status,firstGet.status,stored.jobIds.length],[200,200,1],'候选已入队也必须返回可恢复的POST/GET回执');
    const queued=await firstPost.json();assert.equal(queued.outcome,'processing');assert.equal(app.store.get('jobs',queued.jobIds[0]).chapterId,'');
    await app.worker.tick();const first=await(await get(firstRequest.operationId)).json();assert.equal(first.outcome,'completed');assert.equal(first.jobIds[0],queued.jobIds[0]);assert.equal(first.result.outputs,undefined);assert.equal(modelCalls,1);
    const originalAttempt=app.store.all('attempts',first.jobIds[0])[0],originalAudio=app.store.get('audios',originalAttempt.id);
    app.domain.mutate('voice-session.update',{id:session.id,entityRevision:session.revision,description:'自拟修改后的明亮声线'});
    const secondRequest=request(),secondPost=await post(secondRequest);assert.equal(secondPost.status,200);const secondQueued=await secondPost.json();assert.notEqual(secondQueued.jobIds[0],first.jobIds[0]);await app.worker.tick();
    const secondGet=await get(secondRequest.operationId);assert.equal(secondGet.status,200);const second=await secondGet.json();assert.equal(second.outcome,'completed');assert.equal(modelCalls,2);assert.equal(app.store.all('attempts',second.jobIds[0])[0].input.description,'自拟修改后的明亮声线');assert.deepEqual(app.store.get('audios',originalAudio.id),originalAudio);assert.equal(app.store.get('settings',grant.id).audioUsed,2);
    const thirdRequest=request(),thirdPost=await post(thirdRequest);assert.equal(thirdPost.status,200);await app.worker.tick();const thirdGet=await get(thirdRequest.operationId);assert.equal(thirdGet.status,200);const unknown=await thirdGet.json();assert.equal(unknown.outcome,'unknown');assert.equal(modelCalls,3);
    const repeated=await post(thirdRequest);assert.equal(repeated.status,200);assert.equal((await repeated.json()).outcome,'unknown');const blocked=await post(request());assert.equal(blocked.status,200);assert.ok((await blocked.json()).error);assert.equal(modelCalls,3);assert.equal(app.store.all('jobs').length,3);assert.equal(app.store.get('settings',grant.id).audioUsed,3);
  }finally{await app.close();}
});
test('OP06 声音事件采用后预算失败，目标保留而实际版本保持dry',async t=>{
  const {d,c,rev,e,store,grant}=setup(t,true),s=d.list(c.id)[0],unit=store.get('units',s.id),event=d.mutate('event.create',{chapterId:c.id,revision:rev(),unitId:unit.id,entityRevision:unit.revision,kind:'effect',description:'自拟轻敲门',memberId:s.id,position:'after',state:'draft'}),g=grant({audioLimit:0});
  const op=await e.run({operationId:uid(),kind:'sceneAndGenerate',chapterId:c.id,revision:rev(),unitId:unit.id,entityRevision:store.get('units',unit.id).revision,eventIds:[event.id],grantId:g.grantId});assert.equal(op.outcome,'prepared');assert.equal(store.get('events',event.id).state,'adopted');assert.equal(store.get('units',unit.id).mode,'dry');assert.equal(store.all('jobs').length,0);
});
test('OP07 整章混合dry与scene一次任务逐项发送，保留各单元实际模式',async t=>{
  const {d,c,rev,e,store,grant,w}=setup(t,true),rows=d.list(c.id),unit=store.get('units',rows[1].id);
  d.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:unit.id,entityRevision:unit.revision,mode:'scene',guidance:'保持对白清楚，安静室内背景'});
  const scene=store.get('units',unit.id);scene.mode='scene';store.put('units',scene,c.id);
  const g=grant(),ids=rows.map(s=>s.id),plan=e.plan({kind:'generateSelection',chapterId:c.id,revision:rev(),ids});assert.deepEqual(plan.units.map(u=>u.mode),['dry','scene']);assert.equal(plan.audioRequests,2);
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'content-type':'audio/wav'}});});const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids});assert.equal(op.outcome,'processing');assert.equal(op.jobIds.length,1);assert.deepEqual(store.all('attempts',op.jobIds[0]).map(a=>a.mode),['dry','scene']);
  await w.tick();assert.equal(calls,2);assert.equal(e.get(op.operationId).outcome,'completed');assert.deepEqual(d.enhancement.resolve(c.id).map(r=>r.s.mode),['dry','scene']);assert.equal(store.get('settings',g.id).audioUsed,2);
});
test('场景生成计划核对存在感与指导或已采用事件，干声和轻背景不误挡',async t=>{
  for (const source of ['guidance','event']) await t.test(source,t=>{
    const {d,c,rev,e,store}=setup(t,true),id=d.list(c.id)[0].id;
    d.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:id,entityRevision:store.get('units',id).revision,mode:'scene',backgroundPresence:'clear',guidance:source==='guidance'?'背景音乐极微弱，几乎不可闻':''});
    if (source==='event') d.mutate('event.create',{chapterId:c.id,revision:rev(),unitId:id,entityRevision:store.get('units',id).revision,kind:'music',description:'极微弱的音乐，几乎不可闻',startMemberId:id,endMemberId:id,startPosition:'before',endPosition:'after',state:'adopted'});
    const before=['chapters','units','events','audios','jobs','attempts','settings'].map(kind=>store.all(kind)),fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('计划不得发送');});
    assert.throws(()=>e.plan({chapterId:c.id,revision:rev(),ids:[id],mode:'scene'}),error=>error.status===409&&/背景存在感.*清楚/.test(error.message));
    assert.equal(e.plan({chapterId:c.id,revision:rev(),ids:[id],mode:'dry'}).audioRequests,1);
    assert.deepEqual(['chapters','units','events','audios','jobs','attempts','settings'].map(kind=>store.all(kind)),before);
    d.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:id,entityRevision:store.get('units',id).revision,mode:'scene',backgroundPresence:'subtle'});
    assert.equal(e.plan({chapterId:c.id,revision:rev(),ids:[id],mode:'scene'}).audioRequests,1);
    assert.equal(fetchMock.mock.callCount(),0);
  });
});
test('存在感矛盾不阻断matched场景免费复用或修改旧音频历史，仅阻断重生成',t=>{
  const {d,c,rev,e,store,dir}=setup(t,true),id=d.list(c.id)[0].id;
  d.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:id,entityRevision:store.get('units',id).revision,mode:'scene',backgroundPresence:'clear',guidance:'背景音乐极微弱，几乎不可闻'});
  const unit=store.get('units',id);unit.variants.scene.template='scene-v4-presence-1';store.put('units',unit,c.id);const input=d.enhancement.input(unit,'scene',undefined,false,false),audio={id:uid(),path:'old-scene.wav',input,prompt:compile(input),model:input.model};
  writeFileSync(join(dir,audio.path),wav());store.put('audios',audio,c.id);unit.variants.scene.current=audio.id;unit.mode='scene';store.put('units',unit,c.id);
  const before=['chapters','units','audios','jobs','attempts','settings'].map(kind=>store.all(kind)),fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('复用不得发送');});
  assert.equal(d.enhancement.status(unit,'scene').validity,'matched');
  for (const actionKind of ['fillMissing','updateSelected','redoRejected']) {
    const plan=e.plan({chapterId:c.id,revision:rev(),ids:[id],actionKind});assert.equal(plan.audioRequests,0);assert.equal(plan.units[0].reuse,true);assert.equal(plan.units[0].audioId,audio.id);
  }
  assert.throws(()=>e.plan({chapterId:c.id,revision:rev(),ids:[id],actionKind:'forceRegenerate'}),error=>error.status===409&&/背景存在感/.test(error.message));
  assert.equal(d.enhancement.history(unit,'scene').find(a=>a.id===audio.id).matched,true);assert.equal(d.enhancement.status(unit,'scene').validity,'matched');
  assert.deepEqual(['chapters','units','audios','jobs','attempts','settings'].map(kind=>store.all(kind)),before);assert.equal(fetchMock.mock.callCount(),0);
});
test('OP06 无事件时场景指导可生成，实际版本在新音频前保持dry',async t=>{
  const {d,c,rev,e,store,grant}=setup(t,true),unit=store.get('units',d.list(c.id)[0].id),g=grant();
  d.mutate('unit.update',{chapterId:c.id,revision:rev(),unitId:unit.id,entityRevision:unit.revision,mode:'scene',guidance:'自拟室内背景，保持对白清楚'});
  const op=await e.run({operationId:uid(),kind:'sceneAndGenerate',chapterId:c.id,revision:rev(),unitId:unit.id,entityRevision:store.get('units',unit.id).revision,eventIds:[],grantId:g.grantId});assert.equal(op.outcome,'processing');assert.equal(store.all('units',c.id).find(u=>u.id===unit.id).mode,'dry');
});
test('AR08 模型覆盖授权范围匹配实际模型，默认授权不能代替覆盖',async t=>{
  const {e,c,rev,a,response,store,p}=setup(t,true);const g=e.grant({grantId:uid(),projectId:p.id,chapterId:c.id,steps:['director'],materials:['text'],textModel:'fixture-text-model',textLimit:1,audioLimit:0});assert.equal(g.models.text,'fixture-text-model');
  let calls=0;t.mock.method(globalThis,'fetch',async(_,init)=>{calls++;assert.equal(JSON.parse(init.body).model,'fixture-text-model');return response(init);});
  const op=await e.run({operationId:uid(),kind:'prepareChapter',chapterId:c.id,revision:rev(),model:'fixture-text-model',grantId:g.grantId});await a.close();assert.equal(calls,1);assert.equal(store.get('settings',g.id).textUsed,1);assert.ok(e.get(op.operationId).result.analysis);
});
test('AR03 常规中性词组合自动应用；人工保护和相同值不重复变成待判断',async t=>{
  const {smart,grant,begin,a,d,c,rev,response,e}=setup(t,true);smart();const rows=d.list(c.id);d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:rows[0].id,performance:'用户低声'});
  t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map(i=>({...i,performance:'自然、清楚地表达'}))));const op=await begin(grant());await a.close();assert.equal(d.list(c.id)[0].performance,'用户低声');assert.equal(d.list(c.id)[1].performance,'自然、清楚地表达');assert.equal(e.get(op.operationId).result.needsDecision,0);
  const repeat=await begin(grant());await a.close();assert.equal(e.get(repeat.operationId).result.needsDecision,0);
});
test('AR03 表演不得越权加入背景；修补失败保留缺口而不制造角色审批',async t=>{
  const {smart,grant,begin,a,d,c,response,e}=setup(t,true);smart();t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map(i=>({...i,performance:'大声哭喊，并播放背景音乐'}))));const op=await begin(grant());await a.close();assert.ok(d.list(c.id).every(s=>s.performance===''));const result=e.get(op.operationId);assert.equal(result.result.needsDecision,0);assert.equal(result.result.performanceCoverage.missingIds.length,2);assert.equal(result.outcome,'needsInput');
});
test('OP05 已绑定角色换声默认仅本章，重置单句及新建片段沿同一本章继承',async t=>{
  const {d,c,rev,e,smart,store,v,dir,role,p}=setup(t,true);smart();const replacement={...v,id:uid(),path:'chapter-only.wav'};writeFileSync(join(dir,replacement.path),wav());store.put('voices',replacement);
  const other=d.mutate('chapter.create',{projectId:p.id,title:'后续章',source:'保留。',segment:true});const original=d.list(c.id)[0];
  const op=await e.run({operationId:uid(),kind:'useVoice',scope:'chapter',chapterId:c.id,revision:rev(),roleId:role.id,entityRevision:store.get('roles',role.id).revision,voiceId:replacement.id,apply:true});assert.equal(op.outcome,'completed');assert.equal(store.get('roles',role.id).voiceId,v.id);assert.equal(store.get('chapters',c.id).roleVoices[role.id],replacement.id);assert.ok(d.list(c.id).every(s=>s.voiceId===replacement.id));assert.equal(d.list(other.id)[0].voiceId,v.id);
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:original.id,voiceId:v.id});d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:original.id,resetVoice:true});assert.equal(d.list(c.id)[0].voiceId,replacement.id);
  const added=d.mutate('segment.create',{chapterId:c.id,revision:rev(),text:'补句。'});assert.equal(added.voiceId,replacement.id);
  const future=d.mutate('chapter.create',{projectId:p.id,title:'未来章',source:'仍用原默认。',segment:true});assert.equal(d.list(future.id)[0].voiceId,v.id);
});
test('OP07 仅编排变化也使旧生成计划失效，零新请求',async t=>{
  const {d,c,rev,e,store,grant}=setup(t,true),ids=d.list(c.id).map(s=>s.id),plan=e.plan({kind:'generateSelection',chapterId:c.id,revision:rev(),ids}),g=grant();const chapter=store.get('chapters',c.id);d.touch(chapter,false,true);assert.equal(rev(),plan.revision);
  const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:plan.revision,arrangement:plan.arrangement,ids,grantId:g.grantId});assert.equal(op.errorStatus,409);assert.equal(store.all('jobs').length,0);assert.equal(store.get('settings',g.id).audioUsed,0);
});
test('SV10 上传丢响应按稳定ID恢复；并发同源只入库一次且异内容不覆盖',async t=>{
  const {store}=setup(t),uploadId=uid(),p={uploadId,name:'新参考',filename:'fixture.wav',data:wav().toString('base64')};const [one,two]=await Promise.all([uploadVoice(store,p),uploadVoice(store,p)]);assert.equal(one.id,uploadId);assert.equal(two.id,uploadId);assert.equal(store.all('voices').filter(v=>v.uploadId===uploadId).length,1);assert.deepEqual(await uploadVoice(store,p),one);
  await assert.rejects(uploadVoice(store,{...p,name:'另一名字'}),/同一上传/);assert.equal(store.get('voices',uploadId).name,'新参考');
  const altered=wav();altered[100]=8;await assert.rejects(uploadVoice(store,{...p,data:altered.toString('base64')}),/同一上传/);assert.equal(store.all('voices').filter(v=>v.uploadId===uploadId).length,1);
});
test('OP05 逐项旧项目明确用声也形成继承资格；确认说话人不代签待核对声音',async t=>{
  const {d,c,rev,e,store,v,role}=setup(t,true);const s=d.list(c.id)[0];s.roleConfirmed=false;s.identityConfirmed=false;store.put('segments',s,c.id);
  d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[s.id],roleOnly:true});assert.equal(store.get('segments',s.id).roleConfirmed,true);assert.equal(store.get('segments',s.id).identityConfirmed,false);
  const op=await e.run({operationId:uid(),kind:'useVoice',scope:'chapter',chapterId:c.id,revision:rev(),roleId:role.id,entityRevision:store.get('roles',role.id).revision,voiceId:v.id,apply:true});assert.equal(op.outcome,'completed');assert.ok(configurationDecided(store.get('segments',s.id)));assert.equal(store.get('segments',s.id).decisions.identity.source,'inherited');
});

test('F07 同次章节创建丢回执后重发返回原章，同ID异载荷拒绝',t=>{
  const {d,p,store}=setup(t),payload={operationId:uid(),projectId:p.id,title:'稳定导入',source:'自拟原文。',segment:true};
  const first=d.mutate('chapter.create',payload),second=d.mutate('chapter.create',payload);
  assert.equal(second.id,first.id);assert.equal(store.all('chapters',p.id).length,2);
  assert.throws(()=>d.mutate('chapter.create',{...payload,title:'不同载荷'}),/同一操作/);
  assert.notEqual(d.mutate('chapter.create',{...payload,operationId:uid()}).id,first.id);
});

test('F01 默认和覆盖同音色合并重建最终决定并保存双方人工保护',t=>{
  for(const choice of ['first','second']) {
    const {d,c,rev,v}=setup(t,true),[first,second]=d.list(c.id);
    d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
    d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,voiceId:v.id,performance:'低声',identityChosen:true});
    const merged=d.mutate('segment.merge',{chapterId:c.id,revision:rev(),id:first.id,choice,performance:'自然'});
    assert.equal(merged.voiceSource,'override');assert.ok(configurationDecided(merged));
    assert.ok(merged.protectedFields.includes('voiceSource'));assert.ok(merged.protectedFields.includes('performance'));
    assert.equal(merged.decisions.identity.source,'structural');assert.deepEqual(merged.decisions.identity.parentIds,[first.id,second.id]);
    assert.equal(merged.current,null);assert.equal(merged.review,null);
  }
});

test('F02 matched返工进入所选生成计划，标返工零请求且普通好结果复用',async t=>{
  const {d,e,w,c,rev,grant,store}=setup(t,true),ids=d.list(c.id).map(s=>s.id),g=grant();let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids});await w.tick();
  const first=store.get('units',ids[0]);d.mutate('unit.review',{chapterId:c.id,revision:rev(),unitId:first.id,entityRevision:first.revision,audioId:first.variants.dry.current,basis:d.enhancement.basis(first,'dry'),state:'rework'});
  assert.equal(calls,2);
  const plan=e.plan({chapterId:c.id,revision:rev(),ids});assert.equal(plan.audioRequests,1);assert.deepEqual(plan.unitIds,[first.id]);assert.equal(plan.units[0].rejected,true);assert.equal(plan.units[1].reuse,true);
  await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids});await w.tick();assert.equal(calls,3);
});

test('F03 拆分双子计划按集合绑定同一父unknown并可直接提交',async t=>{
  const {d,e,w,c,rev,grant,store}=setup(t,true),first=d.list(c.id)[0],g=grant();
  const fetchMock=t.mock.method(globalThis,'fetch',async()=>{throw Error('unknown parent');});
  const initial=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids:[first.id]});await w.tick();
  const unknown=store.all('attempts',initial.jobIds[0])[0];assert.equal(unknown.status,'unknown');
  const ids=d.mutate('segment.split',{chapterId:c.id,revision:rev(),id:first.id,offset:1}).map(s=>s.id),plan=e.plan({chapterId:c.id,revision:rev(),ids});
  assert.deepEqual(plan.outstandingAttemptIds,[unknown.id]);assert.equal(plan.audioRequests,2);
  fetchMock.mock.mockImplementation(async()=>new Response(wav(),{headers:{'Content-Type':'audio/wav'}}));
  const next=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:g.grantId,ids,retryUnknown:true,acknowledgedAttemptIds:plan.outstandingAttemptIds});
  assert.equal(next.error,undefined);await w.tick();assert.equal(store.get('jobs',next.jobIds[0]).status,'success');
});

test('F01 未确认父项不提权；拆分决定按实际表演重建并保留操作来源',t=>{
  const {d,c,rev,store}=setup(t,true),[first,second]=d.list(c.id);
  d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,identityConfirmed:false});
  const merged=d.mutate('segment.merge',{chapterId:c.id,revision:rev(),id:first.id,performance:'低声再转自然'});
  assert.equal(configurationDecided(merged),false);assert.equal(merged.identityConfirmed,false);
  d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[merged.id],identityChosen:true});
  const operationId=uid(),children=d.mutate('segment.split',{operationId,chapterId:c.id,revision:rev(),id:merged.id,offset:Array.from(first.text).length,performance:['低声','自然']});
  assert.ok(children.every(configurationDecided));assert.deepEqual(children.map(s=>s.decisions.performance.values),['低声','自然']);
  assert.ok(children.every(s=>s.decisions.identity.operationId===operationId && s.current===null && s.review===null));
  assert.equal(store.get('segments',merged.id).retired,true);
});

test('F01 存量决定dry-run只列可证明父来源，不写库或补造人工确认',t=>{
  const {d,c,rev,store,v}=setup(t,true),[first,second]=d.list(c.id);
  d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,voiceId:v.id,identityChosen:true});
  const merged=d.mutate('segment.merge',{chapterId:c.id,revision:rev(),id:first.id});
  merged.decisions=store.get('segments',first.id).decisions;store.put('segments',merged,c.id);
  const before=store.all('segments',c.id),plan=d.structuralRepairPlan({chapterId:c.id});
  assert.equal(plan.dryRun,true);assert.equal(plan.items[0].eligible,true);assert.equal(plan.items[0].proposed.identity.source,'structural');assert.deepEqual(store.all('segments',c.id),before);
  merged.source.parentIds=[uid()];store.put('segments',merged,c.id);assert.equal(d.structuralRepairPlan({chapterId:c.id}).items[0].eligible,false);
});

test('A21 可证明存量决定预览后事务修复并留前快照，音频/input/review不改',t=>{
  const {d,c,rev,store,v}=setup(t,true),[first,second]=d.list(c.id);
  d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
  d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,voiceId:v.id,identityChosen:true});
  const merged=d.mutate('segment.merge',{chapterId:c.id,revision:rev(),id:first.id});
  merged.decisions=store.get('segments',first.id).decisions;merged.current=uid();merged.review={state:'passed',basis:'original-fixture'};store.put('segments',merged,c.id);
  store.put('audios',{id:merged.current,input:{original:true},prompt:'保留原提示',path:'original.wav'},c.id);
  const plan=d.structuralRepairPlan({chapterId:c.id}),before=store.get('segments',merged.id),audios=store.all('audios'),units=store.all('units'),arrangement=store.get('chapters',c.id).arrangement;
  const result=d.mutate('chapter.repair-structural-decisions',{chapterId:c.id,revision:plan.revision,ids:[merged.id],scope:JSON.parse(JSON.stringify(plan.scope))});
  const after=store.get('segments',merged.id);assert.equal(configurationDecided(after),true);assert.equal(after.decisions.identity.source,'structural');assert.equal(after.decisions.identity.action,'repair');
  assert.deepEqual(store.get('settings',`ux-change:${result.changeId}`).items[0].before.decisions,before.decisions);
  assert.deepEqual({...after,decisions:before.decisions},before);assert.deepEqual(store.all('audios'),audios);assert.deepEqual(store.all('units'),units);assert.equal(store.get('chapters',c.id).arrangement,arrangement);
});

test('A21 缺预览、范围/修订变化、未知父来源和事务故障均零修复',async t=>{
  for(const failure of ['missing-scope','stale-revision','stale-scope','unknown-source','snapshot-failure','write-failure'])await t.test(failure,t=>{
    const {d,c,rev,store,v}=setup(t,true),[first,second]=d.list(c.id);
    d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
    d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,voiceId:v.id,identityChosen:true});
    const merged=d.mutate('segment.merge',{chapterId:c.id,revision:rev(),id:first.id});merged.decisions=store.get('segments',first.id).decisions;store.put('segments',merged,c.id);
    let plan=d.structuralRepairPlan({chapterId:c.id}),payload={chapterId:c.id,revision:plan.revision,ids:[merged.id],scope:plan.scope};
    if(failure==='missing-scope')delete payload.scope;
    if(failure==='stale-revision')d.mutate('chapter.update',{chapterId:c.id,revision:rev(),title:'预览后的章名'});
    if(failure==='stale-scope')payload.scope[0].target.voiceSource='different';
    if(failure==='unknown-source'){merged.source.parentIds=[uid()];store.put('segments',merged,c.id);plan=d.structuralRepairPlan({chapterId:c.id});payload={...payload,scope:plan.scope};assert.equal(plan.items[0].eligible,false);}
    if(failure.endsWith('failure')){const original=store.put.bind(store);t.mock.method(store,'put',(table,value,...args)=>{if(failure==='snapshot-failure'&&table==='settings'&&value.kind==='structural-repair')throw Error('injected repair interruption');const result=original(table,value,...args);if(failure==='write-failure'&&table==='segments'&&value.id===merged.id)throw Error('injected repair interruption');return result;});}
    const snapshot=()=>Object.fromEntries(['segments','chapters','settings','audios','units'].map(table=>[table,store.all(table)])),before=snapshot();
    assert.throws(()=>d.mutate('chapter.repair-structural-decisions',payload),failure.endsWith('failure')?/injected repair interruption/:{status:409});assert.deepEqual(snapshot(),before);
  });
});

test('F07 回执写入失败整笔回滚，重启后同命令不重复创建',t=>{
  const {d,p,store,dir}=setup(t),payload={operationId:uid(),projectId:p.id,title:'安全导入',source:'用户正文。',segment:true},before=store.all('chapters');
  const original=store.put.bind(store),mock=t.mock.method(store,'put',(table,value,...rest)=>{if(value.id.startsWith('ux-chapter-create:'))throw Error('disk fixture');return original(table,value,...rest);});
  assert.throws(()=>d.mutate('chapter.create',payload),/disk fixture/);assert.deepEqual(store.all('chapters'),before);mock.mock.restore();
  const chapter=d.mutate('chapter.create',payload),reopened=openStore(dir);try{assert.equal(createDomain(reopened).mutate('chapter.create',payload).id,chapter.id);}finally{reopened.close();}
});

test('T06 参考停用/unknown不阻断本地成品，实际决定无效可见而正式导出保持阻断',async t=>{
  const {d,e,w,c,rev,grant,store,v}=setup(t,true),ids=d.list(c.id).map(s=>s.id);let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),grantId:grant().grantId,ids});await w.tick();
  for(const id of ids){const u=d.enhancement.getUnit(id);d.mutate('unit.review',{chapterId:c.id,revision:rev(),unitId:id,entityRevision:u.revision,audioId:u.variants.dry.current,basis:d.enhancement.basis(u,'dry'),state:'passed'});}
  v.state='stopped';store.put('voices',v);
  const target=ids[0];store.put('attempts',{id:uid(),jobId:uid(),status:'unknown',targetKind:'unit',targetId:target,mode:'dry'});
  let chapter=d.chapter(c.id),u=chapter.units.find(u=>u.id===target);assert.equal(u.readiness.play.allowed,true);assert.equal(u.readiness.export.allowed,true);assert.equal(u.readiness.generate.allowed,false);assert.equal(chapter.playbackItems[0].latest,'unknown');
  const exported=await w.submit({kind:'export',chapterId:c.id,revision:rev(),arrangement:chapter.arrangement,reviewItems:chapter.reviewItems,format:'wav',commandId:uid()});await w.tick();assert.equal(store.get('jobs',exported.id).status,'success');assert.equal(store.all('exports',c.id).length,1);assert.equal(calls,2);
  const s=store.get('segments',target);s.decisions={identity:{state:'accepted',values:[s.roleId,uid(),'default']}};store.put('segments',s,c.id);
  chapter=d.chapter(c.id);u=chapter.units.find(u=>u.id===target);assert.equal(chapter.segments[0].configurationDecided,false);assert.ok(u.readiness.generate.blockers.some(b=>b.code==='configuration-undecided'));assert.equal(u.readiness.export.allowed,false);assert.equal(u.readiness.play.allowed,true);assert.equal(calls,2);
});

test('F01 不同声音明确first/second后决定对应选择；结构保存沿操作回执可追溯',async t=>{
  for(const choice of ['first','second']) {
    const {d,e,c,rev,store,v}=setup(t,true),[first,second]=d.list(c.id),alternate={...v,id:uid()};store.put('voices',alternate);
    d.mutate('segment.confirm',{chapterId:c.id,revision:rev(),ids:[first.id,second.id],identityChosen:true});
    d.mutate('segment.update',{chapterId:c.id,revision:rev(),id:second.id,voiceId:alternate.id,identityChosen:true});
    const operationId=uid(),op=await e.run({operationId,kind:'save',action:'segment.merge',data:{chapterId:c.id,revision:rev(),id:first.id,choice}});
    assert.equal(op.outcome,'completed');assert.equal(op.result.voiceId,choice==='first'?v.id:alternate.id);assert.ok(configurationDecided(op.result));assert.equal(op.result.decisions.identity.operationId,operationId);
  }
});

test('F02 组返工在混合选择中计一次，redoRejected复用好结果且export仍阻断',async t=>{
  const {d,e,w,c,rev,grant,store}=setup(t,true),ids=d.list(c.id).map(s=>s.id),extra=d.mutate('segment.create',{chapterId:c.id,revision:rev(),text:'新的一句。'}),group=d.mutate('unit.create',{chapterId:c.id,revision:rev(),ids});let calls=0;
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(wav(),{headers:{'Content-Type':'audio/wav'}});});
  const g=grant();await w.submit({kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:[group.id,extra.id],grantId:g.grantId,commandId:uid()});await w.tick();
  const u=d.enhancement.getUnit(group.id);d.mutate('unit.review',{chapterId:c.id,revision:rev(),unitId:u.id,entityRevision:u.revision,audioId:u.variants.dry.current,basis:d.enhancement.basis(u),state:'rework'});
  const plan=e.plan({chapterId:c.id,revision:rev(),ids:[ids[0],extra.id],actionKind:'redoRejected'});assert.deepEqual(plan.unitIds,[group.id]);assert.equal(plan.audioRequests,1);assert.deepEqual(plan.units[0].members,ids);assert.equal(calls,2);
  assert.equal(d.chapter(c.id).units.find(u=>u.id===group.id).readiness.export.allowed,false);
  await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),ids:[ids[0],extra.id],actionKind:'redoRejected',grantId:g.grantId});await w.tick();assert.equal(calls,3);
  assert.equal(e.plan({chapterId:c.id,revision:rev(),ids:[...ids,extra.id],actionKind:'forceRegenerate'}).audioRequests,2);
});
