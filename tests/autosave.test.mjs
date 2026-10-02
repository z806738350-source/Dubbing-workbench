import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compile=file=>ts.transpileModule(readFileSync(new URL(file,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const apiUrl='data:text/javascript;base64,'+Buffer.from(compile('../src/api.ts')).toString('base64');
const source=compile('../src/autosave.ts').replace('"./api"',JSON.stringify(apiUrl));
const fresh=()=>import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+crypto.randomUUID()).toString('base64'));

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
