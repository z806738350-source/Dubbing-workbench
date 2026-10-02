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
  const item={unitId:unit.id,kind:'effect',description:'两下轻敲木门声',memberId:segment.id,position:'during',evidence:'原文明示',evidenceRefs:[0],reason:'原文明示敲门声'};
  const result=items=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items})}}]});
  return {store,domain,project,chapter,segment,unit,analysis,start,item,result};
}

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
