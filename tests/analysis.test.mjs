import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createAnalysis, sourceBlocks} from '../server/analysis.mjs';

function setup(t, source='  他停步。\n\n“你好。”\n\n她回头。😀') {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-analysis-')), store=openStore(dir), domain=createDomain(store);
  const project=domain.mutate('project.create',{name:'校对测试'}), c=domain.mutate('chapter.create',{projectId:project.id,title:'第一章',source});
  const a=createAnalysis(store,domain,{key:'test',baseUrl:'https://example.invalid'}), native=global.fetch;
  t.after(()=>{global.fetch=native;store.close();rmSync(dir,{recursive:true,force:true});});
  const get=id=>store.get('suggestions',id);
  // These inherited assertions cover legacy batching/replay. PG sizing and repair have their own behavioral coverage.
  const start=()=>a.start({chapterId:c.id,revision:store.get('chapters',c.id).revision,includePerformance:false});
  const rows=input=>input.blocks.map(b=>({from:b.id,to:b.id,roleId:input.roles[0].id,type:'narration',performance:'自然',evidence:'原文明示',evidenceRefs:[b.id],reason:'原文',uncertain:false}));
  const result=items=>Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items})}}]});
  return {store,domain,project,c,a,get,start,rows,result};
}
const input=init=>JSON.parse(JSON.parse(init.body).messages[1].content);
const longSource=Array.from({length:130},(_,i)=>`${i} ${'章节原文'.repeat(50)}。\n`).join('');

test('空白不独立成块，Unicode 正文和偏移逐字保留',()=>{
  const source='  \n他😀停步。\n\n“你好。”\n  ', blocks=sourceBlocks(source);
  assert.equal(blocks.map(b=>b.text).join(''),source);
  assert.ok(blocks.every(b=>b.text.trim()));
  for(const b of blocks) assert.equal(Array.from(source).slice(b.start,b.end).join(''),b.text);
});
test('局部错误保留有效标注，校对零调用，草稿冲突与明确采用',async t=>{
  const {a,start,get,rows,result,domain,c}=setup(t);let calls=0;
  global.fetch=async(_,init)=>{calls++;const items=rows(input(init));items[1].evidenceRefs=[999];return result(items);};
  const r=await start();await a.close();const partial=get(r.id);
  assert.equal(partial.status,'partial');assert.equal(partial.items[0].issues.length,0);assert.match(partial.items[1].issues.join(),/依据/);
  assert.equal(domain.list(c.id).length,0);
  const p={id:r.id,draftVersion:partial.draftVersion,batchId:partial.batches[0].id,itemId:partial.items[1].id,item:{evidenceRefs:[partial.items[1].from]}};
  a.edit(p);assert.throws(()=>a.edit(p),/另一页面/);
  const ready=get(r.id);assert.equal(ready.status,'ready');assert.equal(calls,1);
  assert.throws(()=>a.apply({id:r.id,revision:c.revision,draftVersion:partial.draftVersion,replaceConfirmed:true}),/草稿已改变/);
  a.apply({id:r.id,revision:c.revision,draftVersion:ready.draftVersion,replaceConfirmed:true});
  assert.equal(domain.chapter(c.id).coverage.valid,true);assert.ok(domain.list(c.id).every(s=>!s.roleConfirmed));
  assert.equal(domain.list(c.id).map(s=>s.text).join(''),c.source);
});
test('漏项可本地补齐；重复覆盖不能应用；非文本字段可定位而不丢草稿',async t=>{
  const {a,start,get,rows,result}=setup(t);let original;
  global.fetch=async(_,init)=>{original=rows(input(init));const x=structuredClone(original);x.pop();x[0].reason={bad:true};return result(x);};
  const r=await start();await a.close();let d=get(r.id);
  assert.equal(d.status,'partial');assert.equal(d.gaps.length,1);assert.equal(d.items[0].reason,'');assert.match(d.items[0].issues.join(),/说明/);
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,itemId:d.items[0].id,item:{reason:'已核对'}});d=get(r.id);
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,item:original.at(-1)});d=get(r.id);assert.equal(d.status,'ready');
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,item:original[0]});d=get(r.id);assert.equal(d.status,'partial');assert.match(d.issues.join(),/重复/);
});
test('中途 429 保留前批；显式继续只发送未完成批次，无输出预算',async t=>{
  const {a,start,get,rows,result}=setup(t,longSource);const sent=[];let limited=true;
  global.fetch=async(_,init)=>{const request=JSON.parse(init.body);assert.ok(!('max_tokens' in request));assert.ok(!('max_completion_tokens' in request));const data=input(init);sent.push(data.blocks[0].id);if(sent.length===2&&limited)return Response.json({error:{message:'限流'}},{status:429});return result(rows(data));};
  const r=await start();await a.close();let d=get(r.id);assert.equal(d.status,'partial');assert.equal(d.doneChunks,1);assert.equal(sent.length,2);const firstItems=structuredClone(d.batches[0].items);
  limited=false;a.resume({id:r.id,draftVersion:d.draftVersion});await a.close();d=get(r.id);
  assert.equal(d.status,'ready');assert.equal(sent.length,4);assert.deepEqual(sent.slice(0,3),[0,d.batches[1].blockIds[0],d.batches[1].blockIds[0]]);assert.deepEqual(d.batches[0].items,firstItems);
});
test('结果不明不自动重试；需明确同意后续费重发；上下文变动拒绝继续',async t=>{
  const {a,start,get,store,project,rows,result}=setup(t);let calls=0;
  global.fetch=async()=>{calls++;throw new Error('lost');};const r=await start();await a.close();let d=get(r.id);
  assert.equal(d.batches[0].status,'unknown');assert.equal(calls,1);assert.throws(()=>a.resume({id:r.id,draftVersion:d.draftVersion}),/重复计费/);
  global.fetch=async(_,init)=>{calls++;return result(rows(input(init)));};a.resume({id:r.id,draftVersion:d.draftVersion,retryUnknown:true});await a.close();d=get(r.id);assert.equal(d.status,'ready');assert.equal(calls,2);
  const p=store.get('projects',project.id);p.contextRevision++;store.put('projects',p);
  assert.throws(()=>a.resume({id:r.id,draftVersion:d.draftVersion,batchIds:[d.batches[0].id],replace:true}),/角色资料已改变/);assert.equal(calls,2);
});
test('重启可重解析已落盘响应，未确认的在途请求标为结果不明，均不新增调用',async t=>{
  const {a,start,get,store,c,rows,result}=setup(t);let calls=0;
  global.fetch=async(_,init)=>{calls++;return result(rows(input(init)));};const r=await start();await a.close();let d=get(r.id);
  d.status='running';d.batches[0].status='sending';d.batches[0].items=[];store.put('suggestions',d,c.id);a.recover();d=get(r.id);assert.equal(d.status,'ready');assert.equal(calls,1);
  d.status='running';d.batches[0].status='sending';d.batches[0].attempts.at(-1).status='sending';delete d.batches[0].attempts.at(-1).response;store.put('suggestions',d,c.id);a.recover();d=get(r.id);assert.equal(d.batches[0].status,'unknown');assert.equal(calls,1);
});
test('同名新角色按明确身份键隔离；旧章分析不含未来角色事实',async t=>{
  const {a,start,get,store,domain,c,project,rows,result}=setup(t);
  const future=domain.mutate('chapter.create',{projectId:project.id,title:'第二章',source:'后章。'}), narrator=store.all('roles',project.id)[0];narrator.facts=[{chapterId:future.id,note:'未来秘密',gender:'女'}];store.put('roles',narrator,project.id);
  global.fetch=async(_,init)=>{const data=input(init);assert.ok(!JSON.stringify(data.roles).includes('未来秘密'));return result(rows(data).map((x,i)=>({...x,roleId:null,newRole:'同名者',newRoleKey:i===0?'person_one':'person_two'})));};
  const r=await start();await a.close();const d=get(r.id);assert.equal(d.status,'ready');a.apply({id:d.id,draftVersion:d.draftVersion,revision:c.revision,replaceConfirmed:true,confirmRoles:true});
  const ids=new Set(domain.list(c.id).map(s=>s.roleId));assert.equal(ids.size,2);assert.ok(domain.list(c.id).every(s=>s.roleConfirmed));
});
test('重跑或修改前批身份后，后批需重分析，不能静默沿用旧角色推断',async t=>{
  const {a,start,get,rows,result,domain,c}=setup(t,longSource), requests=[];
  global.fetch=async(_,init)=>{
    const data=input(init);requests.push(data);
    const known=data.knownNewRoles[0] || {key:'original_one',name:'领路人'};
    const items=rows(data);items[0]={...items[0],roleId:null,newRole:known.name,newRoleKey:known.key};
    return result(items);
  };
  const r=await start();await a.close();let d=get(r.id);
  assert.equal(d.status,'ready');assert.equal(requests.length,3);
  for(let i=0;i<3;i++){
    const batch=d.batches[i];
    assert.deepEqual(requests[i].context,d.blocks.filter(b=>batch.referenceIds.includes(b.id)&&!batch.blockIds.includes(b.id)));
    assert.deepEqual(requests[i].blocks.map(b=>b.id),batch.blockIds);
    if(i)assert.deepEqual(requests[i].knownNewRoles,[{key:'original_one',name:'领路人'}]);
  }
  const later=structuredClone(d.batches.slice(1));
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,itemId:d.items[0].id,item:{performance:'克制'}});
  d=get(r.id);assert.deepEqual(d.batches.slice(1),later,'仅调整表演不重做后续身份推断');
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,itemId:d.items[0].id,item:{roleId:null,newRole:'新人物',newRoleKey:'new_one'}});
  d=get(r.id);assert.equal(d.status,'partial');assert.ok(d.batches.slice(1).every(b=>b.status==='stale'));
  assert.throws(()=>a.apply({id:r.id,draftVersion:d.draftVersion,revision:c.revision,replaceConfirmed:true}),/过期/);
  const first=structuredClone(d.batches[0]);
  a.resume({id:r.id,draftVersion:d.draftVersion});await a.close();d=get(r.id);
  assert.equal(d.status,'ready');assert.equal(requests.length,5);assert.deepEqual(d.batches[0],first);
  for(const data of requests.slice(3))assert.deepEqual(data.knownNewRoles,[{key:'new_one',name:'新人物'}]);
  a.apply({id:r.id,draftVersion:d.draftVersion,revision:c.revision,replaceConfirmed:true,confirmRoles:true});
  const adopted=domain.list(c.id);assert.equal(adopted.map(s=>s.text).join(''),longSource);
  const identities=adopted.filter(s=>s.roleId!==requests[0].roles[0].id).map(s=>s.roleId);
  assert.equal(identities.length,3);assert.equal(new Set(identities).size,1);
});
test('前批校对和重跑不能抹去后批结果不明的重新计费确认',async t=>{
  const {a,start,get,rows,result}=setup(t,longSource);let calls=0;
  global.fetch=async(_,init)=>{if(++calls===2)throw new Error('lost');return result(rows(input(init)))};
  const r=await start();await a.close();let d=get(r.id);
  const unknownId=d.batches[1].id;
  assert.equal(d.batches[1].status,'unknown');
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,itemId:d.items[0].id,item:{performance:'新的表演',newRoleKey:'',newRole:'',segmentId:''}});
  d=get(r.id);assert.equal(d.batches[1].status,'unknown');
  a.edit({id:r.id,draftVersion:d.draftVersion,batchId:d.batches[0].id,itemId:d.items[0].id,item:{roleId:null,newRole:'新角色',newRoleKey:'new_one'}});
  d=get(r.id);assert.equal(d.batches[1].status,'unknown');
  assert.throws(()=>a.resume({id:r.id,draftVersion:d.draftVersion}),/重复计费/);assert.equal(calls,2);
  a.resume({id:r.id,draftVersion:d.draftVersion,batchIds:[d.batches[0].id],replace:true});await a.close();
  d=get(r.id);assert.equal(d.batches.find(b=>b.id===unknownId).status,'unknown');
  assert.throws(()=>a.resume({id:r.id,draftVersion:d.draftVersion}),/重复计费/);assert.equal(calls,3);
  a.resume({id:r.id,draftVersion:d.draftVersion,retryUnknown:true});await a.close();assert.equal(get(r.id).status,'ready');
});
test('导演多选采用原子写入并保留逐条采用记录，拒绝过期上下文',async t=>{
  const {a,store,domain,project,c,get,result}=setup(t,'第一句。\n第二句。\n第三句。');
  for(const text of ['第一句。','第二句。','第三句。'])domain.mutate('segment.create',{chapterId:c.id,revision:store.get('chapters',c.id).revision,text});
  const guidance=['疲惫地轻声说，句尾收弱。','兴奋地加快语速。','以陌生口音低声表达。'],rolesBefore=structuredClone(store.all('roles'));
  global.fetch=async(_,init)=>result(input(init).segments.map((s,i)=>({segmentId:s.id,performance:guidance[i],evidence:'创作建议',evidenceRefs:[],reason:'无原文依据的待采用声音建议',age:75,gender:'男',accent:'四川口音',facts:[{text:'模型杜撰的人物性格'}]})));
  const begin=async()=>{const r=await a.start({chapterId:c.id,revision:store.get('chapters',c.id).revision,kind:'director',includePerformance:false});await a.close();return get(r.id)};
  const stale=await begin(), p=store.get('projects',project.id);p.contextRevision++;store.put('projects',p);
  const before=domain.list(c.id);
  assert.throws(()=>a.apply({id:stale.id,draftVersion:stale.draftVersion,revision:store.get('chapters',c.id).revision,selected:[stale.items[0].id]}),/过期/);
  assert.deepEqual(domain.list(c.id),before);
  const d=await begin(), revision=store.get('chapters',c.id).revision, command={id:d.id,draftVersion:d.draftVersion,revision,selected:[d.items[0].id,d.items[2].id]};
  const last=store.get('segments',before[2].id);last.retired=true;store.put('segments',last,c.id);
  assert.throws(()=>a.apply(command),/片段已改变/);
  assert.deepEqual(store.get('segments',before[0].id),before[0]);
  assert.equal(get(d.id).status,'ready');assert.equal(get(d.id).appliedItemIds,undefined);
  delete last.retired;store.put('segments',last,c.id);
  a.apply(command);
  assert.deepEqual(get(d.id).appliedItemIds,command.selected);
  assert.equal(store.get('chapters',c.id).revision,revision+1);
  const after=domain.list(c.id);assert.deepEqual(after[1],before[1]);
  for(const i of[0,2])assert.deepEqual(after[i],{...before[i],performance:guidance[i]});
  assert.deepEqual(store.all('roles'),rolesBefore,'逐句状态和模型附带年龄口音性格不得反写角色事实');
  assert.throws(()=>a.apply({...command,revision:revision+1}),/过期/);
});

test('长章边界同文不同位置保留，误输出上下文与重复本批均须明确修正',async t=>{
  const line='他站在门外。'.repeat(32)+'他没有离开。\n',source=line.repeat(65);
  const{a,start,get,rows,result,domain,c}=setup(t,source),requests=[];
  global.fetch=async(_,init)=>{
    const data=input(init);requests.push(data);const items=rows(data);
    if(requests.length===2){
      const preceding=data.context.find(b=>b.id<data.blocks[0].id);assert.ok(preceding);assert.equal(preceding.text,data.blocks[0].text);
      items.unshift({...items[0],from:preceding.id,to:preceding.id,evidenceRefs:[preceding.id]});items.push({...items[1]});
    }
    return result(items);
  };
  const r=await start();await a.close();let draft=get(r.id);assert.equal(requests.length,2);assert.equal(draft.status,'partial');
  assert.ok(draft.items.some(i=>i.issues.some(x=>/越过本批/.test(x))));assert.ok(draft.issues.some(x=>/重复/.test(x)));
  assert.throws(()=>a.apply({id:r.id,draftVersion:draft.draftVersion,revision:c.revision,replaceConfirmed:true}),/当前剧本未被覆盖/);assert.equal(domain.list(c.id).length,0);
  const last=draft.batches[1];for(const itemId of [last.items[0].id,last.items.at(-1).id]){
    a.edit({id:r.id,draftVersion:draft.draftVersion,batchId:last.id,itemId,remove:true});draft=get(r.id);
  }
  assert.equal(draft.status,'ready');a.apply({id:r.id,draftVersion:draft.draftVersion,revision:c.revision,replaceConfirmed:true,confirmRoles:true});
  const adopted=domain.list(c.id);assert.equal(adopted.length,65);assert.equal(adopted.map(s=>s.text).join(''),source);assert.equal(domain.chapter(c.id).coverage.valid,true);
  const boundary=requests[1].blocks[0].id;assert.equal(adopted[boundary-1].text,adopted[boundary].text);assert.notDeepEqual(adopted[boundary-1].source.spans,adopted[boundary].source.spans);
  assert.equal(adopted[boundary-1].source.spans.at(-1).end,adopted[boundary].source.spans[0].start);assert.equal(requests.length,2);
});
