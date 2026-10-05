import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const apiUrl='data:text/javascript;base64,'+Buffer.from(compile('../src/api.ts')).toString('base64');
const source=compile('../src/autosave.ts').replace('"./api"',JSON.stringify(apiUrl));
const fresh=()=>import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+crypto.randomUUID()).toString('base64'));
test('同ID换工作区不复用旧保存链、在途保存或已关闭编辑器屏障',async()=>{
  const previous=Object.getOwnPropertyDescriptor(globalThis,'sessionStorage');let identity='/A',oldRelease;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>identity}});
  try{
    const {queueDraftSave,draftScopeRevision,runDraftSave,activeDraftSave,registerDraftSave,withSavedDrafts}=await fresh();
    await queueDraftSave('chapter',1,['old'],async revision=>({revision:revision+1,changes:['old']}));
    const old=runDraftSave('same',()=>new Promise(resolve=>oldRelease=resolve));await Promise.resolve();
    registerDraftSave('same',{scope:'chapter',dependencies:['same'],dirty:()=>true,state:()=> 'local',freeze:()=>assert.fail('旧工作区不得冻结新页'),flush:()=>assert.fail('旧工作区不得从新页保存')})();
    identity='/B';assert.equal(draftScopeRevision('chapter',1),1);assert.equal(activeDraftSave('same'),undefined);
    let sent=0;await withSavedDrafts('chapter',undefined,async()=>sent++);assert.equal(sent,1);
    const current=runDraftSave('same',async()=> 'B保存');assert.equal(await current,'B保存');oldRelease('A保存');assert.equal(await old,'A保存');
    identity='/A';assert.equal(draftScopeRevision('chapter',1),2);
  }finally{oldRelease?.();if(previous)Object.defineProperty(globalThis,'sessionStorage',previous);else delete globalThis.sessionStorage;}
});
test('两个保存屏障重叠时，先完成一个不会提前解冻仍在使用的编辑',async()=>{
  const {registerDraftSave,withSavedDrafts}=await fresh(),changes=[];let first,second;
  registerDraftSave('one',{scope:'chapter',dependencies:['segment'],dirty:()=>false,state:()=> 'saved',freeze:value=>changes.push(value),flush:async()=>{}});
  const a=withSavedDrafts('chapter',undefined,()=>new Promise(resolve=>first=resolve));
  const b=withSavedDrafts('chapter',undefined,()=>new Promise(resolve=>second=resolve));
  first();await a;assert.equal(changes.at(-1),true);second();await b;assert.equal(changes.at(-1),false);
});

test('同章保存串行，只沿本页不相交依赖的确切回执推进；不能跨过外页修订',async()=>{
  const {queueDraftSave,draftScopeRevision}=await fresh();
  let release,started=0;
  const wait=new Promise(resolve=>release=resolve);
  const first=queueDraftSave('chapter:one',4,['segment:a'],async revision=>{started++;await wait;return {revision:revision+1,changes:['segment:a']};});
  const second=queueDraftSave('chapter:one',4,['segment:b'],async revision=>{started++;assert.equal(revision,5);return {revision:revision+1,changes:['segment:b']};});
  await Promise.resolve();await Promise.resolve();assert.equal(started,1);release();await Promise.all([first,second]);
  assert.equal(draftScopeRevision('chapter:one',4),6);
  await assert.rejects(queueDraftSave('chapter:one',4,['segment:a'],async()=>assert.fail('冲突不得提交')),/改变了相关设置/);
  await queueDraftSave('chapter:one',8,['segment:c'],async revision=>({revision:revision+1,changes:['segment:c']}));
  assert.equal(draftScopeRevision('chapter:one',4),6);
  await assert.rejects(queueDraftSave('chapter:two',2,['segment:c'],async()=>({revision:4,changes:[]})),/版本/);
});

test('保存屏障冻结相关本页编辑，等待成功后才派发；无关章节/变体不阻断',async()=>{
  const {registerDraftSave,withSavedDrafts}=await fresh();let sent=0;const frozen=[];
  registerDraftSave('a',{scope:'chapter:one',dependencies:['segment:a'],dirty:()=>true,state:()=> 'local',freeze:value=>frozen.push(value),flush:async()=>{assert.equal(frozen.at(-1),true);}});
  registerDraftSave('scene',{scope:'chapter:one',dependencies:['unit:a/scene'],dirty:()=>true,state:()=> 'local',freeze:()=>assert.fail('无关场景不冻结'),flush:async()=>assert.fail('无关场景不保存')});
  registerDraftSave('b',{scope:'chapter:two',dependencies:['segment:a'],dirty:()=>true,state:()=> 'local',freeze:()=>assert.fail('其他章不冻结'),flush:async()=>assert.fail('其他章不保存')});
  await withSavedDrafts('chapter:one',['segment:a'],async()=>{assert.equal(frozen.at(-1),true);sent++;});
  assert.deepEqual(frozen,[true,false]);assert.equal(sent,1);
  registerDraftSave('a',{scope:'chapter:one',dependencies:['segment:a'],dirty:()=>true,state:()=> 'conflict',freeze:()=>{},flush:async()=>{throw new Error('冲突');}});
  await assert.rejects(withSavedDrafts('chapter:one',['segment:a'],async()=>sent++),/冲突/);assert.equal(sent,1);
});

test('回执规范化只合并未续写的字段，角色声音耦合保留人工整组修改',async()=>{
  const {mergeSavedValues}=await fresh();
  const before={text:'提交',role:'A',voice:'V1',config:{speed:1,pitch:1}};
  const after={text:'续写',role:'B',voice:'V1',config:{speed:2,pitch:1}};
  const saved={text:'提交规范',role:'A',voice:'规范声音',config:{speed:1,pitch:3}};
  assert.deepEqual(mergeSavedValues(before,after,saved,[['role','voice']]),{text:'续写',role:'B',voice:'V1',config:{speed:2,pitch:3}});
});

test('空正文与未完成数字留在草稿；显式排除与合法数字可以提交',async()=>{
  const {speechDraftProblem}=await fresh();
  const value={text:'　 ',excluded:false,config:{speech_rate:0,loudness_rate:0,pitch_rate:0}};
  assert.match(speechDraftProblem(value),/正文为空/);
  assert.equal(speechDraftProblem({...value,excluded:true}),null);
  for(const input of ['','-','1.5','101'])assert.match(speechDraftProblem({...value,text:'正文',config:{...value.config,speech_rate:input}}),/数值/);
  assert.equal(speechDraftProblem({...value,text:'正文',config:{speech_rate:'1',loudness_rate:-50,pitch_rate:12}}),null);
});

test('保存丢响应查询同操作恢复；修订冲突保留具体状态，不重复POST',async()=>{
  const {saveAction}=await fresh();const fetchOriginal=globalThis.fetch;const calls=[];
  globalThis.fetch=async(path,options)=>{calls.push([path,options?.method || 'GET']);if(options)throw new TypeError('断开');return {ok:true,json:async()=>({outcome:'completed',result:{id:'created',revision:1}})};};
  try{assert.deepEqual(await saveAction('event.create',{description:'敲门'},'one'),{id:'created',revision:1});assert.deepEqual(calls,[['/api/operations','POST'],['/api/operations/one','GET']]);
    globalThis.fetch=async()=>({ok:true,json:async()=>({outcome:'needsInput',error:'版本不同',errorStatus:409})});
    await assert.rejects(saveAction('event.update',{},'two'),error=>error.status === 409);
    calls.length=0;globalThis.fetch=async(path,options)=>{calls.push([path,options?.method || 'GET']);return {ok:true,json:async()=>({outcome:'completed',result:{id:'original-created',revision:1}})};};
    assert.deepEqual(await saveAction('event.update',{id:'rebuilt'},'one',true),{id:'original-created',revision:1});
    assert.deepEqual(calls,[['/api/operations/one','GET']]);
  }finally{globalThis.fetch=fetchOriginal;}
});

test('HTTP500与无法读取的200回执均查询原保存操作，确认后不重复POST',async t=>{
  const {saveAction}=await fresh();const calls=[];let unreadable=false;
  t.mock.method(globalThis,'fetch',async(path,options)=>{calls.push([path,options?.method||'GET']);if(options)return unreadable?new Response('{lost',{status:200}):new Response(JSON.stringify({error:'服务中断',code:'operation-result-unconfirmed',retryClass:'check-existing-operation'}),{status:500});return new Response(JSON.stringify({outcome:'completed',result:{id:'created',revision:1}}));});
  for(const kind of [false,true]){unreadable=kind;calls.length=0;assert.deepEqual(await saveAction('event.create',{},'stable'),{id:'created',revision:1});assert.deepEqual(calls,[['/api/operations','POST'],['/api/operations/stable','GET']]);}
});

test('新对象回执移交失败可查询原操作，不重复推进已确认写入链',async()=>{
  const {queueDraftSave}=await fresh();let executed=0;
  const persist=async base=>{executed++;assert.equal(base,0);return {revision:1,changes:['new'],operationId:'stable'};};
  await queueDraftSave('new',0,['new'],persist);
  await queueDraftSave('new',0,['new'],persist,'stable');assert.equal(executed,2);
  // The second execution retrieves/replays the same server operation; it cannot create another object.
  await assert.rejects(queueDraftSave('new',0,['new'],persist),/改变了相关设置/);
});

test('重新挂载的编辑器等待原保存完成，同对象不会并发提交旧基准',async()=>{
  const {runDraftSave,activeDraftSave}=await fresh();let release,submitted=0;
  const waiting=new Promise(resolve=>release=resolve);
  const first=runDraftSave('same-object',async()=>{submitted++;await waiting;return 5;});
  const remounted=runDraftSave('same-object',async()=>assert.fail('不得用旧基准再次提交'));
  assert.equal(activeDraftSave('same-object'),first);await Promise.resolve();assert.equal(submitted,1);
  release();assert.equal(await remounted,5);assert.equal(activeDraftSave('same-object'),undefined);
  assert.equal(await runDraftSave('same-object',async()=>6),6);
  await assert.rejects(runDraftSave('same-object',async()=>{throw new Error('断网');}),/断网/);
  assert.equal(activeDraftSave('same-object'),undefined);
});

test('新对象稳定ID续写未挂载时屏障停止，接入目标后可转交保存',async()=>{
  const {registerDraftSave,flushRegisteredDraft,withSavedDrafts}=await fresh();let dirty=true,sent=0;
  const unmount=registerDraftSave('temporary',{scope:'chapter:one',dependencies:['events:u'],dirty:()=>dirty,state:()=> 'local',freeze:()=>{},flush:()=>flushRegisteredDraft('stable')});
  unmount();await assert.rejects(withSavedDrafts('chapter:one',['events:u'],async()=>sent++),/恢复入口/);assert.equal(sent,0);
  registerDraftSave('stable',{scope:'chapter:one',dependencies:['events:u'],dirty:()=>dirty,state:()=>dirty?'local':'saved',freeze:()=>{},flush:async()=>{dirty=false;}});
  await withSavedDrafts('chapter:one',['events:u'],async()=>sent++);assert.equal(sent,1);
});

test('关闭未创建背景只保留本机草稿；已有事件冲突、在途保存和创建后的续写仍参与屏障',async t=>{
  const {registerDraftSave,withSavedDrafts,scheduleDraftSave,hasLiveDraft,draftSaveStatus}=await fresh();
  t.mock.timers.enable({apis:['setTimeout']});
  let pending=false,targetId='',flushed=0,sent=0,release;const frozen=[];
  const waiting=new Promise(resolve=>release=resolve);
  const flush=async()=>{flushed++;if(pending)await waiting;};
  const unmount=registerDraftSave('new-background',{scope:'chapter:one',dependencies:['events:u'],dirty:()=>true,state:()=> 'local',freeze:value=>frozen.push(value),flush,deferUnmounted:()=>!pending&&!targetId});
  scheduleDraftSave('new-background',flush,20);unmount();t.mock.timers.tick(21);
  await withSavedDrafts('chapter:one',['events:u'],async()=>sent++);
  await withSavedDrafts('chapter:one',undefined,async()=>sent++);
  assert.equal(flushed,0);assert.deepEqual(frozen,[]);assert.equal(sent,2);
  assert.equal(hasLiveDraft('new-background'),true,'未完成草稿仍保留，不能把排除屏障当作丢弃');
  assert.equal(draftSaveStatus('chapter:one',['events:u']),'saved');

  let existingDirty=true;
  const removeExisting=registerDraftSave('existing-background',{scope:'chapter:one',dependencies:['events:u'],dirty:()=>existingDirty,state:()=> 'conflict',freeze:()=>{},flush:async()=>{throw new Error('已有声音背景发生冲突');}});
  await assert.rejects(withSavedDrafts('chapter:one',['events:u'],async()=>sent++),/已有声音背景发生冲突/);
  assert.equal(sent,2);assert.equal(flushed,0);assert.deepEqual(frozen,[]);
  existingDirty=false;removeExisting();

  pending=true;const barrier=withSavedDrafts('chapter:one',['events:u'],async()=>sent++);
  assert.equal(flushed,1);assert.deepEqual(frozen,[true]);assert.equal(sent,2,'在途保存回执回来前不能派发');
  release();await barrier;assert.deepEqual(frozen,[true,false]);
  pending=false;targetId='created-background';await withSavedDrafts('chapter:one',undefined,async()=>sent++);
  assert.equal(flushed,2);assert.deepEqual(frozen,[true,false,true,false]);assert.equal(sent,4);
});

test('真实未挂载判断保留同对象在途保存、未确认创建回执与损坏存储的保护',async()=>{
  const objectSource=readFileSync(new URL('../src/ObjectDraft.tsx',import.meta.url),'utf8');
  const file=ts.createSourceFile('ObjectDraft.tsx',objectSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let callback;function visit(node){if(ts.isPropertyAssignment(node)&&node.name.getText(file)==='deferUnmounted')callback=node.initializer;else ts.forEachChild(node,visit);}visit(file);
  assert.ok(callback,'必须测试ObjectDraft生产注册中的原始回调');
  const compiled=ts.transpileModule('const callback=('+callback.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const {registerDraftSave,withSavedDrafts,runDraftSave,activeDraftSave,saveOperationId,pendingSaveOperation,forgetSaveOperation,draftSaveStatus}=await fresh();
  const descriptors=['localStorage','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]),storage=new Map();let storageFailure=false;
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>null}});
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:key=>{if(storageFailure)throw new Error('存储不可读');return storage.get(key)??null;},setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
  const current={current:{options:{deferUnmounted:true},targetId:undefined}},pending={current:null},key='new-background';let release,sent=0,flushed=0;
  const waiting=new Promise(resolve=>release=resolve);
  try{
    const defer=new Function('current','pending','key','activeDraftSave','pendingSaveOperation','workspaceIdentity',compiled+'\nreturn callback;')(current,pending,key,activeDraftSave,pendingSaveOperation,'');
    const unmount=registerDraftSave(key,{scope:'chapter:one',dependencies:['events:u'],dirty:()=>true,state:()=> 'local',freeze:()=>{},deferUnmounted:defer,flush:async()=>{flushed++;const active=activeDraftSave(key);if(active)return active;throw new Error('创建回执尚未确认');}});
    unmount();assert.equal(defer(),true);await withSavedDrafts('chapter:one',['events:u'],async()=>sent++);assert.equal(flushed,0);

    const saving=runDraftSave(key,async()=>waiting);assert.equal(pending.current,null);assert.equal(defer(),false);
    const barrier=withSavedDrafts('chapter:one',['events:u'],async()=>sent++);assert.equal(flushed,1);assert.equal(sent,1);
    release();await saving;await barrier;assert.equal(defer(),true);assert.equal(sent,2);

    const operationId=saveOperationId(key,{value:{description:''},revision:0,chapterRevision:13});assert.equal(pending.current,null);assert.equal(defer(),false);
    await assert.rejects(withSavedDrafts('chapter:one',['events:u'],async()=>sent++),/创建回执尚未确认/);assert.equal(sent,2);
    forgetSaveOperation(key,operationId);assert.equal(defer(),true);await withSavedDrafts('chapter:one',undefined,async()=>sent++);assert.equal(sent,3);

    for(const raw of ['{',JSON.stringify({id:operationId,signature:'{'})]){
      storage.set('pending-save:page:'+key,raw);assert.doesNotThrow(()=>assert.equal(defer(),false));
      assert.doesNotThrow(()=>assert.equal(draftSaveStatus('chapter:one'),'local'));
    }
    storage.clear();storageFailure=true;assert.doesNotThrow(()=>assert.equal(defer(),false));assert.doesNotThrow(()=>assert.equal(draftSaveStatus('chapter:one'),'local'));
    storageFailure=false;assert.equal(defer(),true);current.current.targetId='created-background';assert.equal(defer(),false);
  }finally{release();for(const [key,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
});

test('真实新建对戏准备关闭后保留草稿而不阻塞全章，重开或未知创建回执仍受保护',async()=>{
  const unitSource=readFileSync(new URL('../src/UnitPanel.tsx',import.meta.url),'utf8'),unitFile=ts.createSourceFile('UnitPanel.tsx',unitSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let group,call;function unitNode(node){if(ts.isFunctionDeclaration(node)&&node.name?.text==='CreateGroup')group=node;else ts.forEachChild(node,unitNode);}unitNode(unitFile);
  function groupNode(node){if(ts.isCallExpression(node)&&node.expression.getText(unitFile)==='useObjectDraft')call=node;else ts.forEachChild(node,groupNode);}assert.ok(group);groupNode(group);assert.ok(call);
  const expression=node=>ts.transpileModule('const result=('+node.getText(unitFile)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nreturn result;';
  const chapter={id:'one',revision:13},options=new Function('chapter',expression(call.arguments[4]))(chapter),key='unit-v1/'+new Function('chapter',expression(call.arguments[1]))(chapter);
  const objectSource=readFileSync(new URL('../src/ObjectDraft.tsx',import.meta.url),'utf8'),objectFile=ts.createSourceFile('ObjectDraft.tsx',objectSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  let deferred,flushNode;function objectNode(node){if(ts.isPropertyAssignment(node)&&node.name.getText(objectFile)==='deferUnmounted')deferred=node.initializer;else if(ts.isVariableDeclaration(node)&&node.name.getText(objectFile)==='flush')flushNode=node.initializer;else ts.forEachChild(node,objectNode);}objectNode(objectFile);assert.ok(deferred);assert.ok(flushNode);
  const callback=node=>ts.transpileModule('const callback=('+node.getText(objectFile)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText+'\nreturn callback;';
  const {registerDraftSave,withSavedDrafts,hasLiveDraft,draftSaveStatus,activeDraftSave,pendingSaveOperation,saveOperationId,forgetSaveOperation,flushRegisteredDraft}=await fresh();
  const descriptors=['localStorage','sessionStorage','navigator'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]),storage=new Map();
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:name=>storage.get(name)??null,setItem:(name,value)=>storage.set(name,value),removeItem:name=>storage.delete(name)}});
  Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>null}});
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{}}});
  const current={current:{options,targetId:undefined,draft:{ids:['first','second'],guidance:'保留未发送的对戏准备'},base:0,dirty:true,chapterRevision:13}},pending={current:null};let sent=0,unmount;
  try{
    const drafts=await import('data:text/javascript;base64,'+Buffer.from(compile('../src/drafts.ts')+'\n// '+crypto.randomUUID()).toString('base64'));
    drafts.writeDraft(key,{type:'unit',version:1,value:current.current.draft},0);const kept=drafts.readDraft(key);
    const defer=new Function('current','pending','key','activeDraftSave','pendingSaveOperation','workspaceIdentity',callback(deferred))(current,pending,key,activeDraftSave,pendingSaveOperation,'');
    const flush=new Function('current','pending','hasTransferredDraft','flushRegisteredDraft','save',callback(flushNode))(current,pending,()=>false,flushRegisteredDraft,()=>assert.fail('尚未发送的对戏准备不能自行创建'));
    const register=()=>registerDraftSave(key,{scope:options.scope,dependencies:options.dependencies,dirty:()=>current.current.dirty,state:()=> 'local',freeze:()=>{},deferUnmounted:defer,flush});
    unmount=register();await assert.rejects(withSavedDrafts(options.scope,undefined,async()=>sent++),/这份编辑尚未接入自动保存/);
    unmount();await withSavedDrafts(options.scope,undefined,async()=>sent++);
    assert.equal(sent,1);assert.equal(hasLiveDraft(key),true);assert.equal(draftSaveStatus(options.scope),'saved');assert.deepEqual(drafts.readDraft(key),kept);
    unmount=register();assert.deepEqual(drafts.readDraft(key),kept,'重新打开仍能读到同一份本机准备');
    await assert.rejects(withSavedDrafts(options.scope,undefined,async()=>sent++),/这份编辑尚未接入自动保存/);assert.equal(sent,1);unmount();
    const operationId=saveOperationId(key,{value:current.current.draft,revision:0,chapterRevision:13});assert.equal(defer(),false);
    await assert.rejects(withSavedDrafts(options.scope,undefined,async()=>sent++),/这份编辑尚未接入自动保存/);assert.equal(sent,1);assert.equal(hasLiveDraft(key),true);assert.deepEqual(drafts.readDraft(key),kept);
    forgetSaveOperation(key,operationId);await withSavedDrafts(options.scope,undefined,async()=>sent++);assert.equal(sent,2);assert.deepEqual(drafts.readDraft(key),kept);
  }finally{current.current.dirty=false;unmount?.();for(const [name,descriptor]of descriptors)if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}
});
