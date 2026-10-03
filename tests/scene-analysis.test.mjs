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
  global.fetch=async(_,init)=>{calls++;const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.equal(input.unit.id,unit.id);return result([item,{...item,kind:'environment',description:'安静室内微弱底噪',evidence:'创作建议',evidenceRefs:[]}]);};
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
  assert.deepEqual(input.unit,{id:unit.id,members:[segment.id],mode:'scene',guidance,revision:current.variants.scene.revision});
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
