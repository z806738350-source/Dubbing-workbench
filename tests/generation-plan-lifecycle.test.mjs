import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {openStore,uid} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {createWorker} from '../server/worker.mjs';
import {createExperience} from '../server/experience.mjs';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(!result&&predicate(node))result=node;if(!result)ts.forEachChild(node,visit);}visit(file);assert.ok(result,'所测 App 回调仍应存在');return result;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+'\nreturn projected;')(...Object.values(env));}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const workspaceSource=readFileSync(new URL('../src/WorkspaceExperience.tsx',import.meta.url),'utf8'),workspaceFile=ts.createSourceFile('WorkspaceExperience.tsx',workspaceSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const changesNode=workspaceFile.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='generationPlanChanges');
const changesCode=ts.transpileModule(changesNode.getText(workspaceFile).replace(/^export /,''),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
const generationPlanChanges=new Function(changesCode+';return generationPlanChanges;')();
const panel=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='GeneratePlan');
const callback=name=>panel.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(file)===name).initializer.expression;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const chapter=(revision=4,id='chapter')=>({id,projectId:'project',revision,arrangement:1,events:[],units:[],segments:['one','two'].map((id,order)=>({id,order,text:'自拟台词'+order}))});
const plan=(revision=4,ids=['one'])=>({chapterId:'chapter',revision,arrangement:1,unitIds:ids,memberIds:ids,units:ids.map(id=>({unitId:id,members:[id],mode:'dry',model:'fixture-audio',referenceVoices:[{voiceId:'voice',revision:1,fileVersion:'reference-v1'}],reuse:false,audioId:null})),model:'fixture-audio',textRequests:0,audioRequests:ids.length});

function fixture(){
  const calls={api:[],paid:[],grants:[],chapters:[],plans:[],errors:[],notices:[],refresh:0};
  const waiting=new Map();
  const env={chapter:chapter(),chapterRef:{current:'chapter'},generationIntent:{current:0},generationPlan:{plan:plan(),ids:['one'],regenerate:true,retryUnknown:true,resumeRoute:true},grantId:'old-grant',state:{jobs:[],settings:{model:'fixture-audio',routeBlocked:true}},
    playIntent:{current:0},segmentDeletionIntent:{current:0},pendingPlay:{current:null},pendingPlaySnapshot:{current:null},audio:{current:{pause(){}}},
    generationPlanChanges,withSavedDrafts:async(_scope,_dependencies,next)=>{const pending=waiting.get('save')?.shift();if(pending)await pending.promise;return next();},hasDraft:()=>false,unitHasDraft:()=>false,draftScopeRevision:(_scope,revision)=>revision,
    api:async(path,payload)=>{calls.api.push({path,payload});const pending=waiting.get(path)?.shift();if(pending)return pending.promise;return path.startsWith('/chapters/')?chapter(7):plan(payload.revision,payload.ids);},
    submitOperation:async(...args)=>{calls.paid.push(args);const pending=waiting.get('submit')?.shift();return pending?pending.promise:{outcome:'completed',jobIds:['mock-job']};},
    ensureTaskGrant:async intent=>{calls.grants.push(intent);const pending=waiting.get('grant')?.shift();return pending?pending.promise:'automatic-grant';},
    refresh:async()=>{calls.refresh++;},
    setGenerationPlan:value=>{env.generationPlan=typeof value==='function'?value(env.generationPlan):value;calls.plans.push(env.generationPlan);},
    setChapter:value=>{env.chapter=value;calls.chapters.push(value);},setChapterId:value=>{env.chapterId=value;},
    setGrantId:value=>{env.grantId=value;},setError:value=>calls.errors.push(value),setNotice:value=>calls.notices.push(value),
    setDeleteTarget(){},setRenameTarget(){},setSegmentDeletion(){},setInspectorOpen(){},setVoiceTarget(){},setUnitPanelId(){},setUnitInitialMode(){},setPlayer(){},setNavOpen(){},
  };
  env.stateRef={current:env.state};
  function render(){env.closeGeneration=project(declaration('closeGeneration'),env);env.submitGeneration=(...args)=>project(declaration('submitGeneration'),env)(...args);env.generate=project(declaration('generate'),env);return {generate:env.generate,recheck:project(callback('onRecheck'),env),close:project(callback('onClose'),env),pick:project(declaration('pickChapter'),env),submit:env.submitGeneration};}
  function defer(path){let resolve,reject;const pending={promise:new Promise((yes,no)=>{resolve=yes;reject=no;}),resolve:value=>resolve(value),reject:error=>reject(error)};waiting.set(path,[...(waiting.get(path)||[]),pending]);return pending;}
  return {env,calls,render,defer};
}

test('重新核对在章节读取期间关闭，迟到章节不能重新打开生成范围',async()=>{
  const f=fixture(),read=f.defer('/chapters/chapter'),callbacks=f.render(),pending=callbacks.recheck();
  callbacks.close();read.resolve(chapter(7));await pending;
  assert.equal(f.env.generationPlan,null,'关闭后不得重新打开计划');
  assert.deepEqual(f.calls.chapters,[],'关闭的核对不得写回迟到章节');assert.equal(f.calls.paid.length,0);
});

test('重新核对在计划读取期间关闭，迟到计划不能重新打开生成范围',async()=>{
  const f=fixture(),read=f.defer('/operations/plan'),callbacks=f.render(),pending=callbacks.recheck();await tick();
  assert.equal(f.calls.api.filter(call=>call.path==='/operations/plan').length,1);
  callbacks.close();read.resolve(plan(7));await pending;
  assert.equal(f.env.generationPlan,null,'关闭后不得重新打开计划');assert.equal(f.calls.paid.length,0);
});

test('关闭后同章第二次计划先完成，旧第一次核对迟到不能覆盖新范围',async()=>{
  const f=fixture(),read=f.defer('/chapters/chapter'),first=f.render(),pending=first.recheck();
  first.close();await f.render().generate(['two']);const second=f.env.generationPlan;
  assert.deepEqual(second.plan.memberIds,['two']);read.resolve(chapter(7));await pending;
  assert.equal(f.env.generationPlan,second,'旧操作不得覆盖已完成的第二次计划');
  assert.equal(f.calls.api.filter(call=>call.path==='/operations/plan').length,1);assert.equal(f.calls.paid.length,0);
});

test('同范围版本变化自动重新核对并继续，只提交当前版本一次',async()=>{
  const f=fixture();await f.render().recheck();
  assert.equal(f.env.chapter.revision,7);assert.equal(f.env.generationPlan,null);
  assert.equal(f.calls.grants.length,0);assert.deepEqual(f.calls.api.map(call=>call.path),['/chapters/chapter','/operations/plan']);
  assert.equal(f.calls.paid.length,1);assert.equal(f.calls.paid[0][1].revision,7);assert.deepEqual(f.calls.paid[0][1].ids,['one']);assert.equal(f.calls.paid[0][1].regenerate,true);assert.equal('grantId' in f.calls.paid[0][1],false);
  assert.equal(f.calls.paid[0][1].expectedModel,'fixture-audio');assert.deepEqual(f.calls.paid[0][1].expectedReferenceVoices,[{voiceId:'voice',revision:1,fileVersion:'reference-v1'}]);
});

test('真实按钮同一调用直接携带unknown及恢复决定，仍绑定确切attempt IDs',async()=>{
  const f=fixture();f.env.generationPlan.retryUnknown=false;f.env.generationPlan.resumeRoute=false;f.env.generationPlan.plan.outstandingAttemptIds=['attempt-original'];
  await f.render().submit('explicit-grant',{retryUnknown:true,resumeRoute:true});assert.equal(f.calls.paid.length,1);const payload=f.calls.paid[0][1];assert.equal(payload.retryUnknown,true);assert.equal(payload.resumeRoute,true);assert.deepEqual(payload.acknowledgedAttemptIds,['attempt-original']);assert.equal('grantId' in payload,false);
});

test('真实切章回调取消旧章核对，迟到读取不能触及新章或付费提交',async()=>{
  const f=fixture(),read=f.defer('/chapters/chapter'),callbacks=f.render(),pending=callbacks.recheck();
  callbacks.pick('other');read.resolve(chapter(7));await Promise.allSettled([pending]);
  assert.equal(f.env.chapterRef.current,'other');assert.equal(f.env.generationPlan,null);assert.equal(f.calls.grants.length,0);
  assert.deepEqual(f.calls.chapters,[]);assert.equal(f.calls.api.filter(call=>call.path==='/operations/plan').length,0);assert.equal(f.calls.paid.length,0);
});

test('旧核对迟到的章节或计划错误不影响同章新计划',async()=>{
  for(const path of ['/chapters/chapter','/operations/plan']){
    const f=fixture(),read=f.defer(path),callbacks=f.render(),pending=callbacks.recheck();await tick();
    callbacks.close();await f.render().generate(['two']);const second=f.env.generationPlan;
    read.reject(new Error('模拟旧操作读取失败'));await pending;
    assert.equal(f.env.generationPlan,second);assert.deepEqual(second.plan.memberIds,['two']);
    assert.deepEqual(f.calls.errors,[]);assert.equal(f.calls.paid.length,0);
  }
});

test('保存屏障等待期间关闭，免费核对与付费提交都在保存完成后取消',async()=>{
  for(const operation of ['recheck','submit']){
    const f=fixture(),saved=f.defer('save'),callbacks=f.render(),pending=callbacks[operation]();await tick();
    callbacks.close();saved.resolve();await pending;
    assert.equal(f.env.generationPlan,null);assert.equal(f.calls.paid.length,0);
    assert.equal(f.calls.api.filter(call=>call.path==='/operations/plan').length,0);
  }
});

test('同章新生成入口先完成，较旧入口的迟到计划不覆盖它',async()=>{
  const f=fixture(),read=f.defer('/operations/plan'),first=f.render(),pending=first.generate(['one']);await tick();
  await f.render().generate(['two']);const second=f.env.generationPlan;read.resolve(plan(4));await pending;
  assert.equal(f.env.generationPlan,second);assert.deepEqual(second.plan.memberIds,['two']);assert.equal(f.calls.paid.length,0);
});

test('当前核对的真实错误仍向调用者报告，不提交付费请求',async()=>{
  const f=fixture(),read=f.defer('/operations/plan'),pending=f.render().recheck();await tick();
  read.reject(new Error('模拟当前计划读取失败'));await assert.rejects(pending,/模拟当前计划读取失败/);assert.equal(f.calls.paid.length,0);
});

test('已明确提交的旧回执仍刷新任务，但不关闭后来新计划或重复付费',async()=>{
  const f=fixture(),receipt=f.defer('submit'),callbacks=f.render(),pending=callbacks.submit();await tick();
  assert.equal(f.calls.paid.length,1);callbacks.close();await f.render().generate(['two']);const second=f.env.generationPlan;
  receipt.resolve({outcome:'completed',jobIds:['mock-job']});await pending;
  assert.equal(f.env.generationPlan,second);assert.deepEqual(second.plan.memberIds,['two']);
  assert.equal(f.calls.refresh,1,'已经发送的操作回执仍需刷新任务');assert.equal(f.calls.paid.length,1);
});

test('普通一击按新计划直接生成，不读取授权、不提交旧卡范围',async()=>{
  const f=fixture();f.env.state.settings.routeBlocked=false;
  await f.render().generate(['two'],false,{regenerate:true});
  assert.equal(f.calls.paid.length,1);assert.deepEqual(f.calls.paid[0][1].ids,['two']);assert.equal(f.calls.paid[0][1].regenerate,true);
  assert.equal('grantId' in f.calls.paid[0][1],false);assert.equal(f.calls.grants.length,0);assert.equal(f.env.generationPlan,null);
});

test('普通入口等待计划期间有新范围，迟到旧计划不再发送；未知结果仍留一次决定',async()=>{
  const f=fixture();f.env.state.settings.routeBlocked=false;const slow=f.defer('/operations/plan'),first=f.render().generate(['one']);await tick();
  await f.render().generate(['two']);slow.resolve(plan());await first;
  assert.equal(f.calls.paid.length,1);assert.deepEqual(f.calls.paid[0][1].ids,['two']);assert.equal(f.env.generationPlan,null);
  const unknown=fixture();unknown.env.state.settings.routeBlocked=false;
  unknown.env.api=async(_path,p)=>({...plan(p.revision,p.ids),outstandingAttemptIds:['real-unknown-attempt']});
  await unknown.render().generate(['one']);assert.equal(unknown.calls.paid.length,0);assert.deepEqual(unknown.env.generationPlan.plan.outstandingAttemptIds,['real-unknown-attempt']);
});

test('连续版本冲突至多重核一次，保留原选择而不自动扩大范围',async()=>{
  const f=fixture();f.env.state.settings.routeBlocked=false;
  f.env.submitOperation=async(...args)=>{f.calls.paid.push(args);return{error:'本次内容已变化',errorStatus:409,jobIds:[]};};
  await f.render().generate(['two']);assert.equal(f.calls.paid.length,2);assert.equal(f.env.generationPlan.invalidated,true);assert.deepEqual(f.env.generationPlan.ids,['two']);
  assert.equal(f.calls.grants.length,0);
});

test('已有匹配待检查声音的生成所选明确重做两条，普通生成仍复用且零提交',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'selected-regenerate-')),store=openStore(directory),domain=createDomain(store);
  const projectRow=domain.mutate('project.create',{name:'自拟重做验收'}),chapterRow=domain.mutate('chapter.create',{projectId:projectRow.id,title:'第32和33句夹具',source:'第一句。\n第二句。',segment:true}),ids=domain.list(chapterRow.id).map(s=>s.id);
  const bytes=Buffer.alloc(9644);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(96000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(9600,40);
  const voice={id:uid(),name:'合法参考',state:'active',path:'reference.wav'};writeFileSync(join(directory,voice.path),bytes);store.put('voices',voice);
  const rev=()=>store.get('chapters',chapterRow.id).revision,role=store.all('roles',projectRow.id)[0];domain.mutate('role.update',{id:role.id,entityRevision:role.revision??1,chapterId:chapterRow.id,revision:rev(),voiceId:voice.id});domain.mutate('segment.confirm',{chapterId:chapterRow.id,revision:rev(),ids});
  const config={key:'fixture',model:'seed-audio-1.0',audioUrl:'https://fixture.invalid/audio'},worker=createWorker(store,domain,config),experience=createExperience(store,domain,worker,{},config);let calls=0;
  t.after(async()=>{worker.close();await worker.drain();store.close();rmSync(directory,{recursive:true,force:true});});
  t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response(bytes,{headers:{'Content-Type':'audio/wav'}});});
  worker.enqueue({kind:'generate',chapterId:chapterRow.id,revision:rev(),ids,commandId:uid()});await worker.tick();
  const current=domain.chapter(chapterRow.id);assert.ok(current.segments.every(s=>s.validity==='matched'&&s.review==='pending'));assert.equal(calls,2);
  const f=fixture();f.env.chapter=current;f.env.chapterRef.current=current.id;f.env.generationPlan=null;f.env.state.settings.routeBlocked=false;
  f.env.api=async(path,payload)=>{f.calls.api.push({path,payload});assert.equal(path,'/operations/plan');return experience.plan(payload);};
  f.env.submitOperation=async(name,request)=>{f.calls.paid.push([name,request]);return experience.run({operationId:uid(),...request});};
  await f.render().generate(ids);assert.equal(f.env.generationPlan,null);assert.equal(f.calls.api.at(-1).payload.actionKind,'updateSelected');assert.match(f.calls.notices.at(-1),/复用/);assert.equal(f.calls.paid.length,0);
  const reuse=experience.plan({...f.calls.api.at(-1).payload});assert.equal(reuse.audioRequests,0);assert.ok(reuse.units.every(u=>u.reuse));
  const selectedButton=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='button'&&node.children.some(child=>ts.isJsxText(child)&&child.getText(file).includes('生成所选')));
  const click=selectedButton.openingElement.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(file)==='onClick').initializer.expression;
  await project(click,{checked:ids,generate:f.render().generate,run:work=>work()})();
  assert.equal(f.calls.api.at(-1).payload.actionKind,'forceRegenerate');assert.equal(f.env.generationPlan,null);assert.equal(f.calls.grants.length,0);
  assert.equal(f.calls.paid.length,1);assert.equal(f.calls.paid[0][1].actionKind,'forceRegenerate');assert.deepEqual(f.calls.paid[0][1].ids,ids);assert.equal('grantId' in f.calls.paid[0][1],false);
  const job=store.all('jobs',chapterRow.id).at(-1);assert.equal(job.kind,'unit-generate');assert.deepEqual(job.unitIds,ids);assert.equal(store.all('attempts',job.id).length,2);
  await worker.tick();assert.equal(calls,4,'两条已匹配但待检查的声音均收到一次新的Mock生成请求');assert.equal(store.get('jobs',job.id).status,'success');
});

test('已知未入队409在同目标与参考身份内自动重核，最终只创建一份任务',async()=>{
  const f=fixture();f.env.state.settings.routeBlocked=false;let accepted=0;
  f.env.submitOperation=async(...args)=>{f.calls.paid.push(args);if(f.calls.paid.length===1)return{outcome:'needsInput',error:'版本已更新',errorStatus:409,jobIds:[],createdObjectIds:[]};accepted++;return{outcome:'processing',jobIds:['one-job']};};
  await f.render().generate(['one']);assert.equal(f.calls.paid.length,2,'第一次仅有拒绝回执，第二次才入队');assert.equal(accepted,1);assert.equal(f.env.generationPlan,null);
  assert.equal(f.calls.paid[1][1].revision,7);assert.deepEqual(f.calls.paid[1][1].ids,['one']);assert.deepEqual(f.calls.paid[1][1].expectedReferenceVoices,[{voiceId:'voice',revision:1,fileVersion:'reference-v1'}]);
});

test('同目标的模式、成员、参考或模型改变以及新增unknown集中留一张当前决定卡',async()=>{
  const cases=[
    ['模式',next=>{next.units[0].mode='scene';}],
    ['成员',next=>{next.memberIds=['one','two'];next.units[0].members=['one','two'];}],
    ['参考',next=>{next.units[0].referenceVoices[0].voiceId='different-voice';}],
    ['录音版本',next=>{next.units[0].referenceVoices[0].fileVersion='reference-v2';}],
    ['模型',next=>{next.model='another-model';next.units[0].model='another-model';}],
    ['请求数量',next=>{next.audioRequests=2;}],
    ['未确认请求',next=>{next.outstandingAttemptIds=['new-unknown-attempt'];}],
  ];
  for(const [label,change] of cases){
    const f=fixture();f.env.state.settings.routeBlocked=false;
    f.env.api=async(path,payload)=>{f.calls.api.push({path,payload});if(path.startsWith('/chapters/'))return chapter(7);const next=plan(payload.revision,payload.ids);change(next);return next;};
    await f.render().recheck();assert.equal(f.calls.paid.length,0,label);assert.ok(f.env.generationPlan.changes.length,label);assert.equal(f.env.generationPlan.invalidated,false,label);assert.equal(f.env.generationPlan.retryUnknown,false,label);assert.equal(f.env.generationPlan.resumeRoute,false,label);
    assert.ok(f.env.generationPlan.changes.some(detail=>detail.includes(label==='录音版本'?'参考':label)),label);
  }
});

test('已明确决定的同一unknown可继续；未决定的unknown只展示原请求ID不自动发送',async()=>{
  for(const approved of [true,false]){
    const f=fixture();f.env.state.settings.routeBlocked=false;f.env.generationPlan.plan.outstandingAttemptIds=['original-unknown'];f.env.generationPlan.retryUnknown=approved;
    const request=f.env.api;f.env.api=async(path,payload)=>path==='/operations/plan'?{...plan(payload.revision,payload.ids),outstandingAttemptIds:['original-unknown']}:request(path,payload);
    await f.render().recheck();assert.equal(f.calls.paid.length,approved?1:0);
    if(approved)assert.deepEqual(f.calls.paid[0][1].acknowledgedAttemptIds,['original-unknown']);
    else{assert.deepEqual(f.env.generationPlan.plan.outstandingAttemptIds,['original-unknown']);assert.equal(f.env.generationPlan.retryUnknown,false);}
  }
});

test('有已建任务、部分效果或unknown回执的409不自动改ID重新发送',async()=>{
  for(const receipt of [{outcome:'processing',jobIds:['already-enqueued']},{outcome:'prepared',createdObjectIds:['created-effect']},{outcome:'unknown',jobIds:[]}]){
    const f=fixture();f.env.state.settings.routeBlocked=false;f.env.submitOperation=async(...args)=>{f.calls.paid.push(args);return{...receipt,error:'请核对原操作',errorStatus:409};};
    await assert.rejects(f.render().generate(['one']),error=>error.retryClass==='check-existing-operation');assert.equal(f.calls.paid.length,1);assert.equal(f.calls.api.filter(call=>call.path==='/operations/plan').length,1);assert.equal(f.env.generationPlan,null);
  }
});
