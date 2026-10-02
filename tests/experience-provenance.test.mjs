import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {basisOf,createDomain} from '../server/domain.mjs';

function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-provenance-')),store=openStore(dir),d=createDomain(store);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const p=d.mutate('project.create',{name:'确认范围夹具'});
  const c=d.mutate('chapter.create',{projectId:p.id,title:'三句',source:'第一句。\n第二句。\n第三句。',segment:true});
  const role=store.all('roles',p.id)[0];
  const rev=()=>store.get('chapters',c.id).revision;
  const update=(action,payload)=>d.mutate(action,{chapterId:c.id,revision:rev(),...(action==='role.update'?{entityRevision:store.get('roles',payload.id).revision??1}:{}),...payload});
  const voice=()=>{const v={id:uid(),name:'夹具声音',state:'active',path:uid()+'.wav'};writeFileSync(join(dir,v.path),'fixture');store.put('voices',v);return v;};
  const v=voice();update('role.update',{id:role.id,voiceId:v.id});
  function seed() {
    const rows=d.list(c.id);assert.equal(rows.length,3);
    for(const [index,s] of rows.entries()) {
      s.roleConfirmed=true;s.identityConfirmed=true;s.protectedFields=['performance'];
      const origin={at:'2026-10-02T00:00:00.000Z',policyVersion:7,draftId:'draft-'+index,inputRevision:rev(),state:'accepted'};
      s.decisions={role:{...origin,source:'policy_ai',values:[s.roleId,s.type],sourceSpan:{start:index*4,end:index*4+4}},identity:{...origin,source:'inherited',values:[s.roleId,s.voiceId,s.voiceSource],roleId:s.roleId},performance:{...origin,source:'policy_ai',values:s.performance}};
      s.review={state:'passed',audioId:'historical-'+index,basis:basisOf(s),at:'2026-10-01T00:00:00.000Z'};
      store.put('segments',s,c.id);
    }
    return d.list(c.id);
  }
  return {store,d,p,c,role,update,voice,seed};
}

for(const roleOnly of [true,false]) test(`F2 三句仅重新确认第一句${roleOnly?'说话人':'完整身份'}，其余AI来源和听评记录原样保留`,t=>{
  const {store,d,c,update,seed}=setup(t),before=seed();
  update('segment.confirm',{ids:[before[0].id],roleOnly});
  const after=d.list(c.id);
  assert.equal(after[0].decisions.role.source,'human');
  assert.equal(after[0].decisions.role.state,'accepted');
  if(roleOnly)assert.deepEqual(after[0].decisions.identity,before[0].decisions.identity);
  else {assert.equal(after[0].decisions.identity.source,'human');assert.equal(after[0].decisions.identity.state,'accepted');}
  assert.deepEqual(after.slice(1),before.slice(1),'未选中的两句不能改写来源、策略版本、建议依据或其他字段');
  assert.deepEqual(after.map(s=>s.review),before.map(s=>s.review),'配置确认不能伪造或重写人工听评');
  assert.deepEqual(after.map(s=>s.decisions.performance),before.map(s=>s.decisions.performance));
  assert.equal(store.get('chapters',c.id).revision,before[0].decisions.role.inputRevision+1);
});

test('F2 本章角色换声只登记实际继承的句子，保留单句覆盖、其他角色和其他章',t=>{
  const {store,d,p,c,role,update,voice,seed}=setup(t);
  const rows=d.list(c.id),otherRole=d.mutate('role.create',{projectId:p.id,name:'另一个角色'});
  update('segment.update',{id:rows[1].id,voiceId:rows[1].voiceId});
  update('segment.rebind',{ids:[rows[2].id],roleId:otherRole.id});
  const before=seed();
  const other=d.mutate('chapter.create',{projectId:p.id,title:'其他章',source:'保留原声音。',segment:true}),otherBefore=d.list(other.id);
  const replacement=voice();update('role.update',{id:role.id,voiceId:replacement.id,apply:true,chapterOnly:true,identityChosen:true});
  const after=d.list(c.id);
  assert.equal(after[0].voiceId,replacement.id);assert.equal(after[0].decisions.identity.source,'inherited');
  assert.deepEqual(after[0].decisions.identity.values,[after[0].roleId,replacement.id,after[0].voiceSource]);
  assert.deepEqual(after[0].decisions.role,before[0].decisions.role);
  assert.deepEqual(after[0].review,before[0].review);
  assert.equal(after[1].voiceSource,'override');assert.deepEqual(after.slice(1),before.slice(1));
  assert.deepEqual(d.list(other.id),otherBefore);
  assert.equal(store.get('roles',role.id).voiceId,before[0].voiceId);
  assert.equal(store.get('chapters',c.id).roleVoices[role.id],replacement.id);
});
