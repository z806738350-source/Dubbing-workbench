import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf,coverage} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {createAnalysis,sourceBlocks} from '../server/analysis.mjs';
import {createExperience} from '../server/experience.mjs';
import {semanticBlocks,partsAfter,longSegment} from '../server/semantic.mjs';

const longText=Array.from({length:5},(_,i)=>`　自拟第${i+1}段🙂${'微风掠过山林而远处的回声仍然清楚'.repeat(6)}，我记得é和👩🏽‍🚀的旧约。 `).join('');
const narration={performance:'自然',evidence:'原文明示',uncertain:false,reason:'自拟原文明示'};
function wav(){const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b;}
function setup(t,segmented=true){
  const dir=mkdtempSync(join(tmpdir(),'dubbing-semantic-split-')),store=openStore(dir),d=createDomain(store);
  const p=d.mutate('project.create',{name:'语义拆分自拟测试'}),c=d.mutate('chapter.create',{projectId:p.id,title:'保留原文',source:`前邻句。${longText}尾邻句。`,segment:segmented});
  const voice=(name)=>{const v={id:uid(),name,state:'active',revision:1,path:`voices/${uid()}.wav`};mkdirSync(join(dir,'voices'),{recursive:true});writeFileSync(join(dir,v.path),wav());store.put('voices',v);return v;};
  const v=voice('角色默认'),override=voice('本句覆盖'),role=store.all('roles',p.id)[0],rev=()=>store.get('chapters',c.id).revision;
  const edit=(action,data)=>d.mutate(action,{chapterId:c.id,revision:rev(),...data});
  edit('role.update',{id:role.id,entityRevision:1,voiceId:v.id});
  if(segmented)edit('segment.confirm',{ids:d.list(c.id).map(s=>s.id)});
  let parent;
  if(segmented){
    // Reuse real merge lineage rather than inventing a long row with invalid source spans.
    parent=d.list(c.id)[1];
    while(d.list(c.id).findIndex(s=>s.id===parent.id)<d.list(c.id).length-2)parent=edit('segment.merge',{id:parent.id,performance:''});
    assert.ok(Array.from(parent.text).length>longSegment);
  }
  const config={key:'fixture',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/v1/audio/speech'};
  const w=createWorker(store,d,config),a=createAnalysis(store,d,config);
  // Replay the frozen legacy analyzer contract through real operation receipts;
  // new explicit-basic and PG preparation are covered by performance-analysis.
  const legacyAnalysis={...a,start:p=>a.start({...p,performanceMode:undefined,includePerformance:false}),plan:p=>a.plan({...p,performanceMode:undefined,includePerformance:false})};
  const e=createExperience(store,d,w,legacyAnalysis,config);
  t.after(async()=>{await a.close();w.close();store.close();rmSync(dir,{recursive:true,force:true});});
  e.policy({projectId:p.id,revision:0,mode:'smart'});
  const grant=e.grant({grantId:uid(),projectId:p.id,chapterId:c.id,steps:['extract','director'],materials:['text'],textLimit:20,audioLimit:0});
  const calls=[];
  function mock(transform=(items)=>items){t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,config.baseUrl+'/chat/completions','No audio or real supplier request is allowed');
    const input=JSON.parse(JSON.parse(init.body).messages[1].content);calls.push(input);
    const refs=[...(input.blocks||[]),...(input.context||[])].map(b=>b.id);
    const items=input.segments?input.segments.map(s=>({...narration,segmentId:s.id,evidenceRefs:[refs[0]],...(s.splitBoundaries?.length?{splitAfter:s.splitBoundaries.map(b=>b.id)}:{})}))
      :input.blocks.map(b=>({...narration,from:b.id,to:b.id,roleId:role.id,type:'narration',evidenceRefs:[b.id]}));
    return Response.json({choices:[{finish_reason:'stop',message:{content:JSON.stringify({items:transform(items,input)})}}]});
  });}
  async function prepare(data={}){const op=await e.run({operationId:uid(),kind:'prepareChapter',includePerformance:false,chapterId:c.id,revision:rev(),grantId:grant.grantId,...data});assert.ok(!op.error,op.error);await a.close();return e.get(op.operationId);}
  const rows=()=>d.list(c.id),snapshot=()=>({chapter:store.get('chapters',c.id),segments:store.all('segments',c.id),units:store.all('units',c.id),events:store.all('events',c.id)});
  return {dir,store,d,p,c,v,override,role,rev,edit,parent,w,a,e,grant,calls,mock,prepare,rows,snapshot};
}

test('语义边界保留 Unicode、空白与引号；长无标点原文不在第251字硬切',()=>{
  const source=` \t　“👩🏽‍🚀é说：${'没有标点的自拟正文🙂'.repeat(35)}！”\n\n第二段，保留1,000与空格。  `;
  const blocks=semanticBlocks(source),original=sourceBlocks(source),chars=Array.from(source);
  for(const list of [blocks,original]){
    assert.equal(list.map(b=>b.text).join(''),source);
    assert.ok(list.every(b=>b.text===chars.slice(b.start,b.end).join('')));
    assert.equal(list[0].start,0);assert.equal(list.at(-1).end,chars.length);
  }
  assert.ok(original.some(b=>Array.from(b.text).length>350),'Unpunctuated prose must keep its natural boundary');
  const legal=blocks.filter(b=>b.id<blocks.length-1&&b.text.trim()&&chars.slice(b.end).join('').trim()).map(b=>b.id);
  // The leading whitespace-only block is attached to the first readable part.
  const parts=partsAfter(source,legal);
  assert.ok(parts);assert.equal(parts.join(''),source);
  for(const ids of [[999],[blocks.at(-1).id],[1,0],[1,1]])assert.equal(partsAfter(source,ids),null);
  assert.ok(blocks.some(b=>b.text.includes('1,000')),'Thousands separators are not phrase boundaries');
});

test('extract 合法合并长范围自动按原自然块拆回，正文和来源完整',async t=>{
  const f=setup(t,false);f.mock((items,input)=>[{...items[0],from:input.blocks[0].id,to:input.blocks.at(-1).id,evidenceRefs:input.blocks.map(b=>b.id)}]);
  const result=await f.prepare(),rows=f.rows();
  assert.equal(result.outcome,'completed');assert.ok(rows.length>1);
  assert.equal(rows.map(s=>s.text).join(''),f.c.source);
  assert.ok(rows.every(s=>Array.from(s.text).length<=longSegment));
  assert.ok(rows.every(s=>s.roleId===f.role.id&&s.voiceId===f.v.id&&s.performance==='自然'&&s.roleConfirmed));
  assert.equal(coverage(f.store.get('chapters',f.c.id),rows).valid,true);assert.equal(f.store.all('jobs').length,0);assert.equal(f.calls.length,1);
});

test('director 拆长段继承人工角色、本句声音和参数；重复准备不再拆或改邻句',async t=>{
  const f=setup(t),manualRole=f.edit('role.create',{projectId:f.p.id,name:'人工角色'});
  f.edit('role.update',{id:manualRole.id,entityRevision:1,voiceId:f.v.id});
  f.edit('segment.update',{id:f.parent.id,roleId:manualRole.id,type:'dialogue',voiceId:f.override.id,performance:'保持克制但坚定',config:{speech_rate:7,loudness_rate:-5,pitch_rate:2},template:'dry-v1',model:'seed-audio-1.0'});
  const parent=f.store.get('segments',f.parent.id),neighbors=f.rows().filter(s=>s.id!==parent.id);f.mock();
  const op=await f.prepare({ids:[parent.id]}),children=f.rows().filter(s=>!neighbors.some(n=>n.id===s.id));
  assert.ok(children.length>=2);assert.equal(children.map(s=>s.text).join(''),parent.text);
  for(const child of children){
    for(const key of ['roleId','type','voiceId','voiceSource','performance','config','template','model','protectedFields'])assert.deepEqual(child[key],parent[key],key);
    for(const field of ['role','identity','performance']){assert.deepEqual(child.decisions[field].values,parent.decisions[field].values);assert.equal(child.decisions[field].source,'structural');assert.deepEqual(child.decisions[field].parentIds,[parent.id]);assert.ok(child.decisions[field].operationId);}
    assert.equal(child.decisions.role.state,'accepted');assert.equal(child.decisions.identity.state,'accepted');
  }
  assert.equal(f.store.get('segments',parent.id).retired,true);assert.equal(coverage(f.store.get('chapters',f.c.id),f.rows()).valid,true);
  for(const neighbor of neighbors){const after=f.store.get('segments',neighbor.id);assert.equal(after.text,neighbor.text);assert.equal(after.performance,neighbor.performance);assert.equal(after.voiceId,neighbor.voiceId);}
  assert.ok(op.result.analysis.splitResults?.some(s=>s.segmentId===parent.id));
  const first=f.rows().map(s=>s.id);await f.prepare();assert.deepEqual(f.rows().map(s=>s.id),first);assert.equal(f.store.all('roles',f.p.id).length,2);assert.equal(f.store.all('jobs').length,0);
});

test('人工明确清空表演后，智能拆分与再次准备保留受保护的空值',async t=>{
  const f=setup(t);f.edit('segment.update',{id:f.parent.id,performance:'原人工轻声要求'});
  f.edit('segment.update',{id:f.parent.id,performance:''});
  const parent=f.store.get('segments',f.parent.id);
  assert.ok(parent.protectedFields.includes('performance'));assert.equal(parent.decisions.performance.source,'human');
  f.mock();const op=await f.prepare({ids:[parent.id]}),split=op.result.analysis.splitResults.find(row=>row.segmentId===parent.id);
  assert.ok(split.childIds.length>1);
  for(const id of split.childIds){const child=f.store.get('segments',id);assert.equal(child.performance,'');assert.equal(child.decisions.performance.values,parent.decisions.performance.values);assert.equal(child.decisions.performance.source,'structural');assert.deepEqual(child.decisions.performance.parentIds,[parent.id]);assert.ok(child.protectedFields.includes('performance'));}
  await f.prepare({ids:split.childIds});
  assert.ok(split.childIds.every(id=>f.store.get('segments',id).performance===''));assert.equal(f.store.all('jobs').length,0);
});

test('已成组、有场景、匹配旧声音和 unknown 的长段保持原结构；旧失败无声仍可拆',async t=>{
  for(const protectedBy of ['pending-group','active-group','scene','audio','unknown','failed'])await t.test(protectedBy,async t=>{
    const f=setup(t);f.edit('segment.update',{id:f.parent.id,performance:'保持原人工表演'});const s=f.store.get('segments',f.parent.id);
    if(protectedBy.endsWith('group')){const group=f.edit('unit.create',{ids:[s.id,f.rows().at(-1).id]});if(protectedBy==='active-group'){group.state='active';f.store.put('units',group,f.c.id);}}
    if(protectedBy==='scene'){const unit=f.store.get('units',s.id);f.edit('event.create',{unitId:s.id,entityRevision:unit.revision,kind:'effect',description:'人工声音事件',memberId:s.id,position:'after',state:'draft'});}
    if(protectedBy==='audio'){
      const audio={id:uid(),path:`audio/${uid()}.wav`,input:inputOf(s),basis:basisOf(s),model:s.model};mkdirSync(join(f.dir,'audio'));writeFileSync(join(f.dir,audio.path),wav());f.store.put('audios',audio,f.c.id);s.current=audio.id;s.latest='success';f.store.put('segments',s,f.c.id);f.d.enhancement.syncLegacySegment(s);
      assert.equal(f.d.enhancement.status(f.store.get('units',s.id),'dry').validity,'matched');
    }
    if(['unknown','failed'].includes(protectedBy)){const unit=f.store.get('units',s.id);unit.variants.dry.latest=protectedBy;f.store.put('units',unit,f.c.id);}
    const before=f.snapshot();f.mock();await f.prepare({ids:[s.id]});
    if(protectedBy==='failed')assert.ok(f.rows().length>3);else assert.deepEqual(f.snapshot(),before);
    assert.equal(f.store.all('jobs').length,0);assert.equal(f.calls.length,1);
  });
});

test('位置性人工表演先待处理；独立拆分预览不修改表演，明确沿用后只拆正文',async t=>{
  const f=setup(t);f.edit('segment.update',{id:f.parent.id,performance:'前半句克制，后半句哽咽'});const parent=f.store.get('segments',f.parent.id);f.mock();
  const automatic=await f.prepare({ids:[parent.id]});assert.equal(f.rows().length,3);assert.equal(f.store.get('segments',parent.id).performance,parent.performance);assert.ok(automatic.result.analysis.items[0].splitIssue);
  const before=f.snapshot(),preview=await f.prepare({analysisKind:'director',ids:[parent.id],splitOnly:true,autoApply:false}),draft=preview.result.analysis,item=draft.items[0];
  assert.equal(draft.splitOnly,true);assert.ok(item.splitParts.length>=2);assert.equal(item.splitParts.join(''),parent.text);assert.deepEqual(f.snapshot(),before);
  assert.throws(()=>f.a.apply({id:draft.id,revision:f.rev(),draftVersion:draft.draftVersion,selected:[item.id]}),/沿用原表演/);assert.deepEqual(f.snapshot(),before);
  const applied=f.a.apply({id:draft.id,revision:f.rev(),draftVersion:draft.draftVersion,selected:[item.id],inheritPerformanceConfirmed:true}),children=applied.splitResults[0].childIds.map(id=>f.store.get('segments',id));
  assert.equal(children.map(s=>s.text).join(''),parent.text);assert.ok(children.every(s=>s.performance===parent.performance));
});

test('强烈或存疑表演与缺失拆分建议不能自动拆分、不能假记为已采用',async t=>{
  for(const proposal of ['strong','uncertain','uncertain-same','no-cuts']){
    const f=setup(t),before=f.snapshot();f.mock(items=>items.map(item=>proposal==='no-cuts'?{...item,performance:'',splitAfter:[]}:{...item,...(proposal==='strong'?{performance:'大声哭喊并播放背景音乐'}:{uncertain:true,...(proposal==='uncertain-same'?{performance:''}:{})})}));
    const op=await f.prepare({ids:[f.parent.id]}),draft=op.result.analysis,item=draft.items[0];
    assert.deepEqual(f.snapshot(),before);assert.ok(!draft.splitResults?.length);assert.ok(!draft.appliedItemIds?.includes(item.id));assert.ok(draft.automation.pendingItemIds.includes(item.id));
  }
});

test('非法边界与中途写入失败不留下半拆结构，原来源和章节版本保留',async t=>{
  for(const invalid of ['missing','last','reverse','duplicate'])await t.test(invalid,async t=>{
    const f=setup(t),before=f.snapshot();f.mock((items,input)=>items.map(item=>{const ids=input.segments.find(s=>s.id===item.segmentId).splitBoundaries.map(b=>b.id);return {...item,splitAfter:invalid==='missing'?[999]:invalid==='last'?[semanticBlocks(f.parent.text).at(-1).id]:invalid==='reverse'?[ids[1],ids[0]]:[ids[0],ids[0]]};}));
    const preview=await f.prepare({ids:[f.parent.id],splitOnly:true,autoApply:false}),draft=preview.result.analysis;assert.deepEqual(f.snapshot(),before);
    assert.ok(draft.items[0].splitIssue||draft.items[0].issues.length);assert.ok(!draft.items[0].splitParts?.length);
    assert.throws(()=>f.a.apply({id:draft.id,revision:f.rev(),draftVersion:draft.draftVersion,selected:[draft.items[0].id]}));assert.deepEqual(f.snapshot(),before);
  });
  await t.test('second-child-write',async t=>{
    const f=setup(t);f.mock();const preview=await f.prepare({ids:[f.parent.id],splitOnly:true,autoApply:false}),draft=preview.result.analysis,before=f.snapshot(),put=f.store.put.bind(f.store);let writes=0;
    t.mock.method(f.store,'put',(table,value,parent)=>{if(table==='segments'&&!f.store.maybe('segments',value.id)&&++writes===2)throw Error('injected second child');return put(table,value,parent);});
    assert.throws(()=>f.a.apply({id:draft.id,revision:f.rev(),draftVersion:draft.draftVersion,selected:[draft.items[0].id]}),/injected second child/);assert.equal(writes,2);assert.deepEqual(f.snapshot(),before);assert.equal(f.store.get('suggestions',draft.id).status,'ready');
  });
  await t.test('automatic-second-child-write',async t=>{
    const f=setup(t);f.mock();const before=f.snapshot(),put=f.store.put.bind(f.store);let writes=0;
    t.mock.method(f.store,'put',(table,value,parent)=>{if(table==='segments'&&!f.store.maybe('segments',value.id)&&++writes===2)throw Error('injected automatic second child');return put(table,value,parent);});
    const op=await f.prepare({ids:[f.parent.id]}),draft=op.result.analysis;
    assert.equal(writes,2);assert.deepEqual(f.snapshot(),before);assert.ok(!draft.splitResults?.length);assert.equal(f.e.project(f.p.id).changes.length,0);assert.match(draft.automation.error,/停止|失败|保留/);
  });
});

test('撤销自动拆分还原原父条；子条后续人工修改拒绝撤销且全部保留',async t=>{
  for(const edited of [false,true])await t.test(edited?'edited-child':'restore-parent',async t=>{
    const f=setup(t),original=f.rows();f.mock();await f.prepare({ids:[f.parent.id]});const change=f.e.project(f.p.id).changes.find(c=>c.splits?.length);assert.ok(change);
    const children=f.rows().filter(s=>!original.some(p=>p.id===s.id));assert.ok(children.length>=2);
    if(edited){f.edit('segment.update',{id:children[0].id,performance:'拆分后人工新版'});const before=f.snapshot();assert.throws(()=>f.e.undo({changeId:change.changeId,revision:f.rev()}),{status:409});assert.deepEqual(f.snapshot(),before);}
    else{f.e.undo({changeId:change.changeId,revision:f.rev()});assert.deepEqual(f.rows().map(s=>s.id),original.map(s=>s.id));assert.deepEqual(f.rows().map(s=>({...s,retired:false})),original.map(s=>({...s,retired:false})));assert.ok(children.every(s=>f.store.get('segments',s.id).retired));assert.equal(coverage(f.store.get('chapters',f.c.id),f.rows()).valid,true);}
    assert.equal(f.store.all('jobs').length,0);
  });
});
