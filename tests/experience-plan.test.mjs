import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {createExperience} from '../server/experience.mjs';

function wav() {
  const b=Buffer.alloc(9644);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(9600,40);return b;
}
async function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-plan-race-')),store=openStore(dir),d=createDomain(store);
  const project=d.mutate('project.create',{name:'生成计划并发夹具'}),chapter=d.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'一句自拟对白。',segment:true});
  const voice={id:uid(),name:'自拟参考',state:'active',revision:1,path:'reference.wav'};writeFileSync(join(dir,voice.path),wav());store.put('voices',voice);
  const rev=()=>store.get('chapters',chapter.id).revision,unitId=d.list(chapter.id)[0].id,role=store.all('roles',project.id)[0];
  d.mutate('role.update',{id:role.id,entityRevision:1,chapterId:chapter.id,revision:rev(),voiceId:voice.id});
  d.mutate('segment.confirm',{chapterId:chapter.id,revision:rev(),ids:[unitId]});
  const config={key:'fixture',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/v1/audio/speech'},worker=createWorker(store,d,config),experience=createExperience(store,d,worker,null,config);
  t.after(()=>{worker.close();store.close();rmSync(dir,{recursive:true,force:true});});
  let calls=0;t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,config.audioUrl);calls++;return new Response(wav(),{headers:{'content-type':'audio/wav'}});});
  const unit=()=>store.get('units',unitId);
  worker.enqueue({kind:'unit-generate',chapterId:chapter.id,revision:rev(),unitIds:[unitId],mode:'dry',commandId:uid()});await worker.tick();
  d.mutate('unit.update',{chapterId:chapter.id,revision:rev(),unitId,entityRevision:unit().revision,mode:'scene',guidance:'自拟安静室内背景，保持对白清楚'});
  worker.enqueue({kind:'unit-generate',chapterId:chapter.id,revision:rev(),unitIds:[unitId],mode:'scene',commandId:uid()});await worker.tick();
  assert.equal(calls,2);assert.equal(d.enhancement.status(unit(),'dry').validity,'matched');assert.equal(d.enhancement.status(unit(),'scene').validity,'matched');calls=0;
  const switchMode=mode=>d.mutate('unit.switch',{chapterId:chapter.id,revision:rev(),unitId,entityRevision:unit().revision,mode});
  const grant=experience.grant({grantId:uid(),projectId:project.id,chapterId:chapter.id,steps:['unit-generate'],textLimit:0,audioLimit:1});
  return {store,d,worker,experience,chapter,rev,unitId,unit,switchMode,grant,calls:()=>calls};
}

for (const entry of ['experience','worker']) for (const [from,to] of [['dry','scene'],['scene','dry']]) {
  test(`F1 ${entry} 真实FFprobe预检期间 ${from}→${to} 拒绝重新解释方案，保留音频与预算`,async t=>{
    const {store,worker,experience,chapter,rev,unitId,unit,switchMode,grant,calls}=await setup(t);
    switchMode(from);
    const before=unit(),plan=experience.plan({chapterId:chapter.id,revision:rev(),ids:[unitId],regenerate:true});
    assert.equal(plan.audioRequests,1);assert.equal(plan.units[0].mode,from);
    const pending=entry==='experience'
      ? experience.run({operationId:uid(),kind:'generateSelection',chapterId:chapter.id,revision:plan.revision,arrangement:plan.arrangement,ids:[unitId],regenerate:true,grantId:grant.grantId})
      : worker.submit({commandId:uid(),kind:'unit-generate',chapterId:chapter.id,revision:plan.revision,unitIds:[unitId],grantId:grant.grantId,requireGrant:true});
    // submit has already launched the real asynchronous FFprobe; a legal switch can still commit before enqueue.
    assert.equal(store.all('jobs').length,2);
    switchMode(to);assert.equal(rev(),plan.revision);assert.notEqual(store.get('chapters',chapter.id).arrangement,plan.arrangement);
    const result=await pending.catch(error=>({errorStatus:error.status,error:error.message}));await worker.tick();
    assert.equal(result.errorStatus,409,JSON.stringify({outcome:result.outcome,actualModes:store.all('attempts').map(a=>a.mode),calls:calls(),budget:store.get('settings',grant.id).audioUsed}));
    assert.equal(store.all('jobs').length,2);assert.equal(store.all('attempts').length,2);assert.equal(calls(),0);
    assert.equal(unit().mode,to);
    for (const mode of ['dry','scene']) { assert.deepEqual(unit().variants[mode],before.variants[mode]);assert.equal(experience.plan({chapterId:chapter.id,revision:rev(),ids:[unitId],mode}).units[0].reuse,true); }
    assert.equal(store.get('settings',grant.id).audioReserved,0);assert.equal(store.get('settings',grant.id).audioUsed,0);
  });
}
