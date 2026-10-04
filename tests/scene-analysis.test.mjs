import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createAnalysis} from '../server/analysis.mjs';

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-scene-ai-')),store=openStore(dir),domain=createDomain(store);
  const project=domain.mutate('project.create',{name:'声音事件建议'});
  const chapter=domain.mutate('chapter.create',{projectId:project.id,title:'测试',source:'门外响起两下敲门声。',segment:true});
  const segment=domain.list(chapter.id)[0],unit=domain.enhancement.getUnit(segment.id);
  const native=global.fetch,analysis=createAnalysis(store,domain,{key:'fixture',baseUrl:'https://example.invalid',model:'seed-audio-1.0'});
  t.after(async()=>{await analysis.close();global.fetch=native;store.close();rmSync(dir,{recursive:true,force:true});});
  const start=()=>analysis.start({kind:'scene',sceneEnabled:true,chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,unitId:unit.id,unitRevision:store.get('units',unit.id).revision});
  const change=(action,data)=>domain.mutate(action,{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,unitId:unit.id,entityRevision:store.get('units',unit.id).revision,...data});
  const item={unitId:unit.id,kind:'effect',description:'两下轻敲木门声',memberId:segment.id,position:'during',evidence:'原文明示',evidenceRefs:[0],reason:'原文明示敲门声'};
  const result=items=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items})}}]});
  return {store,domain,project,chapter,segment,unit,analysis,start,change,item,result};
}

test('S03 AI与编辑采用共用1500 Unicode代码点，不截断原返回',async t=>{
  for(const [description,ready] of [['声'.repeat(1500),true],['声'.repeat(1501),false],['声'.repeat(2000),false],['💧'.repeat(1500),true],['💧'.repeat(1501),false]]) await t.test(`${Array.from(description).length}代码点/${description.length}UTF16`,async t=>{
    const {store,chapter,unit,analysis,start,item,result}=setup(t);let calls=0;
    global.fetch=async()=>{calls++;return result([{...item,description}]);};
    const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    assert.equal(draft.status,ready?'ready':'partial');assert.equal(draft.items[0].description,description);
    if(ready){analysis.apply({id:r.id,revision:chapter.revision,draftVersion:draft.draftVersion,selected:[draft.items[0].id]});assert.equal(store.all('events',unit.id)[0].description,description);}
    else {assert.ok(draft.items[0].issues.some(message=>/1500/.test(message)));assert.throws(()=>analysis.apply({id:r.id,revision:chapter.revision,draftVersion:draft.draftVersion,selected:[draft.items[0].id]}));assert.equal(store.all('events',unit.id).length,0);}
    assert.equal(calls,1);
  });
});

test('SC01/SC02 场景建议须明确开启；多选一次采用事件，不改正文或角色',async t=>{
  const {store,chapter,segment,unit,analysis,start,item,result}=setup(t);let calls=0;
  global.fetch=async(_,init)=>{calls++;const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.equal(input.unit.id,unit.id);return result([item,{...item,kind:'environment',description:'安静室内可辨底噪',evidence:'创作建议',evidenceRefs:[]}]);};
  await assert.rejects(analysis.start({kind:'scene',chapterId:chapter.id,revision:chapter.revision,unitId:unit.id,unitRevision:unit.revision}),/明确开启/);
  const r=await start();await analysis.close();const d=store.get('suggestions',r.id);
  assert.equal(d.status,'ready');assert.equal(store.all('events',unit.id).length,0);
  const before=store.get('segments',segment.id);
  analysis.apply({id:d.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:[d.items[0].id]});
  const events=store.all('events',unit.id);assert.equal(events.length,1);assert.equal(events[0].state,'adopted');assert.equal(events[0].description,item.description);
  assert.deepEqual(store.get('segments',segment.id),before);assert.equal(calls,1);
  assert.throws(()=>analysis.apply({id:d.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:[d.items[1].id]}),{status:409});
});

test('SC03 错误单元/同文不同ID锚点不可采用；可校对后一次应用',async t=>{
  const {store,chapter,unit,analysis,start,item,result}=setup(t);
  global.fetch=async()=>result([{...item,memberId:'same-text-other-id'},{...item,unitId:'other-unit'}]);
  const r=await start();await analysis.close();let d=store.get('suggestions',r.id);
  assert.equal(d.status,'partial');assert.ok(d.items.every(i=>i.issues.length));
  assert.throws(()=>analysis.apply({id:r.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:[d.items[0].id]}),/过期/);
  for(const bad of d.items){analysis.edit({id:r.id,draftVersion:d.draftVersion,batchId:bad.batchId,itemId:bad.id,item});d=store.get('suggestions',r.id);}
  assert.equal(d.status,'ready');analysis.apply({id:r.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:d.items.map(i=>i.id)});
  assert.equal(store.all('events',unit.id).length,2);
});

test('SC03 上下文与单元修订变化拒绝过期建议，空事件结果不虚构事件',async t=>{
  const {store,project,unit,analysis,start,item,result}=setup(t);
  global.fetch=async()=>result([]);const empty=await start();await analysis.close();assert.equal(store.get('suggestions',empty.id).status,'ready');assert.equal(store.all('events',unit.id).length,0);
  global.fetch=async()=>result([item]);const r=await start();await analysis.close();const d=store.get('suggestions',r.id);
  const p=store.get('projects',project.id);p.contextRevision++;store.put('projects',p);
  assert.throws(()=>analysis.resume({id:d.id,draftVersion:d.draftVersion,replace:true,batchIds:[d.batches[0].id]}),{status:409});
  p.contextRevision--;store.put('projects',p);const u=store.get('units',unit.id);u.revision++;store.put('units',u,u.chapterId);
  assert.throws(()=>analysis.resume({id:d.id,draftVersion:d.draftVersion,replace:true,batchIds:[d.batches[0].id]}),{status:409});assert.equal(store.all('events',unit.id).length,0);
});

test('F3 逆序持续建议与旧ready草稿均不可采用；本地校对保留起止位置且零重分析',async t=>{
  const {store,chapter,segment,unit,analysis,start,item,result}=setup(t);let calls=0;
  global.fetch=async()=>{calls++;return result(['environment','music'].map(kind=>({...item,kind,evidence:'创作建议',evidenceRefs:[],startMemberId:segment.id,endMemberId:segment.id,startPosition:'after',endPosition:'before'})));};
  const r=await start();await analysis.close();let d=store.get('suggestions',r.id);
  assert.equal(d.status,'partial');assert.ok(d.items.every(i=>i.issues.some(message=>/范围|顺序/.test(message))));
  // Simulate a ready draft persisted by the previous release: apply must revalidate it.
  d.status='ready';d.items.forEach(i=>i.issues=[]);store.put('suggestions',d,chapter.id);
  assert.throws(()=>analysis.apply({id:r.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:d.items.map(i=>i.id)}),{status:409});
  assert.equal(store.all('events',unit.id).length,0);
  for(const bad of d.items){analysis.edit({id:r.id,draftVersion:d.draftVersion,batchId:bad.batchId,itemId:bad.id,item:{startPosition:'before',endPosition:'after'}});d=store.get('suggestions',r.id);}
  assert.equal(d.status,'ready');analysis.apply({id:r.id,revision:chapter.revision,draftVersion:d.draftVersion,selected:d.items.map(i=>i.id)});
  const events=store.all('events',unit.id);assert.equal(events.length,2);assert.ok(events.every(e=>e.startPosition==='before'&&e.endPosition==='after'));assert.equal(calls,1);
});

test('NAT-06/C11 场景建议发送整体指导、场景修订、真实声音观察及已采用/移除事件；空结果只是不新增',async t=>{
  const {store,project,segment,unit,analysis,start,change,result}=setup(t);let calls=0,request;
  const observations={tone:'低沉男声',accent:'普通话',performance:'平静',volume:'正常'};
  store.put('voices',{id:'scene-reference',name:'实际参考',observations});
  const row=store.get('segments',segment.id);Object.assign(row,{voiceId:'scene-reference',performance:'叙述清楚、节奏自然',protectedFields:['performance']});store.put('segments',row,row.chapterId);
  const role=store.get('roles',row.roleId);role.voiceId='different-role-default';store.put('roles',role,project.id);
  const guidance='门声清楚可辨；音乐有可听出的旋律，随后转为宁静，不刻意压低背景。';
  change('unit.update',{mode:'scene',guidance});
  const adopted=change('event.create',{kind:'music',description:'宁静器乐旋律',memberId:segment.id,position:'during',startMemberId:segment.id,endMemberId:segment.id,startPosition:'before',endPosition:'after',state:'adopted'});
  const removed=change('event.create',{kind:'environment',description:'车流声',memberId:segment.id,position:'during',state:'adopted'});
  change('event.remove',{eventId:removed.id,eventRevision:removed.revision});
  change('event.create',{kind:'effect',description:'尚未采用的脚步草稿',memberId:segment.id,position:'before',state:'draft'});
  const before=store.all('events',unit.id),current=store.get('units',unit.id);
  global.fetch=async(_,init)=>{calls++;request=JSON.parse(init.body);return result([]);};
  const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),input=JSON.parse(request.messages[1].content);
  assert.deepEqual(input.unit,{id:unit.id,members:[segment.id],mode:'scene',guidance,backgroundPresence:current.variants.scene.backgroundPresence??'clear',revision:current.variants.scene.revision});
  assert.equal(draft.sceneGuidance,guidance);assert.equal(draft.sceneRevision,current.variants.scene.revision);
  assert.equal(input.segments[0].voiceId,'scene-reference');assert.deepEqual(input.segments[0].referenceObservations,observations);assert.deepEqual(input.segments[0].protectedFields,['performance']);assert.equal(input.segments[0].performance,row.performance);
  assert.equal(input.roles.find(r=>r.id===row.roleId).voiceId,'different-role-default');
  assert.equal(input.events.length,2);assert.deepEqual(input.events.find(e=>e.id===adopted.id),before.find(e=>e.id===adopted.id));assert.equal(input.events.find(e=>e.id===removed.id).state,'removed');assert.ok(input.events.every(e=>Number.isInteger(e.revision)));
  assert.match(request.messages[0].content,/整体场景创作意图/);assert.match(request.messages[0].content,/removed.*不得再次建议/);assert.match(request.messages[0].content,/空列表只表示.*新增/);assert.doesNotMatch(request.messages[0].content,/当前制作模式固定为逐条干声/);
  assert.equal(draft.status,'ready');assert.deepEqual(draft.items,[]);assert.deepEqual(store.all('events',unit.id),before);assert.equal(store.get('units',unit.id).variants.scene.guidance,guidance);assert.equal(calls,1);
});

test('C18 分析等待期间修改scene共同指导，旧建议不能采用或继续重试；人工表演和新指导保留',async t=>{
  const {store,chapter,segment,unit,analysis,start,change,item,result}=setup(t);let release,calls=0;
  change('unit.update',{mode:'scene',guidance:'背景正常、清楚可辨'});
  global.fetch=async()=>{calls++;return new Promise(resolve=>{release=()=>resolve(result([item]));});};
  const r=await start();assert.equal(calls,1);
  change('unit.update',{mode:'scene',guidance:'音乐渐强，门声出现时保持清楚'});
  const before=store.get('segments',segment.id);release();await analysis.close();const draft=store.get('suggestions',r.id),revision=store.get('chapters',chapter.id).revision;
  assert.equal(draft.sceneGuidance,'背景正常、清楚可辨');assert.equal(draft.status,'ready');
  assert.throws(()=>analysis.apply({id:r.id,revision,draftVersion:draft.draftVersion,selected:[draft.items[0].id]}),{status:409});
  assert.throws(()=>analysis.resume({id:r.id,draftVersion:draft.draftVersion,replace:true,batchIds:[draft.batches[0].id]}),{status:409});
  assert.equal(store.get('units',unit.id).variants.scene.guidance,'音乐渐强，门声出现时保持清楚');assert.deepEqual(store.get('segments',segment.id),before);assert.deepEqual(store.all('events',unit.id),[]);assert.equal(calls,1);
});

test('C20 普通extract与dry导演保持原纯人声政策，不附scene共同指导或声音事件',async t=>{
  const {store,chapter,segment,unit,analysis,change,result}=setup(t);const requests=[];
  change('unit.update',{mode:'scene',guidance:'音乐要明显'});
  change('event.create',{kind:'music',description:'器乐旋律',memberId:segment.id,position:'during',state:'adopted'});
  global.fetch=async(_,init)=>{const request=JSON.parse(init.body);requests.push(request);return result(requests.length===1?[{from:0,to:0,roleId:segment.roleId,type:'narration',performance:'自然叙述',evidence:'创作建议',evidenceRefs:[],reason:'保持自然',uncertain:false}]:[{segmentId:segment.id,performance:'自然叙述',evidence:'创作建议',evidenceRefs:[],reason:'保持自然',uncertain:false}]);};
  for(const kind of ['extract','director']) {const r=await analysis.start({kind,chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision});await analysis.close();assert.equal(store.get('suggestions',r.id).status,'ready');}
  for(const request of requests) {const input=JSON.parse(request.messages[1].content);assert.match(request.messages[0].content,/当前制作模式固定为逐条干声/);assert.match(request.messages[0].content,/不允许提出环境、音效或音乐/);assert.equal(input.unit,undefined);assert.equal(input.events,undefined);}
  assert.equal(requests.length,2);assert.equal(store.get('units',unit.id).variants.scene.guidance,'音乐要明显');assert.equal(store.all('events',unit.id).length,1);
});

const reusePayload=(store,chapter,unit,draft,selected=draft.items.map(i=>i.id))=>({id:draft.id,draftVersion:draft.draftVersion,chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,unitId:unit.id,unitRevision:store.get('units',unit.id).revision,selected});

test('历史背景建议按当前版本免费复用，保留现有指导、事件和原建议；普通采用仍拒绝旧版本',async t=>{
  const {store,chapter,segment,unit,analysis,start,change,item,result}=setup(t);let calls=0;
  global.fetch=async()=>{calls++;return result([item]);};
  const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
  change('unit.update',{mode:'scene',guidance:'音乐从明快变为宁静，门声保持清楚'});
  const event=change('event.create',{kind:'music',description:'由明快转为宁静的旋律',memberId:segment.id,position:'during',state:'adopted'}),unrelated=store.get('events',event.id),before=store.get('segments',segment.id);
  const p=reusePayload(store,chapter,unit,draft);
  assert.throws(()=>analysis.apply({id:r.id,revision:p.revision,draftVersion:draft.draftVersion,selected:p.selected}),{status:409});
  const receipt=analysis.reuse(p),events=store.all('events',unit.id),added=events.find(e=>receipt.addedEventIds.includes(e.id));
  assert.equal(receipt.addedCount,1);assert.deepEqual(receipt.skippedItemIds,[]);assert.equal(events.length,2);
  assert.equal(added.description,item.description);assert.equal(added.evidence.suggestionId,draft.id);assert.equal(added.evidence.itemId,draft.items[0].id);
  assert.deepEqual(store.get('events',unrelated.id),unrelated);assert.deepEqual(store.get('segments',segment.id),before);
  assert.equal(store.get('units',unit.id).variants.scene.guidance,'音乐从明快变为宁静，门声保持清楚');assert.deepEqual(store.get('suggestions',r.id),draft);
  assert.equal(receipt.chapterRevision,store.get('chapters',chapter.id).revision);assert.equal(receipt.unitRevision,store.get('units',unit.id).revision);assert.equal(calls,1);
});

test('applied历史中removed与draft明确复制，原事件不改；有效相同事件重复点击零新增零修订',async t=>{
  for(const state of ['removed','draft']) await t.test(state,async t=>{
    const {store,chapter,unit,analysis,start,change,item,result}=setup(t);let calls=0;
    global.fetch=async()=>{calls++;return result([item]);};const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    analysis.apply({id:r.id,revision:chapter.revision,draftVersion:draft.draftVersion,selected:[draft.items[0].id]});
    const original=store.all('events',unit.id)[0];
    change(state==='removed'?'event.remove':'event.update',{eventId:original.id,eventRevision:original.revision,...(state==='draft'?{state}: {})});
    const old=store.get('events',original.id),history=store.get('suggestions',r.id),receipt=analysis.reuse(reusePayload(store,chapter,unit,history));
    assert.equal(receipt.addedCount,1);assert.notEqual(receipt.addedEventIds[0],original.id);assert.deepEqual(store.get('events',original.id),old);
    const p=reusePayload(store,chapter,unit,history),c=store.get('chapters',chapter.id),u=store.get('units',unit.id),events=store.all('events',unit.id);
    const repeat=analysis.reuse(p);assert.equal(repeat.addedCount,0);assert.deepEqual(repeat.skippedItemIds,[draft.items[0].id]);
    assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.deepEqual(store.all('events',unit.id),events);assert.deepEqual(store.get('suggestions',r.id),history);assert.equal(calls,1);
  });
});

test('历史复用判重按实际内容与当前有效性，跨来源默认范围可跳过；已改描述/位置或失效事件不冒充原建议',async t=>{
  for(const variation of ['other-source','description','position','needsReview']) await t.test(variation,async t=>{
    const {store,chapter,segment,unit,analysis,start,change,item,result}=setup(t);
    global.fetch=async()=>result([{...item,startMemberId:segment.id,endMemberId:segment.id}]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    const event=change('event.create',{kind:item.kind,description:variation==='description'?'三下急促敲门声':item.description,memberId:segment.id,position:variation==='position'?'before':item.position,startMemberId:segment.id,endMemberId:segment.id,startPosition:'before',endPosition:'after',state:'adopted'});
    const old=store.get('events',event.id);old.evidence.suggestionId=variation==='other-source'?'other-history':draft.id;old.evidence.itemId=variation==='other-source'?'other-item':draft.items[0].id;
    if(variation==='needsReview')old.needsReview=true;store.put('events',old,unit.id);
    const receipt=analysis.reuse(reusePayload(store,chapter,unit,draft));assert.equal(receipt.addedCount,variation==='other-source'?0:1);
    assert.deepEqual(store.get('events',old.id),old);assert.deepEqual(receipt.skippedItemIds,variation==='other-source'?[draft.items[0].id]:[]);
  });
});

test('partial历史只复用所选合法项，不必重新分析；被选错误项拒绝且无部分写入',async t=>{
  const {store,chapter,unit,analysis,start,item,result}=setup(t);let calls=0;
  global.fetch=async()=>{calls++;return result([item,{...item,description:'声'.repeat(1501)}]);};const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
  assert.equal(draft.status,'partial');const p=reusePayload(store,chapter,unit,draft);
  assert.throws(()=>analysis.reuse(p),{status:409});assert.equal(store.all('events',unit.id).length,0);assert.equal(store.get('chapters',chapter.id).revision,p.revision);
  const receipt=analysis.reuse({...p,selected:[draft.items[0].id]});assert.equal(receipt.addedCount,1);assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
});

test('历史复用拒绝当前版本竞争、跨章跨单元、草稿改变及不可用状态，均零写入',async t=>{
  const cases=[['chapter race',p=>({...p,revision:p.revision-1})],['unit race',p=>({...p,unitRevision:p.unitRevision-1})],['other chapter',p=>({...p,chapterId:'other'})],['other unit',p=>({...p,unitId:'other'})],['draft race',p=>({...p,draftVersion:p.draftVersion-1})],['unknown item',p=>({...p,selected:['other-item']})],['empty selection',p=>({...p,selected:[]})]];
  for(const [name,modify] of cases) await t.test(name,async t=>{
    const {store,chapter,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),p=reusePayload(store,chapter,unit,draft);
    assert.throws(()=>analysis.reuse(modify(p)),error=>[400,409].includes(error.status));assert.equal(store.all('events',unit.id).length,0);assert.equal(store.get('chapters',chapter.id).revision,p.revision);assert.equal(store.get('units',unit.id).revision,p.unitRevision);assert.deepEqual(store.get('suggestions',r.id),draft);
  });
  for(const status of ['running','unknown','failed']) await t.test(status,async t=>{
    const {store,chapter,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);draft.status=status;store.put('suggestions',draft,chapter.id);
    assert.throws(()=>analysis.reuse(reusePayload(store,chapter,unit,draft)),{status:409});assert.equal(store.all('events',unit.id).length,0);assert.deepEqual(store.get('suggestions',r.id),draft);
  });
  for(const blocked of ['retired','dissolved','active job']) await t.test(blocked,async t=>{
    const {store,chapter,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    if(blocked==='active job')store.put('jobs',{id:'isolated-active-job',chapterId:chapter.id,status:'running'},chapter.id);
    else {const current=store.get('units',unit.id);current.state=blocked;store.put('units',current,chapter.id);}
    const c=store.get('chapters',chapter.id),u=store.get('units',unit.id);
    assert.throws(()=>analysis.reuse(reusePayload(store,chapter,unit,draft)),{status:409});assert.equal(store.all('events',unit.id).length,0);assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);
  });
});

test('历史复用完整校验当前成员、单元、位置、范围、长度和引文，已有同内容也不能绕过',async t=>{
  const cases=[['member retired',()=>{},(store,segment)=>{const row=store.get('segments',segment.id);row.retired=true;store.put('segments',row,row.chapterId);}],['wrong unit',i=>{i.unitId='other-unit';}],['wrong member',i=>{i.memberId='missing-member';}],['wrong position',i=>{i.position='invalid';}],['reverse range',(i,segment)=>Object.assign(i,{startMemberId:segment.id,endMemberId:segment.id,startPosition:'after',endPosition:'before'})],['long description',i=>{i.description='💧'.repeat(1501);}],['missing current quote',()=>{},(store,segment,chapter)=>{const c=store.get('chapters',chapter.id);c.source='当前正文不再包含原引文。';store.put('chapters',c,c.projectId);}]];
  for(const [name,modify,changeCurrent] of cases) await t.test(name,async t=>{
    const {store,chapter,segment,unit,analysis,start,change,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    change('event.create',{kind:item.kind,description:item.description,memberId:segment.id,position:item.position,state:'adopted'});
    modify(draft.batches[0].items[0],segment);store.put('suggestions',draft,chapter.id);changeCurrent?.(store,segment,chapter);
    const p=reusePayload(store,chapter,unit,draft),c=store.get('chapters',chapter.id),u=store.get('units',unit.id),events=store.all('events',unit.id);
    assert.throws(()=>analysis.reuse(p),error=>[400,409].includes(error.status));assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.deepEqual(store.all('events',unit.id),events);assert.deepEqual(store.get('suggestions',r.id),draft);
  });
});

test('历史复用批内写入失败整笔回滚，不留下首项或修订变化',async t=>{
  const {store,chapter,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item,{...item,description:'更缓慢的轻敲声',position:'before'}]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),p=reusePayload(store,chapter,unit,draft);
  const c=store.get('chapters',chapter.id),u=store.get('units',unit.id),put=store.put;let writes=0;
  store.put=(table,...args)=>{if(table==='events'&&++writes===2)throw new Error('isolated second event failure');return put(table,...args);};
  assert.throws(()=>analysis.reuse(p),/isolated second event failure/);store.put=put;
  assert.equal(writes,2);assert.deepEqual(store.all('events',unit.id),[]);assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.deepEqual(store.get('suggestions',r.id),draft);
});

test('无batches旧历史的孤立结束锚点在映射前拒绝，不退化为单点事件',async t=>{
  const {store,chapter,segment,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
  delete draft.batches;draft.items[0].endMemberId=segment.id;store.put('suggestions',draft,chapter.id);
  const c=store.get('chapters',chapter.id),u=store.get('units',unit.id);
  assert.throws(()=>analysis.reuse(reusePayload(store,chapter,unit,draft)),{status:400});
  assert.deepEqual(store.all('events',unit.id),[]);assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.deepEqual(store.get('suggestions',r.id),draft);
});

test('场景建议冻结并实际发送用户背景存在感，旧缺省按clear，显式unspecified保持',async t=>{
  for(const presence of [undefined,'clear','natural','subtle','unspecified']) await t.test(presence??'legacy default',async t=>{
    const {store,unit,analysis,start,change,result}=setup(t);let request,calls=0;
    if(presence===undefined){const current=store.get('units',unit.id);delete current.variants.scene.backgroundPresence;store.put('units',current,current.chapterId);}
    else change('unit.update',{mode:'scene',backgroundPresence:presence});
    global.fetch=async(_,init)=>{calls++;request=JSON.parse(init.body);return result([]);};const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),input=JSON.parse(request.messages[1].content);
    assert.equal(draft.sceneBackgroundPresence,presence??'clear');assert.equal(input.unit.backgroundPresence,presence??'clear');assert.equal(draft.status,'ready');assert.equal(calls,1);
    assert.match(request.messages[0].content,/unit\.backgroundPresence/);for(const value of ['clear','natural','subtle','unspecified'])assert.ok(request.messages[0].content.includes(value));
  });
});

test('clear相反的AI新建议保留原描述并逐项标问题，合法子集可免费加入且不重分析',async t=>{
  const {store,chapter,unit,analysis,start,item,result}=setup(t);let calls=0;
  const quiet='极微弱，几乎不可闻的音乐';global.fetch=async()=>{calls++;return result([{...item,kind:'music',description:quiet,backgroundPresence:'subtle',state:'removed'},{...item,kind:'music',description:'宁静且旋律清楚可辨'}]);};
  const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
  assert.equal(draft.sceneBackgroundPresence,'clear');assert.equal(draft.status,'partial');assert.equal(draft.items[0].description,quiet);assert.ok(draft.items[0].issues.length);assert.deepEqual(draft.items[1].issues,[]);
  assert.throws(()=>analysis.reuse(reusePayload(store,chapter,unit,draft)),{status:409});assert.equal(store.all('events',unit.id).length,0);
  const receipt=analysis.reuse(reusePayload(store,chapter,unit,draft,[draft.items[1].id]));assert.equal(receipt.addedCount,1);assert.equal(store.all('events',unit.id)[0].description,'宁静且旋律清楚可辨');assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
});

test('分析期间改变presence不改已发送冻结clear结果；历史在当前subtle下重新核对可免费复用',async t=>{
  const {store,chapter,unit,analysis,start,change,item,result}=setup(t);let calls=0,release,request;
  global.fetch=async(_,init)=>{calls++;request=JSON.parse(init.body);return new Promise(resolve=>{release=()=>resolve(result([{...item,kind:'music',description:'极微弱，几乎不可闻的音乐'}]));});};
  const r=await start();change('unit.update',{mode:'scene',backgroundPresence:'subtle'});release();await analysis.close();const draft=store.get('suggestions',r.id);
  assert.equal(draft.sceneBackgroundPresence,'clear');assert.equal(JSON.parse(request.messages[1].content).unit.backgroundPresence,'clear');assert.equal(draft.status,'partial');assert.ok(draft.items[0].issues.length);
  const receipt=analysis.reuse(reusePayload(store,chapter,unit,draft));assert.equal(receipt.addedCount,1);assert.equal(store.get('units',unit.id).variants.scene.backgroundPresence,'subtle');assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
});

test('旧无presence历史仍可查看与复用；当前clear重验且已有相同采纳事件不能绕过冲突',async t=>{
  for(const includeExisting of [false,true]) await t.test(includeExisting?'existing adopted':'no event',async t=>{
    const {store,chapter,unit,analysis,start,change,item,result}=setup(t);let calls=0;
    change('unit.update',{mode:'scene',backgroundPresence:'unspecified'});global.fetch=async()=>{calls++;return result([{...item,kind:'music',description:'极微弱，几乎不可闻的音乐'},item]);};
    const r=await start();await analysis.close();let draft=store.get('suggestions',r.id);assert.equal(draft.status,'ready');
    if(includeExisting)analysis.apply({id:r.id,revision:store.get('chapters',chapter.id).revision,draftVersion:draft.draftVersion,selected:[draft.items[0].id]});
    draft=store.get('suggestions',r.id);delete draft.sceneBackgroundPresence;if(includeExisting)delete draft.batches;store.put('suggestions',draft,chapter.id);change('unit.update',{mode:'scene',backgroundPresence:'clear'});
    const p=reusePayload(store,chapter,unit,draft,[draft.items[0].id]),c=store.get('chapters',chapter.id),u=store.get('units',unit.id),events=store.all('events',unit.id);
    assert.throws(()=>analysis.reuse(p),{status:409});assert.deepEqual(store.all('events',unit.id),events);assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.deepEqual(store.get('suggestions',r.id),draft);
    assert.equal(analysis.reuse({...p,selected:[draft.items[1].id]}).addedCount,1);assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
  });
});

test('已采纳声音与clear冲突只列核对问题，removed不再建议；空结果不改变任何事件或指导',async t=>{
  const {store,chapter,segment,unit,analysis,start,change,result}=setup(t);let calls=0,request;
  change('unit.update',{mode:'scene',guidance:'保留用户确定的现有声音'});
  change('event.create',{kind:'music',description:'极微弱，几乎不可闻的音乐',memberId:segment.id,position:'during',state:'adopted'});
  const removed=change('event.create',{kind:'environment',description:'极微弱的室外环境声',memberId:segment.id,position:'during',state:'adopted'});change('event.remove',{eventId:removed.id,eventRevision:removed.revision});
  const events=store.all('events',unit.id),current=store.get('units',unit.id),c=store.get('chapters',chapter.id);
  global.fetch=async(_,init)=>{calls++;request=JSON.parse(init.body);return result([]);};const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),input=JSON.parse(request.messages[1].content);
  assert.deepEqual(draft.items,[]);assert.ok(draft.issues.some(issue=>/音乐/.test(issue)));assert.ok(draft.issues.every(issue=>!/环境/.test(issue)));assert.equal(draft.status,'partial');assert.deepEqual(input.events,events);
  assert.deepEqual(store.all('events',unit.id),events);assert.deepEqual(store.get('units',unit.id),current);assert.deepEqual(store.get('chapters',chapter.id),c);assert.match(request.messages[0].content,/不改写、弱化、复制替换或恢复已有声音/);assert.equal(calls,1);
});

test('自然和轻的新建议沿共享规则标冲突，显式未设置保持原描述且不增加音量政策',async t=>{
  for(const [presence,description,expected] of [['natural','极微弱，几乎不可闻的音乐','partial'],['subtle','音乐响亮压过人声','partial'],['unspecified','极微弱，几乎不可闻的音乐','ready']]) await t.test(presence,async t=>{
    const {store,analysis,unit,start,change,item,result}=setup(t);let calls=0;change('unit.update',{mode:'scene',backgroundPresence:presence});
    global.fetch=async()=>{calls++;return result([{...item,kind:'music',description}]);};const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    assert.equal(draft.status,expected);assert.equal(draft.items[0].description,description);assert.equal(!!draft.items[0].issues.length,expected==='partial');assert.equal(store.get('units',unit.id).variants.scene.backgroundPresence,presence);assert.equal(calls,1);
  });
});

test('旧无presence批次明确重分析时冻结当前选择并实际发送，免费历史未被提前改写',async t=>{
  for(const presence of [undefined,'subtle','unspecified']) await t.test(presence??'legacy default',async t=>{
    const {store,analysis,unit,start,change,result}=setup(t);const requests=[];
    if(presence===undefined){const current=store.get('units',unit.id);delete current.variants.scene.backgroundPresence;store.put('units',current,current.chapterId);}
    else change('unit.update',{mode:'scene',backgroundPresence:presence});
    global.fetch=async(_,init)=>{requests.push(JSON.parse(init.body));return result([]);};const r=await start();await analysis.close();const old=store.get('suggestions',r.id);delete old.sceneBackgroundPresence;store.put('suggestions',old,old.chapterId);
    assert.equal(store.get('suggestions',r.id).sceneBackgroundPresence,undefined);
    analysis.resume({id:old.id,draftVersion:old.draftVersion,replace:true,batchIds:[old.batches[0].id]});await analysis.close();const next=store.get('suggestions',r.id);
    assert.equal(next.sceneBackgroundPresence,presence??'clear');assert.equal(JSON.parse(requests[1].messages[1].content).unit.backgroundPresence,presence??'clear');assert.equal(next.status,'ready');assert.equal(requests.length,2);
    assert.deepEqual(next.batches[0].attempts[0],old.batches[0].attempts[0]);
  });
});

test('H01免费预检在当前subtle核对旧clear问题，保留历史且正式复用只加入一次',async t=>{
  const {store,chapter,unit,analysis,start,change,item,result}=setup(t);let calls=0;
  global.fetch=async()=>{calls++;return result([{...item,kind:'music',description:'极微弱，几乎不可闻的音乐'}]);};
  const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);assert.ok(draft.items[0].issues.length);
  change('unit.update',{mode:'scene',backgroundPresence:'subtle'});
  const p=reusePayload(store,chapter,unit,draft),before={c:store.get('chapters',chapter.id),u:store.get('units',unit.id),events:store.all('events',unit.id)};
  const preview=analysis.previewReuse(p),row=preview.items[0];
  assert.deepEqual(row.historicalIssues,draft.items[0].issues);assert.deepEqual(row.currentIssues,[]);assert.equal(row.canReuse,true);assert.equal(row.alreadyIncluded,false);
  assert.equal(preview.target.chapterRevision,p.revision);assert.equal(preview.target.unitRevision,p.unitRevision);
  assert.deepEqual(store.get('chapters',chapter.id),before.c);assert.deepEqual(store.get('units',unit.id),before.u);assert.deepEqual(store.all('events',unit.id),before.events);assert.deepEqual(store.get('suggestions',r.id),draft);
  assert.equal(analysis.reuse(p).addedCount,1);const again=reusePayload(store,chapter,unit,draft);
  assert.equal(analysis.previewReuse(again).items[0].alreadyIncluded,true);assert.equal(analysis.reuse(again).addedCount,0);assert.equal(store.all('events',unit.id).length,1);assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
});

test('H01免费预检用当前clear与指导区分合法项，旧subtle结论不豁免正式复用',async t=>{
  const {store,chapter,unit,analysis,start,change,item,result}=setup(t);let calls=0;
  change('unit.update',{mode:'scene',backgroundPresence:'subtle'});global.fetch=async()=>{calls++;return result([{...item,kind:'music',description:'极微弱，几乎不可闻的音乐'},item]);};
  const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);assert.deepEqual(draft.items[0].issues,[]);change('unit.update',{mode:'scene',backgroundPresence:'clear'});
  const p=reusePayload(store,chapter,unit,draft),preview=analysis.previewReuse(p);
  assert.equal(preview.items[0].canReuse,false);assert.ok(preview.items[0].currentIssues.length);assert.equal(preview.items[1].canReuse,true);assert.throws(()=>analysis.reuse(p),{status:409});assert.equal(store.all('events',unit.id).length,0);
  assert.equal(analysis.reuse({...p,selected:[draft.items[1].id]}).addedCount,1);change('unit.update',{mode:'scene',guidance:'背景全程几乎不可闻'});
  const checked=analysis.previewReuse(reusePayload(store,chapter,unit,draft));assert.ok(checked.items.every(i=>!i.canReuse&&i.currentIssues.length));assert.deepEqual(store.get('suggestions',r.id),draft);assert.equal(calls,1);
});

test('H01免费预检拒绝当前失效成员、引文和范围；历史与未选项目保持完整',async t=>{
  for(const invalid of ['member','quote','range','length'])await t.test(invalid,async t=>{
    const {store,chapter,segment,unit,analysis,start,item,result}=setup(t);global.fetch=async()=>result([item,{...item,position:'before'}]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
    if(invalid==='member'){const current=store.get('segments',segment.id);current.retired=true;store.put('segments',current,chapter.id);}
    if(invalid==='quote'){const current=store.get('chapters',chapter.id);current.source='当前原文没有对应引文。';store.put('chapters',current,current.projectId);}
    if(invalid==='range')Object.assign(draft.batches[0].items[0],{startMemberId:segment.id,endMemberId:segment.id,startPosition:'after',endPosition:'before'});
    if(invalid==='length')draft.batches[0].items[0].description='💧'.repeat(1501);
    store.put('suggestions',draft,chapter.id);const p=reusePayload(store,chapter,unit,draft),c=store.get('chapters',chapter.id),u=store.get('units',unit.id);
    const preview=analysis.previewReuse(p);assert.equal(preview.items[0].canReuse,false);assert.ok(preview.items[0].currentIssues.length);assert.throws(()=>analysis.reuse(p),error=>[400,409].includes(error.status));
    assert.deepEqual(store.get('suggestions',r.id),draft);assert.deepEqual(store.get('chapters',chapter.id),c);assert.deepEqual(store.get('units',unit.id),u);assert.equal(store.all('events',unit.id).length,0);
    if(['range','length'].includes(invalid))assert.equal(preview.items[1].canReuse,true,'单项错误不禁用合法候选');
  });
});

test('H01免费预检后presence或内容更新使旧版本不可提交，无部分写入',async t=>{
  for(const action of ['presence','guidance','source'])await t.test(action,async t=>{
    const {store,domain,chapter,unit,analysis,start,change,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id),p=reusePayload(store,chapter,unit,draft);
    assert.equal(analysis.previewReuse(p).items[0].canReuse,true);
    if(action==='source'){const c=store.get('chapters',chapter.id);c.source='新原文。';c.sourceVersion=(c.sourceVersion||1)+1;domain.touch(c,true,false);}
    else change('unit.update',{mode:'scene',...(action==='presence'?{backgroundPresence:'subtle'}:{guidance:'背景清楚且保持正文清晰'})});
    assert.throws(()=>analysis.reuse(p),{status:409});assert.throws(()=>analysis.previewReuse(p),{status:409});assert.equal(store.all('events',unit.id).length,0);assert.deepEqual(store.get('suggestions',r.id),draft);
  });
});

test('H01免费预检共享不确定提醒不作硬阻断，正式复用不改历史说明',async t=>{
  const {store,chapter,unit,analysis,start,change,item,result}=setup(t);global.fetch=async()=>result([item]);const r=await start();await analysis.close();const draft=store.get('suggestions',r.id);
  change('unit.update',{mode:'scene',guidance:'听不清'});const p=reusePayload(store,chapter,unit,draft),preview=analysis.previewReuse(p);
  assert.deepEqual(preview.items[0].currentIssues,[]);assert.ok(preview.items[0].warnings.length);assert.equal(preview.items[0].canReuse,true);assert.equal(analysis.reuse(p).addedCount,1);assert.deepEqual(store.get('suggestions',r.id),draft);
});
