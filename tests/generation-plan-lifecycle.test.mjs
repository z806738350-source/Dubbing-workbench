import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(!result&&predicate(node))result=node;if(!result)ts.forEachChild(node,visit);}visit(file);assert.ok(result,'所测 App 回调仍应存在');return result;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+'\nreturn projected;')(...Object.values(env));}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const panel=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='GeneratePlan');
const callback=name=>panel.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(file)===name).initializer.expression;
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const chapter=(revision=4,id='chapter')=>({id,projectId:'project',revision,arrangement:1,events:[],units:[],segments:['one','two'].map((id,order)=>({id,order,text:'自拟台词'+order}))});
const plan=(revision=4,ids=['one'])=>({chapterId:'chapter',revision,arrangement:1,unitIds:ids,memberIds:ids,units:ids.map(id=>({unitId:id,members:[id],mode:'dry',reuse:false,audioId:null})),textRequests:0,audioRequests:ids.length});

function fixture(){
  const calls={api:[],paid:[],chapters:[],plans:[],errors:[],notices:[],refresh:0};
  const waiting=new Map();
  const env={chapter:chapter(),chapterRef:{current:'chapter'},generationIntent:{current:0},generationPlan:{plan:plan(),ids:['one'],regenerate:true,retryUnknown:true,resumeRoute:true},grantId:'old-grant',state:{jobs:[]},
    playIntent:{current:0},pendingPlay:{current:null},pendingPlaySnapshot:{current:null},audio:{current:{pause(){}}},
    withSavedDrafts:async(_scope,_dependencies,next)=>{const pending=waiting.get('save')?.shift();if(pending)await pending.promise;return next();},hasDraft:()=>false,unitHasDraft:()=>false,draftScopeRevision:(_scope,revision)=>revision,
    api:async(path,payload)=>{calls.api.push({path,payload});const pending=waiting.get(path)?.shift();if(pending)return pending.promise;return path.startsWith('/chapters/')?chapter(7):plan(payload.revision,payload.ids);},
    submitOperation:async(...args)=>{calls.paid.push(args);const pending=waiting.get('submit')?.shift();return pending?pending.promise:{outcome:'completed',jobIds:['mock-job']};},
    refresh:async()=>{calls.refresh++;},
    setGenerationPlan:value=>{env.generationPlan=typeof value==='function'?value(env.generationPlan):value;calls.plans.push(env.generationPlan);},
    setChapter:value=>{env.chapter=value;calls.chapters.push(value);},setChapterId:value=>{env.chapterId=value;},
    setGrantId:value=>{env.grantId=value;},setError:value=>calls.errors.push(value),setNotice:value=>calls.notices.push(value),
    setDeleteTarget(){},setInspectorOpen(){},setVoiceTarget(){},setUnitPanelId(){},setUnitInitialMode(){},setPlayer(){},setNavOpen(){},
  };
  function render(){env.closeGeneration=project(declaration('closeGeneration'),env);env.generate=project(declaration('generate'),env);env.planIntent=project(declaration('planIntent'),env);return {generate:env.generate,recheck:project(callback('onRecheck'),env),close:project(callback('onClose'),env),grant:project(callback('onGrant'),env),pick:project(declaration('pickChapter'),env),submit:project(declaration('submitGeneration'),env)};}
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

test('正常重新核对使用新章版本并清授权，只有明确开始生成才提交一次',async()=>{
  const f=fixture();await f.render().recheck();
  assert.equal(f.env.chapter.revision,7);assert.equal(f.env.generationPlan.plan.revision,7);
  assert.deepEqual(f.env.generationPlan.ids,['one']);assert.equal(f.env.generationPlan.regenerate,true);
  assert.equal(f.env.generationPlan.retryUnknown,false);assert.equal(f.env.generationPlan.resumeRoute,false);assert.equal(f.env.grantId,null);
  assert.equal(f.calls.paid.length,0);assert.deepEqual(f.calls.api.map(call=>call.path),['/chapters/chapter','/operations/plan']);
  f.render().grant('fresh-grant');await f.render().submit();
  assert.equal(f.calls.paid.length,1);assert.equal(f.calls.paid[0][1].revision,7);assert.equal(f.calls.paid[0][1].grantId,'fresh-grant');assert.equal(f.env.generationPlan,null);
});

test('真实切章回调取消旧章核对，迟到读取不能触及新章或付费提交',async()=>{
  const f=fixture(),read=f.defer('/chapters/chapter'),callbacks=f.render(),pending=callbacks.recheck();
  callbacks.pick('other');read.resolve(chapter(7));await Promise.allSettled([pending]);
  assert.equal(f.env.chapterRef.current,'other');assert.equal(f.env.generationPlan,null);assert.equal(f.env.grantId,null);
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

test('关闭后旧授权回调迟到，不会将授权写入同章新计划',async()=>{
  const f=fixture(),old=f.render();old.close();await f.render().generate(['two']);const second=f.env.generationPlan;
  old.grant('expired-grant');assert.equal(f.env.grantId,null);assert.equal(f.env.generationPlan,second);assert.equal(f.calls.paid.length,0);
});
