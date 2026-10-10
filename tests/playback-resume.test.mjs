import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'实际播放回调应存在');return found;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const snapshotNode=declaration('chapterPlaybackSnapshot');
const chapterPlaybackSnapshot=project(snapshotNode,{});
const mediaEffect=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[1]?.getText(file)==='[player]').arguments[0];
const progressHook=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('const target=pendingPlaybackTarget;'));
const browserEffects=[];
function collectBrowserEffects(node){
  if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&/addEventListener\(["'](?:focus|visibilitychange)["']/.test(node.arguments[0]?.getText(file)||''))browserEffects.push(node.arguments[0]);
  ts.forEachChild(node,collectBrowserEffects);
}
collectBrowserEffects(file);
const copy=value=>structuredClone(value);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;return{promise:new Promise((done,fail)=>{resolve=done;reject=fail;}),resolve,reject};};
const statusFor=(chapter,jobs=[])=>({chapterId:chapter.id,workspaceIdentity:'/fixture',revision:chapter.revision,arrangement:chapter.arrangement,renderRevision:chapter.renderRevision??0,renderSignature:chapter.renderSignature??null,activeJobs:jobs.filter(job=>job.chapterId===chapter.id&&['queued','running','stopping'].includes(job.status))});
const variant=id=>({current:id,previous:null,approved:null,history:id?[{id}]:[]});
function chapterFixture(){
  const playbackItems=['one','two','three'].map(id=>({id,unitId:id,members:[id],mode:'dry',audioId:id+'-old',basis:{text:id},validity:'matched'}));
  return {id:'chapter',projectId:'project',title:'续播夹具',revision:1,arrangement:1,segments:playbackItems.map((item,order)=>({id:item.id,order})),playbackItems,masters:[],units:playbackItems.map(item=>({id:item.id,kind:'single',state:'active',mode:'dry',members:item.members,variants:{dry:variant(item.audioId),scene:variant(null)}}))};
}
function adopt(chapter,id,audioId,mode='dry'){
  const item=chapter.playbackItems.find(item=>item.id===id),unit=chapter.units.find(unit=>unit.id===id),v=unit.variants[mode];
  v.previous=v.current;v.current=audioId;v.history.push({id:audioId});unit.mode=mode;
  Object.assign(item,{audioId,mode,validity:'matched'});chapter.arrangement++;
}
function fixture({tracked=true}={}){
  const initial=chapterFixture(),calls={players:[],notices:[],errors:[],loads:0,plays:0,pauses:0};
  let fresh=copy(initial),jobs=[],workspace='/fixture';
  const env={chapterPlaybackSnapshot,useCallback:callback=>callback,refreshPending:{current:null},playbackReadEpoch:{current:0},chapter:initial,
    chapterRef:{current:initial.id},projectRef:{current:initial.projectId},stateRef:{current:{settings:{workspaceDirectory:workspace},chapters:[{id:initial.id,revision:initial.revision,arrangement:initial.arrangement}],jobs:[]}},playerRef:{current:null},
    chapterPlaybackSnapshots:{current:tracked?{chapter:chapterPlaybackSnapshot(copy(initial))}:{}},bookmarks:{current:{chapter:'three'}},
    pendingPlay:{current:null},pendingPlaySnapshot:{current:null},playIntent:{current:1},playbackPreparation:{current:null},pendingPlaybackRead:{current:null},rangeResume:{current:null},generationIntent:{current:0},segmentDeletionIntent:{current:0},
    draftWorkspace:()=>workspace,bindDraftWorkspace:identity=>{workspace=identity;},document:{visibilityState:'visible'},
    active:status=>['queued','running','stopping'].includes(status),playbackIdentity:items=>JSON.stringify(items),connectionMessage:'连接失败',
    api:async path=>path==='/state'?{settings:{workspaceDirectory:workspace},projects:[{id:'project'}],chapters:[{id:'chapter',projectId:'project',revision:fresh.revision,arrangement:fresh.arrangement,renderRevision:fresh.renderRevision??0}],jobs}:path.endsWith('/playback-status')?statusFor(fresh,jobs):copy(fresh),
    audio:{current:{paused:true,currentTime:0,readyState:4,getAttribute(){return this.src;},load(){calls.loads++;},play(){calls.plays++;return Promise.resolve();},pause(){calls.pauses++;this.paused=true;}}},
    setPlayer:value=>{calls.players.push(value);env.player=value;env.playerRef.current=value;},
    setNotice:value=>calls.notices.push(value),setError:value=>{if(typeof value!=='function')calls.errors.push(value);},
  };
  for(const name of ['State','Chapter','ProjectId','ChapterId','Selected','Loading','ConnectionReady','CurrentSegment','CurrentMembers','Playing','Position','Duration','Transitioning','Follow','GenerationPlan','GrantId','DeleteTarget','RenameTarget','SegmentDeletion','UnitPanelId','VoiceTarget','OldPreview','Modal','DraftSignal','PlayPreparing','PendingPlaybackTarget'])env['set'+name]=value=>{if(typeof value!=='function')env[name[0].toLowerCase()+name.slice(1)]=value;};
  env.beginPlayback=project(declaration('beginPlayback'),env);env.finishPlayback=project(declaration('finishPlayback'),env);
  env.setState=value=>{env.stateRef.current=env.state=value;};
  env.applyPlaybackChapter=(...args)=>project(declaration('applyPlaybackChapter'),env)(...args);
  env.refresh=()=>project(declaration('refresh'),env)();
  env.readPlaybackChapter=(...args)=>project(declaration('readPlaybackChapter'),env)(...args);
  env.acceptPlaybackChapter=context=>project(declaration('acceptPlaybackChapter'),env)(context);
  env.rememberPlaybackJob=job=>project(declaration('rememberPlaybackJob'),env)(job);
  return {env,calls,get fresh(){return fresh;},set fresh(value){fresh=value;},set jobs(value){jobs=value;},refresh:()=>project(declaration('refresh'),env)(),mount:()=>project(mediaEffect,env)()};
}

function progressFixture(){
  const f=fixture(),timers=new Map(),reads=[],progress={id:'local-master',chapterId:'chapter',kind:'master',status:'running',arrangement:1,renderRevision:0,renderSignature:null,error:null};let timerId=0,cleanup,deps;
  Object.assign(f.env,{chapterId:'chapter',connectionReady:true,pendingPlaybackTarget:{jobId:progress.id,chapterId:'chapter',intent:1},setPendingPlaybackTarget:next=>{f.env.pendingPlaybackTarget=typeof next==='function'?next(f.env.pendingPlaybackTarget):next;},setTimeout:(callback,ms)=>{assert.equal(ms,500);timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id)});
  f.env.pendingPlay.current='chapter';f.env.pendingPlaySnapshot.current={intent:1,jobId:progress.id,arrangement:1,renderRevision:0,renderSignature:null,items:copy(f.fresh.playbackItems)};f.env.playbackPreparation.current={key:'chapter:chapter',intent:1};
  const request=f.env.api;f.env.api=async(path,_body,_method,options)=>{reads.push({path,options});assert.ok(!_body,'进度读取不得重建任务或发送模型');return path.endsWith('/progress')?copy(progress):request(path);};
  const render=()=>{const next=project(progressHook.arguments[1],f.env);if(!deps||next.some((value,i)=>!Object.is(value,deps[i]))){cleanup?.();cleanup=project(progressHook.arguments[0],f.env)();deps=next;}};
  return{...f,timers,reads,progress,render,close:()=>cleanup?.(),poll:async()=>{const [id,callback]=[...timers][0]||[];assert.ok(callback,'下一次只读进度应已排队');timers.delete(id);callback();await tick();}};
}

async function mountBrowserEvents(f){
  let automatic;
  Object.assign(f.env,{window:new EventTarget(),document:Object.assign(new EventTarget(),{visibilityState:'visible'}),
    setInterval:callback=>{automatic=callback;return 1;},clearInterval:()=>{},refresh:f.refresh});
  const cleanups=browserEffects.map(effect=>project(effect,f.env)());
  await f.env.refreshPending.current;
  return {close:()=>cleanups.forEach(cleanup=>cleanup()),
    async poll(){automatic?.();await f.env.refreshPending.current;},
    hide:()=>{f.env.document.visibilityState='hidden';f.env.document.dispatchEvent(new Event('visibilitychange'));},
    async focus(){f.env.document.visibilityState='visible';f.env.document.dispatchEvent(new Event('visibilitychange'));f.env.window.dispatchEvent(new Event('focus'));await f.env.refreshPending.current;}};
}

test('单条和整章播放切到后台或重新聚焦仍保留播放会话，聚焦只刷新数据',async()=>{
  for(const kind of ['audios','masters']){
    const f=fixture();f.env.playerRef.current={kind,id:'current',chapterId:'chapter',arrangement:1,playbackItems:copy(f.fresh.playbackItems),intent:1};
    const events=await mountBrowserEvents(f);f.env.audio.current.paused=false;f.env.audio.current.currentTime=12;
    const player=f.env.playerRef.current,pauses=f.calls.pauses;
    for(let i=0;i<2;i++){events.hide();assert.equal(f.calls.pauses,pauses);await events.focus();}
    assert.equal(f.env.playerRef.current,player);assert.equal(f.env.playIntent.current,1);assert.equal(f.calls.pauses,pauses);
    assert.equal(f.env.audio.current.currentTime,12);assert.equal(f.calls.players.length,0);assert.equal(f.env.connectionReady,true);events.close();
  }
});

test('用户已请求的整章试听在后台准备就绪后正常开始，切出不取消请求',async()=>{
  const f=fixture(),events=await mountBrowserEvents(f);f.env.pendingPlay.current='chapter';
  f.env.pendingPlaySnapshot.current={intent:1,arrangement:1,items:copy(f.fresh.playbackItems)};
  f.jobs=[{chapterId:'chapter',kind:'master',status:'running'}];events.hide();await f.refresh();
  assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.playIntent.current,1);
  f.jobs=[];f.fresh.masters=[{id:'background-master',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:144000}]}];
  await f.refresh();assert.equal(f.calls.players.at(-1)?.id,'background-master');assert.equal(f.calls.players.at(-1)?.resumeAt,3);
  const count=f.calls.players.length;await events.focus();assert.equal(f.calls.players.length,count);events.close();
});

test('暂停或结束后切换窗口不会自动播放，已取消的整章准备也不会复活',async()=>{
  for(const ended of [false,true]){
    const f=fixture(),events=await mountBrowserEvents(f);Object.assign(f.env.audio.current,{paused:true,ended,currentTime:ended?45:12});
    events.hide();await events.focus();assert.equal(f.calls.plays,0);assert.equal(f.calls.players.length,0);assert.equal(f.env.audio.current.currentTime,ended?45:12);events.close();
  }
  const f=fixture(),events=await mountBrowserEvents(f);f.env.playIntent.current++;
  f.env.pendingPlay.current=null;f.env.pendingPlaySnapshot.current=null;events.hide();
  f.fresh.masters=[{id:'cancelled',arrangement:1,sampleRate:48000,mapping:[]}];await events.focus();assert.equal(f.calls.players.length,0);events.close();
});

test('回到页面发现版本变化或断网仍停止旧播放，恢复网络不会自动重播',async()=>{
  const changed=fixture(),events=await mountBrowserEvents(changed);
  changed.env.playerRef.current={kind:'masters',id:'old',chapterId:'chapter',arrangement:1,playbackItems:copy(changed.fresh.playbackItems),intent:1};
  events.hide();adopt(changed.fresh,'one','changed-while-away');await events.focus();
  assert.equal(changed.calls.players.at(-1),null);assert.ok(changed.calls.pauses>0);assert.equal(changed.env.playIntent.current,2);events.close();
  const offline=fixture(),browser=await mountBrowserEvents(offline);offline.env.pendingPlay.current='chapter';
  offline.env.pendingPlaySnapshot.current={intent:1,arrangement:1,items:copy(offline.fresh.playbackItems)};
  offline.env.window.dispatchEvent(new Event('offline'));assert.equal(offline.env.pendingPlay.current,null);assert.equal(offline.env.playIntent.current,2);assert.ok(offline.calls.pauses>0);
  offline.env.window.dispatchEvent(new Event('online'));await offline.env.refreshPending.current;
  assert.equal(offline.env.connectionReady,true);assert.equal(offline.calls.plays,0);assert.equal(offline.calls.players.length,0);browser.close();
});

test('已整章试听后，断点之前或之后重跑成功均移到重跑单元开头所用的稳定ID',async()=>{
  for(const id of ['one','three']){
    const f=fixture();f.env.bookmarks.current.chapter='two';adopt(f.fresh,id,id+'-new');await f.refresh();
    assert.equal(f.env.bookmarks.current.chapter,id);assert.equal(f.calls.players.length,0,'任务完成仅更新起点，不自动出声');
    assert.equal(f.env.chapterPlaybackSnapshots.current.chapter.playbackItems.find(item=>item.id===id).audioId,id+'-new');
  }
});

test('批次期间保留旧快照，全部结束后按剧本顺序定位最前面的成功采用项',async()=>{
  const f=fixture();f.jobs=[{chapterId:'chapter',status:'running'}];adopt(f.fresh,'two','two-new');await f.refresh();
  assert.equal(f.env.bookmarks.current.chapter,'three');assert.equal(f.env.chapterPlaybackSnapshots.current.chapter.playbackItems[1].audioId,'two-old');
  adopt(f.fresh,'one','one-new');f.jobs=[{chapterId:'chapter',status:'failed'}];await f.refresh();
  assert.equal(f.env.bookmarks.current.chapter,'one','批次部分失败仍可定位其中成功采用的音频');assert.equal(f.calls.players.length,0);
  await f.refresh();assert.equal(f.env.bookmarks.current.chapter,'one');
});

test('无整章试听记录、失败取消、纯编辑和历史声音切换不改章节断点',async()=>{
  const untracked=fixture({tracked:false});adopt(untracked.fresh,'one','one-new');await untracked.refresh();assert.equal(untracked.env.bookmarks.current.chapter,'three');
  for(const status of ['failed','stopped','unknown']){
    const f=fixture();f.jobs=[{chapterId:'chapter',status}];await f.refresh();assert.equal(f.env.bookmarks.current.chapter,'three');
  }
  const edited=fixture();edited.fresh.playbackItems[0].basis={text:'修改正文'};edited.fresh.playbackItems[0].validity='stale';edited.fresh.arrangement++;await edited.refresh();assert.equal(edited.env.bookmarks.current.chapter,'three');
  for(const field of ['history','current','previous','approved']){
    const f=fixture(),v=f.env.chapterPlaybackSnapshots.current.chapter.units[0].variants.scene;
    if(field==='history')v.history.push({id:'historical-scene'});else v[field]='historical-scene';
    adopt(f.fresh,'one','historical-scene','scene');await f.refresh();assert.equal(f.env.bookmarks.current.chapter,'three',field);
  }
});

test('迟到结果未采用仅加入历史，随后明确选用该旧结果也不误判为新重跑',async()=>{
  const f=fixture();f.fresh.units[0].variants.dry.history.push({id:'late-unadopted'});await f.refresh();
  assert.equal(f.env.bookmarks.current.chapter,'three');adopt(f.fresh,'one','late-unadopted');await f.refresh();assert.equal(f.env.bookmarks.current.chapter,'three');
});

test('新生成的场景声音和已存在的对戏组按实际单元定位；其他章节任务不阻塞',async()=>{
  const scene=fixture();adopt(scene.fresh,'one','scene-new','scene');scene.jobs=[{chapterId:'another',status:'running'}];await scene.refresh();assert.equal(scene.env.bookmarks.current.chapter,'one');
  const group=fixture();
  for(const c of [group.fresh,group.env.chapterPlaybackSnapshots.current.chapter]){
    c.playbackItems[1].members=['two','three'];c.units[1].members=['two','three'];c.units[1].kind='group';c.playbackItems.pop();
  }
  adopt(group.fresh,'two','group-new');await group.refresh();assert.equal(group.env.bookmarks.current.chapter,'two');
});

test('结构替换不猜旧断点，新音频未匹配或尚未实际采用时也不移动',async()=>{
  const split=fixture();split.fresh.playbackItems[0]={...split.fresh.playbackItems[0],id:'split-new',unitId:'split-new',members:['split-new'],audioId:'split-audio'};split.fresh.arrangement++;await split.refresh();assert.equal(split.env.bookmarks.current.chapter,'three');
  const stale=fixture();adopt(stale.fresh,'one','one-new');stale.fresh.playbackItems[0].validity='stale';await stale.refresh();assert.equal(stale.env.bookmarks.current.chapter,'three');
});

test('同次刷新母版就绪时先更新重跑起点，再按新时长映射定位',async()=>{
  const f=fixture();adopt(f.fresh,'two','two-new');
  f.fresh.masters=[{id:'new-master',arrangement:f.fresh.arrangement,sampleRate:48000,mapping:[{unitId:'one',startFrame:0},{unitId:'two',memberIds:['two'],startFrame:240000},{unitId:'three',startFrame:720000}]}];
  f.env.pendingPlay.current='chapter';f.env.pendingPlaySnapshot.current={intent:1,arrangement:f.fresh.arrangement,items:copy(f.fresh.playbackItems)};
  await f.refresh();assert.equal(f.env.bookmarks.current.chapter,'two');assert.equal(f.calls.players.length,1);assert.equal(f.calls.players[0].resumeAt,5);
});

test('从单条切换整章时，旧播放会话不能取消新母版准备完成后的播放',async()=>{
  const f=fixture();
  f.env.playerRef.current={kind:'audios',id:'one-old',chapterId:'chapter',arrangement:1,playbackItems:copy(f.fresh.playbackItems),intent:1};
  f.env.playIntent.current=2;f.env.pendingPlay.current='chapter';
  f.env.pendingPlaySnapshot.current={intent:2,arrangement:1,items:copy(f.fresh.playbackItems)};
  f.jobs=[{chapterId:'chapter',kind:'master',status:'running'}];await f.refresh();
  assert.equal(f.env.playIntent.current,2);assert.equal(f.env.pendingPlay.current,'chapter');
  f.jobs=[];f.fresh.masters=[{id:'prepared',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:144000}]}];
  await f.refresh();assert.equal(f.calls.players.at(-1)?.id,'prepared');assert.equal(f.calls.players.at(-1)?.resumeAt,3);
});

test('当前播放遇到本章生成任务仍会停止，且不会自动播迟到母版',async()=>{
  const f=fixture();
  f.env.playerRef.current={kind:'audios',id:'one-old',chapterId:'chapter',arrangement:1,playbackItems:copy(f.fresh.playbackItems),intent:1};
  f.jobs=[{chapterId:'chapter',kind:'unit-generate',status:'running'}];await f.refresh();
  assert.equal(f.env.playIntent.current,2);assert.equal(f.calls.players.at(-1),null);assert.ok(f.calls.pauses>0);
});

test('整章试听需要构建时，提交前就暂停并释放旧的单条播放器',async()=>{
  const f=fixture(),api=f.env.api;
  f.env.playerRef.current={kind:'audios',id:'one-old',chapterId:'chapter',intent:1};
  f.env.flushAudioRanges=async()=>{};f.env.crypto={randomUUID:()=> 'master-command'};f.env.run=fn=>fn();f.env.withSavedDrafts=(_key,_target,fn)=>fn();
  f.env.api=async(path,body)=>{
    if(path==='/jobs'){assert.equal(body.kind,'master');assert.equal(f.env.playerRef.current,null);assert.ok(f.calls.pauses>0);return {id:'job'};}
    return api(path);
  };
  await project(declaration('playChapter'),f.env)();assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.intent,2);
});

test('整章准备期间重复点击只准备一次；成品先登记、任务后完成不会吞掉续播',async()=>{
  const f=fixture(),request=f.env.api;let release,reads=0,submitted=0;
  f.env.flushAudioRanges=()=>new Promise(resolve=>release=resolve);f.env.crypto={randomUUID:()=> 'one-command'};f.env.run=fn=>fn();f.env.withSavedDrafts=(_key,_target,fn)=>fn();
  f.env.api=async(path,body)=>{if(body){submitted++;return {id:'job'};}if(path.startsWith('/chapters/'))reads++;return request(path);};
  const play=project(declaration('playChapter'),f.env),first=play();await Promise.resolve();await play();await play();
  assert.equal(f.env.playIntent.current,2);assert.equal(reads,0);release();await first;await play();
  assert.equal(submitted,1);assert.equal(reads,1);assert.equal(f.env.pendingPlaySnapshot.current.intent,2);
  f.jobs=[{chapterId:'chapter',kind:'master',status:'running'}];f.fresh.masters=[{id:'prepared',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:480000}]}];
  await f.refresh();assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.calls.players.filter(Boolean).length,0);
  f.jobs=[];await f.refresh();assert.equal(f.calls.players.at(-1)?.resumeAt,10);assert.equal(f.env.pendingPlay.current,null);
});

test('整章播放中裁剪的精确续播位置不被准备期间再点击覆盖',async()=>{
  const f=fixture();Object.assign(f.env,{chapterId:'chapter',setFollow(){},flushAudioRanges:async()=>{},run:fn=>fn(),withSavedDrafts:(_key,_target,fn)=>fn(),crypto:{randomUUID:()=> 'unused'}});
  const master={mapping:[{unitId:'two',audioId:'two-old',startFrame:240000,endFrame:480000}],sampleRate:48000};
  f.env.playerRef.current={kind:'masters',id:'old',chapterId:'chapter',master,intent:1};f.env.audio.current.paused=false;f.env.audio.current.currentTime=7;
  project(declaration('beginRangeEdit'),f.env)('two','two-old');const anchor=f.env.rangeResume.current;
  await project(declaration('playChapter'),f.env)();assert.equal(f.env.rangeResume.current,anchor);assert.equal(anchor.sourceFrame,96000);assert.equal(f.env.playIntent.current,2);
  f.fresh.masters=[{id:'new',arrangement:1,sampleRate:48000,mapping:[{unitId:'two',audioId:'two-old',startFrame:144000,endFrame:360000,clipStartFrame:48000}]}];
  await project(declaration('rangeSaved'),f.env)({chapterId:'chapter'});assert.equal(f.calls.players.at(-1)?.resumeAt,4);
});

test('裁剪等待期间该段换成新音频，按同单元开头续播，不回到整章开头',async()=>{
  const f=fixture();f.env.flushAudioRanges=async()=>{};
  f.env.rangeResume.current={kind:'masters',intent:1,chapterId:'chapter',unitId:'two',audioId:'two-old',sourceFrame:96000};
  f.fresh.masters=[{id:'new',arrangement:1,sampleRate:48000,mapping:[{unitId:'two',audioId:'two-new',startFrame:240000,endFrame:480000}]}];
  await project(declaration('rangeSaved'),f.env)({chapterId:'chapter'});assert.equal(f.calls.players.at(-1)?.resumeAt,5);
});
test('裁剪续播遇到引用语境失配，即使旧母版同签名也不播放或重新准备',async()=>{
  const f=fixture(),request=f.env.api;f.env.flushAudioRanges=async()=>{};
  f.env.rangeResume.current={kind:'masters',intent:1,chapterId:'chapter',unitId:'two',audioId:'two-old',sourceFrame:96000};
  f.fresh.masters=[{id:'old',arrangement:1,sampleRate:48000,mapping:[{unitId:'two',audioId:'two-old',startFrame:240000,endFrame:480000}]}];f.fresh.playbackItems[0].validity='stale';
  f.env.api=async(path,body)=>{assert.equal(body,undefined,'语境失效不能自动提交成品任务');return request(path);};
  await project(declaration('rangeSaved'),f.env)({chapterId:'chapter'});assert.equal(f.calls.players.length,0);assert.equal(f.env.rangeResume.current,null);assert.match(f.calls.notices.at(-1),/依据已变化/);
});

test('只有整章媒体播放建立跟踪，单条抽听不覆盖既有整章快照',async()=>{
  const f=fixture({tracked:false});f.env.player={kind:'masters',id:'master',chapterId:'chapter',master:{mapping:[]},intent:1};f.env.playerRef.current=f.env.player;f.mount();
  assert.deepEqual(f.env.chapterPlaybackSnapshots.current.chapter.playbackItems,chapterPlaybackSnapshot(f.env.chapter).playbackItems);const snapshot=f.env.chapterPlaybackSnapshots.current.chapter;
  f.env.chapter=copy(f.env.chapter);adopt(f.env.chapter,'one','one-new');f.env.player={kind:'audios',id:'one-new',chapterId:'chapter',intent:1};f.env.playerRef.current=f.env.player;f.mount();
  assert.equal(f.env.chapterPlaybackSnapshots.current.chapter,snapshot);assert.equal(f.calls.plays,2);
});

test('跨章读取迟到不改当前章节断点或快照',async()=>{
  const f=fixture();adopt(f.fresh,'one','one-new');const request=f.env.api;let resolve;
  f.env.api=path=>path==='/state'?request(path):new Promise(done=>{resolve=done;});
  const snapshot=f.env.chapterPlaybackSnapshots.current.chapter,pending=f.refresh();await new Promise(done=>setImmediate(done));f.env.chapterRef.current='another';resolve(copy(f.fresh));await pending;
  assert.equal(f.env.bookmarks.current.chapter,'three');assert.equal(f.env.chapterPlaybackSnapshots.current.chapter,snapshot);
});

test('工作区身份变化清理全部试听快照与断点，不把另一工作区的音频识别成重跑',async()=>{
  const f=fixture();adopt(f.fresh,'one','another-workspace-audio');const request=f.env.api;
  f.env.api=async path=>{const response=await request(path);if(path==='/state')response.settings.workspaceDirectory='/another-workspace';return response;};
  await f.refresh();assert.deepEqual(f.env.chapterPlaybackSnapshots.current,{});assert.deepEqual(f.env.bookmarks.current,{});assert.ok(f.calls.pauses>0);
});

test('旧状态刷新不能清掉随后提交的整章准备，任务成功后仍一次自动续播',async()=>{
  const f=fixture(),request=f.env.api;adopt(f.fresh,'two','two-regenerated');
  let releaseOldChapter,chapterReads=0,submitted=0;
  Object.assign(f.env,{flushAudioRanges:async()=>{},crypto:{randomUUID:()=> 'new-master-command'},run:fn=>fn(),withSavedDrafts:(_key,_target,fn)=>fn()});
  f.env.api=async(path,body)=>{
    if(path==='/jobs'){submitted++;f.jobs=[{id:'new-master-job',chapterId:'chapter',kind:'master',status:'running'}];return {id:'new-master-job'};}
    if(path.startsWith('/chapters/')&&++chapterReads===1)return new Promise(resolve=>releaseOldChapter=resolve);
    return request(path,body);
  };
  const oldRefresh=f.refresh();await new Promise(resolve=>setImmediate(resolve));assert.ok(releaseOldChapter,'旧刷新已经取得无master任务的/state，正在等章详情');
  await project(declaration('playChapter'),f.env)();assert.equal(submitted,1);assert.equal(f.env.pendingPlay.current,'chapter');
  const pending=f.env.pendingPlaySnapshot.current;
  releaseOldChapter(copy(f.fresh));await oldRefresh;
  assert.equal(f.env.pendingPlay.current,'chapter','较旧state里的空jobs不能取消后来建立的待播请求');assert.equal(f.env.pendingPlaySnapshot.current,pending);assert.equal(f.env.playbackPreparation.current.intent,pending.intent);
  f.jobs=[];f.fresh.masters=[{id:'prepared-after-regen',arrangement:f.fresh.arrangement,sampleRate:48000,mapping:[{unitId:'one',startFrame:0},{unitId:'two',startFrame:240000},{unitId:'three',startFrame:720000}]}];
  await f.refresh();assert.equal(f.calls.players.at(-1)?.id,'prepared-after-regen');assert.equal(f.calls.players.at(-1)?.resumeAt,5);assert.equal(f.env.pendingPlay.current,null);
  f.mount();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.plays,1);assert.equal(submitted,1);
});

test('实际媒体与刷新缓存跨多章只保留续播身份，重历史不随播放缓存累计',async t=>{
  const f=fixture({tracked:false});let fullBytes=0;
  f.env.api=async path=>path==='/state'?{settings:{workspaceDirectory:'/fixture'},projects:[{id:'project'}],chapters:[{id:f.env.chapterRef.current,projectId:'project'}],jobs:[]}:copy(f.fresh);
  for(let index=0;index<8;index++){
    const large=chapterFixture();Object.assign(large,{id:'large-'+index,revision:8,sourceVersion:3,renderRevision:5,renderSignature:'current-render',renderContentKey:'current-content',source:'自拟原文'.repeat(16384),suggestions:[{items:[{text:'自拟分析'.repeat(16384)}]}],masters:[{id:'current',mapping:[],renderRows:[{text:'自拟冻结'.repeat(16384)}]}]});
    const variant=large.units[0].variants.dry;Object.assign(variant,{latest:'unknown',outstandingAttemptIds:['pending-attempt'],revision:9,status:{validity:'matched',review:'passed',basis:{voiceId:'voice',sourceVersion:3},prompt:'自拟要求'.repeat(16384)}});variant.history[0].prompt='自拟历史'.repeat(16384);variant.history[0].input={text:'自拟冻结'.repeat(16384)};
    fullBytes+=Buffer.byteLength(JSON.stringify(large));f.fresh=large;f.env.chapter=large;f.env.chapterRef.current=large.id;f.env.bookmarks.current[large.id]='three';
    f.env.player={kind:'masters',id:'master-'+index,chapterId:large.id,arrangement:large.arrangement,playbackItems:large.playbackItems,master:{mapping:[]},intent:1};f.env.playerRef.current=f.env.player;
    f.mount();await tick();
    for(let repeat=0;repeat<3;repeat++)await f.refresh();
    const cached=f.env.chapterPlaybackSnapshots.current[large.id];
    assert.deepEqual(cached.playbackItems,large.playbackItems.map(({id,audioId})=>({id,audioId})));assert.equal(cached.units[0].variants.dry.current,variant.current);assert.deepEqual(cached.units[0].variants.dry.history.map(audio=>audio.id),variant.history.map(audio=>audio.id));
    for(const field of ['source','suggestions','masters','segments','exports'])assert.equal(Object.hasOwn(cached,field),false,field);assert.equal(Object.hasOwn(cached.units[0].variants.dry.history[0],'prompt'),false);assert.equal(Object.hasOwn(cached.units[0].variants.dry,'status'),false);assert.equal(Object.hasOwn(cached.playbackItems[0],'basis'),false);
    assert.equal(f.env.chapter.units[0].variants.dry.latest,'unknown');assert.deepEqual(f.env.chapter.units[0].variants.dry.outstandingAttemptIds,['pending-attempt']);assert.deepEqual(f.env.chapter.units[0].variants.dry.status.basis,variant.status.basis);
    assert.equal(f.env.bookmarks.current[large.id],'three');assert.equal(f.env.chapter.source,large.source,'实时章与历史数据不被缓存投影改写');
  }
  const cachedBytes=Buffer.byteLength(JSON.stringify(f.env.chapterPlaybackSnapshots.current));assert.equal(Object.keys(f.env.chapterPlaybackSnapshots.current).length,8);assert.ok(cachedBytes<fullBytes,'缓存不再持有自拟重历史');t.diagnostic(JSON.stringify({chapters:8,fullBytes,cachedBytes}));
});

test('state或chapter慢于轮询周期时，实际refresh始终只有一个在途请求链',async()=>{
  const f=fixture(),request=f.env.api;let releaseState,releaseChapter,stateReads=0,chapterReads=0;
  f.env.api=async path=>{if(path==='/state'){stateReads++;if(stateReads===1)return new Promise(resolve=>releaseState=()=>request(path).then(resolve));}else{chapterReads++;if(chapterReads===1)return new Promise(resolve=>releaseChapter=()=>request(path).then(resolve));}return request(path);};
  const first=f.refresh();assert.equal(f.refresh(),first);assert.equal(f.refresh(),first);assert.equal(stateReads,1);releaseState();await tick();assert.equal(chapterReads,1);
  assert.equal(f.refresh(),first);assert.equal(f.refresh(),first);assert.equal(stateReads,1);releaseChapter();await first;assert.equal(f.env.refreshPending.current,null);
  await f.refresh();assert.equal(stateReads,2);assert.equal(chapterReads,2);
});

test('暂停旧母版定向核对后共用断点规则，保留保存屏障重读且一次从新采用单元续播',async()=>{
  for(const prepared of [false,true]){
    const f=fixture(),reads=[],master={id:'new-master',arrangement:2,sampleRate:48000,mapping:[{unitId:'two',startFrame:240000}]};let barriers=0;
    f.env.chapter.revision=1;f.fresh.revision=2;adopt(f.fresh,'two','two-new');if(prepared)f.fresh.masters=[master];
    const state=()=>({settings:{workspaceDirectory:'/fixture'},projects:[{id:'project'}],chapters:[{id:'chapter',projectId:'project',revision:f.fresh.revision,arrangement:f.fresh.arrangement}],jobs:[]});
    f.env.stateRef.current=state();f.env.playerRef.current={kind:'masters',id:'old-master',chapterId:'chapter',arrangement:1,playbackItems:copy(f.env.chapter.playbackItems),master:{id:'old-master'},intent:0};
    Object.assign(f.env,{chapterId:'chapter',connectionReady:true,run:work=>work(),withSavedDrafts:(_scope,_ids,work)=>work(),crypto:{randomUUID:()=> 'local-master-command'},
      flushAudioRanges:async()=>{barriers++;assert.equal(f.env.bookmarks.current.chapter,'two','共享refresh必须先更新重跑断点');},
      api:async(path,body)=>{reads.push({path,body});return path==='/state'?state():path==='/jobs'?{id:'one-local-master'}:path.endsWith('/playback-status')?statusFor(f.fresh):copy(f.fresh);},
      playChapter:intent=>project(declaration('playChapter'),f.env)(intent),startPlay:(...args)=>project(declaration('startPlay'),f.env)(...args)});
    await f.env.startPlay('masters','old-master','旧整章');
    assert.equal(barriers,1);assert.deepEqual(reads.map(read=>read.path),prepared?['/chapters/chapter','/chapters/chapter/playback-status','/chapters/chapter','/chapters/chapter/playback-status']:['/chapters/chapter','/chapters/chapter/playback-status','/chapters/chapter','/jobs']);
    assert.equal(reads.filter(read=>read.body).length,prepared?0:1);assert.equal(f.env.playIntent.current,2);assert.equal(f.env.playbackPreparation.current.intent,2);assert.deepEqual(f.calls.errors,[]);
    if(prepared){assert.equal(f.calls.players.at(-1)?.id,master.id);assert.equal(f.calls.players.at(-1)?.resumeAt,5);}
    else{assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.jobId,'one-local-master');assert.equal(f.env.pendingPlaySnapshot.current.items[1].audioId,'two-new');}
  }
  const f=fixture(),reads=[];f.env.chapter.revision=1;f.fresh.revision=2;adopt(f.fresh,'two','two-new');
  f.env.stateRef.current={chapters:[{id:'chapter',revision:1,arrangement:1}],jobs:[]};f.env.playerRef.current={kind:'masters',id:'old-master',chapterId:'chapter',arrangement:1,playbackItems:copy(f.env.chapter.playbackItems),intent:0};
  Object.assign(f.env,{chapterId:'chapter',connectionReady:true,run:work=>work(),withSavedDrafts:(_scope,_ids,work)=>work(),crypto:{randomUUID:()=> 'local-master-command'},
    flushAudioRanges:async()=>{adopt(f.fresh,'three','saved-during-barrier');},
    api:async(path,body)=>{reads.push(path);return path==='/state'?{settings:{workspaceDirectory:'/fixture'},projects:[{id:'project'}],chapters:[{id:'chapter',revision:f.fresh.revision,arrangement:f.fresh.arrangement}],jobs:[]}:path==='/jobs'?{id:'one-local-master'}:path.endsWith('/playback-status')?statusFor(f.fresh):copy(f.fresh);},
    playChapter:intent=>project(declaration('playChapter'),f.env)(intent),startPlay:(...args)=>project(declaration('startPlay'),f.env)(...args)});
  await f.env.startPlay('masters','old-master','旧整章');assert.equal(f.env.pendingPlaySnapshot.current.items[2].audioId,'saved-during-barrier');assert.equal(f.env.pendingPlaySnapshot.current.arrangement,3);assert.equal(reads.filter(path=>path==='/chapters/chapter').length,2);
});

test('真实run包裹整章准备或现成母版不追加全局刷新，busy在提交或交接后立即释放',async()=>{
  for(const prepared of [false,true]){
    const f=fixture(),reads=[],busy=[],master={id:'ready-master',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:480000}]};if(prepared)f.fresh.masters=[master];
    Object.assign(f.env,{chapterId:'chapter',connectionReady:true,withSavedDrafts:(_scope,_ids,work)=>work(),flushAudioRanges:async()=>{},crypto:{randomUUID:()=> 'one-command'},setBusy:value=>{busy.push(value);f.env.busy=value;},startPlay:(...args)=>project(declaration('startPlay'),f.env)(...args)});
    const request=f.env.api;f.env.api=async(...args)=>{reads.push(args[0]);return args[0]==='/jobs'?{id:'local-master',chapterId:'chapter',kind:'master',status:'queued',done:0,total:3,stop:false,createdAt:'now'}:request(...args);};
    f.env.run=project(declaration('run'),f.env);await project(declaration('playChapter'),f.env)();
    assert.deepEqual(reads,prepared?['/chapters/chapter','/chapters/chapter/playback-status']:['/chapters/chapter','/jobs']);assert.deepEqual(busy,[true,false]);assert.equal(f.env.busy,false);assert.equal(reads.includes('/state'),false);assert.ok(f.calls.errors.every(message=>!message));
    if(prepared){assert.equal(f.calls.players.at(-1)?.id,master.id);f.mount();await tick();assert.equal(f.calls.plays,1);assert.equal(f.env.busy,false,'媒体开始后暂停按钮无需再等待全局刷新');}
    else{assert.equal(f.env.pendingPlaySnapshot.current.jobId,'local-master');assert.equal(f.env.stateRef.current.jobs.find(job=>job.id==='local-master').status,'queued');}
  }
});

test('普通mutate经真实run仍保留默认完整刷新；定向选项不削错误与busy收尾',async()=>{
  const f=fixture(),reads=[],busy=[],actions=[],request=f.env.api;
  Object.assign(f.env,{setBusy:value=>busy.push(value),action:async(name,data)=>{actions.push({name,data});return {acknowledged:true};}});
  f.env.api=async(...args)=>{reads.push(args[0]);return request(...args);};f.env.run=project(declaration('run'),f.env);
  await f.env.run(()=>project(declaration('mutate'),f.env)('segment.patch',{id:'one',text:'自拟修改'}));
  assert.equal(actions.length,1);assert.equal(actions[0].name,'segment.patch');assert.deepEqual(reads,['/state','/chapters/chapter','/state','/chapters/chapter']);assert.deepEqual(busy,[true,false]);
  reads.length=0;busy.length=0;await f.env.run(async()=>{throw Error('隔离本机准备失败');},{refresh:false});assert.deepEqual(reads,[]);assert.deepEqual(busy,[true,false]);assert.equal(f.calls.errors.at(-1),'隔离本机准备失败');
});

test('进度完成定向核对立即从精确源帧续播，慢全局响应或失败都不能覆盖新播放',async()=>{
  for(const stage of ['state','chapter'])for(const failure of [false,true]){
    const f=progressFixture(),progress=deferred(),oldRead=deferred(),request=f.env.api,oldChapter=copy(f.fresh);let first=true,active=0,peak=0,stateReads=0;
    f.env.pendingPlaySnapshot.current.anchor={unitId:'three',audioId:'three-old',sourceFrame:6000};
    f.env.api=async(...args)=>{
      const path=args[0];if(path==='/state')stateReads++;
      if(first&&path===(stage==='state'?'/state':'/chapters/chapter')){first=false;return oldRead.promise;}
      if(path.endsWith('/progress')){active++;peak=Math.max(peak,active);try{return await progress.promise;}finally{active--;}}
      return request(...args);
    };
    const waiting=f.refresh();await tick();f.render();f.render();assert.equal(active,1);assert.equal(peak,1);assert.equal(f.timers.size,0);
    f.fresh.revision=2;f.fresh.masters=[{id:'ready-master',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',audioId:'three-old',startFrame:144000,endFrame:240000}]}];
    progress.resolve({...f.progress,status:'success'});await tick();await tick();
    const player=f.calls.players.at(-1);assert.equal(player?.id,'ready-master');assert.equal(player?.resumeAt,3.125);assert.equal(f.env.pendingPlaybackTarget,null);assert.equal(f.timers.size,0);assert.equal(f.env.refreshPending.current,waiting,'新播放无需等待旧全局读取');assert.equal(f.env.stateRef.current.chapters[0].revision,2);
    if(failure)oldRead.reject(Error('旧请求迟到失败'));else oldRead.resolve(stage==='state'?{settings:{workspaceDirectory:'/fixture'},projects:[{id:'project'}],chapters:[{id:'chapter',revision:1,arrangement:1}],jobs:[]}:oldChapter);
    await waiting;assert.equal(f.calls.players.at(-1),player);assert.equal(f.env.chapter.revision,2);assert.equal(f.env.stateRef.current.chapters[0].revision,2);assert.equal(f.env.playIntent.current,1);assert.equal(stateReads,1);assert.deepEqual(f.calls.errors,[]);f.close();
  }
});

test('定向就绪核对拒绝错工作区、章节、版本、范围与异章任务，失败只回退读取不重建',async()=>{
  for(const fields of [{workspaceIdentity:'/other'},{chapterId:'other'},{revision:2},{arrangement:2},{renderRevision:1},{renderSignature:'other'},{activeJobs:[{id:'wrong',chapterId:'other',kind:'master',status:'running'}]}]){
    const f=progressFixture(),request=f.env.api;let refreshes=0;f.progress.status='success';f.env.refresh=async()=>{refreshes++;};
    f.env.api=async(...args)=>args[0].endsWith('/playback-status')?{...statusFor(f.fresh),...fields}:request(...args);
    f.render();await tick();await tick();assert.equal(refreshes,1);assert.equal(f.calls.players.length,0);assert.equal(f.env.pendingPlay.current,null);assert.equal(f.env.pendingPlaybackTarget,null);assert.ok(f.calls.errors.length);assert.equal(f.reads.some(read=>read.body),false);f.close();
  }
  const changed=progressFixture(),actual=changed.env.api;changed.progress.status='success';changed.fresh.masters=[{id:'ready-but-scope-changed',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:144000}]}];
  changed.env.api=async(...args)=>args[0].endsWith('/playback-status')?{...statusFor(changed.fresh),renderRevision:1}:actual(...args);
  changed.render();await tick();await tick();assert.equal(changed.calls.players.length,0,'发现scope变动后，全局fallback也不能自动采用旧待播意图');assert.equal(changed.env.pendingPlay.current,null);assert.equal(changed.env.pendingPlaybackTarget,null);changed.close();
  const f=progressFixture(),request=f.env.api;let refreshes=0;f.progress.status='success';f.env.refresh=async()=>{refreshes++;};
  f.env.api=async(...args)=>{if(args[0].endsWith('/playback-status'))throw Object.assign(Error('本机状态暂不可读'),{status:404});return request(...args);};
  f.render();await tick();assert.equal(refreshes,1);assert.equal(f.env.pendingPlaySnapshot.current.jobId,'local-master');assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,false);assert.equal(f.timers.size,1);assert.equal(f.calls.players.length,0);f.close();
});

test('进度success后的章详情或最后状态读取途中取消、换章或离线，迟到就绪不恢复播放',async()=>{
  for(const stage of ['chapter','status'])for(const cancel of ['intent','chapter','offline','unmount']){
    const f=progressFixture(),wait=deferred(),request=f.env.api;let signal;f.progress.status='success';
    f.env.api=async(...args)=>{if(args[0]===(stage==='chapter'?'/chapters/chapter':'/chapters/chapter/playback-status')){signal=args[3].signal;return wait.promise;}return request(...args);};
    f.render();await tick();assert.equal(signal.aborted,false);
    if(cancel==='intent')f.env.beginPlayback('voices:other');if(cancel==='chapter')f.env.chapterRef.current=f.env.chapterId='other';if(cancel==='offline')f.env.connectionReady=false;
    if(cancel==='unmount')f.close();else f.render();assert.equal(signal.aborted,true);
    wait.resolve(stage==='chapter'?copy(f.fresh):statusFor(f.fresh));await tick();assert.equal(f.calls.players.length,0);assert.equal(f.timers.size,0);assert.deepEqual(f.calls.errors,[]);f.close();
  }
});

test('当前章任务摘要保留unknown、历史和别章状态，新master回执只同步真实进度且不保留正文',async()=>{
  const f=fixture();f.env.stateRef.current.jobs=[{id:'unknown',chapterId:'chapter',status:'unknown',attempts:[{id:'original'}]},{id:'past',chapterId:'chapter',status:'success'},{id:'other',chapterId:'other',status:'running'},{id:'current',chapterId:'chapter',status:'running',attempts:[{id:'known'}]}];
  const status={...statusFor(f.fresh),activeJobs:[{id:'current',chapterId:'chapter',kind:'unit-generate',status:'queued',done:0,total:1,stop:false,createdAt:'now'}]};
  f.env.acceptPlaybackChapter({chapter:copy(f.fresh),status,intent:1,requestedPlayback:null});
  assert.deepEqual(f.env.stateRef.current.jobs.map(job=>job.id),['unknown','past','other','current']);assert.deepEqual(f.env.stateRef.current.jobs.find(job=>job.id==='current').attempts,[{id:'known'}]);
  const before=f.env.playbackReadEpoch.current;
  f.env.rememberPlaybackJob({id:'master',chapterId:'chapter',kind:'master',status:'queued',done:0,total:3,stop:false,createdAt:'now',renderRows:[{text:'自拟正文'}],outputRecords:[{input:{text:'自拟正文'}}]});
  const job=f.env.stateRef.current.jobs.find(job=>job.id==='master');assert.equal(job.status,'queued');assert.equal(Object.hasOwn(job,'renderRows'),false);assert.equal(Object.hasOwn(job,'outputRecords'),false);assert.equal(f.env.playbackReadEpoch.current,before+1);
  f.env.rememberPlaybackJob({id:'unknown-receipt'});assert.equal(f.env.stateRef.current.jobs.some(job=>job.id==='unknown-receipt'),false);
});

test('全局poll让路时定向进度更新实际计数并保留依据，重复同一进度不重建整页state',async()=>{
  const f=progressFixture();f.env.stateRef.current.jobs=[{id:'local-master',chapterId:'chapter',kind:'master',status:'queued',done:0,total:142,attempts:[{id:'saved-attempt'}]},{id:'other',chapterId:'other',kind:'unit-generate',status:'unknown',done:0,total:1}];
  let writes=0;const setState=f.env.setState;f.env.setState=value=>{writes++;setState(value);};
  Object.assign(f.progress,{done:19,total:142});f.render();await tick();
  const job=f.env.stateRef.current.jobs.find(job=>job.id==='local-master');assert.equal(job.status,'running');assert.equal(job.done,19);assert.equal(job.total,142);assert.deepEqual(job.attempts,[{id:'saved-attempt'}]);assert.equal(f.env.stateRef.current.jobs.find(job=>job.id==='other').status,'unknown');assert.equal(f.reads.some(read=>read.path==='/state'),false);assert.equal(writes,1);
  const unchanged=f.env.stateRef.current;await f.poll();assert.equal(writes,1);assert.equal(f.env.stateRef.current,unchanged);f.progress.done=20;await f.poll();assert.equal(writes,2);assert.equal(f.env.stateRef.current.jobs.find(job=>job.id==='local-master').done,20);f.close();
});

test('进度404或短暂失败保留原jobID只读重试，running响应500ms后再读且无重复提交',async()=>{
  const f=progressFixture(),request=f.env.api;let calls=0;
  f.env.api=async(...args)=>{if(args[0].endsWith('/progress')&&!calls++)throw Object.assign(Error('临时查不到原任务'),{status:404});return request(...args);};
  f.render();await tick();assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,false);assert.equal(f.timers.size,1);await f.poll();assert.equal(f.timers.size,1);assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,true);assert.equal(f.env.pendingPlaySnapshot.current.jobId,'local-master');assert.equal(f.calls.players.length,0);assert.deepEqual(f.calls.errors,[]);f.close();assert.equal(f.timers.size,0);
});

test('自动全局poll在同章同意图已有真实在途job时让路，首次进度未到不争用，失败及手动刷新保留',async()=>{
  const f=fixture();let refreshes=0;f.refresh=async()=>{refreshes++;};const browser=await mountBrowserEvents(f);refreshes=0;
  const pending={intent:1,jobId:'master-job',arrangement:1,items:[],progressObserved:true};
  f.env.pendingPlay.current='chapter';f.env.pendingPlaySnapshot.current=pending;f.env.stateRef.current={jobs:[{id:'master-job',chapterId:'chapter',status:'running'}]};
  await browser.poll();assert.equal(refreshes,0);
  delete pending.progressObserved;await browser.poll();assert.equal(refreshes,0,'POST已确认，首次进度返回前也让路');
  for(const reason of ['unobserved','unregistered','failed','stopped','unknown','chapter','intent']){
    pending.progressObserved=reason!=='unobserved';pending.intent=reason==='intent'?0:1;f.env.pendingPlay.current=reason==='chapter'?'other':'chapter';f.env.stateRef.current={jobs:reason==='unregistered'?[]:[{id:'master-job',chapterId:'chapter',status:['failed','stopped','unknown'].includes(reason)?reason:'running'}]};
    const before=refreshes;await browser.poll();assert.equal(refreshes,before+1,reason);
  }
  pending.progressObserved=true;pending.intent=1;f.env.pendingPlay.current='chapter';f.env.stateRef.current={jobs:[{id:'master-job',chapterId:'chapter',status:'running'}]};
  const before=refreshes;f.env.window.dispatchEvent(new Event('focus'));f.env.window.dispatchEvent(new Event('online'));f.env.window.dispatchEvent(Object.assign(new Event('storage'),{key:'workbench-change'}));await tick();assert.equal(refreshes,before+3);browser.close();
});

test('真实进度success到最后scope核对和媒体接上之间仍让全局timer让路，播放完成或取消后恢复',async()=>{
  for(const cancel of [false,true]){
    const f=progressFixture(),lastStatus=deferred(),request=f.env.api;let refreshes=0;f.refresh=async()=>{refreshes++;};
    f.env.stateRef.current.jobs=[{id:'local-master',chapterId:'chapter',kind:'master',status:'running',done:0,total:142}];
    Object.assign(f.progress,{status:'success',done:142,total:142});f.fresh.masters=[{id:'ready-master',arrangement:1,sampleRate:48000,mapping:[{unitId:'three',startFrame:480000,endFrame:960000}]}];
    f.env.api=async(...args)=>args[0].endsWith('/playback-status')?lastStatus.promise:request(...args);
    const browser=await mountBrowserEvents(f);refreshes=0;f.render();await tick();
    assert.equal(f.env.stateRef.current.jobs[0].status,'success');assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,true);assert.equal(f.calls.players.length,0);
    await browser.poll();assert.equal(refreshes,0,'完成任务仍在最后核对时不可插入full refresh');
    if(cancel){f.env.playIntent.current++;f.render();}
    lastStatus.resolve(statusFor(f.fresh));await tick();await tick();
    if(cancel){assert.equal(f.calls.players.length,0);await browser.poll();assert.equal(refreshes,1);}
    else{assert.equal(f.calls.players.at(-1)?.id,'ready-master');assert.equal(f.env.pendingPlaySnapshot.current,null);await browser.poll();assert.equal(refreshes,0,'媒体尚未接上仍属于有效准备');f.mount();await tick();assert.equal(f.calls.plays,1);assert.equal(f.env.playbackPreparation.current,null);await browser.poll();assert.equal(refreshes,1);}
    f.close();browser.close();
  }
});

test('提交前有效播放准备让自动poll让路，进度故障保留fullpoll，取消后恢复且手动刷新始终可用',async()=>{
  const f=fixture();let refreshes=0;f.refresh=async()=>{refreshes++;};const browser=await mountBrowserEvents(f);refreshes=0;
  const intent=f.env.beginPlayback('chapter:chapter');assert.equal(f.env.pendingPlaySnapshot.current,null);
  await browser.poll();assert.equal(refreshes,0,'保存和核对阶段不与自动state竞争');
  f.env.window.dispatchEvent(new Event('focus'));f.env.window.dispatchEvent(new Event('online'));f.env.window.dispatchEvent(Object.assign(new Event('storage'),{key:'workbench-change'}));await tick();assert.equal(refreshes,3);
  const pending={intent,jobId:'master-job',arrangement:1,items:[]};
  f.env.pendingPlay.current='chapter';f.env.pendingPlaySnapshot.current=pending;f.env.stateRef.current={jobs:[{id:'master-job',chapterId:'chapter',status:'running'}]};
  await browser.poll();assert.equal(refreshes,3,'POST已确认、首轮進度尚未返回也让路');
  pending.progressObserved=false;await browser.poll();assert.equal(refreshes,4,'首次进度读取失败恢复完整读取');
  pending.progressObserved=true;await browser.poll();assert.equal(refreshes,4);
  pending.progressObserved=false;await browser.poll();assert.equal(refreshes,5,'404或故障让全局poll恢复');
  f.env.pendingPlay.current=null;f.env.pendingPlaySnapshot.current=null;f.env.playIntent.current++;
  await browser.poll();assert.equal(refreshes,6,'取消后的过期准备不能继续压制poll');
  f.env.finishPlayback(intent);await browser.poll();assert.equal(refreshes,7);browser.close();
});

test('单次进度2500ms超时只取消GET，保留原job并恢复fullpoll，随后500ms按同ID重查',async()=>{
  const f=progressFixture(),request=f.env.api,timeouts=[];let refreshes=0,signal,waiting=true;f.refresh=async()=>{refreshes++;};
  f.env.stateRef.current.jobs=[{id:'local-master',chapterId:'chapter',kind:'master',status:'queued',done:0,total:142}];
  f.env.AbortSignal={any:signals=>AbortSignal.any(signals),timeout:ms=>{assert.equal(ms,2500);const timeout=new AbortController();timeouts.push(timeout);return timeout.signal;}};
  f.env.api=async(...args)=>{if(waiting&&args[0].endsWith('/progress')){assert.equal(args[1],undefined);signal=args[3].signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}return request(...args);};
  const browser=await mountBrowserEvents(f);refreshes=0;f.render();await tick();assert.equal(signal.aborted,false);await browser.poll();assert.equal(refreshes,0);
  timeouts[0].abort(new DOMException('隔离查询超时','TimeoutError'));await tick();assert.equal(signal.aborted,true);assert.equal(f.env.pendingPlaybackRead.current.signal.aborted,false,'UI意图与原任务未取消');assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,false);assert.equal(f.env.pendingPlaySnapshot.current.jobId,'local-master');assert.equal(f.timers.size,1);
  await browser.poll();assert.equal(refreshes,1);waiting=false;await f.poll();assert.equal(timeouts.length,2);assert.equal(f.env.pendingPlaySnapshot.current.progressObserved,true);assert.equal(f.env.pendingPlaySnapshot.current.jobId,'local-master');assert.equal(f.reads.filter(read=>read.path.endsWith('/progress')).length,1);assert.equal(f.calls.players.length,0);assert.deepEqual(f.calls.errors,[]);
  await browser.poll();assert.equal(refreshes,1);f.close();browser.close();
});

test('换播放意图、换章、离线和卸载中止进度读取，迟到success不播放也不新刷新',async()=>{
  for(const kind of ['intent','chapter','offline','unmount']){
    const f=progressFixture(),read=deferred();let signal,refreshed=0;f.env.api=async(_path,_body,_method,options)=>{signal=options.signal;return read.promise;};f.env.refresh=async()=>{refreshed++;};
    f.render();assert.equal(signal.aborted,false);
    if(kind==='intent'){f.env.beginPlayback('voices:other');assert.equal(signal.aborted,true,'新来源在等待React渲染前就应取消旧GET');}
    if(kind==='chapter')f.env.chapterRef.current=f.env.chapterId='other';if(kind==='offline')f.env.connectionReady=false;
    if(kind==='unmount')f.close();else f.render();assert.equal(signal.aborted,true,kind);
    read.resolve({...f.progress,status:'success'});await tick();assert.equal(refreshed,0,kind);assert.equal(f.calls.players.length,0,kind);assert.equal(f.timers.size,0,kind);f.close();
  }
});

test('terminal结果停自动意图并显示原错误，范围/归属不匹配同样不采用或重提交',async()=>{
  for(const fields of [{status:'failed',error:'本机写入失败'},{status:'stopped',error:'任务已停止'},{status:'unknown',error:'原结果待核对'},{id:'other'},{chapterId:'other'},{kind:'export'},{arrangement:2},{renderRevision:1},{renderSignature:'other-range'}]){
    const f=progressFixture();Object.assign(f.progress,fields);f.render();await tick();assert.equal(f.env.pendingPlay.current,null);assert.equal(f.env.pendingPlaybackTarget,null);assert.equal(f.env.playbackPreparation.current,null);assert.equal(f.calls.players.length,0);assert.ok(f.calls.errors[0]);if(fields.error)assert.equal(f.calls.errors[0],fields.error);assert.equal(f.timers.size,0);f.close();
  }
});

test('整章提交和裁剪续播都绑定同一个明确job、intent与render身份，裁剪源帧锚点保留',async()=>{
  for(const kind of ['play','range']){
    const f=fixture();Object.assign(f.env,{connectionReady:true,chapterId:'chapter',flushAudioRanges:async()=>{},run:work=>work(),withSavedDrafts:(_scope,_ids,work)=>work(),crypto:{randomUUID:()=> 'command'}});f.fresh.renderRevision=7;f.fresh.renderSignature='current-range';const request=f.env.api;
    f.env.api=async(path,body)=>path==='/jobs'?{id:'one-master-job'}:request(path,body);
    const anchor={kind:'masters',intent:1,chapterId:'chapter',unitId:'two',audioId:'two-old',sourceFrame:96000};
    if(kind==='play')await project(declaration('playChapter'),f.env)();else{f.env.rangeResume.current=anchor;await project(declaration('rangeSaved'),f.env)({chapterId:'chapter'});}
    const pending=f.env.pendingPlaySnapshot.current;assert.equal(pending.jobId,'one-master-job');assert.equal(pending.renderRevision,7);assert.equal(pending.renderSignature,'current-range');assert.deepEqual(f.env.pendingPlaybackTarget,{jobId:'one-master-job',chapterId:'chapter',intent:pending.intent});if(kind==='range')assert.equal(pending.anchor,anchor);
  }
});
