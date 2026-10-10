import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'真实删除界面或回调应存在');return found;}
const declared=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const component=name=>find(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name);
function projected(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+'\nreturn projected;')(...Object.values(env));}
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const defer=()=>{let resolve;return {promise:new Promise(yes=>resolve=yes),resolve:value=>resolve(value)};};
const rows=[{id:'one',order:1,text:'保留原编号的第一条'}, {id:'two',order:4,text:'第二条'}];

test('已删除列表恢复按钮绑定原编号与单条ID；锁定时禁用，空列表清楚说明',()=>{
  const restored=[],Deleted=projected(component('DeletedSegments'),{React,Dialog:'Dialog'});
  const props={chapter:{deletedSegments:rows},locked:false,onClose(){},onRestore:ids=>restored.push(ids)},tree=Deleted(props);
  button(tree,'恢复第 5 条').props.onClick();assert.deepEqual(restored,[['two']]);assert.match(text(tree),/原编号保留/);
  assert.equal(button(Deleted({...props,locked:true}),'恢复第 2 条').props.disabled,true);
  assert.match(text(Deleted({...props,chapter:{deletedSegments:[]}})),/暂无已删除台词/);
});

function openFixture(){
  const calls={reads:[],writes:[],barriers:[],modals:[],draftChecks:[],notices:[]},fresh={id:'chapter',revision:7,segments:rows,deletedSegments:rows.map(s=>({...s,id:'deleted-'+s.id,deletion:{excluded:s.id==='one'}}))};
  const env={workspace:'/fixture',chapter:{id:'chapter',revision:4},chapterRef:{current:'chapter'},connectionReady:true,locked:false,segmentDeletionIntent:{current:0},checked:['one','two','outside'],draftWorkspace:()=>env.workspace,hasDraft:id=>{calls.draftChecks.push(id);return false;},api:async path=>{calls.reads.push(path);return fresh;},withSavedDrafts:async(scope,deps,callback)=>{calls.barriers.push({scope,deps});return callback();},mutate:async(...args)=>calls.writes.push(args),setChecked:callback=>{env.checked=callback(env.checked);},setNotice:value=>calls.notices.push(value),setModal:value=>calls.modals.push(value)};
  return {env,calls,fresh,open:()=>projected(declared('onDeleteSegments'),env)};
}

test('单条与多选删除保存目标草稿并直接写一次，使用当前版本和点击时的明确ID',async()=>{
  const f=openFixture();await f.open()(['two','one']);
  assert.deepEqual(f.calls.barriers,[{scope:'chapter:chapter',deps:['segment:two','segment:one']}]);assert.deepEqual(f.calls.draftChecks,['two','one']);
  assert.deepEqual(f.calls.reads,['/chapters/chapter']);assert.deepEqual(f.calls.writes,[['segment.delete',{chapterId:'chapter',revision:7,ids:['two','one']}]]);
  assert.deepEqual(f.env.checked,['outside']);assert.match(f.calls.notices[0],/原|恢复/);assert.deepEqual(f.calls.modals,[]);
  const one=openFixture();await one.open()(['one']);assert.deepEqual(one.calls.writes,[['segment.delete',{chapterId:'chapter',revision:7,ids:['one'] }]]);assert.deepEqual(one.env.checked,['two','outside']);
});

test('删除版本冲突不重试、不清选择或原草稿；锁定与离线零读取零写入',async()=>{
  const f=openFixture(),before=[...f.env.checked];f.env.mutate=async(...args)=>{f.calls.writes.push(args);throw Object.assign(new Error('本章已在其他页面更新'),{status:409});};
  await assert.rejects(f.open()(['one']),e=>e.status===409);assert.equal(f.calls.writes.length,1);assert.deepEqual(f.env.checked,before);assert.deepEqual(f.calls.notices,[]);
  for(const state of [{locked:true},{connectionReady:false},{chapter:null}]){
    const blocked=openFixture();Object.assign(blocked.env,state);await blocked.open()(['one']);assert.deepEqual(blocked.calls.reads,[]);assert.deepEqual(blocked.calls.writes,[]);
  }
});

test('读取在途期间修改选择数组不会扩大已点击的删除范围',async()=>{
  const f=openFixture(),wait=defer(),ids=['one'];f.env.api=()=>wait.promise;
  const pending=f.open()(ids);await tick();ids.push('two');f.env.checked=['one','two','outside'];wait.resolve(f.fresh);await pending;
  assert.deepEqual(f.calls.writes,[['segment.delete',{chapterId:'chapter',revision:7,ids:['one']}]]);assert.deepEqual(f.env.checked,['two','outside']);
});

test('删除或恢复写入在途切章、换工作区或新意图，迟到完成与失败都不清新页选择或提示',async()=>{
  for(const restore of [false,true])for(const failed of [false,true])for(const change of [f=>{f.env.chapterRef.current='other';},f=>{f.env.workspace='/other';},f=>{f.env.segmentDeletionIntent.current++;}]){
    const f=openFixture(),wait=defer();f.env.mutate=async(...args)=>{f.calls.writes.push(args);await wait.promise;if(failed)throw Error('迟到错误');};
    const pending=f.open()([restore?'deleted-one':'one'],restore);await tick();change(f);f.env.checked=['new-page'];wait.resolve();await pending;
    assert.equal(f.calls.writes.length,1);assert.deepEqual(f.env.checked,['new-page']);assert.deepEqual(f.calls.notices,[]);assert.deepEqual(f.calls.modals,[]);
  }
});

test('已删除列表一击恢复只提交具体ID，真实后端恢复原不朗读状态且保留原文',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'restore-deleted-ui-')),store=openStore(directory),domain=createDomain(store);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const project=domain.mutate('project.create',{name:'恢复自拟章'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'原先不朗读。\n原先朗读。',segment:true}),[first,second]=domain.list(chapter.id),rev=()=>domain.chapter(chapter.id).revision;
  domain.mutate('segment.update',{chapterId:chapter.id,revision:rev(),id:first.id,excluded:true});domain.mutate('segment.delete',{chapterId:chapter.id,revision:rev(),ids:[first.id,second.id]});
  const f=openFixture();f.env.chapter={id:chapter.id};f.env.chapterRef.current=chapter.id;f.env.api=async()=>domain.chapter(chapter.id);f.env.checked=['unrelated'];
  f.env.mutate=async(action,data)=>{f.calls.writes.push([action,data]);return domain.mutate(action,data);};
  const Deleted=projected(component('DeletedSegments'),{React,Dialog:'Dialog'}),pending=[];
  const tree=Deleted({chapter:domain.chapter(chapter.id),locked:false,onClose(){assert.fail('恢复后列表应保持可用');},onRestore:ids=>pending.push(f.open()(ids,true))});
  button(tree,'恢复第 1 条').props.onClick();await Promise.all(pending);assert.equal(f.calls.writes.length,1);
  assert.deepEqual(f.calls.writes[0][1].ids,[first.id]);assert.equal('excluded'in f.calls.writes[0][1],false);assert.equal(store.get('segments',first.id).excluded,true);assert.equal(store.get('segments',first.id).text,first.text);
  assert.ok(store.get('segments',second.id).deletion);assert.deepEqual(f.env.checked,['unrelated']);assert.deepEqual(f.calls.modals,[]);
  button(tree,'恢复第 2 条').props.onClick();await Promise.all(pending);assert.equal(f.calls.writes.length,2);
  assert.deepEqual(f.calls.writes[1][1].ids,[second.id]);assert.equal(store.get('segments',second.id).excluded,false);assert.equal(store.get('segments',second.id).deletion,undefined);assert.equal(store.get('segments',second.id).text,second.text);
});

test('实际保存屏障只等待目标草稿，非目标同章、其他章和场景草稿不提交也不丢弃',async()=>{
  const compile=path=>ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const apiUrl='data:text/javascript;base64,'+Buffer.from(compile('../src/api.ts')).toString('base64');
  const module=await import('data:text/javascript;base64,'+Buffer.from(compile('../src/autosave.ts').replace('"./api"',JSON.stringify(apiUrl))+'\n// '+crypto.randomUUID()).toString('base64'));
  const f=openFixture(),frozen=[],draft={text:'尚未提交的另一句'},cleanup=[];
  const register=(id,scope,dependencies,flush,freeze=()=>{})=>cleanup.push(module.registerDraftSave(id,{scope,dependencies,dirty:()=>true,state:()=> 'local',flush,freeze}));
  try{
    register('target','chapter:chapter',['segment:one'],async()=>{assert.equal(frozen.at(-1),true);f.fresh.revision++;},value=>frozen.push(value));
    for(const [id,scope,dependencies] of [['outside','chapter:chapter',['segment:outside']],['other','chapter:other',['segment:one']],['scene','chapter:chapter',['unit:one/scene']]])register(id,scope,dependencies,()=>assert.fail('无关草稿不能被删除动作提交'),()=>assert.fail('无关草稿不能被冻结'));
    f.env.withSavedDrafts=module.withSavedDrafts;f.env.mutate=async(...args)=>{assert.equal(frozen.at(-1),true,'删除落库前目标草稿仍冻结');f.calls.writes.push(args);};await f.open()(['one']);assert.deepEqual(frozen,[true,false]);assert.equal(f.calls.writes[0][1].revision,8);assert.equal(draft.text,'尚未提交的另一句');
  }finally{cleanup.forEach(remove=>remove());}
});

test('保存或核对版本期间切章、换工作区或新意图，不向迟到范围写入；目标草稿失败不读不删',async()=>{
  for(const change of [f=>{f.env.chapterRef.current='other';},f=>{f.env.workspace='/other';},f=>{f.env.segmentDeletionIntent.current++;}]){
    const f=openFixture(),wait=defer();f.env.api=async path=>{f.calls.reads.push(path);return wait.promise;};const pending=f.open()(['one']);await tick();change(f);wait.resolve(f.fresh);await pending;assert.deepEqual(f.calls.writes,[]);assert.deepEqual(f.calls.modals,[]);
  }
  const saved=openFixture(),wait=defer();saved.env.withSavedDrafts=async(scope,deps,callback)=>{await wait.promise;return callback();};const pending=saved.open()(['one']);saved.env.workspace='/new';wait.resolve();await pending;assert.deepEqual(saved.calls.reads,[]);assert.deepEqual(saved.calls.writes,[]);
  const blocked=openFixture();blocked.env.withSavedDrafts=async()=>{throw Error('目标草稿冲突');};await assert.rejects(blocked.open()(['one']),/草稿冲突/);assert.deepEqual(blocked.calls.reads,[]);assert.deepEqual(blocked.calls.writes,[]);
  const legacy=openFixture();legacy.env.hasDraft=()=>true;await assert.rejects(legacy.open()(['one']),/遗留的编辑/);assert.deepEqual(legacy.calls.reads,[]);
  const changed=openFixture();for(const ids of [[],['outside'],['one','one']])await assert.rejects(changed.open()(ids),/所选台词已变化/);assert.deepEqual(changed.calls.writes,[]);
  const wrong=openFixture();wrong.fresh.id='other';await assert.rejects(wrong.open()(['one']),/所选台词已变化/);assert.deepEqual(wrong.calls.writes,[]);
});

test('实际多选栏删除绑定checked，不改绑、生成或发送写入',async()=>{
  const bar=find(node=>ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='className'&&attr.initializer?.getText(file)==='"selection-bar"'));
  const sent=[],env={React,checked:['one','two'],locked:false,busy:false,connectionReady:true,state:{settings:{}},openUnit(){assert.fail('不能创建组');},setRebindOpen(){assert.fail('不能改绑');},generate(){assert.fail('不能生成');},mutate(){assert.fail('不能写入');},setChecked(){assert.fail('不能清选择');},run:fn=>fn(),onDeleteSegments:ids=>sent.push(ids),Users:'Users',MicVocal:'MicVocal',AudioLines:'AudioLines',CheckCheck:'CheckCheck',Trash2:'Trash2',X:'X'};
  button(projected(bar,env),'删除所选').props.onClick();assert.deepEqual(sent,[['one','two']]);
  env.busy=true;assert.equal(button(projected(bar,env),'删除所选').props.disabled,true);
});

for(const actor of ['当前页一击删除','助手或其他页刷新'])for(const stage of ['章节响应在途','状态响应在途'])test(`${actor}删除时${stage}，迟到删除前快照不能恢复被删台词`,async()=>{
  const wait=defer(),players=[],notices=[],errors=[],old={id:'chapter',revision:4,arrangement:1,playbackItems:[{id:'one',audioId:'audio-one'}]},fresh={...old,projectId:'project',revision:5,arrangement:2,segments:[rows[1]],deletedSegments:[rows[0]],playbackItems:[{id:'two',audioId:'audio-two'}],masters:[{id:'new-master',arrangement:2,mapping:[]}],units:[]};
  const state={settings:{workspaceIdentity:'/fixture'},chapters:[{id:'chapter',revision:5,arrangement:2}],jobs:[],projects:[{id:'project'}]},oldState={...state,chapters:[{id:'chapter',revision:4,arrangement:1}]};let paused=0,chapterReads=0,stateReads=0;
  const env={chapterPlaybackSnapshot:projected(declared('chapterPlaybackSnapshot'),{}),chapter:old,chapterId:'chapter',chapterRef:{current:'chapter'},projectRef:{current:'project'},stateRef:{current:oldState},playerRef:{current:{kind:'audios',id:'audio-one',chapterId:'chapter',intent:0,arrangement:1,playbackItems:old.playbackItems}},audio:{current:{pause(){paused++;},paused:true}},connectionReady:true,playIntent:{current:0},playbackPreparation:{current:null},setPlayPreparing:value=>{env.playPreparing=value;},refreshPending:{current:null},pendingPlay:{current:'chapter'},pendingPlaySnapshot:{current:{intent:0,arrangement:1,items:old.playbackItems}},chapterPlaybackSnapshots:{current:{}},bookmarks:{current:{chapter:'one'}},
    useCallback:callback=>callback,draftWorkspace:()=>'/fixture',bindDraftWorkspace(){},playbackIdentity:items=>JSON.stringify(items),active:()=>false,api:async path=>path==='/state'?++stateReads===1&&stage==='状态响应在途'?wait.promise:state:++chapterReads===1?stage==='章节响应在途'?wait.promise:old:fresh,
    segmentDeletionIntent:{current:0},locked:false,hasDraft:()=>false,withSavedDrafts:async(scope,deps,callback)=>callback(),
    setState:value=>{env.stateRef.current=value;},setChapter(){},setProjectId(){},setChapterId(){},setSelected(){},setChecked(){},setCurrentSegment(){},setLoading(){},setConnectionReady(){},setPlaying(){},setNotice:value=>notices.push(value),setError:value=>errors.push(value),setPlayer:value=>{players.push(value);env.playerRef.current=value;}};
  let deletionRead=false;const read=env.api;env.api=async path=>deletionRead&&path==='/chapters/chapter'?{...old,segments:rows,deletedSegments:[]}:read(path);
  env.pendingPlaybackRead={current:null};env.beginPlayback=projected(declared('beginPlayback'),env);env.finishPlayback=projected(declared('finishPlayback'),env);
  env.playbackReadEpoch={current:0};env.applyPlaybackChapter=projected(declared('applyPlaybackChapter'),env);
  env.refresh=projected(declared('refresh'),env);env.mutate=async()=>{deletionRead=false;await env.refresh();};const pending=projected(declared('startPlay'),env)('audios','audio-one','原台词');await tick();if(actor==='当前页一击删除'){deletionRead=true;await projected(declared('onDeleteSegments'),env)(['one']);}else await env.refresh();
  assert.ok(paused>0);assert.equal(env.pendingPlay.current,null);assert.equal(env.pendingPlaySnapshot.current,null);
  wait.resolve(stage==='章节响应在途'?old:oldState);await pending;assert.ok(!players.some(value=>value?.id==='audio-one'),'迟到核验不能重新选择已经删除的音频');assert.ok(!errors.some(value=>typeof value==='string'&&value.includes('无法核对')));
});
