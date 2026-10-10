import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {createAnalysis} from '../server/analysis.mjs';
import {createExperience} from '../server/experience.mjs';
import {compile} from '../server/templates.mjs';
import {updateAudioRange,savedAudioRange} from '../server/audio-range.mjs';

function wav() {
  const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b;
}
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'dubbing-bulk-voice-')),store=openStore(directory),domain=createDomain(store);
  const project=domain.mutate('project.create',{name:'批量声音夹具'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'第一句。\n第二句。\n第三句。',segment:true});
  const revision=()=>store.get('chapters',chapter.id).revision;
  const edit=(action,p)=>domain.mutate(action,{chapterId:chapter.id,revision:revision(),...p});
  const makeVoice=name=>{const voice={id:uid(),name,state:'active',revision:1,path:uid()+'.wav'};writeFileSync(join(directory,voice.path),wav());store.put('voices',voice);return voice;};
  const original=makeVoice('原声'),replacement=makeVoice('新声'),custom=makeVoice('已有单句覆盖');
  const narrator=store.all('roles',project.id)[0];edit('role.update',{id:narrator.id,entityRevision:1,voiceId:original.id});
  const speaker=domain.mutate('role.create',{projectId:project.id,name:'另一角色'});edit('role.update',{id:speaker.id,entityRevision:1,voiceId:custom.id});
  const ids=domain.list(chapter.id).map(s=>s.id);assert.equal(ids.length,3);
  edit('segment.confirm',{ids});edit('segment.update',{id:ids[0],voiceId:custom.id,performance:'压低声音，缓慢说完。'});
  edit('segment.update',{id:ids[1],roleId:speaker.id,type:'dialogue',performance:'语速略快，句尾收住。'});
  const unknown=store.get('segments',ids[1]);unknown.roleConfirmed=false;unknown.identityPending=true;store.put('segments',unknown,chapter.id);
  const config={key:'',model:'seed-audio-1.0',baseUrl:'https://fixture.invalid/v1',audioUrl:'https://fixture.invalid/v1/audio/speech'},worker=createWorker(store,domain,config),analysis=createAnalysis(store,domain,config),experience=createExperience(store,domain,worker,analysis,config);
  t.mock.method(globalThis,'fetch',()=>assert.fail('批量使用已有声音不能调用模型'));
  t.after(async()=>{await analysis.close();worker.close();await worker.drain();store.close();rmSync(directory,{recursive:true,force:true});});
  const request=(extra={})=>({operationId:uid(),kind:'useVoice',scope:'selected',chapterId:chapter.id,revision:revision(),segmentIds:ids.slice(0,2),voiceId:replacement.id,apply:true,chapterOnly:true,...extra});
  const businessState=()=>({chapters:store.all('chapters'),segments:store.all('segments'),units:store.all('units'),roles:store.all('roles'),voices:store.all('voices'),audios:store.all('audios')});
  return {directory,store,domain,project,chapter,revision,edit,original,replacement,custom,narrator,speaker,ids,experience,request,businessState};
}

test('勾选跨角色台词一次批量换声，覆盖旧单句声音并保留未选、默认声和正文指导',async t=>{
  const f=fixture(t),before=f.domain.list(f.chapter.id),roles=f.store.all('roles'),chapterBefore=f.store.get('chapters',f.chapter.id);
  const remote=f.domain.mutate('chapter.create',{projectId:f.project.id,title:'另章',source:'另章自拟句。',segment:true}),remoteBefore=f.domain.list(remote.id);
  const result=await f.experience.run(f.request());assert.equal(result.outcome,'completed',result.error);
  const after=f.domain.list(f.chapter.id);
  for(let index=0;index<2;index++) {
    const old=before[index],current=after[index];assert.equal(current.voiceId,f.replacement.id);assert.equal(current.voiceSource,'override');assert.equal(current.identityConfirmed,true);assert.equal(current.decisions.identity.source,'human');
    for(const field of ['roleId','type','roleConfirmed','text','performance','identityPending','config','template','source'])assert.deepEqual(current[field],old[field],field);
    assert.ok(current.protectedFields.includes('voiceId'));assert.equal(f.store.get('units',current.id).variants.dry.current,old.current);
  }
  assert.deepEqual(after[2],before[2]);assert.deepEqual(f.store.all('roles'),roles);assert.deepEqual(f.domain.list(remote.id),remoteBefore);
  const chapter=f.store.get('chapters',f.chapter.id);assert.equal(chapter.revision,chapterBefore.revision+1);assert.equal(chapter.arrangement,chapterBefore.arrangement);assert.deepEqual(chapter.roleVoices,chapterBefore.roleVoices);
  assert.deepEqual(result.result.target,{chapterId:f.chapter.id,chapterRevision:chapter.revision,ids:f.ids.slice(0,2)});assert.equal(f.store.all('jobs').length,0);assert.equal(f.store.all('attempts').length,0);
});

test('批量操作同标识重试只应用一次，不同范围不能复用标识',async t=>{
  const f=fixture(t),p=f.request(),before=f.revision(),first=await f.experience.run(p),stored=f.businessState();
  assert.equal(first.outcome,'completed');assert.equal(f.revision(),before+1);assert.deepEqual((await f.experience.run(p)).result,first.result);assert.deepEqual(f.businessState(),stored);
  assert.deepEqual(f.experience.get(p.operationId).result,first.result);
  await assert.rejects(f.experience.run({...p,segmentIds:[f.ids[2]]}),/同一操作/);assert.deepEqual(f.businessState(),stored);
});

test('批量所有目标先核对：重复、空、未知、异章、删除、排除和过期版本均原子保留',async t=>{
  const f=fixture(t),other=f.domain.mutate('chapter.create',{projectId:f.project.id,title:'外章',source:'外章句。',segment:true}),foreign=f.domain.list(other.id)[0].id;
  const bad=[[],[f.ids[0],f.ids[0]],[f.ids[0],uid()],[f.ids[0],foreign],[f.ids[0],null]];
  for(const segmentIds of bad){const before=f.businessState(),result=await f.experience.run(f.request({segmentIds}));assert.notEqual(result.outcome,'completed');assert.ok(result.error);assert.deepEqual(f.businessState(),before);}
  const p=f.request({revision:f.revision()-1}),before=f.businessState();assert.equal((await f.experience.run(p)).errorStatus,409);assert.deepEqual(f.businessState(),before);
  for(const field of ['excluded','deletion','retired']) {
    const original=f.store.get('segments',f.ids[1]),changed={...original,[field]:field==='deletion'?{at:new Date().toISOString(),excluded:false}:true};f.store.put('segments',changed,f.chapter.id);
    const before=f.businessState(),result=await f.experience.run(f.request());assert.equal(result.errorStatus,409);assert.deepEqual(f.businessState(),before);
    f.store.put('segments',original,f.chapter.id);
  }
});

test('不可用声音拒绝整批，台词仍保持原值',async t=>{
  const f=fixture(t);
  for(const change of [{state:'archived'},{state:'active',deletePending:true},{state:'active',path:'missing.wav'}]) {
    f.store.put('voices',{...f.replacement,...change});const before=f.businessState(),result=await f.experience.run(f.request());assert.notEqual(result.outcome,'completed');assert.ok(result.error);assert.deepEqual(f.businessState(),before);
  }
  const before=f.businessState(),result=await f.experience.run(f.request({voiceId:uid()}));assert.ok(result.error);assert.deepEqual(f.businessState(),before);
});

test('第二条落盘失败会回滚整批声音及章节修订',async t=>{
  const f=fixture(t),before=f.businessState(),put=f.store.put;let writes=0;
  t.mock.method(f.store,'put',(table,value,parent)=>{
    if(table==='segments'&&f.ids.includes(value.id)&&value.voiceId===f.replacement.id&&++writes===2)throw Error('模拟第二条写入失败');
    return put(table,value,parent);
  });
  const result=await f.experience.run(f.request());assert.equal(result.errorStatus,500);assert.equal(writes,2);assert.deepEqual(f.businessState(),before);
});

test('批量不接候选或矛盾的声音库范围，拒绝时不登记操作也不入库声音',async t=>{
  const f=fixture(t),before=f.businessState(),settings=f.store.all('settings');
  await assert.rejects(f.experience.run(f.request({audioId:uid()})),/已有的声音/);
  await assert.rejects(f.experience.run(f.request({scope:'library'})),/所选台词/);
  await assert.rejects(f.experience.run(f.request({apply:false})),/所选台词/);
  assert.deepEqual(f.businessState(),before);assert.deepEqual(f.store.all('settings'),settings);
});

test('组成员批量换声令dry与scene失配，一次修订保留历史、组选择与裁剪',async t=>{
  const f=fixture(t),e=f.domain.enhancement;f.edit('segment.confirm',{ids:f.ids.slice(0,2),identityChosen:true});
  const created=f.edit('unit.create',{ids:f.ids.slice(0,2),guidance:'两句连贯衔接。'}),group=e.getUnit(created.id);group.state='active';group.mode='scene';f.store.put('units',group,f.chapter.id);
  const audios={};
  for(const mode of ['dry','scene']) {
    const unit=e.getUnit(group.id),input=e.input(unit,mode),audio={id:uid(),chapterId:f.chapter.id,path:'group-'+mode+'.wav',input,basis:e.basis(unit,mode),prompt:compile(input),model:input.model};writeFileSync(join(f.directory,audio.path),wav());f.store.put('audios',audio,f.chapter.id);
    unit.variants[mode]={...unit.variants[mode],current:audio.id,previous:audio.id,approved:audio.id,latest:'success',review:{audioId:audio.id,basis:audio.basis,state:'passed'}};f.store.put('units',unit,f.chapter.id);audios[mode]=audio;
  }
  await updateAudioRange(f.store,{operationId:uid(),unitId:group.id,mode:'scene',audioId:audios.scene.id,expectedRevision:0,startFrame:100,endFrame:4500});
  const unitBefore=e.getUnit(group.id),rangeBefore=savedAudioRange(f.store,group.id,'scene',audios.scene.id),audiosBefore=f.store.all('audios'),singleBefore=e.getUnit(f.ids[2]),chapterBefore=f.store.get('chapters',f.chapter.id);
  for(const mode of ['dry','scene'])assert.equal(e.status(unitBefore,mode).validity,'matched');
  const result=await f.experience.run(f.request());assert.equal(result.outcome,'completed',result.error);
  const after=e.getUnit(group.id);assert.deepEqual(after,unitBefore,'不能改组状态、选版或历史听评');
  for(const mode of ['dry','scene']){assert.equal(e.status(after,mode).validity,'stale');assert.equal(e.status(after,mode).review,'pending');assert.notDeepEqual(e.basis(after,mode),audios[mode].basis);}
  assert.deepEqual(f.store.all('audios'),audiosBefore);assert.deepEqual(savedAudioRange(f.store,group.id,'scene',audios.scene.id),rangeBefore);assert.deepEqual(e.getUnit(f.ids[2]),singleBefore);
  assert.equal(f.revision(),chapterBefore.revision+1);assert.equal(f.store.get('chapters',f.chapter.id).arrangement,chapterBefore.arrangement);assert.equal(f.store.all('jobs').length,0);assert.equal(f.store.all('attempts').length,0);
});
