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
import {createExperience,configurationDecided,reserveGrant,settleGrant} from '../server/experience.mjs';

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
  const smart=()=>e.policy({projectId:p.id,revision:0,mode:'smart'});
  const begin=g=>e.run({operationId:uid(),kind:'prepareChapter',chapterId:c.id,revision:rev(),grantId:g.grantId});
  const response=(init,transform=items=>items)=>{
    const input=JSON.parse(JSON.parse(init.body).messages[1].content);
    const items=input.segments ? input.segments.map(s=>({segmentId:s.id,performance:'自然',evidence:'原文明示',evidenceRefs:[0],uncertain:false,reason:'自拟原文'})) : input.blocks.map(b=>({from:b.id,to:b.id,roleId:input.roles[0].id,type:'narration',performance:'自然',evidence:'原文明示',evidenceRefs:[b.id],uncertain:false,reason:'自拟原文'}));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:transform(items)})}}]});
  };
  return {dir,store,d,p,c,v,role,rev,config,w,a,e,grant,smart,begin,response};
}

test('AR01/AR02/AR10 智能初稿来源成立而非人工听验；旧项目默认逐项',async t=>{
  const {e,smart,grant,begin,a,d,c,store,response}=setup(t);
  assert.equal(e.project(c.projectId).policy.revision,0);assert.equal(e.project(c.projectId).policy.mode,'review');
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
test('AR08 新组合收费动作未授权拒绝，旧入口在启用策略后不能绕过',async t=>{
  const {e,d,w,c,rev,smart,store}=setup(t,true),ids=d.list(c.id).map(s=>s.id);
  const op=await e.run({operationId:uid(),kind:'generateSelection',chapterId:c.id,revision:rev(),ids});assert.equal(op.errorStatus,403);assert.equal(store.all('jobs').length,0);smart();assert.throws(()=>w.enqueue({commandId:uid(),kind:'unit-generate',chapterId:c.id,revision:rev(),unitIds:ids}),/外发范围/);assert.equal(store.all('jobs').length,0);
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
test('OP05 单句用声不替用户确认未知角色，也不改变项目默认声',async t=>{
  const {d,c,rev,e,smart,store,v,role}=setup(t,true);smart();const s=d.list(c.id)[0];s.roleConfirmed=false;s.identityConfirmed=false;store.put('segments',s,c.id);
  const op=await e.run({operationId:uid(),kind:'useVoice',chapterId:c.id,revision:rev(),segmentId:s.id,voiceId:v.id});assert.equal(op.outcome,'completed');const after=store.get('segments',s.id);assert.equal(after.identityConfirmed,true);assert.equal(after.roleConfirmed,false);assert.equal(configurationDecided(after),false);assert.equal(after.decisions.identity.source,'human');assert.equal(store.get('roles',role.id).voiceId,v.id);
});
test('OP05 候选入库后绑定冲突可恢复，重复提交不复制音色',async t=>{
  const {store,dir,e,c,rev,d}=setup(t,true),session=d.mutate('voice-session.create',{description:'自拟温和声'}),id=uid();writeFileSync(join(dir,'candidate.wav'),wav());store.put('audios',{id,path:'candidate.wav',targetKind:'candidate',input:{targetKind:'candidate',sessionId:session.id,description:session.description,text:session.text}});store.put('attempts',{id,status:'success',targetId:session.id,jobId:uid()});
  const request={operationId:uid(),kind:'useVoice',audioId:id,name:'自拟候选',chapterId:c.id,revision:rev()-1,segmentId:d.list(c.id)[0].id};const first=await e.run(request);assert.equal(first.outcome,'prepared');assert.equal(first.errorStatus,409);assert.equal(first.result.voice.id,id);const second=await e.run(request);assert.equal(second.result.voice.id,id);assert.equal(store.all('voices').filter(v=>v.sourceAudioId===id).length,1);assert.notEqual(d.list(c.id)[0].voiceId,id);
  const recovered=await e.run({operationId:uid(),kind:'useVoice',voiceId:id,chapterId:c.id,revision:rev(),segmentId:request.segmentId});assert.equal(recovered.outcome,'completed');assert.equal(d.list(c.id)[0].voiceId,id);
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
test('AR03 强表演不在中性白名单自动应用',async t=>{
  const {smart,grant,begin,a,d,c,response,e}=setup(t,true);smart();t.mock.method(globalThis,'fetch',async(_,init)=>response(init,items=>items.map(i=>({...i,performance:'大声哭喊，并播放背景音乐'}))));const op=await begin(grant());await a.close();assert.ok(d.list(c.id).every(s=>s.performance===''));assert.equal(e.get(op.operationId).result.needsDecision,2);
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
