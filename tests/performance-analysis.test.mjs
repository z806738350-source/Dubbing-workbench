import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf} from '../server/domain.mjs';
import {createAnalysis} from '../server/analysis.mjs';
import {createExperience} from '../server/experience.mjs';
import {createWorker} from '../server/worker.mjs';
import {inspectPerformance,performanceCoverage,performanceContract,hasReadableText} from '../server/performance.mjs';

function fixture(t,{source='沈栀展开信纸。\n“先别开门。等我数到三。”',segmented=false,limit=20}={}) {
  const dir=mkdtempSync(join(tmpdir(),'pg-analysis-')),store=openStore(dir),d=createDomain(store);
  const p=d.mutate('project.create',{name:'逐段表演自拟'}),c=d.mutate('chapter.create',{projectId:p.id,title:'自拟正文',source,segment:segmented});
  const config={key:'mock-test',baseUrl:'https://pg.invalid/v1',model:'seed-audio-1.0'},a=createAnalysis(store,d,config),e=createExperience(store,d,{},a,config);
  e.policy({projectId:p.id,revision:0,mode:'smart'});
  const grant=e.grant({grantId:uid(),projectId:p.id,chapterId:c.id,steps:['extract','director'],materials:['text'],textLimit:limit,audioLimit:0});
  const rev=()=>store.get('chapters',c.id).revision,edit=(id,fields)=>d.mutate('segment.update',{chapterId:c.id,revision:rev(),id,...fields}),calls=[];
  function mock(fn) {t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,config.baseUrl+'/chat/completions');const request=JSON.parse(init.body),input=JSON.parse(request.messages[1].content);calls.push(input);return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:await fn(input,request)})}}],usage:{total_tokens:100}});});}
  const base=input=>input.blocks.map(b=>({from:b.id,to:b.id,roleId:input.roles[0].id,type:'narration',performance:'平稳叙述，动作间自然停连，句末轻收。',performanceEvidence:{kind:'创作建议',refs:[b.id]},performanceUncertain:false,evidence:'原文明示',evidenceRefs:[b.id],reason:'角色由原文确定',uncertain:false}));
  async function run(options={},context) {const r=await a.start({chapterId:c.id,revision:rev(),autoApply:true,grantId:grant.grantId,...options},context);await a.close();return store.get('suggestions',r.id);}
  t.after(async()=>{await a.close();store.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,store,d,p,c,a,e,grant,rev,edit,calls,mock,base,run,rows:()=>d.list(c.id)};
}

test('PG指导合同：UTF16硬上限、占位与真实锚点、明确越界操作和笑意',()=>{
  assert.equal(performanceContract.maxLength,2000);
  assert.deepEqual(inspectPerformance('😀'.repeat(1000),'正文'),[]);
  assert.ok(inspectPerformance('😀'.repeat(1001),'正文').length);
  for(const value of ['',' \u200b ','待补充','同上','添加笑声','降低背景音乐','停顿2秒','从“失踪”开始紧张'])assert.ok(inspectPerformance(value,'这是正文').length,value);
  assert.deepEqual(inspectPerformance('带轻微笑意，字词清楚，句尾轻收。','微笑回应。'),[]);
  assert.deepEqual(inspectPerformance('从“等等”开始压低声音。','等等，先别走。',{performanceAnchors:['等等']}),[]);
});

test('合法否定与原文重音不会制造表演缺口，肯定越权及后半冲突仍阻断',t=>{
  for(const value of ['带一点笑意，不要添加笑声。','保持平静，不要删除台词。','强调“3秒”，语气干脆。','重音落在“3秒”，随后自然收句。'])assert.deepEqual(inspectPerformance(value,'3秒后出发。'),[],value);
  for(const value of ['加入笑声。','删掉台词。','播放背景音乐。','停顿3秒。','在3秒内读完。','不要添加笑声，但最后加入笑声。','不要添加笑声但最后加入笑声。'])assert.ok(inspectPerformance(value,'3秒后出发。').length,value);
  assert.ok(inspectPerformance('强调“4秒”。','3秒后出发。').length);
  assert.ok(inspectPerformance('平静。','3秒后出发。',{performanceAnchors:['4秒']}).length);
  const f=fixture(t,{source:'3秒后出发。\n3秒后出发。',segmented:true}),rows=f.rows();
  f.edit(rows[0].id,{performance:'带一点笑意，不要添加笑声。'});
  const ai=f.store.get('segments',rows[1].id);ai.performance='保持平静，不要删除台词。';ai.decisions={performance:{source:'policy_ai'}};f.store.put('segments',ai,f.c.id);
  const coverage=performanceCoverage(f.store,f.c.id);assert.equal(coverage.coveredCount,2);assert.deepEqual(coverage.missingIds,[]);assert.deepEqual(coverage.reviewRequiredIds,[]);
});

test('联合提取丰富指导一次请求自动保存，角色与表演证据独立，原文逐字完整',async t=>{
  const f=fixture(t);f.mock(input=>f.base(input).map((i,index)=>({...i,performance:index?'压低声音，第一句制止，第二句放慢并带指令感。':i.performance,performanceEvidence:{kind:'上下文推断',refs:[i.from]},uncertain:index===1})));
  const r=await f.run();assert.equal(f.calls.length,1);assert.equal(r.status,'applied');
  assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.ok(f.rows().every(s=>s.performance));
  assert.equal(f.rows()[1].roleConfirmed,false);assert.equal(f.rows()[0].roleConfirmed,true);
  assert.equal(f.rows()[1].decisions.performance.evidence.kind,'上下文推断');
  assert.equal(r.performanceReceipt.writtenIds.length,f.rows().length);assert.equal(f.a.coverage(f.c.id).coveredCount,f.rows().length);
  assert.equal(f.store.all('jobs').length,0);
});

test('只漏两条时仅补真实目标，已保存原响应、一轮请求幂等合并，零音频',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。\n第三句。\n第四句。'});
  f.mock(input=>input.targets ? input.targets.map(x=>({targetId:x.targetId,performance:'信息清楚，句末自然收住。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false})) : f.base(input).map((x,i)=>({...x,performance:i<2?'':x.performance})));
  const r=await f.run();assert.equal(f.calls.length,2);assert.equal(f.calls[1].targets.length,2);assert.ok(!f.calls[1].segments);assert.equal(r.performanceReceipt.repairedIds.length,2);
  assert.equal(JSON.parse(JSON.parse(r.batches[0].attempts[0].response).choices[0].message.content).items[0].performance,'');assert.equal(r.performanceRepairs.length,1);assert.equal(r.performanceReceipt.coverage.coveredCount,4);assert.equal(f.store.get('settings','ux-grant:'+f.grant.grantId).textUsed,2);
});

test('额度只够主分析不偷偷扩费，完整分段可落库但真实指导缺口保留',async t=>{
  const f=fixture(t,{limit:1});f.mock(input=>f.base(input).map(x=>({...x,performance:''})));
  const r=await f.run();assert.equal(f.calls.length,1);assert.equal(r.status,'applied');assert.ok(f.rows().length);assert.equal(r.performanceReceipt.coverage.coveredCount,0);assert.equal(r.performanceReceipt.coverage.missingIds.length,f.rows().length);
});

test('补缺不改已有人工、有效AI、删除排除和退役；对戏按成员统计',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。\n第三句。\n第四句。\n第五句。',segmented:true});const rows=f.rows();
  f.edit(rows[0].id,{performance:'人工克制而坚定。'});const ai=f.store.get('segments',rows[1].id);ai.performance='清楚通知，时间信息稍强调。';ai.decisions={performance:{source:'policy_ai',values:ai.performance}};f.store.put('segments',ai,f.c.id);
  const deleted=f.store.get('segments',rows[3].id);deleted.deletion={at:'fixture'};deleted.excluded=true;f.store.put('segments',deleted,f.c.id);const excluded=f.store.get('segments',rows[4].id);excluded.excluded=true;f.store.put('segments',excluded,f.c.id);
  f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'平静叙述，句末轻收。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));
  const before=f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,voiceId:s.voiceId})),r=await f.run({kind:'director',performanceMode:'fillMissing'});
  assert.deepEqual(f.calls[0].segments.map(s=>s.id),[rows[2].id]);assert.equal(f.rows()[0].performance,'人工克制而坚定。');assert.equal(f.rows()[1].performance,ai.performance);
  assert.deepEqual(f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,voiceId:s.voiceId})),before);assert.equal(r.performanceReceipt.preservedHumanIds.length,1);assert.equal(r.performanceReceipt.coverage.eligibleCount,3);assert.equal(r.performanceReceipt.coverage.coveredCount,3);assert.equal(r.performanceReceipt.coverage.deletedCount,1);assert.equal(r.performanceReceipt.coverage.excludedCount,1);
});

test('等待期间人工新值保留、无关修改允许其他目标自动继续、撤销只恢复安全字段',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。',segmented:true}),ids=f.rows().map(s=>s.id);
  let release;const waiting=new Promise(resolve=>release=resolve);
  f.mock(async input=>{await waiting;return input.segments.map(s=>({segmentId:s.id,performance:'放慢语速，句尾坚定收束。',evidence:'创作建议',evidenceRefs:[],uncertain:false}));});
  const started=await f.a.start({chapterId:f.c.id,revision:f.rev(),kind:'director',performanceMode:'fillMissing',autoApply:true,grantId:f.grant.grantId});
  f.edit(ids[0],{performance:'等待时新增的人工指导。'});release();await f.a.close();const r=f.store.get('suggestions',started.id);
  assert.equal(f.store.get('segments',ids[0]).performance,'等待时新增的人工指导。');assert.equal(f.store.get('segments',ids[1]).performance,'放慢语速，句尾坚定收束。');assert.equal(r.performanceReceipt.writtenIds.length,1);
  f.edit(ids[1],{performance:'后来更新。'});const result=f.a.undoPerformance({analysisId:r.id,operationId:uid(),revision:f.rev()});assert.equal(result.restoredIds.length,0);assert.deepEqual(result.preservedChangedIds,[ids[1]]);
});

test('明确所选人工重写只准performance，默认保留legacy；撤销直接还原',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。',segmented:true}),ids=f.rows().map(s=>s.id);f.edit(ids[0],{performance:'我的原人工值。'});
  f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'低声但清楚，逐词坚定。',evidence:'创作建议',evidenceRefs:[],uncertain:false,voiceId:'forged',text:'forged'})));
  const before=f.store.get('segments',ids[0]),r=await f.run({kind:'director',ids:[ids[0]],performanceMode:'selectedRewrite'},{actorKind:'human_direct',performanceRewrite:{segmentIds:[ids[0]],includeHuman:true,source:{kind:'ui',id:uid()}}});
  const after=f.store.get('segments',ids[0]);assert.equal(after.text,before.text);assert.equal(after.roleId,before.roleId);assert.equal(after.voiceId,before.voiceId);assert.equal(after.performance,'低声但清楚，逐词坚定。');assert.equal(f.store.get('segments',ids[1]).performance,'');
  const op=uid(),undo=f.a.undoPerformance({analysisId:r.id,operationId:op,revision:f.rev()});assert.deepEqual(undo.restoredIds,[ids[0]]);assert.equal(f.store.get('segments',ids[0]).performance,before.performance);assert.deepEqual(f.a.undoPerformance({analysisId:r.id,operationId:op,revision:undo.chapterRevision-1}),undo);
});

test('PG长章24目标/有界正文；拆分后的失效锚点仅进入对应子段缺口',async t=>{
  const f=fixture(t,{source:Array.from({length:60},(_,i)=>`自拟第${i}行，平静叙述。\n`).join('')});
  const plan=f.a.plan({chapterId:f.c.id,revision:f.rev()});assert.equal(plan.textRequests,3);assert.equal(plan.maxTextRequests,6);
  f.mock(input=>f.base(input));await f.run();assert.ok(f.calls.every(input=>input.blocks.length<=24));assert.ok(f.calls.every(input=>input.blocks.reduce((n,b)=>n+b.text.length,0)<=12000));assert.equal(f.calls.length,3);
});

test('已接收响应重启本地恢复自动采用，unknown保留不重发',async t=>{
  const f=fixture(t);f.mock(input=>f.base(input));const r=await f.run({autoApply:false});const persisted=f.store.get('suggestions',r.id);persisted.autoApply=true;persisted.status='running';persisted.batches[0].status='sending';persisted.batches[0].items=[];f.store.put('suggestions',persisted,f.c.id);f.a.recover();assert.equal(f.calls.length,1);assert.equal(f.store.get('suggestions',r.id).status,'applied');assert.equal(f.rows().length,2);
});

test('长提取父段的位置锚点只保留合法子段，缺口target自动补齐不复制假转折',async t=>{
  const source=Array.from({length:4},(_,i)=>`第${i}段${'风吹过山林，'.repeat(25)}${i===3?'下一刻看见影子。':'仍然平静。'}\n`).join(''),f=fixture(t,{source});
  f.mock(input=>input.targets ? input.targets.map(x=>({targetId:x.targetId,performance:'平稳叙述，句末自然轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false})) : [{...f.base(input)[0],from:input.blocks[0].id,to:input.blocks.at(-1).id,performance:'从“下一刻”开始收紧语气。',performanceAnchors:['下一刻']}]);
  const r=await f.run();assert.equal(f.calls.length,2);assert.ok(f.rows().length>1);assert.equal(f.rows().map(s=>s.text).join(''),source);
  const anchored=f.rows().filter(s=>s.performance.includes('下一刻'));assert.equal(anchored.length,1);assert.ok(anchored[0].text.includes('下一刻'));assert.equal(r.performanceReceipt.coverage.coveredCount,f.rows().length);
});

test('director子段映射按真实边界逐一绑定，缺项局部补齐且错误ID不污染邻段',async t=>{
  const source=Array.from({length:5},(_,i)=>`${'自拟正文'.repeat(25)}第${i}句。`).join(''),f=fixture(t,{source,segmented:true});let parent=f.rows()[0];
  while(f.rows().length>1)parent=f.d.mutate('segment.merge',{chapterId:f.c.id,revision:f.rev(),id:parent.id,performance:''});
  f.mock(input=>{
    if(input.targets)return input.targets.map(x=>({targetId:x.targetId,performance:'平静而清楚，句尾轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false}));
    return input.segments.map(s=>({segmentId:s.id,performance:'逐词坚定，重音突出信息。',evidence:'原文明示',evidenceRefs:[input.blocks[0].id],uncertain:false,splitAfter:s.splitBoundaries.map(b=>b.id),splitPerformance:[{index:0,performance:'低声清楚，句末坚定收住。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[]}]}));
  });
  const r=await f.run({kind:'director'});assert.equal(f.calls.length,2);assert.equal(f.calls[1].targets.length,4);assert.equal(f.rows().length,5);assert.equal(f.rows()[0].performance,'低声清楚，句末坚定收住。');assert.ok(f.rows().slice(1).every(s=>s.performance==='平静而清楚，句尾轻收。'));assert.equal(r.performanceReceipt.coverage.coveredCount,5);assert.ok(f.rows().every(s=>s.decisions.performance.source==='structural_ai'));
});

test('局部补齐仍无效止于一轮；网络unknown不会因重开/换ID自动付费',async t=>{
  for(const unknown of [false,true])await t.test(unknown?'unknown':'invalid',async t=>{
    const f=fixture(t);f.mock(input=>{if(input.targets&&unknown)throw Error('lost');return input.targets ? input.targets.map(x=>({targetId:'wrong-'+x.targetId,performance:'自然朗读'})) : f.base(input).map(x=>({...x,performance:'待补充'}));});
    const r=await f.run();assert.equal(f.calls.length,2);assert.equal(r.performanceRepairs.length,1);assert.equal(r.performanceReceipt.coverage.coveredCount,0);assert.ok(r.performanceReceipt.coverage.missingIds.length);
    if(unknown){assert.equal(r.performanceRepairs[0].status,'unknown');await assert.rejects(f.a.start({chapterId:f.c.id,revision:f.rev(),kind:'extract',grantId:f.grant.grantId,autoApply:true}),/结果不明/);}f.a.recover();assert.equal(f.calls.length,2);
  });
});

test('纯不可见记录不纳入覆盖；恢复deleted台词重新计算且元信息不等于音频更新',t=>{
  const f=fixture(t,{source:'正文。\n正文二。',segmented:true}),rows=f.rows();
  const invisible={...rows[0],id:uid(),text:'\u200b\u2060\ufeff',source:{kind:'manual'}};f.store.put('segments',invisible,f.c.id);
  const deleted=f.store.get('segments',rows[1].id);deleted.deletion={at:'fixture'};deleted.excluded=true;f.store.put('segments',deleted,f.c.id);
  let result=performanceCoverage(f.store,f.c.id);assert.equal(result.eligibleCount,1);assert.equal(result.deletedCount,1);
  delete deleted.deletion;deleted.excluded=false;f.store.put('segments',deleted,f.c.id);result=performanceCoverage(f.store,f.c.id);assert.equal(result.eligibleCount,2);assert.ok(result.missingIds.includes(deleted.id));assert.equal(f.calls.length,0);
});

test('review候选齐全与持久覆盖分列，一次统一采用后无需再次保存',async t=>{
  const f=fixture(t);const policy=f.e.policy({projectId:f.p.id,revision:1,mode:'review'});assert.equal(policy.mode,'review');f.mock(input=>f.base(input));const r=await f.run();assert.equal(r.status,'ready');assert.equal(r.performanceCoverage.coveredCount,2);assert.equal(f.a.coverage(f.c.id).eligibleCount,0);
  f.a.apply({id:r.id,draftVersion:r.draftVersion,revision:f.rev(),replaceConfirmed:true});assert.equal(f.a.coverage(f.c.id).coveredCount,2);assert.equal(f.calls.length,1);
});

test('PG未知修补一次具体决定后重发同记录并只补原缺口，不重新提取或加章',async t=>{
  const f=fixture(t);let lost=true;f.mock(input=>{if(input.targets&&lost)throw Error('lost');return input.targets ? input.targets.map(x=>({targetId:x.targetId,performance:'自然停连，句末轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false})) : f.base(input).map(x=>({...x,performance:''}));});
  const r=await f.run(),repair=r.performanceRepairs[0],ids=f.rows().map(s=>s.id);assert.equal(repair.status,'unknown');assert.throws(()=>f.a.resume({id:r.id,draftVersion:r.draftVersion,repairIds:[repair.id]}),/结果不明/);assert.equal(f.calls.length,2);
  lost=false;f.a.resume({id:r.id,draftVersion:r.draftVersion,repairIds:[repair.id],retryUnknown:true,grantId:f.grant.grantId});await f.a.close();const final=f.store.get('suggestions',r.id);
  assert.equal(f.calls.length,3);assert.deepEqual(f.rows().map(s=>s.id),ids);assert.ok(f.rows().every(s=>s.performance==='自然停连，句末轻收。'));assert.equal(final.performanceRepairs[0].attempts.length,2);assert.equal(final.performanceRepairs[0].attempts[0].status,'unknown');assert.equal(final.performanceReceipt.coverage.coveredCount,2);
});

test('明确人工重写指令冻结在send时，随后续写在start前也保留',async t=>{
  const f=fixture(t,{source:'第一句。',segmented:true}),s=f.rows()[0];f.edit(s.id,{performance:'发送时原人工值。'});const base=f.store.get('segments',s.id),ctx={actorKind:'human_direct',performanceRewrite:{segmentIds:[s.id],includeHuman:true,source:{kind:'message',id:uid()},bases:[{segmentId:s.id,performance:base.performance,decision:base.decisions.performance,dependencies:{text:base.text,roleId:base.roleId,type:base.type,source:base.source}}]}};
  f.edit(s.id,{performance:'发送后、分析前的新版。'});f.mock(()=>{throw Error('must not send');});const r=await f.run({kind:'director',performanceMode:'selectedRewrite',ids:[s.id]},ctx);assert.equal(f.calls.length,0);assert.equal(f.rows()[0].performance,'发送后、分析前的新版。');assert.deepEqual(r.performanceReceipt.preservedHumanIds,[s.id]);assert.equal(r.performanceReceipt.changeSetId,undefined);
});

test('仅角色显示名变化继续，实质facts变化只跳过关联目标；回执写入集合可靠',async t=>{
  for(const facts of [false,true])await t.test(facts?'facts':'display-name',async t=>{
    const f=fixture(t,{source:'第一句。\n第二句。',segmented:true});let release;const waiting=new Promise(r=>release=r);f.mock(async input=>{await waiting;return input.segments.map(s=>({segmentId:s.id,performance:'压低声音，语速略缓。',evidence:'创作建议',evidenceRefs:[],uncertain:false}));});
    const started=await f.a.start({chapterId:f.c.id,revision:f.rev(),kind:'director',performanceMode:'fillMissing',autoApply:true,grantId:f.grant.grantId}),role=f.store.get('roles',f.rows()[0].roleId);role.name='新显示名';if(facts)role.facts=[{chapterId:f.c.id,note:'新增的实际性格要求'}];f.store.put('roles',role,f.p.id);const project=f.store.get('projects',f.p.id);project.contextRevision++;f.store.put('projects',project);
    release();await f.a.close();const r=f.store.get('suggestions',started.id);assert.equal(r.performanceReceipt.writtenIds.length,facts?0:2);assert.deepEqual(r.performanceReceipt.coverage.currentRun.writtenIds,r.performanceReceipt.writtenIds);assert.equal(r.performanceReceipt.affectedUnitIds.length,facts?0:2);
  });
});

test('review提取保留AI证据并可字段撤销；同operation采用返回同一回执不再touch',async t=>{
  const f=fixture(t);f.e.policy({projectId:f.p.id,revision:1,mode:'review'});f.mock(input=>f.base(input));const r=await f.run(),command={id:r.id,draftVersion:r.draftVersion,revision:f.rev(),replaceConfirmed:true,operationId:uid()};
  const applied=f.a.apply(command),revision=f.rev();assert.equal(f.rows()[0].decisions.performance.source,'human_accepted_ai');assert.equal(f.rows()[0].decisions.performance.evidence.kind,'创作建议');assert.deepEqual(f.a.apply(command),applied);assert.equal(f.rev(),revision);const ids=f.rows().map(s=>s.id),texts=f.rows().map(s=>s.text);const undo=f.a.undoPerformance({analysisId:r.id,operationId:uid(),revision:f.rev()});assert.deepEqual(undo.restoredIds,ids);assert.deepEqual(f.rows().map(s=>s.text),texts);assert.ok(f.rows().every(s=>s.performance===''));assert.equal(f.calls.length,1);
});

test('已收到JSON格式错误只在原修补预留内重做对应基础批，unknown不走此路',async t=>{
  const f=fixture(t);let calls=0;t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'https://pg.invalid/v1/chat/completions');calls++;const input=JSON.parse(JSON.parse(init.body).messages[1].content);f.calls.push(input);return Response.json({choices:[{finish_reason:'stop',message:{content:calls===1?'{bad-json':JSON.stringify({items:f.base(input)})}}]});});
  const r=await f.run();assert.equal(calls,2);assert.deepEqual(f.calls[0].blocks,f.calls[1].blocks);assert.equal(r.structuralRetryIds.length,1);assert.equal(r.batches[0].attempts.length,2);assert.equal(r.batches[0].attempts[0].status,'received');assert.equal(r.status,'applied');assert.equal(r.performanceReceipt.coverage.coveredCount,2);assert.equal(f.store.get('settings','ux-grant:'+f.grant.grantId).textUsed,2);
});

test('助手在分析等待期间暂停或删除会话：接收候选但不补发/不落正式指导',async t=>{
  for(const state of ['paused','deleting'])await t.test(state,async t=>{
    const f=fixture(t,{source:'第一句。\n第二句。',segmented:true}),runId=uid(),sessionId=uid();f.store.put('assistantSessions',{id:sessionId,state:'active'},f.p.id);f.store.put('assistantRuns',{id:runId,state:'waitingJobs',sessionId},sessionId);
    let release;const waiting=new Promise(resolve=>release=resolve);f.mock(async input=>{await waiting;return input.segments.map(s=>({segmentId:s.id,performance:s.id===input.segments[0].id?'':'低声清楚地说。',evidence:'创作建议',evidenceRefs:[],uncertain:false}));});
    const started=await f.a.start({chapterId:f.c.id,revision:f.rev(),kind:'director',performanceMode:'fillMissing',autoApply:true,grantId:f.grant.grantId},{actorKind:'assistant_delegated',runId,mandateId:uid()});
    if(state==='paused')f.store.put('assistantRuns',{id:runId,state:'paused',sessionId},sessionId);else f.store.put('assistantSessions',{id:sessionId,state:'deleting'},f.p.id);
    release();await f.a.close();const r=f.store.get('suggestions',started.id);assert.equal(f.calls.length,1);assert.equal(r.batches[0].status,'received');assert.ok(f.rows().every(s=>s.performance===''));assert.equal(r.automation.applied,0);assert.ok(!r.performanceRepairs?.length);
  });
});

test('导演拆分已落库后的子段未知补齐可按同一请求重发，只填原空子段',async t=>{
  const source=Array.from({length:4},(_,i)=>`${'自拟正文'.repeat(25)}第${i}句。`).join(''),f=fixture(t,{source,segmented:true});let parent=f.rows()[0];while(f.rows().length>1)parent=f.d.mutate('segment.merge',{chapterId:f.c.id,revision:f.rev(),id:parent.id,performance:''});let lost=true;
  f.mock(input=>{if(input.targets){if(lost)throw Error('lost');return input.targets.map(x=>({targetId:x.targetId,performance:'平静叙述，句末轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false}));}return input.segments.map(s=>({segmentId:s.id,performance:'逐词坚定，信息明确。',evidence:'原文明示',evidenceRefs:[input.blocks[0].id],uncertain:false,splitAfter:s.splitBoundaries.map(b=>b.id),splitPerformance:[{index:0,performance:'低声清楚，句末坚定。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[]}]}));});
  const r=await f.run({kind:'director'}),ids=f.rows().map(s=>s.id),first=f.rows()[0].performance,repair=r.performanceRepairs[0];assert.equal(f.rows().length,4);assert.equal(repair.status,'unknown');lost=false;f.a.resume({id:r.id,draftVersion:r.draftVersion,repairIds:[repair.id],retryUnknown:true,grantId:f.grant.grantId});await f.a.close();const final=f.store.get('suggestions',r.id);assert.deepEqual(f.rows().map(s=>s.id),ids);assert.equal(f.rows()[0].performance,first);assert.ok(f.rows().slice(1).every(s=>s.performance==='平静叙述，句末轻收。'));assert.equal(final.performanceReceipt.coverage.coveredCount,4);assert.equal(f.calls.length,3);
});

test('所选三句目标完成独立于整章未选缺口，scope回执直接ready而global如实needsAttention',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。\n第三句。\n第四句。',segmented:true}),ids=f.rows().slice(0,3).map(s=>s.id);
  f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'平稳叙述，句末轻收。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));
  const r=await f.run({kind:'director',ids,performanceMode:'selectedRewrite'});assert.equal(f.calls.length,1);assert.equal(f.rows().at(-1).performance,'');assert.equal(r.performanceReceipt.scopeCoverage.eligibleCount,3);assert.equal(r.performanceReceipt.scopeCoverage.coveredCount,3);assert.equal(r.performanceReceipt.scopeCoverage.phase,'ready');assert.equal(r.performanceReceipt.coverage.eligibleCount,4);assert.equal(r.performanceReceipt.coverage.phase,'needsAttention');assert.equal(r.performanceReceipt.coverage.missingIds.length,1);
});

test('可信明确基础朗读初次分段标豁免，legacy false不伪造来源，后续补缺不再回填',async t=>{
  for(const explicit of [false,true])await t.test(explicit?'explicit-basic':'legacy-false',async t=>{
    const f=fixture(t);f.mock(input=>f.base(input).map(x=>({...x,performance:''})));const context=explicit ? {actorKind:'human_direct',performanceBasic:{source:{kind:'ui',id:uid()}}} : undefined;
    const r=await f.run({includePerformance:false},context);assert.equal(r.explicitBasic===true,explicit);assert.ok(f.rows().every(s=>s.decisions.performance.waivedBasic===true)===explicit);
    if(explicit){assert.equal(r.performanceReceipt.coverage.coveredCount,0);assert.equal(r.performanceReceipt.coverage.waivedBasicIds.length,2);assert.equal(r.performanceReceipt.coverage.phase,'ready');const later=await f.run({kind:'director',performanceMode:'fillMissing'});assert.equal(f.calls.length,1);assert.equal(later.performanceReceipt.scopeCoverage.phase,'ready');assert.ok(f.rows().every(s=>s.performance===''));}
  });
});

test('旧章明确基础范围只标空字段，非空人工和音频输入原样，不触碰chapter编排',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。\n第三句。',segmented:true}),rows=f.rows(),ids=rows.slice(0,2).map(s=>s.id);f.edit(ids[1],{performance:'保留这条人工值。'});const before=f.rows().map(s=>({id:s.id,input:inputOf(s),basis:basisOf(s)})),revision=f.rev();f.mock(()=>{throw Error('basic metadata must be free');});
  const r=await f.run({kind:'director',includePerformance:false,ids},{actorKind:'human_direct',performanceBasic:{source:{kind:'ui',id:uid()},segmentIds:ids}});assert.equal(f.calls.length,0);assert.equal(f.rev(),revision);assert.deepEqual(f.rows().map(s=>({id:s.id,input:inputOf(s),basis:basisOf(s)})),before);assert.equal(f.rows()[0].decisions.performance.waivedBasic,true);assert.equal(f.rows()[1].performance,'保留这条人工值。');assert.ok(!f.rows()[2].decisions?.performance?.waivedBasic);assert.equal(r.performanceReceipt.scopeCoverage.phase,'ready');assert.equal(r.performanceReceipt.coverage.phase,'needsAttention');
});

test('模型不能自选basic豁免；Unicode纯格式/variation不读，真实组合与标点保留',async t=>{
  const f=fixture(t);await assert.rejects(f.a.start({chapterId:f.c.id,revision:f.rev(),includePerformance:false,grantId:f.grant.grantId},{actorKind:'assistant_delegated',runId:uid()}),/真实用户/);assert.equal(f.calls.length,0);
  for(const value of [' \u00ad\u061c\u200d\u202e\u2067\u2069\ufeff','\ufe0e\ufe0f','\u{e0100}\u{e01ef}'])assert.equal(hasReadableText(value),false);
  for(const value of ['字\u{e0100}','e\u0301','👩🏽‍🚀','。','中文\u200d组合'])assert.equal(hasReadableText(value),true);
});

test('可信Basic旧章预检与执行同为0文本请求，legacy false仍按旧批次计划',t=>{
  const f=fixture(t,{source:'第一句。\n第二句。',segmented:true}),p={chapterId:f.c.id,revision:f.rev(),kind:'director',includePerformance:false},context={actorKind:'human_direct',performanceBasic:{source:{kind:'ui',id:uid()}}};
  assert.equal(f.a.plan(p,context).textRequests,0);assert.equal(f.a.plan(p,context).maxTextRequests,0);assert.equal(f.a.plan(p).textRequests,1);
});

test('fillMissing按共享依赖修补文本仍有效但已经stale的AI指导，保留真实范围与basic豁免',async t=>{
  const f=fixture(t,{source:'第一句。\n第二句。',segmented:true}),[target,other]=f.rows();
  target.performance='平静而清楚地读出。';target.decisions={performance:{source:'policy_ai',values:target.performance,dependencies:{text:target.text,roleId:target.roleId,type:target.type,source:target.source},roleFacts:[]}};f.store.put('segments',target,f.c.id);
  const role=f.store.get('roles',target.roleId);role.facts=[{chapterId:f.c.id,note:'当前场景需要急切表达'}];f.store.put('roles',role,f.p.id);
  other.decisions={performance:{source:'human',values:'',waivedBasic:true,dependencies:{text:'旧依赖',roleId:other.roleId,type:other.type,source:other.source}}};f.store.put('segments',other,f.c.id);
  assert.deepEqual(f.a.coverage(f.c.id).missingIds,[target.id]);
  const plan=f.a.plan({chapterId:f.c.id,revision:f.rev(),kind:'director',performanceMode:'fillMissing'});assert.deepEqual(plan.memberIds,[target.id]);
  f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'急切但吐字清楚，句末收住。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));
  const r=await f.run({kind:'director',performanceMode:'fillMissing'});assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].segments.map(s=>s.id),[target.id]);assert.equal(f.rows()[0].performance,'急切但吐字清楚，句末收住。');assert.deepEqual(f.rows()[0].decisions.performance.roleFacts,role.facts);assert.equal(f.rows()[1].performance,'');assert.equal(r.performanceReceipt.scopeCoverage.phase,'ready');assert.equal(r.performanceReceipt.coverage.coveredCount,1);assert.deepEqual(r.performanceReceipt.coverage.waivedBasicIds,[other.id]);
});

test('明确所选重写就是一次写入意图，旧review偏好不再追加审批；仅求候选仍不落库',async t=>{
 const f=fixture(t,{segmented:true}),first=f.rows()[0];f.edit(first.id,{performance:'已有人工指导，保持平静。'});f.e.policy({projectId:f.p.id,revision:1,mode:'review'});
 f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'压低声音，句末坚定收住。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));
 const result=await f.e.run({operationId:uid(),kind:'prepareChapter',chapterId:f.c.id,revision:f.rev(),analysisKind:'director',performanceMode:'selectedRewrite',ids:[first.id],includeHumanPerformance:true,grantId:f.grant.grantId});await f.a.close();
 const r=f.store.get('suggestions',result.result.analysis.id);assert.equal(r.status,'applied');assert.equal(f.rows()[0].performance,'压低声音，句末坚定收住。');assert.equal(f.rows()[1].performance,'');assert.equal(f.store.get('settings','ux-policy:'+f.p.id).mode,'review');
 const prior=f.rows()[0].performance,candidate=await f.e.run({operationId:uid(),kind:'prepareChapter',chapterId:f.c.id,revision:f.rev(),analysisKind:'director',performanceMode:'selectedRewrite',ids:[first.id],includeHumanPerformance:true,autoApply:false,grantId:f.grant.grantId});await f.a.close();assert.equal(f.store.get('suggestions',candidate.result.analysis.id).status,'ready');assert.equal(f.rows()[0].performance,prior);
});

test('PG03/PG55/PG68真实分组：2句1单元与8句5单元逐句覆盖，旧音频保持且整组输入待更新',async t=>{
 for(const [count,mode] of [[2,'dry'],[8,'dry'],[2,'scene']])await t.test(`${count}句${mode}`,async t=>{
  const f=fixture(t,{source:Array.from({length:count},(_,i)=>`自拟第${i+1}句，信息清楚。\n`).join(''),segmented:true}),ids=f.rows().map(s=>s.id);
  const bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);
  const voice={id:uid(),name:'隔离合成参考',state:'active',revision:1,path:'group-reference.wav'};writeFileSync(join(f.dir,voice.path),bytes);f.store.put('voices',voice);
  for(const id of ids)f.edit(id,{voiceId:voice.id,roleConfirmed:true,identityConfirmed:true});
  const groups=[];for(let index=0;index<(count===2?1:3);index++)groups.push(f.d.mutate('unit.create',{chapterId:f.c.id,revision:f.rev(),ids:ids.slice(index*2,index*2+2),guidance:'顺序衔接，字词清楚。'}));
  const unitIds=[...groups.map(g=>g.id),...(count===8?ids.slice(6):[])],original=[];
  if(mode==='scene')for(const id of unitIds){let unit=f.store.get('units',id);f.d.mutate('unit.update',{chapterId:f.c.id,revision:f.rev(),unitId:id,entityRevision:unit.revision,mode:'scene',guidance:'人声与场地风声共同清楚呈现。',backgroundPresence:'clear'});unit=f.store.get('units',id);f.d.mutate('event.create',{chapterId:f.c.id,revision:f.rev(),unitId:id,entityRevision:unit.revision,kind:'environment',description:'清楚可辨的轻柔风声。',memberId:unit.members[0],position:'during',state:'adopted'});}
  for(const unitId of unitIds){
   const unit=f.store.get('units',unitId),input=f.d.enhancement.input(unit,mode),basis=f.d.enhancement.basis(unit,mode),audio={id:uid(),chapterId:f.c.id,path:`prior-${unitId}.wav`,state:'ready',format:'wav',duration:.1,model:'seed-audio-1.0',targetKind:'unit',targetId:unit.id,input,basis,fixture:'local-synthetic'};
   writeFileSync(join(f.dir,audio.path),bytes);f.store.put('audios',audio,f.c.id);assert.equal(f.d.enhancement.register({id:uid(),status:'running',chapterId:f.c.id,revision:f.rev()},{id:audio.id,targetKind:'unit',targetId:unit.id,unitId:unit.id,mode,unitRevision:unit.revision,membershipRevision:unit.membershipRevision,input,basis},audio),true);original.push(f.store.get('audios',audio.id));
  }
  for(const unitId of unitIds)assert.equal(f.d.enhancement.status(f.store.get('units',unitId),mode).validity,'matched');
  assert.equal(f.d.chapter(f.c.id).playbackItems.length,count===2?1:5);assert.equal(f.a.coverage(f.c.id).eligibleCount,count);assert.equal(f.a.coverage(f.c.id).missingIds.length,count);
  const eventsBefore=unitIds.flatMap(id=>f.store.all('events',id)),unitsBefore=unitIds.map(id=>f.store.get('units',id)),rowsBefore=f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,voiceId:s.voiceId}));
  f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'平稳叙述，信息词略强调，句末轻收。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));
  const r=await f.run({kind:'director',performanceMode:'fillMissing',ids});assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0].segments.map(s=>s.id),ids);assert.equal(r.performanceReceipt.coverage.eligibleCount,count);assert.equal(r.performanceReceipt.coverage.coveredCount,count);assert.equal(r.performanceReceipt.writtenIds.length,count);assert.equal(r.performanceReceipt.affectedUnitIds.length,count===2?1:5);assert.deepEqual(new Set(r.performanceReceipt.affectedUnitIds),new Set(unitIds));
  assert.deepEqual(f.rows().map(s=>({id:s.id,text:s.text,roleId:s.roleId,voiceId:s.voiceId})),rowsBefore);assert.equal(f.store.all('jobs').length,0,'只填指导不创建任何新音频或母版任务');
  for(const [index,unitId] of unitIds.entries()){const unit=f.store.get('units',unitId);assert.deepEqual(unit.members,unitsBefore[index].members);assert.equal(unit.state,'active');assert.equal(unit.variants[mode].current,original[index].id);assert.equal(unit.mode,mode);if(mode==='scene'){assert.equal(unit.variants.scene.backgroundPresence,'clear');assert.equal(unit.variants.scene.template,unitsBefore[index].variants.scene.template);assert.equal(unit.variants.scene.guidance,unitsBefore[index].variants.scene.guidance);assert.deepEqual(f.d.enhancement.events(unit).map(e=>[e.id,e.state,e.validity]),eventsBefore.map(e=>[e.id,'adopted','valid']));}assert.equal(f.d.enhancement.status(unit,mode).validity,'stale','组和单条按真实冻结输入待更新');}
  assert.deepEqual(unitIds.flatMap(id=>f.store.all('events',id)),eventsBefore);
  for(const audio of original){const stored=f.store.get('audios',audio.id);assert.deepEqual(stored.input,audio.input);assert.equal(stored.path,audio.path);assert.deepEqual(readFileSync(join(f.dir,stored.path)),bytes);}
  if(mode==='scene') {
   const config={key:'mock-test',model:'seed-audio-1.0',baseUrl:'https://pg.invalid/v1',audioUrl:'https://pg.invalid/v1/audio/speech'},worker=createWorker(f.store,f.d,config),production=createExperience(f.store,f.d,worker,f.a,config),grant=production.grant({grantId:uid(),projectId:f.p.id,chapterId:f.c.id,steps:['unit-generate'],materials:['text','reference'],voiceIds:[voice.id],textLimit:0,audioLimit:1}),http=[];
   t.mock.method(globalThis,'fetch',async(url,options)=>{assert.equal(url,config.audioUrl);http.push(JSON.parse(options.body));return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});});
   try {
    const job=await worker.submit({kind:'unit-generate',chapterId:f.c.id,revision:f.rev(),unitId:unitIds[0],mode:'scene',commandId:uid(),grantId:grant.grantId,requireGrant:true});await worker.tick();const actual=f.store.get('jobs',job.id),attempt=f.store.all('attempts',job.id)[0];assert.equal(actual.status,'success',actual.error);assert.equal(http.length,1,'新指导由一次Seed原生联合请求生成，未本地混音替代');assert.equal(http[0].model,'seed-audio-1.0');assert.equal(http[0].text_prompt,attempt.prompt);assert.deepEqual(attempt.input.members.map(m=>m.text),f.rows().map(s=>s.text));assert.deepEqual(attempt.input.members.map(m=>m.voiceId),ids.map(()=>voice.id));assert.ok(attempt.input.members.every(m=>m.performance==='平稳叙述，信息词略强调，句末轻收。'));assert.ok(http[0].text_prompt.includes('平稳叙述，信息词略强调，句末轻收。'));assert.ok(http[0].text_prompt.includes('清楚可辨的轻柔风声。'));assert.ok(http[0].text_prompt.includes('人声与场地风声共同清楚呈现。'));for(const s of f.rows())assert.ok(http[0].text_prompt.includes(s.text.trim()));assert.equal(http[0].references.length,1);assert.ok(JSON.stringify(http[0].references).includes(bytes.toString('base64')));assert.equal(attempt.input.backgroundPresence,'clear');assert.deepEqual(attempt.input.events,original[0].input.events);assert.equal(f.calls.length,1,'真实音频任务未追加文本导演分析');assert.equal(f.d.enhancement.status(f.store.get('units',unitIds[0]),'scene').validity,'matched');assert.notEqual(f.store.get('units',unitIds[0]).variants.scene.current,original[0].id);assert.equal(f.store.get('units',unitIds[0]).variants.scene.previous,original[0].id);assert.deepEqual(readFileSync(join(f.dir,original[0].path)),bytes);
   } finally {await worker.close();}
  }
 });
});

test('PG22子段指导index重复或越界仅留局部缺口，原合法拆分继续且补齐不绑错邻段',async t=>{
 for(const invalid of ['duplicate','outside'])await t.test(invalid,async t=>{
  const f=fixture(t,{source:Array.from({length:4},(_,i)=>`${'自拟正文'.repeat(25)}第${i}句。`).join(''),segmented:true});let parent=f.rows()[0];while(f.rows().length>1)parent=f.d.mutate('segment.merge',{chapterId:f.c.id,revision:f.rev(),id:parent.id,performance:''});
  f.mock(input=>input.targets ? input.targets.map(x=>({targetId:x.targetId,performance:'补齐的平静叙述，句尾轻收。',performanceEvidence:{kind:'创作建议',refs:[]},performanceAnchors:[],performanceUncertain:false})) : input.segments.map(s=>({segmentId:s.id,performance:'逐词坚定，信息明确。',evidence:'原文明示',evidenceRefs:[input.blocks[0].id],uncertain:false,splitAfter:s.splitBoundaries.map(b=>b.id),splitPerformance:invalid==='duplicate'?[{index:0,performance:'重复一。'},{index:0,performance:'重复二。'},{index:1,performance:'第二段的合法指导。'}]:[{index:99,performance:'越界指导不能污染邻段。'},{index:1,performance:'第二段的合法指导。'}]})));
  const r=await f.run({kind:'director'});assert.equal(f.rows().length,4);assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.equal(f.calls.length,2);assert.equal(f.calls[1].targets.length,3);assert.equal(f.rows()[1].performance,'第二段的合法指导。');assert.ok(f.rows().filter((_,i)=>i!==1).every(s=>s.performance==='补齐的平静叙述，句尾轻收。'));assert.ok(!f.rows().some(s=>/重复一|重复二|越界指导/.test(s.performance)));assert.equal(r.performanceReceipt.coverage.coveredCount,4);
 });
});

test('PG46 finish_reason length不能采用缺尾正文，只用原R重做对应基础批',async t=>{
 const f=fixture(t);let requests=0;t.mock.method(globalThis,'fetch',async(url,init)=>{assert.equal(url,'https://pg.invalid/v1/chat/completions');requests++;const input=JSON.parse(JSON.parse(init.body).messages[1].content);f.calls.push(input);if(requests===2)assert.equal(f.rows().length,0,'截断第一响应未提前写正式剧本');return Response.json({choices:[{finish_reason:requests===1?'length':'stop',message:{content:JSON.stringify({items:requests===1?f.base(input).slice(0,1):f.base(input)})}}]});});
 const r=await f.run();assert.equal(requests,2);assert.equal(r.batches[0].attempts[0].finishReason,'length');assert.equal(r.batches[0].attempts[0].status,'received');assert.equal(r.batches[0].attempts.length,2);assert.deepEqual(f.calls[0].blocks,f.calls[1].blocks);assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.equal(r.performanceReceipt.coverage.coveredCount,2);
});

test('PG47指导写入故障整笔回滚，同operation免费重用received，提交回执在新连接恢复无新模型',async t=>{
 const f=fixture(t,{source:'第一句。\n第二句。',segmented:true});f.mock(input=>input.segments.map(s=>({segmentId:s.id,performance:'压低声音但吐字清楚，句末收住。',evidence:'创作建议',evidenceRefs:[],uncertain:false})));const r=await f.run({kind:'director',performanceMode:'fillMissing',autoApply:false}),before=f.rows(),revision=f.rev(),command={id:r.id,draftVersion:r.draftVersion,revision,selected:r.items.map(i=>i.id),operationId:uid()};
 const originalPut=f.store.put.bind(f.store);let writes=0;const failure=t.mock.method(f.store,'put',(table,value,parent)=>{if(table==='segments'&&++writes===2)throw Error('模拟PG登记中断');return originalPut(table,value,parent);});assert.throws(()=>f.a.apply(command),/登记中断/);failure.mock.restore();assert.deepEqual(f.rows(),before);assert.equal(f.rev(),revision);assert.equal(f.store.maybe('settings',`analysis-apply:${command.operationId}`),null);assert.equal(f.store.maybe('settings',`ux-change:${r.id}`),null);assert.equal(f.calls.length,1);
 const applied=f.a.apply(command);assert.equal(applied.performanceReceipt.writtenIds.length,2);const afterRevision=f.rev(),next=openStore(f.dir);try{const domain=createDomain(next),analysis=createAnalysis(next,domain,{key:'mock-test',baseUrl:'https://pg.invalid/v1',model:'seed-audio-1.0'});assert.deepEqual(analysis.apply(command),applied);assert.equal(next.get('chapters',f.c.id).revision,afterRevision);assert.equal(f.calls.length,1);}finally{next.close();}
});

test('PG51多批PG在途暂停：收到第一批仅保留候选，释放全部未发预留且不继续收费',async t=>{
 const f=fixture(t,{source:Array.from({length:60},(_,i)=>`自拟第${i}句，信息清楚。\n`).join('')}),runId=uid(),sessionId=uid();f.store.put('assistantSessions',{id:sessionId,state:'active'},f.p.id);f.store.put('assistantRuns',{id:runId,state:'waitingJobs',sessionId},sessionId);let release;const waiting=new Promise(resolve=>release=resolve);f.mock(async input=>{assert.equal(f.calls.length,1,'暂停后不得派第二批');await waiting;return f.base(input);});
 const r=await f.a.start({chapterId:f.c.id,revision:f.rev(),autoApply:true,grantId:f.grant.grantId},{actorKind:'assistant_delegated',runId,mandateId:uid()});assert.equal(r.batches.length,3);assert.equal(f.store.get('settings',`ux-grant:${f.grant.grantId}`).textReserved,2);f.store.put('assistantRuns',{id:runId,state:'paused',sessionId},sessionId);release();await f.a.close();const final=f.store.get('suggestions',r.id),grant=f.store.get('settings',`ux-grant:${f.grant.grantId}`);assert.equal(grant.textUsed,1);assert.equal(grant.textReserved,0);assert.equal(f.calls.length,1);assert.equal(final.batches[0].status,'received');assert.ok(final.batches.slice(1).every(b=>b.status==='pending'&&b.grantReservation.state==='released'));assert.equal(f.rows().length,0);assert.equal(final.automation.applied,0);
});

test('跨批同新角色key不同name只软置身份待确认，全文和PG免费落库且原响应不改',async t=>{
 const f=fixture(t,{source:Array.from({length:26},(_,i)=>`自拟第${i+1}句，角色站在门前。\n`).join('')}),outputs=[];
 f.mock(input=>{const items=f.base(input).map(x=>({...x,roleId:null,newRoleKey:'person_1',newRole:x.from<24?'甲角':'乙角'}));outputs.push(structuredClone(items));return items;});
 const r=await f.run();assert.equal(f.calls.length,2,'只接收原两批，不付费重发角色请求');assert.equal(r.status,'applied',r.automation?.error);assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.equal(f.rows().length,26);assert.equal(r.performanceReceipt.coverage.coveredCount,26);const identities=f.store.all('roles',f.p.id).filter(role=>!role.narrator);assert.equal(identities.length,2);assert.deepEqual(new Set(identities.map(role=>role.name)),new Set(['甲角','乙角']));assert.ok(identities.every(role=>role.identityPending===true));assert.ok(f.rows().every(s=>s.roleConfirmed===false));assert.ok(r.items.every(i=>i.uncertain===true&&i.roleIssues?.length));assert.ok(r.items.every(i=>!i.issues.length));assert.notEqual(f.rows()[0].roleId,f.rows().at(-1).roleId);
 for(const [index,batch] of r.batches.entries())assert.deepEqual(JSON.parse(JSON.parse(batch.attempts[0].response).choices[0].message.content).items,outputs[index]);
 const bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);const voice={id:uid(),name:'仅选择声音不确认身份',state:'active',revision:1,path:'pending-role-reference.wav'};writeFileSync(join(f.dir,voice.path),bytes);f.store.put('voices',voice);const first=f.rows()[0];f.edit(first.id,{voiceId:voice.id,identityChosen:true});assert.equal(f.store.get('segments',first.id).roleConfirmed,false);
 const worker=createWorker(f.store,f.d,{key:'mock-test',model:'seed-audio-1.0',audioUrl:'https://pg.invalid/v1/audio/speech'});try{await assert.rejects(worker.submit({kind:'generate',chapterId:f.c.id,revision:f.rev(),ids:[first.id],commandId:uid()}),/确认|归属|身份/);assert.equal(f.store.all('jobs').length,0);assert.equal(f.calls.length,2);}finally{await worker.close();}
 const aiContext={actorKind:'assistant_delegated',runId:uid(),operationId:uid(),receiptOwner:'fixture'};assert.throws(()=>f.d.mutate('segment.confirm',{chapterId:f.c.id,revision:f.rev(),ids:[first.id],roleOnly:true},aiContext),/身份|确认|人工|决定/);assert.equal(f.store.get('segments',first.id).roleConfirmed,false,'模型确认动作不能解除pending身份');
});

test('跨批同key同name正常延续、同名不同key保持独立，不因软身份修复按姓名合并',async t=>{
 for(const splitKey of [false,true])await t.test(splitKey?'same-name-different-key':'same-key-same-name',async t=>{
  const f=fixture(t,{source:Array.from({length:26},(_,i)=>`自拟第${i+1}句，人物在门前。\n`).join('')});f.mock(input=>f.base(input).map(x=>({...x,roleId:null,newRoleKey:splitKey&&x.from>=24?'person_2':'person_1',newRole:'同名者'})));const r=await f.run();assert.equal(r.status,'applied',r.automation?.error);assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.equal(f.calls.length,2);assert.equal(new Set(f.rows().map(s=>s.roleId)).size,splitKey?2:1);assert.equal(f.store.all('roles',f.p.id).filter(role=>!role.narrator).length,splitKey?2:1);
 });
});

test('缺角色name只从同稳定key唯一合法定义补全；缺key或全缺使用稳定item身份保持待确认',async t=>{
 const f=fixture(t,{source:'第一句。\n第二句。\n第三句。\n第四句。'}),raw=[];f.mock(input=>{const items=f.base(input).map((x,i)=>({...x,roleId:null,newRoleKey:i===3?'':'person_1',newRole:i===0||i===2?'甲角':''}));items[2].newRoleKey='';raw.push(structuredClone(items));return items;});const r=await f.run();assert.equal(r.status,'applied',r.automation?.error);assert.equal(f.calls.length,1);assert.equal(f.rows().length,4);assert.equal(f.rows()[0].roleId,f.rows()[1].roleId,'同稳定key唯一名字可免费恢复缺name');assert.equal(f.store.get('roles',f.rows()[1].roleId).name,'甲角');assert.notEqual(f.rows()[2].roleId,f.rows()[0].roleId,'缺key不能按同名猜成已有身份');assert.notEqual(f.rows()[3].roleId,f.rows()[2].roleId);assert.ok(f.rows().slice(2).every(s=>s.roleConfirmed===false));assert.ok(r.items.slice(2).every(i=>i.roleIssues?.length&&i.uncertain===true));assert.deepEqual(JSON.parse(JSON.parse(r.batches[0].attempts[0].response).choices[0].message.content).items,raw[0]);
 const next=openStore(f.dir);try{const detail=next.get('suggestions',r.id);assert.deepEqual(detail.items.map(i=>[i.id,i.newRoleKey,i.newRole,i.roleIssues]),r.items.map(i=>[i.id,i.newRoleKey,i.newRole,i.roleIssues]));assert.deepEqual(createDomain(next).list(f.c.id).map(s=>s.roleId),f.rows().map(s=>s.roleId));}finally{next.close();}
});

test('pending角色下轮不进入knownRoles，模型uncertain=false不能自行引用解除，human确认后才可复用',async t=>{
 const f=fixture(t,{source:'第一句。\n第二句。'});f.mock(input=>f.base(input).map((x,i)=>({...x,roleId:null,newRoleKey:'collision',newRole:i?'乙角':'甲角'})));const first=await f.run();assert.equal(first.status,'applied',first.automation?.error);const pending=f.rows()[0],nextChapter=f.d.mutate('chapter.create',{projectId:f.p.id,title:'下一章',source:'后续新句。'}),grant=f.e.grant({grantId:uid(),projectId:f.p.id,chapterId:nextChapter.id,steps:['extract'],materials:['text'],textLimit:2,audioLimit:0});
 f.mock(input=>{assert.ok(!input.roles.some(role=>role.id===pending.roleId),'pending身份不得作为已知人提供');return f.base(input).map(x=>({...x,roleId:pending.roleId,uncertain:false}));});const r=await f.a.start({chapterId:nextChapter.id,revision:f.store.get('chapters',nextChapter.id).revision,autoApply:true,grantId:grant.grantId});await f.a.close();assert.equal(f.store.get('suggestions',r.id).status,'partial');assert.equal(f.d.list(nextChapter.id).length,0);assert.ok(f.store.get('suggestions',r.id).items.some(i=>i.issues.some(issue=>/角色不在/.test(issue))));assert.equal(f.store.get('segments',pending.id).roleConfirmed,false);
 f.d.mutate('segment.confirm',{chapterId:f.c.id,revision:f.rev(),ids:[pending.id],roleOnly:true});assert.equal(f.store.get('segments',pending.id).decisions.role.source,'human');const third=f.d.mutate('chapter.create',{projectId:f.p.id,title:'人类确认后',source:'另一句。'}),humanGrant=f.e.grant({grantId:uid(),projectId:f.p.id,chapterId:third.id,steps:['extract'],materials:['text'],textLimit:2,audioLimit:0});f.mock(input=>{assert.ok(input.roles.some(role=>role.id===pending.roleId),'真实human角色确认后可作为已知身份');return f.base(input).map(x=>({...x,roleId:pending.roleId,uncertain:false}));});const accepted=await f.a.start({chapterId:third.id,revision:1,autoApply:true,grantId:humanGrant.grantId});await f.a.close();assert.equal(f.store.get('suggestions',accepted.id).status,'applied');assert.equal(f.d.list(third.id)[0].roleId,pending.roleId);
});

test('旧received角色错误partial仅免费恢复最新extract，原响应/额度不变且重复恢复不touch',async t=>{
 const f=fixture(t,{source:Array.from({length:27},(_,i)=>`自拟第${i+1}句，角色在门前。\n`).join('')});f.mock(input=>f.base(input).map(x=>({...x,roleId:null,newRoleKey:'collision',newRole:x.from<24?'甲角':'乙角'})));
 const old=await f.run({autoApply:false}),latest=await f.run({autoApply:false});for(const candidate of [old,latest]){candidate.autoApply=true;candidate.status='partial';candidate.gaps=[];candidate.issues=[];candidate.items.forEach(i=>i.issues=[]);candidate.items[24].issues=['同一新角色标识对应不同名称，请统一或另建身份'];f.store.put('suggestions',candidate,f.c.id);}assert.equal(f.rows().length,0);assert.equal(f.calls.length,4);const raw=latest.batches.map(b=>b.attempts.map(a=>a.response)),beforeGrant=f.store.get('settings',`ux-grant:${f.grant.grantId}`),beforeRevision=f.rev();
 f.mock(()=>assert.fail('已收到的角色字段修复禁止再发送模型'));f.a.recover({id:old.id});assert.equal(f.rows().length,0,'旧稿不是最近明确发起的任务，不抢先落库');assert.equal(f.rev(),beforeRevision);f.a.recover({id:latest.id});const recovered=f.store.get('suggestions',latest.id);assert.equal(recovered.status,'applied',recovered.automation?.error);assert.equal(f.rows().length,27);assert.equal(f.rows().map(s=>s.text).join(''),f.c.source);assert.equal(recovered.performanceReceipt.coverage.coveredCount,27);assert.ok(f.rows().every(s=>!s.roleConfirmed&&s.identityPending));assert.deepEqual(recovered.batches.map(b=>b.attempts.map(a=>a.response)),raw);assert.deepEqual(f.store.get('settings',`ux-grant:${f.grant.grantId}`),beforeGrant);assert.equal(f.calls.length,4);const final=f.rows(),revision=f.rev();f.a.recover({id:latest.id});f.a.recover();assert.equal(f.rev(),revision);assert.deepEqual(f.rows(),final);
 const roles=f.store.all('roles',f.p.id),narrator=roles.find(role=>role.narrator);f.edit(final[0].id,{roleId:narrator.id});const direct=f.store.get('segments',final[0].id);assert.equal(direct.roleConfirmed,true,'直接选定真实角色就是一次归属确认');assert.equal(direct.identityPending,false);assert.equal(direct.decisions.role.source,'human');
 const approved=f.d.mutate('segment.confirm',{chapterId:f.c.id,revision:f.rev(),ids:[final[1].id],roleOnly:true},{actorKind:'human_approved_proposal',operationId:uid(),proposalId:uid(),runId:uid(),receiptOwner:'fixture'});assert.ok(approved);const row=f.store.get('segments',final[1].id);assert.equal(row.roleConfirmed,true);assert.equal(row.identityPending,false);assert.equal(row.decisions.role.actorKind,'human_approved_proposal','已有真实具体批准来源同样可一次解除pending，不再追加审批');
});
