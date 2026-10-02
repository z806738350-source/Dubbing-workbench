import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore, uid } from '../server/store.mjs';
import { createDomain, inputOf, basisOf } from '../server/domain.mjs';
import { compile } from '../server/templates.mjs';
import { startServer } from '../server/index.mjs';

function setup(t, source = '第一句。第二句。第三句。') {
  const dir = mkdtempSync(join(tmpdir(), 'dubbing-enhancement-domain-')), store = openStore(dir), d = createDomain(store);
  t.after(() => { store.close(); rmSync(dir, {recursive:true,force:true}); });
  const p = d.mutate('project.create', {name:'增强'}), c = d.mutate('chapter.create', {projectId:p.id,title:'样章',source,segment:true});
  const role = store.all('roles',p.id)[0], v = {id:uid(),name:'参考',state:'active',path:'voices/reference.wav'};
  mkdirSync(join(dir,'voices')); writeFileSync(join(dir,v.path),'fixture'); store.put('voices',v);
  const edit = (action, data={}) => d.mutate(action, {chapterId:c.id,revision:store.get('chapters',c.id).revision,...data});
  edit('role.update', {id:role.id,entityRevision:1,voiceId:v.id}); if (d.list(c.id).length) edit('segment.confirm', {ids:d.list(c.id).map(s=>s.id)});
  const e = d.enhancement;
  function singleAudio(s, checked=false) {
    const a={id:uid(),path:`audio/${uid()}.wav`,input:inputOf(s),basis:basisOf(s),prompt:compile(s),model:s.model};
    mkdirSync(join(dir,'audio'),{recursive:true}); writeFileSync(join(dir,a.path),'audio'); store.put('audios',a,c.id);
    s.current=a.id; s.latest='success'; if(checked){s.review={audioId:a.id,basis:basisOf(s),state:'passed'};s.approved=a.id;a.review=s.review;store.put('audios',a,c.id)}
    store.put('segments',s,c.id);e.syncLegacySegment(s);return a;
  }
  function complete(unitId, mode='dry') {
    const prepared=e.prepare({kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,unitId,mode},{model:'seed-audio-1.0'});
    const job={id:uid(),kind:'unit-generate',status:'running',...prepared.job}, a={id:uid(),jobId:job.id,...prepared.attempts[0],status:'sending'};
    store.put('jobs',job,c.id); store.put('attempts',a,job.id);
    const audio={id:a.id,path:`audio/${a.id}.wav`,input:a.input,basis:a.basis,prompt:compile(a.input),model:a.input.model};
    mkdirSync(join(dir,'audio'),{recursive:true});writeFileSync(join(dir,audio.path),'audio');store.put('audios',audio,c.id);
    const adopted=e.register(job,a,audio);job.status='success';store.put('jobs',job,c.id);a.status='success';store.put('attempts',a,job.id);return {job,a,audio,adopted};
  }
  const mutateUnit=(action,u,data={})=>edit(action,{id:u.id,unitId:u.id,entityRevision:store.get('units',u.id).revision,...data});
  return {dir,store,d,p,c,role,v,e,edit,singleAudio,complete,mutateUnit};
}

test('MR01/MR02 旧选择/提示/检查映射原ID，重复迁移不写旧记录',t=>{
  const {store,d,c,singleAudio}=setup(t), rows=d.list(c.id), a=singleAudio(rows[0],true);
  rows[0]=store.get('segments',rows[0].id); rows[0].previous=uid();
  store.put('audios',{...a,id:rows[0].previous},c.id);store.put('segments',rows[0],c.id);
  store.db.exec("DELETE FROM units; DELETE FROM settings WHERE id='data-schema'");
  const before=['segments','audios','chapters','roles','jobs','attempts'].map(table=>store.all(table));
  const next=createDomain(store),u=store.get('units',rows[0].id);
  assert.equal(u.kind,'single'); assert.deepEqual(u.members,[rows[0].id]);
  for(const key of ['current','previous','approved','review'])assert.deepEqual(u.variants.dry[key],rows[0][key]);
  assert.equal(next.enhancement.status(u,'dry').review,'passed');
  const schema=store.get('settings','data-schema'),units=store.all('units');createDomain(store);
  assert.deepEqual(store.all('units'),units);assert.deepEqual(store.get('settings','data-schema'),schema);
  assert.deepEqual(['segments','audios','chapters','roles','jobs','attempts'].map(table=>store.all(table)),before);
});

test('MR03 迁移登记失败回滚全部单元及版本标记，再开可恢复',t=>{
  const {store,d}=setup(t);store.db.exec("DELETE FROM units; DELETE FROM settings WHERE id='data-schema'");
  const old=store.all('segments'),put=store.put.bind(store);let count=0;
  t.mock.method(store,'put',(table,value,parent)=>{if(table==='units'&&++count===2)throw Error('injected migration');return put(table,value,parent)});
  assert.throws(()=>createDomain(store),/injected migration/);assert.equal(store.all('units').length,0);assert.equal(store.maybe('settings','data-schema'),null);assert.deepEqual(store.all('segments'),old);
  t.mock.restoreAll();createDomain(store);assert.equal(store.all('units').length,d.list(old[0].chapterId).length);
});

test('MR07 不支持的新模式在DDL前拒绝，启动失败清理运行标记',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'dubbing-future-schema-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=openStore(dir);store.put('settings',{id:'data-schema',version:99});store.close();
  assert.throws(()=>openStore(dir),/数据模式/);
  await assert.rejects(startServer({port:0,directory:dir,config:{model:'seed-audio-1.0'}}),/数据模式/);
  assert.equal(existsSync(join(dir,'runtime.json')),false);
  const db=new DatabaseSync(join(dir,'workbench.sqlite'),{readOnly:true});assert.equal(JSON.parse(db.prepare("SELECT data FROM settings WHERE id='data-schema'").get().data).version,99);db.close();
});

test('GU01/GU02 真实连续边界、跨章及重叠选择均拒绝并无部分组',t=>{
  const {store,d,c,p,e,edit}=setup(t),ids=d.list(c.id).map(s=>s.id);
  const other=edit('chapter.create',{projectId:p.id,title:'另章',source:'别句。',segment:true});
  for(const selected of [[ids[0],ids[2]],[ids[0],d.list(other.id)[0].id]])assert.throws(()=>edit('unit.create',{ids:selected}),/连续|同章/);
  assert.equal(store.all('units',c.id).filter(u=>u.kind==='group').length,0);
  const group=edit('unit.create',{ids:ids.slice(0,2)});assert.equal(group.state,'pending');
  assert.deepEqual(e.resolve(c.id).map(r=>r.s.id),ids);
  assert.throws(()=>edit('unit.create',{ids:ids.slice(1)}),{status:409});assert.equal(store.all('units',c.id).filter(u=>u.kind==='group').length,1);
  assert.throws(()=>edit('segment.split',{id:ids[0],offset:1}),/解除/);
  assert.throws(()=>edit('segment.merge',{id:ids[1]}),/解除/);
});

test('GU03 不同配置/同角色不同参考/模板差异不静默选第一条',t=>{
  const {store,d,c,edit,v}=setup(t),rows=d.list(c.id);
  edit('segment.update',{id:rows[1].id,config:{speech_rate:5,loudness_rate:0,pitch_rate:0}});
  assert.throws(()=>edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}),/数值配置/);
  edit('segment.update',{id:rows[1].id,config:rows[0].config});
  const second={...v,id:uid(),name:'另参考'};store.put('voices',second);edit('segment.update',{id:rows[1].id,voiceId:second.id});
  assert.throws(()=>edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}),/同角色/);
  assert.equal(store.all('units',c.id).filter(u=>u.kind==='group').length,0);
});

test('GU04 多角色共参考仍有独立槽位，引用按首次使用去重',t=>{
  const {store,d,c,p,edit,e}=setup(t),rows=d.list(c.id);
  const role=edit('role.create',{projectId:p.id,name:'另角色'});edit('segment.update',{id:rows[1].id,roleId:role.id,voiceId:rows[0].voiceId,roleConfirmed:true,identityConfirmed:true});
  const u=edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}),input=e.input(u,'dry');
  assert.equal(input.slots.length,2);assert.equal(input.referenceVoiceIds.length,1);assert.deepEqual(input.slots.map(v=>v.reference),[1,1]);assert.deepEqual(input.members.map(v=>v.text),rows.slice(0,2).map(v=>v.text));
});

test('GU05/GU07 待生成组保留single，成功一次启用，解除恢复原选择不补生成',t=>{
  const {store,d,c,e,edit,singleAudio,complete,mutateUnit}=setup(t),rows=d.list(c.id),old=singleAudio(rows[0],true);
  const u=edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}),before=store.get('chapters',c.id);
  assert.equal(e.resolve(c.id)[0].a.id,old.id);assert.equal(e.resolve(c.id).length,3);
  const done=complete(u.id);assert.equal(done.adopted,true);assert.equal(e.resolve(c.id).length,2);assert.equal(e.resolve(c.id)[0].a.id,done.audio.id);
  assert.equal(store.get('chapters',c.id).revision,before.revision);assert.equal(store.get('segments',rows[0].id).current,old.id);
  assert.throws(()=>edit('segment.review',{id:rows[0].id,audioId:old.id,basis:basisOf(rows[0]),state:'passed'}),/整组/);
  const current=store.get('units',u.id),preview=e.preview({kind:'dissolve',chapterId:c.id,revision:store.get('chapters',c.id).revision,id:u.id,entityRevision:current.revision});
  assert.equal(preview.items[0].audioId,old.id);assert.equal(preview.items[0].review,'passed');assert.equal(preview.items[1].validity,'missing');
  mutateUnit('unit.dissolve',current);assert.deepEqual(e.resolve(c.id).map(r=>r.s.id),rows.map(s=>s.id));assert.equal(store.all('audios').length,2);assert.equal(e.resolve(c.id)[1].validity,'missing');
  assert.throws(()=>e.prepareRender({kind:'export',format:'wav'},store.get('chapters',c.id)),/缺少匹配/);
});

test('GU08 同设置失败保留匹配旧声音，改字后旧组仅历史；迟到不重启解除组',t=>{
  const {store,d,c,e,edit,complete,mutateUnit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});
  const done=complete(u.id),current=store.get('units',u.id);current.variants.dry.latest='failed';store.put('units',current,c.id);
  assert.equal(e.status(current,'dry').validity,'matched');assert.equal(current.variants.dry.current,done.audio.id);
  edit('segment.update',{id:ids[0],text:'新文字。'});assert.equal(e.status(store.get('units',u.id),'dry').validity,'stale');
  mutateUnit('unit.dissolve',current);const before=e.resolve(c.id).map(r=>r.s.id);
  assert.equal(e.register({...done.job,status:'unknown'},done.a,done.audio),false);assert.deepEqual(e.resolve(c.id).map(r=>r.s.id),before);
});

test('F1 异常旧组可读诊断和明确解除，严格编排不静默遗漏成员',async t=>{
  for (const defect of ['missing','retired','excluded','blank']) await t.test(defect,t=>{
    const {store,d,c,e,edit,complete,mutateUnit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});
    complete(u.id);
    if(defect==='missing')store.db.prepare('DELETE FROM segments WHERE id=?').run(ids[0]);
    else {const s=store.get('segments',ids[0]);if(defect==='blank')s.text=' ';else s[defect]=true;store.put('segments',s,c.id);}
    const current=store.get('units',u.id),before=store.all('segments');
    assert.throws(()=>e.resolve(c.id));
    const inspected=e.inspectArrangement(c.id);assert.deepEqual(inspected.rows,[]);assert.ok(inspected.issues.length);
    const viewed=e.view(current);assert.ok(viewed.diagnostics.length);assert.deepEqual(viewed.members,ids.slice(0,2));assert.equal(viewed.variants.dry.history.length,1);
    const preview=e.preview({kind:'dissolve',chapterId:c.id,revision:store.get('chapters',c.id).revision,id:u.id,entityRevision:current.revision});
    assert.deepEqual(preview.items.map(i=>i.id),ids.slice(0,2));assert.equal(preview.items[0].mode,'dry');assert.ok(preview.items[0].diagnostics.length);
    mutateUnit('unit.dissolve',current);assert.equal(store.get('units',u.id).state,'dissolved');assert.deepEqual(store.get('units',u.id).members,ids.slice(0,2));assert.deepEqual(store.all('segments'),before);
  });
});

test('F3 持续事件按语义位置拒绝同句逆序，旧坏事件可诊断和显式修正',async t=>{
  for(const kind of ['environment','music'])await t.test(kind,t=>{
    const {store,d,c,e,edit}=setup(t),id=d.list(c.id)[0].id;
    const event=data=>edit('event.create',{unitId:id,entityRevision:store.get('units',id).revision,kind,description:'持续铺底',startMemberId:id,endMemberId:id,state:'adopted',...data});
    for(const [startPosition,endPosition] of [['after','before'],['after','during'],['during','before']])assert.throws(()=>event({startPosition,endPosition}),/顺序|范围/);
    assert.equal(store.all('events',id).length,0);
    const valid=event({startPosition:'before',endPosition:'after'});assert.equal(valid.validity,'valid');
    assert.doesNotThrow(()=>e.input(store.get('units',id),'scene'));
    const old=store.get('events',valid.id);old.startPosition='after';old.endPosition='before';store.put('events',old,id);
    const diagnosed=e.events(store.get('units',id))[0];assert.equal(diagnosed.validity,'needsReview');assert.ok(diagnosed.diagnostics.some(s=>/顺序|范围/.test(s)));
    assert.throws(()=>e.prepare({kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,unitId:id,mode:'scene'},{model:'seed-audio-1.0'}),/失效|顺序|范围/);
    assert.throws(()=>e.addEvents(id,[{...old,id:undefined}],store.get('units',id).revision),/顺序|范围/);
    const updated=edit('event.update',{unitId:id,id:old.id,entityRevision:store.get('units',id).revision,eventRevision:old.revision,startPosition:'before',endPosition:'after'});
    assert.equal(updated.validity,'needsReview');
    const verified=edit('event.reconfirm',{unitId:id,id:old.id,entityRevision:store.get('units',id).revision,eventRevision:updated.revision});assert.equal(verified.validity,'valid');
    assert.doesNotThrow(()=>e.input(store.get('units',id),'scene'));
  });
});

test('F2 拆组确认重验后台产物登记后的编排版本，过期预览不切成员mode或解除组',t=>{
  const {store,d,c,e,edit,complete,mutateUnit}=setup(t),ids=d.list(c.id).map(s=>s.id);
  complete(ids[0],'dry');const scene=complete(ids[0],'scene'),u=edit('unit.create',{ids:ids.slice(0,2)});
  const current=store.get('units',u.id),cBefore=store.get('chapters',c.id),preview=e.preview({kind:'dissolve',chapterId:c.id,revision:cBefore.revision,id:u.id,entityRevision:current.revision});
  const newer=complete(ids[0],'dry'),unitsBefore=store.all('units',c.id);assert.notEqual(newer.audio.id,preview.items[0].audioId);
  assert.equal(store.get('chapters',c.id).revision,cBefore.revision);assert.notEqual(store.get('chapters',c.id).arrangement,preview.arrangement);
  assert.throws(()=>mutateUnit('unit.dissolve',current,{arrangement:preview.arrangement}),{status:409});assert.equal(store.get('units',u.id).state,'pending');assert.deepEqual(store.all('units',c.id),unitsBefore);assert.equal(store.get('units',ids[0]).variants.dry.current,newer.audio.id);
  mutateUnit('unit.dissolve',current,{arrangement:store.get('chapters',c.id).arrangement});assert.equal(store.get('units',ids[0]).mode,'dry');assert.equal(store.get('units',ids[0]).variants.scene.current,scene.audio.id);
});

test('EX03 请求等效角色纠正保留声音匹配但不沿用组检查',t=>{
  const {store,d,c,p,e,edit,complete,mutateUnit}=setup(t),rows=d.list(c.id),u=edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}),done=complete(u.id);
  mutateUnit('unit.review',u,{mode:'dry',audioId:done.audio.id,basis:e.basis(store.get('units',u.id),'dry'),state:'passed'});
  const role=edit('role.create',{projectId:p.id,name:'身份纠正'});edit('segment.rebind',{ids:rows.slice(0,2).map(s=>s.id),roleId:role.id});
  // Overrides retain the same reference, and slot A remains slot A.
  for(const s of d.list(c.id).slice(0,2))edit('segment.update',{id:s.id,voiceId:rows[0].voiceId,identityConfirmed:true});
  const current=store.get('units',u.id),st=e.status(current,'dry');assert.equal(st.validity,'matched');assert.equal(st.review,'pending');
  assert.throws(()=>mutateUnit('unit.review',current,{mode:'dry',audioId:done.audio.id,basis:done.a.basis,state:'passed'}),{status:409});
});

test('SC03/SC04/SC05 双边界修改后复原仍需显式复核，显示名不锁存失效',t=>{
  const {store,d,c,e,role,edit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});
  const event=(data={})=>edit('event.create',{unitId:u.id,entityRevision:store.get('units',u.id).revision,kind:'environment',description:'持续轻风',startMemberId:ids[0],endMemberId:ids[1],state:'adopted',...data});
  assert.throws(()=>event({endMemberId:ids[2]}),/边界/);const sound=event();assert.equal(sound.validity,'valid');
  edit('role.update',{id:role.id,entityRevision:store.get('roles',role.id).revision??1,name:'改显示名'});assert.equal(e.events(store.get('units',u.id))[0].validity,'valid');
  assert.equal(store.get('events',sound.id).needsReview,false);
  for (const id of ids.slice(0,2)) {
    const original=store.get('segments',id).text;
    edit('segment.update',{id,text:'改变边界。'});assert.equal(store.get('events',sound.id).needsReview,true);
    edit('segment.update',{id,text:original});assert.equal(e.events(store.get('units',u.id))[0].validity,'needsReview');
    assert.throws(()=>e.prepare({kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,unitId:u.id,mode:'scene'},{model:'seed-audio-1.0'}),/失效/);
    const previous=store.get('events',sound.id);
    const renewed=edit('event.reconfirm',{unitId:u.id,id:sound.id,entityRevision:store.get('units',u.id).revision,eventRevision:previous.revision});assert.equal(renewed.revision,previous.revision+1);assert.equal(renewed.validity,'valid');assert.equal(store.get('events',sound.id).needsReview,false);
  }
});

test('SC06/SC07/SC08 干场景引用与指导分开，空切换零请求，恢复不能撤销身份',t=>{
  const {store,d,c,e,edit,complete,mutateUnit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)}),dry=complete(u.id);
  assert.throws(()=>mutateUnit('unit.switch',u,{mode:'scene'}),/没有匹配/);assert.equal(store.get('units',u.id).mode,'dry');
  mutateUnit('unit.update',u,{mode:'scene',guidance:'雨声远远铺底'});assert.equal(e.status(store.get('units',u.id),'dry').validity,'matched');
  const sound=edit('event.create',{unitId:u.id,entityRevision:store.get('units',u.id).revision,kind:'effect',description:'两下轻敲',memberId:ids[1],position:'after',state:'adopted'});
  const first=complete(u.id,'scene');const second=complete(u.id,'scene');const third=complete(u.id,'scene');let current=store.get('units',u.id);
  assert.equal(current.variants.dry.current,dry.audio.id);assert.equal(current.variants.scene.previous,second.audio.id);assert.equal(current.variants.scene.current,third.audio.id);
  mutateUnit('unit.switch',current,{mode:'dry'});assert.equal(e.resolve(c.id)[0].a.id,dry.audio.id);
  const sceneGuidance=current.variants.scene.guidance;mutateUnit('unit.update',current,{mode:'scene',guidance:'更远更轻的雨声'});
  assert.equal(e.status(store.get('units',u.id),'dry').validity,'matched');assert.equal(e.status(store.get('units',u.id),'scene').validity,'stale');
  mutateUnit('unit.restore',store.get('units',u.id),{mode:'scene',audioId:second.audio.id,restoreSettings:true});current=store.get('units',u.id);assert.equal(current.variants.scene.guidance,sceneGuidance);
  assert.equal(current.variants.dry.current,dry.audio.id);assert.equal(e.events(current).find(x=>x.id===sound.id).state,'adopted');
});

test('EX06/CP07 四层资格不能绕过，参考停用不阻断本地导出，关闭增强不拆活动组',t=>{
  const {store,d,c,e,v,edit,complete,mutateUnit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});complete(u.id);complete(ids[2]);
  const cNow=()=>store.get('chapters',c.id), payload=()=>({kind:'export',format:'wav',confirm:true,arrangement:cNow().arrangement,reviewItems:e.resolve(c.id).map(r=>({id:r.s.id,audioId:r.a.id,basis:r.basis}))});
  e.prepareRender(payload(),cNow());assert.equal(e.resolve(c.id)[0].review,'passed');assert.equal(store.get('segments',ids[0]).review,null);
  const original=store.get('voices',v.id);original.state='stopped';store.put('voices',original);assert.doesNotThrow(()=>e.prepareRender({...payload(),confirm:false},cNow()));
  const settings=store.maybe('settings','models');d.mutate('settings.update',{entityRevision:settings?.revision??1,features:{groups:false,scenes:false}});assert.equal(e.resolve(c.id)[0].s.id,u.id);
  assert.doesNotThrow(()=>e.prepareRender({...payload(),confirm:false},cNow()));
  mutateUnit('unit.review',store.get('units',u.id),{mode:'dry',audioId:e.resolve(c.id)[0].a.id,basis:e.resolve(c.id)[0].basis,state:'rework'});
  assert.throws(()=>e.prepareRender(payload(),cNow()),/返工/);
  edit('segment.update',{id:ids[2],roleConfirmed:false});assert.throws(()=>e.prepareRender(payload(),cNow()),/身份核对/);
});

test('事件创建不能覆盖其他单元记录，指导回执精确且另一页旧稿冲突',t=>{
  const {store,d,c,e,edit,mutateUnit}=setup(t),rows=d.list(c.id),single1=store.get('units',rows[0].id),single2=store.get('units',rows[1].id);
  const first=edit('event.create',{unitId:single1.id,entityRevision:single1.revision,kind:'effect',description:'一下轻敲',memberId:rows[0].id,position:'after',state:'adopted'});
  const second=edit('event.create',{id:first.id,unitId:single2.id,entityRevision:single2.revision,kind:'effect',description:'另一下轻敲',memberId:rows[1].id,position:'after',state:'adopted'});
  assert.notEqual(first.id,second.id);assert.equal(store.get('events',first.id).unitId,single1.id);
  const before=store.get('units',single1.id);const saved=mutateUnit('unit.update',before,{mode:'scene',guidance:'轻声环境'});assert.equal(saved.revision,before.revision+1);assert.equal(saved.chapterRevision,store.get('chapters',c.id).revision);
  assert.throws(()=>edit('unit.update',{id:single1.id,entityRevision:before.revision,mode:'scene',guidance:'旧稿'}),{status:409});assert.throws(()=>mutateUnit('unit.update',saved,{mode:'dry',guidance:'无效组指导'}),/片段编辑/);
});

test('SC04 失效已采用事件改描述或锚点不能自动复核，明确重新确认才恢复资格',t=>{
  const {store,d,c,e,edit}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});
  const event=edit('event.create',{unitId:u.id,entityRevision:u.revision,kind:'effect',description:'轻敲一次',memberId:ids[1],position:'after',state:'adopted'});
  edit('segment.update',{id:ids[1],text:'目标文字已改。'});
  const updated=edit('event.update',{unitId:u.id,id:event.id,entityRevision:store.get('units',u.id).revision,eventRevision:event.revision,description:'更轻的敲声',memberId:ids[0]});
  assert.equal(updated.validity,'needsReview');assert.equal(updated.revision,event.revision+1);
  assert.throws(()=>e.input(store.get('units',u.id),'scene'),/失效/);
  const verified=edit('event.reconfirm',{unitId:u.id,id:event.id,entityRevision:store.get('units',u.id).revision,eventRevision:updated.revision});assert.equal(verified.validity,'valid');
});

test('EX04 干声否定指导复用旧冲突分析器，未知配置和增强模板不能注入单条',t=>{
  const {store,d,c,e,edit}=setup(t),rows=d.list(c.id),u=edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id),guidance:'不要加入音乐或环境声'});
  assert.doesNotThrow(()=>e.input(u,'dry'));
  assert.throws(()=>edit('segment.template',{id:rows[0].id,template:'voice-design-v1',confirm:true}),/增强目标/);
  assert.throws(()=>edit('segment.update',{id:rows[0].id,config:{...rows[0].config,format:'mp3'}}),/仅允许/);
  assert.equal(store.get('segments',rows[0].id).template,'dry-v1');
});

test('TR04/TR06 结束任务补登记只归历史，显式选择匹配产物才启用，解除组不能复活',t=>{
  const {store,d,c,e,edit,complete,mutateUnit,dir}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)}),first=complete(u.id);
  const job={...first.job,id:uid(),status:'unknown'},a={...first.a,id:uid(),jobId:job.id,status:'unknown'},audio={...first.audio,id:a.id,path:`audio/${a.id}.wav`};
  store.put('jobs',job,c.id);store.put('attempts',a,job.id);writeFileSync(join(dir,audio.path),'complete history');store.put('audios',audio,c.id);
  assert.equal(e.register(job,a,audio),false);assert.equal(store.get('units',u.id).variants.dry.current,first.audio.id);
  assert.equal(e.view(store.get('units',u.id)).variants.dry.history.find(v=>v.id===audio.id).matched,true);
  const chosen=mutateUnit('unit.select-result',store.get('units',u.id),{mode:'dry',audioId:audio.id});assert.equal(chosen.variants.dry.current,audio.id);assert.equal(chosen.status.review,'pending');
  const other={...audio,id:uid(),input:{...audio.input,guidance:'新的不同设置'},prompt:compile({...audio.input,guidance:'新的不同设置'})};store.put('audios',other,c.id);
  assert.throws(()=>mutateUnit('unit.select-result',chosen,{mode:'dry',audioId:other.id}),{status:409});
  mutateUnit('unit.dissolve',chosen);assert.throws(()=>mutateUnit('unit.select-result',store.get('units',u.id),{mode:'dry',audioId:audio.id}),{status:409});
});

test('GU02 新单元请求不允许同批group+single重复覆盖或单独重做活动组成员',t=>{
  const {store,d,c,e,edit,complete}=setup(t),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids:ids.slice(0,2)});
  const p={kind:'unit-generate',chapterId:c.id,revision:store.get('chapters',c.id).revision,unitIds:[u.id,ids[0]],mode:'dry'};
  assert.throws(()=>e.prepare(p,{model:'seed-audio-1.0'}),/重复覆盖/);complete(u.id);
  assert.throws(()=>e.prepare({...p,revision:store.get('chapters',c.id).revision,unitIds:[ids[0]]},{model:'seed-audio-1.0'}),/活动组/);
});

test('MR07 升级库拒绝未升级连接DML，仍允许旧库读备份和匹配版本恢复写入',t=>{
  const {dir,store,d,p}=setup(t),before=store.get('projects',p.id),old=new DatabaseSync(join(dir,'workbench.sqlite'));
  t.after(()=>old.close());
  assert.deepEqual(JSON.parse(old.prepare('SELECT data FROM projects WHERE id=?').get(p.id).data),before);
  assert.equal(Object.values(old.prepare('PRAGMA integrity_check').get())[0],'ok');
  for(const sql of ['UPDATE projects SET data=data WHERE id=?','DELETE FROM projects WHERE id=?',"INSERT INTO projects(id,parent,data) VALUES (?,'','{}')"])
    assert.throws(()=>old.prepare(sql).run(sql.startsWith('INSERT')?uid():p.id),/workbench_schema_version/);
  assert.deepEqual(store.get('projects',p.id),before);
  const changed=d.mutate('project.rename',{id:p.id,entityRevision:before.revision??1,name:'匹配代码正常写'});assert.equal(changed.name,'匹配代码正常写');
});

test('SC02/SC04 手工来源按实际有序剧本文本验证逐字依据，变更使事件待核对',t=>{
  const {store,d,c,e,edit}=setup(t,'');
  edit('segment.create',{text:'房间安静下来。'});edit('segment.create',{text:'我轻轻推开门。'});
  const rows=d.list(c.id),voice=store.all('voices')[0];for(const s of rows)edit('segment.update',{id:s.id,voiceId:voice.id,roleConfirmed:true,identityConfirmed:true});
  const u=edit('unit.create',{ids:rows.map(s=>s.id)}),event=edit('event.create',{unitId:u.id,entityRevision:u.revision,kind:'effect',description:'一声轻门响',memberId:rows[1].id,position:'before',state:'adopted',evidence:{kind:'原文明示',quote:'我轻轻推开门。',reason:''}});
  assert.equal(event.validity,'valid');assert.equal(event.evidence.kind,'原文明示');
  edit('segment.update',{id:rows[0].id,text:'屋里依然喧闹。'});assert.equal(e.events(store.get('units',u.id))[0].validity,'needsReview');
  assert.throws(()=>edit('event.reconfirm',{unitId:u.id,id:event.id,entityRevision:store.get('units',u.id).revision,eventRevision:event.revision,evidence:{kind:'原文明示',quote:'不存在的字句。',reason:''}}),/逐字引文/);
});

test('SC02 有原文时不借手工改写正文放宽明示/推断引文',t=>{
  const {store,d,c,edit}=setup(t,'原文这一句。'),s=d.list(c.id)[0];edit('segment.update',{id:s.id,text:'改写的新字句。'});
  assert.throws(()=>edit('event.create',{unitId:s.id,entityRevision:store.get('units',s.id).revision,kind:'effect',description:'选择声音',memberId:s.id,position:'after',state:'adopted',evidence:{kind:'原文明示',quote:'改写的新字句。',reason:''}}),/逐字引文/);
});

test('SC02 非连续逐字依据片段保持分类，任一伪造片段及展示不符均拒绝',t=>{
  const {store,d,c,e,edit}=setup(t,'门开了。没人回答。窗外起风。'),ids=d.list(c.id).map(s=>s.id),u=edit('unit.create',{ids});
  const evidence={kind:'上下文推断',quote:'门开了。\n窗外起风。',quotes:['门开了。','窗外起风。'],reason:'开门与起风支持轻风场景选择'};
  const data={unitId:u.id,kind:'environment',description:'很轻的风声',memberId:ids[0],position:'during',state:'adopted'};
  const event=edit('event.create',{...data,entityRevision:u.revision,evidence});assert.equal(event.validity,'valid');assert.equal(event.evidence.kind,'上下文推断');assert.deepEqual(event.evidence.quotes,evidence.quotes);
  assert.throws(()=>edit('event.create',{...data,entityRevision:store.get('units',u.id).revision,evidence:{...evidence,quote:'门开了。\n伪造的话。',quotes:['门开了。','伪造的话。']}}),/逐字引文/);
  assert.throws(()=>edit('event.create',{...data,entityRevision:store.get('units',u.id).revision,evidence:{...evidence,quote:'展示另一句。'}}),/展示与逐字/);
  assert.equal(e.events(store.get('units',u.id)).length,1);
});

test('VS02 长章单条状态读取不为每个变体重复扫描全章，成员保护仍有效',t=>{
  const {store,d,c,e}=setup(t,Array.from({length:305},(_,i)=>`第${i+1}句。`).join('\n'));
  const rows=d.list(c.id),ids=rows.map(s=>s.id),all=store.all.bind(store);let scans=0;
  t.mock.method(store,'all',(table,parent)=>{if(table==='segments')scans++;return all(table,parent);});
  const chapter=d.chapter(c.id);
  assert.ok(scans<=4,`一次章读取进行了${scans}次全章扫描`);
  assert.deepEqual(chapter.playbackItems.flatMap(item=>item.members),ids);
  assert.deepEqual(chapter.segments.map(s=>s.id),ids);assert.equal(chapter.coverage.valid,true);
  assert.deepEqual(chapter.arrangementIssues,[]);assert.equal(chapter.units.length,305);
  assert.ok(chapter.playbackItems.every(item=>item.validity==='missing'));
  scans=0;assert.equal(d.snapshot().chapters.find(item=>item.id===c.id).productionStatus,'待生成');
  assert.ok(scans<=4,`一次快照进行了${scans}次全章扫描`);
  const segment=store.get('segments',ids[0]);
  for(const patch of [{excluded:true},{retired:true},{chapterId:'another-chapter'},{text:'　'}]){
    store.put('segments',{...segment,...patch},c.id);
    assert.throws(()=>e.members(store.get('units',segment.id)),{status:409});
  }
});

test('MR01/RG05 旧single干声审核缺model时统一读取，真实身份或设置变化仍待检查',t=>{
  const {store,d,c,e,singleAudio}=setup(t,'旧版这一句。'),s=d.list(c.id)[0],audio=singleAudio(s,true);
  delete s.model;delete s.review.basis.model;delete audio.input.model;
  store.put('segments',s,c.id);store.put('audios',audio,c.id);e.syncLegacySegment(s);
  for(const state of ['passed','rework','pending']){
    s.review.state=state;store.put('segments',s,c.id);e.syncLegacySegment(s);
    const before={segments:store.all('segments',c.id),units:store.all('units',c.id),audios:store.all('audios',c.id),chapter:store.get('chapters',c.id)};
    const chapter=d.chapter(c.id),unit=chapter.units.find(u=>u.id===s.id);
    assert.equal(chapter.segments[0].review,state);assert.equal(chapter.playbackItems[0].review,state);assert.equal(unit.variants.dry.status.review,state);
    assert.equal(d.snapshot().chapters.find(row=>row.id===c.id).productionStatus,state==='passed'?'已检查':state==='rework'?'需返工':'待检查');
    assert.deepEqual({segments:store.all('segments',c.id),units:store.all('units',c.id),audios:store.all('audios',c.id),chapter:store.get('chapters',c.id)},before);
  }
  s.review.state='passed';
  for(const patch of [{text:'已改文字。'},{roleConfirmed:false},{identityConfirmed:false},{model:'different-model'}]){
    store.put('segments',{...s,...patch},c.id);e.syncLegacySegment({...s,...patch});
    const chapter=d.chapter(c.id);assert.equal(chapter.segments[0].review,'pending');assert.equal(chapter.playbackItems[0].review,'pending');
  }
  store.put('segments',s,c.id);e.syncLegacySegment(s);
  const unit=store.get('units',s.id);unit.variants.dry.review.basis.model='different-model';store.put('units',unit,c.id);
  assert.equal(e.status(unit,'dry').validity,'matched');assert.equal(e.status(unit,'dry').review,'pending');
});

test('MR01/RG03 显式恢复旧single干声沿原审核兼容，不覆盖当前返工决定',t=>{
  const {store,d,c,e,singleAudio,mutateUnit}=setup(t,'旧版这一句。'),s=d.list(c.id)[0],old=singleAudio(s,true);
  delete s.model;delete old.input.model;delete old.review.basis.model;store.put('audios',old,c.id);
  const current=singleAudio(s);s.previous=old.id;s.approved=old.id;s.review=null;store.put('segments',s,c.id);e.syncLegacySegment(s);
  const restored=mutateUnit('unit.restore',store.get('units',s.id),{mode:'dry',audioId:old.id});
  assert.equal(restored.variants.dry.status.review,'passed');assert.equal(d.chapter(c.id).segments[0].review,'passed');
  assert.equal(store.get('audios',old.id).review.state,'passed');assert.equal(Object.hasOwn(store.get('audios',old.id).review.basis,'model'),false);
  s.current=current.id;s.previous=old.id;s.review={audioId:current.id,basis:basisOf(s),state:'rework'};store.put('segments',s,c.id);e.syncLegacySegment(s);
  const rework=mutateUnit('unit.restore',store.get('units',s.id),{mode:'dry',audioId:old.id});
  assert.equal(rework.variants.dry.status.review,'rework');assert.equal(d.chapter(c.id).segments[0].review,'rework');
});

test('RG05 group与scene审核仍严格匹配完整成员model，不套旧single兼容',t=>{
  for(const mode of ['dry','scene']){
    const {store,d,c,e,edit,complete,mutateUnit}=setup(t),rows=d.list(c.id);
    const u=mode==='dry'?edit('unit.create',{ids:rows.slice(0,2).map(s=>s.id)}):store.get('units',rows[0].id),done=complete(u.id,mode);
    mutateUnit('unit.review',store.get('units',u.id),{mode,audioId:done.audio.id,basis:e.basis(store.get('units',u.id),mode),state:'passed'});
    const current=store.get('units',u.id);assert.equal(e.status(current,mode).review,'passed');
    delete current.variants[mode].review.basis.members[0].model;store.put('units',current,c.id);
    assert.equal(e.status(current,mode).validity,'matched');assert.equal(e.status(current,mode).review,'pending');
  }
});
