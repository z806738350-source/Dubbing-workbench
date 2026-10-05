import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, uid } from '../server/store.mjs';
import { createDomain, inputOf, basisOf, compile } from '../server/domain.mjs';
import { createExperience } from '../server/experience.mjs';
import { createAnalysis } from '../server/analysis.mjs';

function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'segment-deletion-'));
  let store=openStore(directory),domain=createDomain(store);
  const project=domain.mutate('project.create',{name:'删除台词验收'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章节',source:'第一句。\n第二句。\n第三句。',segment:true});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {directory,project,chapter,get store(){return store;},get domain(){return domain;},
    edit:(action,data={},context)=>domain.mutate(action,{chapterId:chapter.id,revision:store.get('chapters',chapter.id).revision,...data},context),
    reopen(){store.close();store=openStore(directory);domain=createDomain(store);},
    snapshot:()=>JSON.stringify(['chapters','segments','units','events','settings'].map(table=>store.all(table))) };
}
const analysisOf=f=>createAnalysis(f.store,f.domain,{baseUrl:'https://fixture.invalid/v1',model:'seed-audio-1.0'});
const experienceOf=f=>createExperience(f.store,f.domain,{},analysisOf(f),{});
function configureVoice(f) {
  const role=f.store.all('roles',f.project.id)[0],voice={id:uid(),name:'夹具参考',path:'fixture-reference.wav',state:'active'};
  writeFileSync(join(f.directory,voice.path),'fixture-reference');f.store.put('voices',voice);
  f.edit('role.update',{id:role.id,entityRevision:role.revision??1,voiceId:voice.id});f.edit('segment.confirm',{ids:f.domain.list(f.chapter.id).map(s=>s.id)});
}

test('删除从台词、播放与检查范围移除，原文覆盖、顺序和已有声音保持，恢复沿用原排除状态',t=>{
  const f=fixture(t),[first,second]=f.domain.list(f.chapter.id),audio={id:uid(),path:'existing.wav',input:inputOf(first),basis:basisOf(first),model:first.model};
  writeFileSync(join(f.directory,audio.path),'isolated-audio-bytes');f.store.put('audios',audio,f.chapter.id);f.store.put('segments',{...first,current:audio.id,previous:'previous',approved:audio.id},f.chapter.id);
  const row=f.store.get('segments',first.id),source=f.store.get('chapters',f.chapter.id).source,revision=f.store.get('chapters',f.chapter.id).revision,arrangement=f.store.get('chapters',f.chapter.id).arrangement;
  f.edit('segment.delete',{ids:[first.id]});
  let current=f.domain.chapter(f.chapter.id),deleted=f.store.get('segments',first.id);
  assert.equal(current.coverage.valid,true);assert.equal(current.revision,revision+1);assert.equal(current.arrangement,arrangement+1);assert.equal(f.domain.list(f.chapter.id).length,3);
  assert.deepEqual(current.segments.map(s=>s.id),[second.id,f.domain.list(f.chapter.id)[2].id]);assert.deepEqual(current.deletedSegments.map(s=>s.id),[first.id]);
  assert.ok(!current.playbackItems.some(item=>item.members.includes(first.id)));assert.ok(!current.reviewItems.some(item=>item.id===first.id));
  assert.equal(deleted.excluded,true);assert.equal(deleted.deletion.excluded,false);assert.ok(deleted.deletion.at);
  for(const field of ['text','source','order','current','previous','approved','review'])assert.deepEqual(deleted[field],row[field]);
  assert.equal(current.source,source);assert.deepEqual(f.store.get('audios',audio.id),audio);assert.equal(readFileSync(join(f.directory,audio.path),'utf8'),'isolated-audio-bytes');
  f.edit('segment.restore-deleted',{ids:[first.id]});current=f.domain.chapter(f.chapter.id);assert.equal(current.deletedSegments.length,0);assert.equal(current.segments[0].id,first.id);assert.equal(current.coverage.valid,true);assert.equal(f.store.get('segments',first.id).excluded,false);assert.equal(f.store.get('segments',first.id).current,audio.id);
  f.edit('segment.update',{id:second.id,excluded:true});f.edit('segment.delete',{ids:[second.id]});f.edit('segment.restore-deleted',{ids:[second.id]});assert.equal(f.store.get('segments',second.id).excluded,true);
});

test('批量删除和恢复原子保存，重开数据库后仍可恢复，全部删除保持覆盖而没有朗读项目',t=>{
  const f=fixture(t),ids=f.domain.list(f.chapter.id).map(s=>s.id),orders=f.domain.list(f.chapter.id).map(s=>s.order);
  f.edit('segment.delete',{ids});f.reopen();
  const deleted=f.domain.chapter(f.chapter.id);assert.equal(deleted.segments.length,0);assert.equal(deleted.deletedSegments.length,3);assert.equal(deleted.coverage.valid,true);assert.deepEqual(deleted.playbackItems,[]);assert.deepEqual(deleted.reviewItems,[]);
  f.edit('segment.restore-deleted',{ids});f.reopen();assert.deepEqual(f.domain.chapter(f.chapter.id).segments.map(s=>s.id),ids);assert.deepEqual(f.domain.list(f.chapter.id).map(s=>s.order),orders);assert.equal(f.domain.chapter(f.chapter.id).deletedSegments.length,0);
});

test('过期、重复、跨章、退役、删除状态混合与活动任务均拒绝整批，不留下部分修改',t=>{
  const f=fixture(t),ids=f.domain.list(f.chapter.id).map(s=>s.id),other=f.domain.mutate('chapter.create',{projectId:f.project.id,title:'其他章',source:'另一句。',segment:true}),foreign=f.domain.list(other.id)[0].id;
  const reject=(action,payload,status)=>{const before=f.snapshot();assert.throws(()=>f.edit(action,payload),status?{status}:undefined);assert.equal(f.snapshot(),before);};
  reject('segment.delete',{ids:[]},400);reject('segment.delete',{ids:{length:1}},400);reject('segment.delete',{ids:[17]},400);reject('segment.delete',{ids:[ids[0],ids[0]]},400);reject('segment.delete',{ids:[ids[0],foreign]},409);reject('segment.delete',{ids:[ids[0]],revision:0},409);
  const split=f.edit('segment.split',{id:ids[2],offset:2});reject('segment.delete',{ids:[ids[0],ids[2]]},409);assert.ok(split.length===2);
  f.edit('segment.delete',{ids:[ids[0]]});reject('segment.delete',{ids:[ids[1],ids[0]]},409);reject('segment.restore-deleted',{ids:[ids[0],ids[1]]},409);
  f.store.put('jobs',{id:uid(),status:'running',chapterId:f.chapter.id},f.chapter.id);reject('segment.restore-deleted',{ids:[ids[0]]},409);
});

test('真实待生成或活动对戏组拒绝删除，其他组不阻断，解除组后可删成员',t=>{
  const f=fixture(t);configureVoice(f);const ids=f.domain.list(f.chapter.id).map(s=>s.id),unit=f.edit('unit.create',{ids:ids.slice(0,2)});
  const before=f.snapshot();assert.throws(()=>f.edit('segment.delete',{ids:[ids[0],ids[2]]}),{status:409});assert.equal(f.snapshot(),before);
  f.store.put('units',{...f.store.get('units',unit.id),state:'active'},f.chapter.id);assert.throws(()=>f.edit('segment.delete',{ids:[ids[1]]}),{status:409});
  f.edit('segment.delete',{ids:[ids[2]]});assert.equal(f.store.get('units',unit.id).state,'active');assert.equal(f.domain.chapter(f.chapter.id).coverage.valid,true);
  f.edit('unit.dissolve',{id:unit.id,entityRevision:f.store.get('units',unit.id).revision});f.edit('segment.delete',{ids:[ids[0]]});assert.ok(f.store.get('segments',ids[0]).deletion);
});

test('单条场景删除保留真实业务事件、原音频和历史，恢复后保持既有事件核对规则',t=>{
  const f=fixture(t);configureVoice(f);const id=f.domain.list(f.chapter.id)[0].id,event=f.edit('event.create',{unitId:id,entityRevision:f.store.get('units',id).revision,kind:'music',description:'缓慢琴声',memberId:id,position:'during',state:'adopted'});
  const prepared=f.domain.enhancement.prepare({kind:'unit-generate',chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,unitId:id,mode:'scene'},{model:'seed-audio-1.0'});
  const job={id:uid(),kind:'unit-generate',status:'running',...prepared.job},attempt={id:uid(),jobId:job.id,...prepared.attempts[0],status:'sending'},audio={id:attempt.id,path:'existing-scene.wav',input:attempt.input,basis:attempt.basis,prompt:compile(attempt.input),model:attempt.input.model};
  writeFileSync(join(f.directory,audio.path),'fixture-scene-bytes');f.store.put('jobs',job,f.chapter.id);f.store.put('attempts',attempt,job.id);f.store.put('audios',audio,f.chapter.id);assert.equal(f.domain.enhancement.register(job,attempt,audio),true);f.store.put('jobs',{...job,status:'success'},f.chapter.id);f.store.put('attempts',{...attempt,status:'success'},job.id);
  const unit=f.store.get('units',id),original=f.store.get('audios',audio.id);f.edit('segment.delete',{ids:[id]});
  assert.equal(f.store.get('units',id).variants.scene.current,unit.variants.scene.current);assert.deepEqual(f.store.get('audios',audio.id),original);assert.equal(f.store.get('events',event.id).state,'adopted');assert.equal(f.store.get('events',event.id).needsReview,true);
  assert.ok(f.domain.chapter(f.chapter.id).units.find(u=>u.id===id).variants.scene.history.some(a=>a.id===audio.id));assert.ok(!f.domain.chapter(f.chapter.id).playbackItems.some(item=>item.members.includes(id)));
  f.edit('segment.restore-deleted',{ids:[id]});assert.equal(f.store.get('events',event.id).needsReview,true);assert.equal(f.store.get('units',id).variants.scene.current,audio.id);assert.equal(readFileSync(join(f.directory,audio.path),'utf8'),'fixture-scene-bytes');
});

test('已删除台词拒绝旧编辑、确认、改绑、拆分、AI指导采用和撤销旁路，标记不会无声消失',t=>{
  const f=fixture(t),[s]=f.domain.list(f.chapter.id),role=f.store.all('roles',f.project.id)[0];f.edit('segment.delete',{ids:[s.id]});
  for(const [action,payload] of [['segment.update',{id:s.id,excluded:false}],['segment.confirm',{ids:[s.id]}],['segment.rebind',{ids:[s.id],roleId:role.id}],['segment.split',{id:s.id,offset:2}]]){const before=f.snapshot();assert.throws(()=>f.edit(action,payload),{status:409});assert.equal(f.snapshot(),before);}
  const c=f.store.get('chapters',f.chapter.id),suggestion={id:uid(),chapterId:c.id,kind:'director',status:'ready',revision:c.revision,contextRevision:f.store.get('projects',f.project.id).contextRevision,items:[{id:uid(),segmentId:s.id,performance:'不应写入'}]};
  f.store.put('suggestions',suggestion,c.id);assert.throws(()=>analysisOf(f).apply({id:suggestion.id,revision:c.revision,selected:[suggestion.items[0].id]}),{status:409});assert.equal(f.store.get('segments',s.id).performance,'');
  const changeId=uid();f.store.put('settings',{id:'ux-change:'+changeId,chapterId:c.id,items:[{id:s.id,before:{excluded:false},after:{performance:''}}]});
  assert.throws(()=>experienceOf(f).undo({changeId,chapterId:c.id,revision:c.revision}),{status:409});assert.throws(()=>experienceOf(f).unprotect({segmentId:s.id,chapterId:c.id,revision:c.revision,field:'performance'}));
  assert.equal(f.store.get('segments',s.id).excluded,true);assert.ok(f.store.get('segments',s.id).deletion);
});

test('助手仍需对删除或恢复导致的实际朗读范围改变取得具体批准',t=>{
  const f=fixture(t),[s]=f.domain.list(f.chapter.id),delegated={actorKind:'assistant_delegated',operationId:uid(),voicePolicy:'askMissing',allowedVoiceIds:[]};
  const before=f.snapshot();assert.throws(()=>f.edit('segment.delete',{ids:[s.id]},delegated),{status:403});assert.equal(f.snapshot(),before);
  const request={chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,ids:[s.id]},effects=f.domain.previewAssistantEffects('segment.delete',request);
  f.domain.mutate('segment.delete',request,{...delegated,operationId:uid(),actorKind:'human_approved_proposal',approvedEffects:effects,namedOverrides:[s.id+'.excluded']});
  assert.ok(f.store.get('segments',s.id).deletion);assert.throws(()=>f.edit('segment.restore-deleted',{ids:[s.id]},{...delegated,operationId:uid()}),{status:403});assert.equal(f.store.get('segments',s.id).excluded,true);
});
