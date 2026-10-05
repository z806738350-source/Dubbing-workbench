import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'实际播放回调应存在');return found;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const mediaEffect=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[1]?.getText(file)==='[player]').arguments[0];
const browserEffects=[];
function collectBrowserEffects(node){
  if(ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&/addEventListener\(["'](?:focus|visibilitychange)["']/.test(node.arguments[0]?.getText(file)||''))browserEffects.push(node.arguments[0]);
  ts.forEachChild(node,collectBrowserEffects);
}
collectBrowserEffects(file);
const copy=value=>structuredClone(value);
const variant=id=>({current:id,previous:null,approved:null,history:id?[{id}]:[]});
function chapterFixture(){
  const playbackItems=['one','two','three'].map(id=>({id,unitId:id,members:[id],mode:'dry',audioId:id+'-old',basis:{text:id},validity:'matched'}));
  return {id:'chapter',projectId:'project',title:'续播夹具',arrangement:1,segments:playbackItems.map((item,order)=>({id:item.id,order})),playbackItems,masters:[],units:playbackItems.map(item=>({id:item.id,kind:'single',state:'active',mode:'dry',members:item.members,variants:{dry:variant(item.audioId),scene:variant(null)}}))};
}
function adopt(chapter,id,audioId,mode='dry'){
  const item=chapter.playbackItems.find(item=>item.id===id),unit=chapter.units.find(unit=>unit.id===id),v=unit.variants[mode];
  v.previous=v.current;v.current=audioId;v.history.push({id:audioId});unit.mode=mode;
  Object.assign(item,{audioId,mode,validity:'matched'});chapter.arrangement++;
}
function fixture({tracked=true}={}){
  const initial=chapterFixture(),calls={players:[],notices:[],errors:[],loads:0,plays:0,pauses:0};
  let fresh=copy(initial),jobs=[],workspace='/fixture';
  const env={useCallback:callback=>callback,refreshPending:{current:null},chapter:initial,
    chapterRef:{current:initial.id},projectRef:{current:initial.projectId},playerRef:{current:null},
    chapterPlaybackSnapshots:{current:tracked?{chapter:copy(initial)}:{}},bookmarks:{current:{chapter:'three'}},
    pendingPlay:{current:null},pendingPlaySnapshot:{current:null},playIntent:{current:1},generationIntent:{current:0},segmentDeletionIntent:{current:0},
    draftWorkspace:()=>workspace,bindDraftWorkspace:identity=>{workspace=identity;},document:{visibilityState:'visible'},
    active:status=>['queued','running','stopping'].includes(status),playbackIdentity:items=>JSON.stringify(items),connectionMessage:'连接失败',
    api:async path=>path==='/state'?{settings:{workspaceDirectory:workspace},projects:[{id:'project'}],chapters:[{id:'chapter',projectId:'project'}],jobs}:copy(fresh),
    audio:{current:{paused:true,currentTime:0,load(){calls.loads++;},play(){calls.plays++;return Promise.resolve();},pause(){calls.pauses++;}}},
    setPlayer:value=>{calls.players.push(value);env.player=value;env.playerRef.current=value;},
    setNotice:value=>calls.notices.push(value),setError:value=>{if(typeof value!=='function')calls.errors.push(value);},
  };
  for(const name of ['State','Chapter','ProjectId','ChapterId','Selected','Loading','ConnectionReady','CurrentSegment','CurrentMembers','Playing','Position','Duration','Transitioning','Follow','GenerationPlan','GrantId','DeleteTarget','RenameTarget','SegmentDeletion','UnitPanelId','VoiceTarget','OldPreview','Modal','DraftSignal'])env['set'+name]=value=>{if(typeof value!=='function')env[name[0].toLowerCase()+name.slice(1)]=value;};
  return {env,calls,get fresh(){return fresh;},set fresh(value){fresh=value;},set jobs(value){jobs=value;},refresh:()=>project(declaration('refresh'),env)(),mount:()=>project(mediaEffect,env)()};
}

async function mountBrowserEvents(f){
  Object.assign(f.env,{window:new EventTarget(),document:Object.assign(new EventTarget(),{visibilityState:'visible'}),
    setInterval:()=>1,clearInterval:()=>{},refresh:f.refresh});
  const cleanups=browserEffects.map(effect=>project(effect,f.env)());
  await f.env.refreshPending.current;
  return {close:()=>cleanups.forEach(cleanup=>cleanup()),
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
  f.env.crypto={randomUUID:()=> 'master-command'};f.env.run=fn=>fn();f.env.withSavedDrafts=(_key,_target,fn)=>fn();
  f.env.api=async(path,body)=>{
    if(path==='/jobs'){assert.equal(body.kind,'master');assert.equal(f.env.playerRef.current,null);assert.ok(f.calls.pauses>0);return {id:'job'};}
    return api(path);
  };
  await project(declaration('playChapter'),f.env)();assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.intent,2);
});

test('只有整章媒体播放建立跟踪，单条抽听不覆盖既有整章快照',async()=>{
  const f=fixture({tracked:false});f.env.player={kind:'masters',id:'master',chapterId:'chapter',master:{mapping:[]},intent:1};f.env.playerRef.current=f.env.player;f.mount();
  assert.equal(f.env.chapterPlaybackSnapshots.current.chapter.id,'chapter');const snapshot=f.env.chapterPlaybackSnapshots.current.chapter;
  f.env.chapter=copy(f.env.chapter);adopt(f.env.chapter,'one','one-new');f.env.player={kind:'audios',id:'one-new',chapterId:'chapter',intent:1};f.env.playerRef.current=f.env.player;f.mount();
  assert.equal(f.env.chapterPlaybackSnapshots.current.chapter,snapshot);assert.equal(f.calls.plays,2);
});

test('跨章读取迟到不改当前章节断点或快照',async()=>{
  const f=fixture();adopt(f.fresh,'one','one-new');const request=f.env.api;let resolve;
  f.env.api=path=>path==='/state'?request(path):new Promise(done=>{resolve=done;});
  const pending=f.refresh();await new Promise(done=>setImmediate(done));f.env.chapterRef.current='another';resolve(copy(f.fresh));await pending;
  assert.equal(f.env.bookmarks.current.chapter,'three');assert.equal(f.env.chapterPlaybackSnapshots.current.chapter.arrangement,1);
});

test('工作区身份变化清理全部试听快照与断点，不把另一工作区的音频识别成重跑',async()=>{
  const f=fixture();adopt(f.fresh,'one','another-workspace-audio');const request=f.env.api;
  f.env.api=async path=>{const response=await request(path);if(path==='/state')response.settings.workspaceDirectory='/another-workspace';return response;};
  await f.refresh();assert.deepEqual(f.env.chapterPlaybackSnapshots.current,{});assert.deepEqual(f.env.bookmarks.current,{});assert.ok(f.calls.pauses>0);
});
