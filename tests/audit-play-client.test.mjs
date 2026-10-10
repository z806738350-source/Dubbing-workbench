import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,env){let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(file)===name)found=node.initializer;ts.forEachChild(node,visit);}visit(file);assert.ok(found);const code=ts.transpileModule('const projected=('+found.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)}};
const chapter={id:'chapter',title:'夹具',workspaceIdentity:'workspace',revision:1,arrangement:1,segments:[],playbackItems:[],units:[],masters:[{id:'A',arrangement:1,renderSignature:null,sampleRate:48000,mapping:[]}]};
const state={settings:{workspaceIdentity:'workspace'},jobs:[],chapters:[{id:chapter.id,revision:chapter.revision,arrangement:chapter.arrangement}]};
const playbackStatus=(detail=chapter,changes={})=>({chapterId:detail.id,workspaceIdentity:detail.workspaceIdentity||'workspace',revision:detail.revision,arrangement:detail.arrangement,renderRevision:detail.renderRevision||0,renderSignature:detail.renderSignature??null,activeJobs:[],...changes});
function fixture(){
  const players=[],errors=[],env={useCallback:fn=>fn,playIntent:{current:0},playbackPreparation:{current:null},pendingPlaybackRead:{current:null},rangeResume:{current:null},pendingPlay:{current:null},pendingPlaySnapshot:{current:null},connectionReady:true,connectionMessage:'本机连接不可用',chapter,chapterId:'chapter',chapterRef:{current:'chapter'},stateRef:{current:state},api:async path=>path==='/state'?state:path.endsWith('/playback-status')?playbackStatus():chapter,active:()=>false,refresh:async()=>{},playerRef:{current:null},audio:{current:{pause(){},paused:true,ended:false,currentTime:0,duration:45,readyState:4,play:async()=>{}}},bookmarks:{current:{}},playbackIdentity:items=>JSON.stringify(items),setError:e=>errors.push(e),setNotice(){},setPosition(){},setDuration(){},setTransitioning(){},setPlaying(){},setPendingPlaybackTarget(){},setPlayPreparing:value=>{env.playPreparing=value;},setChapter:c=>{env.chapter=c;},setPlayer:p=>{players.push(p);env.playerRef.current=p;}};
  env.beginPlayback=callback('beginPlayback',env);env.finishPlayback=callback('finishPlayback',env);
  env.draftWorkspace=()=>env.workspace||'workspace';env.readPlaybackChapter=(...args)=>callback('readPlaybackChapter',env)(...args);env.acceptPlaybackChapter=context=>{env.chapter=context.chapter;return true;};env.rememberPlaybackJob=()=>{};
  return {env,players,errors,start:()=>callback('startPlay',env)};
}
test('实际播放回调：慢A不能抢回后选B或参考的播放意图',async()=>{for(const kind of ['audios','voices']){const f=fixture(),read=defer();f.env.api=async path=>path==='/state'?state:read.promise;const a=f.start()('audios','A','A');await f.start()(kind,'B','B',undefined,true);read.resolve(chapter);await a;assert.deepEqual(f.players.map(p=>p.id),['B']);}});
test('实际播放回调：准备中停止使迟到声音和错误失效',async()=>{const f=fixture(),read=defer();f.env.api=async()=>read.promise;const a=f.start()('audios','A','A');f.env.playIntent.current++;read.resolve(chapter);await a;assert.deepEqual(f.players,[]);assert.deepEqual(f.errors,[]);});
test('实际播放回调：再次点正在试听的来源立即暂停，不等待预检或媒体下载',async()=>{const f=fixture();let paused=0,reads=0;f.env.playerRef.current={kind:'audios',id:'A'};f.env.audio.current.paused=false;f.env.audio.current.pause=()=>paused++;f.env.api=async()=>{reads++;throw Error('不应读取');};await f.start()('audios','A','A');assert.equal(paused,1);assert.equal(reads,0);assert.equal(f.players.length,0);assert.equal(f.env.playIntent.current,1);});

test('新播放核验失败时旧声音已暂停，不会继续播放已失效的音频',async()=>{
  const f=fixture();let paused=0;f.env.playerRef.current={kind:'audios',id:'A',intent:0};
  f.env.audio.current.paused=false;f.env.audio.current.pause=()=>{paused++;f.env.audio.current.paused=true;};
  f.env.api=async path=>{assert.ok(paused>0);return path==='/state'?{...state,chapters:[{...state.chapters[0],arrangement:2}]}:{...chapter,arrangement:2};};
  await f.start()('audios','B','B');assert.equal(f.env.audio.current.paused,true);assert.ok(f.players.every(p=>p===null));assert.match(f.errors[0],/版本或任务状态已变化/);
});

for(const [kind,label,standalone] of [['audios','单段',false],['masters','整章',false],['voices','参考声音',true],['demo','演示',true]]){
  for(const [name,media,resumeAt] of [
    ['自然播完后从头重播',{ended:true,currentTime:45},0],
    ['暂停后从原位置续播',{currentTime:17},17],
    ['手动拖到末尾后从头重播',{currentTime:45},0],
    ['接近末尾但未播完仍从原位置续播',{currentTime:44.999},44.999],
  ])test(`实际播放回调：${label}${name}`,async()=>{
    const f=fixture();
    const master=kind==='masters'?{id:'A',sampleRate:48000,mapping:[]}:undefined;
    const existing={kind,id:'A',title:label,chapterId:standalone?undefined:chapter.id,playbackItems:chapter.playbackItems,master};
    f.env.playerRef.current=existing;
    Object.assign(f.env.audio.current,media);
    await f.start()(kind,'A',label,undefined,standalone);
    assert.deepEqual(f.errors,[]);
    assert.equal(f.players.length,1);
    assert.equal(f.players[0].resumeAt,resumeAt);
    assert.equal(f.players[0].master,master,'整章续播应保留已有时间映射');
    assert.equal(f.players[0].intent,f.env.playIntent.current);
  });
}

test('实际播放回调：结束标记优先于媒体时间舍入，未知时长不会误判结束',async()=>{
  for(const [media,resumeAt] of [[{ended:true,currentTime:44.999},0],[{currentTime:45.01},0],[{currentTime:17,duration:NaN},17],[{currentTime:17,duration:Infinity},17]]){
    const f=fixture();f.env.playerRef.current={kind:'audios',id:'A',playbackItems:chapter.playbackItems};Object.assign(f.env.audio.current,media);
    await f.start()('audios','A','A');
    assert.equal(f.players[0].resumeAt,resumeAt);
  }
});

test('暂停同段在另一页改变范围后，单次点击自动核对并使用新范围',async()=>{
  const f=fixture(),oldItems=[{id:'one',unitId:'one',audioId:'A',clipStartFrame:0,clipEndFrame:96000,rangeRevision:0}],unit={id:'one',kind:'single',state:'active',mode:'dry',members:['one'],variants:{dry:{current:'A',history:[]},scene:{history:[]}}};
  f.env.chapter={...chapter,playbackItems:oldItems,units:[unit]};
  const fresh={...f.env.chapter,playbackItems:[{...oldItems[0],clipStartFrame:4800,rangeRevision:1}]},resolved={previewUrl:'/new-range',range:{startFrame:4800,endFrame:96000,sampleRate:48000}};
  f.env.playerRef.current={kind:'audios',id:'A',chapterId:'chapter',arrangement:1,intent:0,playbackItems:oldItems,url:'/old-range'};
  f.env.api=async path=>path==='/state'?state:path.startsWith('/units/')?resolved:fresh;
  f.env.refresh=async()=>{f.env.chapter=fresh;};
  await f.start()('audios','A','A');
  assert.equal(f.players.at(-1)?.url,'/new-range');assert.equal(f.players.at(-1)?.sourceStartFrame,4800);
});

test('暂停的单段拖动与保存不自动播放或重建整章',async()=>{
  const f=fixture();Object.assign(f.env,{rangeResume:{current:null},setFollow(){},setCurrentSegment(){},setCurrentMembers(){},refresh:async()=>{},flushAudioRanges:async()=>{}});
  f.env.playerRef.current={kind:'audios',id:'A',intent:0,sourceStartFrame:0,sampleRate:48000};let jobs=0;f.env.api=async()=>{jobs++;return chapter;};
  callback('beginRangeEdit',f.env)('one','A');callback('rangeChanged',f.env)({unitId:'one',audioId:'A'});await callback('rangeSaved',f.env)({chapterId:'chapter',unitId:'one',audioId:'A'});
  assert.deepEqual(f.players,[null]);assert.equal(jobs,0);assert.equal(f.env.rangeResume.current,null);
});

test('范围保存等待其他段同步时，新播放意图取消迟到的整章重建与恢复',async()=>{
  const f=fixture(),waiting=defer();Object.assign(f.env,{rangeResume:{current:{kind:'masters',intent:0,chapterId:'chapter',unitId:'one',audioId:'A',sourceFrame:4800}},flushAudioRanges:()=>waiting.promise});
  const pending=callback('rangeSaved',f.env)({chapterId:'chapter',unitId:'one',audioId:'A'});await new Promise(r=>setImmediate(r));f.env.playIntent.current++;waiting.resolve();await pending;
  assert.deepEqual(f.players,[]);assert.equal(f.env.pendingPlay.current,null);
});

test('慢整章续播：同一来源连续点三次只核验一次并保留原37.5秒',async()=>{
  const f=fixture(),read=defer();let chapterReads=0,stateReads=0;
  const master={id:'A',sampleRate:48000,mapping:[]};
  f.env.playerRef.current={kind:'masters',id:'A',title:'整章',chapterId:chapter.id,arrangement:1,playbackItems:chapter.playbackItems,master};
  f.env.audio.current.currentTime=37.5;
  let statusReads=0;f.env.api=async path=>{if(path==='/state'){stateReads++;return state;}if(path.endsWith('/playback-status')){statusReads++;return playbackStatus();}chapterReads++;return read.promise;};
  const first=f.start()('masters','A','整章');
  await f.start()('masters','A','整章');await f.start()('masters','A','整章');
  assert.equal(chapterReads,1);assert.equal(statusReads,0);assert.equal(stateReads,0);assert.equal(f.env.playIntent.current,1);
  read.resolve(chapter);await first;
  assert.equal(stateReads,0);assert.equal(statusReads,1);assert.equal(f.players.length,1);assert.equal(f.players[0].resumeAt,37.5);assert.equal(f.players[0].master,master);
});

test('续播媒体尚未加载metadata时，临时currentTime为0不覆盖已记录的37.5秒',async()=>{
  const f=fixture(),master={id:'A',sampleRate:48000,mapping:[]};
  f.env.playerRef.current={kind:'masters',id:'A',title:'整章',chapterId:chapter.id,arrangement:1,playbackItems:chapter.playbackItems,master,resumeAt:37.5};
  Object.assign(f.env.audio.current,{currentTime:0,readyState:0});
  await f.start()('masters','A','整章');
  assert.equal(f.players.length,1);assert.equal(f.players[0].resumeAt,37.5);assert.equal(f.players[0].master,master);
});

test('慢续播期间可以选另一来源，旧请求完成或清理不能释放新来源的准备状态',async()=>{
  const f=fixture(),read=defer();f.env.api=async path=>path==='/state'?state:read.promise;
  const first=f.start()('audios','A','慢声音');
  await f.start()('voices','B','新参考',undefined,true);
  const newer=f.env.playbackPreparation.current;
  assert.ok(newer);assert.equal(newer.intent,f.env.playIntent.current);assert.equal(f.players.at(-1)?.id,'B');
  read.resolve(chapter);await first;
  assert.equal(f.env.playbackPreparation.current,newer);assert.deepEqual(f.players.map(value=>value.id),['B']);
  f.env.finishPlayback(newer.intent-1);assert.equal(f.env.playbackPreparation.current,newer);
  f.env.finishPlayback(newer.intent);assert.equal(f.env.playbackPreparation.current,null);
});

test('当前准备失败后会释放同来源状态，恢复连接的一次重试可以正常开始',async()=>{
  const f=fixture();let reads=0;
  f.env.api=async path=>{if(++reads===1)throw Error('本机读取中断');return path==='/state'?state:chapter;};
  await f.start()('audios','A','声音');assert.equal(f.env.playbackPreparation.current,null);
  await f.start()('audios','A','声音');assert.equal(f.players.at(-1)?.id,'A');assert.equal(f.env.playIntent.current,2);
});

test('正式新母版handoff可跨React旧章revision，非当前母版与普通旧声音仍拒绝',async()=>{
  const currentMaster={id:'new-master',arrangement:2,renderSignature:'render-new',sampleRate:48000,mapping:[{unitId:'one',audioId:'new-audio',startFrame:96000,endFrame:192000}]};
  const fresh={...chapter,revision:2,arrangement:2,renderRevision:1,renderSignature:'render-new',playbackItems:[{id:'one',unitId:'one',audioId:'new-audio',validity:'matched'}],masters:[currentMaster]};
  for(const [label,registered,kind,provided,accepted,latestRenderRevision=1] of [
    ['正式当前母版',currentMaster,'masters',currentMaster,true],
    ['母版ID已变',{...currentMaster,id:'other-master'},'masters',currentMaster,false],
    ['旧编排母版',{...currentMaster,arrangement:1},'masters',currentMaster,false],
    ['旧范围母版',{...currentMaster,renderSignature:'render-old'},'masters',currentMaster,false],
    ['核验期间另一页已修改范围',currentMaster,'masters',currentMaster,false,2],
    ['普通声音保留旧章保护',currentMaster,'audios',undefined,false],
  ]){
    const f=fixture();f.env.bookmarks.current.chapter='one';
    f.env.api=async path=>path==='/state'?{...state,chapters:[{...state.chapters[0],revision:2,arrangement:2,renderRevision:latestRenderRevision}]}:path.endsWith('/playback-status')?playbackStatus(fresh,{renderRevision:latestRenderRevision}):{...fresh,masters:[registered]};
    await f.start()(kind,kind==='masters'?currentMaster.id:'new-audio',label,provided);
    if(accepted){
      assert.equal(f.players.at(-1)?.id,currentMaster.id,label);assert.equal(f.players.at(-1)?.arrangement,2);assert.equal(f.players.at(-1)?.master,currentMaster);assert.equal(f.players.at(-1)?.resumeAt,2);assert.deepEqual(f.errors,[]);
    }else{
      assert.ok(f.players.every(player=>player===null),label);assert.match(f.errors[0],/版本或任务状态已变化/,label);assert.equal(f.env.playbackPreparation.current,null,label);
    }
  }
});

test('保存屏障后的整章handoff复用已读章节，只取一次详情；随后版本/范围/任务变化仍拒绝',async()=>{
  for(const changed of ['none','revision','range','job']){
    const f=fixture(),reads=[];f.env.active=status=>['queued','running'].includes(status);
    Object.assign(f.env,{run:work=>work(),withSavedDrafts:(_scope,_ids,work)=>work(),flushAudioRanges:async()=>{},startPlay:(...args)=>f.start()(...args)});
    f.env.api=async path=>{reads.push(path);assert.ok(path==='/chapters/chapter/playback-status'||path==='/chapters/chapter','不会读取全工作区、提交任务或调用模型');return path.endsWith('/playback-status')?playbackStatus(chapter,{revision:changed==='revision'?2:1,renderRevision:changed==='range'?1:0,activeJobs:changed==='job'?[{id:'busy',chapterId:'chapter',status:'running'}]:[]}):chapter;};
    await callback('playChapter',f.env)();assert.deepEqual(reads,['/chapters/chapter','/chapters/chapter/playback-status']);
    if(changed==='none'){assert.equal(f.players.at(-1)?.id,'A');assert.deepEqual(f.errors,[]);}
    else{assert.ok(f.players.every(player=>player===null),changed);assert.match(f.errors[0],/版本或任务状态已变化/,changed);assert.equal(f.env.playbackPreparation.current,null);}
  }
});

test('跨章节的handoff上下文不复用，普通声音仍读取实际章节核验',async()=>{
  for(const kind of ['masters','audios']){
    const f=fixture(),reads=[];f.env.api=async path=>{reads.push(path);return path==='/state'?state:path.endsWith('/playback-status')?playbackStatus():chapter;};
    await f.start()(kind,'A','声音',kind==='masters'?chapter.masters[0]:undefined,false,undefined,undefined,{...chapter,id:'other-chapter'});
    assert.deepEqual(reads,['/chapters/chapter',kind==='masters'?'/chapters/chapter/playback-status':'/state']);assert.equal(f.players.at(-1)?.id,'A');
  }
});

test('重生成后暂停旧母版的一次续播转交当前整章，已有新母版或需要本机准备均不要求再点',async()=>{
  for(const prepared of [false,true])for(const rendered of [false,true]){
    const f=fixture(),master={id:'new-master',arrangement:2,sampleRate:48000,mapping:[{unitId:'two',startFrame:240000}]};
    const fresh={...chapter,revision:2,arrangement:2,playbackItems:[{id:'two',unitId:'two',audioId:'new-audio',validity:'matched'}],masters:prepared?[master]:[]};
    let jobs=0;
    f.env.bookmarks.current.chapter='two';
    f.env.playerRef.current={kind:'masters',id:'A',chapterId:'chapter',arrangement:1,playbackItems:[],master:chapter.masters[0]};
    if(rendered)f.env.chapter=fresh;
    Object.assign(f.env,{flushAudioRanges:async()=>{},crypto:{randomUUID:()=> 'new-master-command'},run:fn=>fn(),withSavedDrafts:(_key,_target,fn)=>fn(),
      refresh:async()=>{f.env.chapter=fresh;f.env.bookmarks.current.chapter='two';},
      api:async(path,body)=>{if(body){jobs++;assert.equal(body.kind,'master');return {id:'local-job'};}return path==='/state'?{jobs:[],chapters:[{id:'chapter',revision:2,arrangement:2}]}:path.endsWith('/playback-status')?playbackStatus(fresh):fresh;},
      playChapter:intent=>callback('playChapter',f.env)(intent),startPlay:(...args)=>f.start()(...args)});
    await f.start()('masters','A','旧整章');
    assert.deepEqual(f.errors,[]);assert.equal(f.env.playIntent.current,1);assert.equal(jobs,prepared?0:1);
    if(prepared){assert.equal(f.players.at(-1)?.id,'new-master');assert.equal(f.players.at(-1)?.resumeAt,5);assert.equal(f.players.at(-1)?.master,master);}
    else{assert.equal(f.env.pendingPlay.current,'chapter');assert.equal(f.env.pendingPlaySnapshot.current.intent,1);}
    assert.equal(f.env.playbackPreparation.current.intent,1,'交接后继续保留准备状态直到媒体就绪');
  }
});

test('重生成续播仍拒绝正在变化的版本，等待期间切章或换播放意图不继续交接',async()=>{
  for(const cancel of ['superseded','running','chapter','intent']){
    const f=fixture(),fresh={...chapter,revision:2,arrangement:2,playbackItems:[{validity:'matched'}],masters:[]},read=defer();let handoffs=0;
    f.env.playerRef.current={kind:'masters',id:'A',chapterId:'chapter',arrangement:1,playbackItems:[],master:chapter.masters[0]};
    f.env.active=status=>status==='running';
    f.env.api=async path=>path==='/state'?{jobs:cancel==='running'?[{chapterId:'chapter',status:'running'}]:[],chapters:[{id:'chapter',revision:cancel==='superseded'?3:2,arrangement:2}]}:path.endsWith('/playback-status')?playbackStatus(fresh,{revision:cancel==='superseded'?3:2,activeJobs:cancel==='running'?[{id:'busy',chapterId:'chapter',status:'running'}]:[]}):['chapter','intent'].includes(cancel)?read.promise:fresh;
    f.env.playChapter=async()=>{handoffs++;};
    const pending=f.start()('masters','A','旧整章');if(['chapter','intent'].includes(cancel)){await new Promise(resolve=>setImmediate(resolve));if(cancel==='chapter')f.env.chapterRef.current='other';else f.env.playIntent.current++;read.resolve(fresh);}await pending;assert.equal(handoffs,0,cancel);assert.ok(f.players.every(player=>player===null),cancel);
  }
});

test('整章定向状态仍拒绝断线、错章/工作区、版本/范围/签名变化与活动任务，不读取全工作区',async()=>{
  for(const changed of ['disconnected','read-failed','chapter','workspace','revision','arrangement','range','signature','job','wrong-job-scope','observed-revision']) {
    const f=fixture(),reads=[];let refreshed=0;f.env.refresh=async()=>{refreshed++;};f.env.active=value=>['queued','running'].includes(value);
    if(changed==='disconnected')f.env.connectionReady=false;
    if(changed==='observed-revision')f.env.stateRef.current={...state,chapters:[{...state.chapters[0],revision:2}]};
    f.env.api=async path=>{
      reads.push(path);assert.notEqual(path,'/state','master不能为了核验读取全工作区');if(!path.endsWith('/playback-status'))return chapter;
      if(changed==='read-failed')throw Error('定向核验断线');
      return playbackStatus(chapter,{chapterId:changed==='chapter'?'other':chapter.id,workspaceIdentity:changed==='workspace'?'other':'workspace',revision:changed==='revision'?2:1,arrangement:changed==='arrangement'?2:1,renderRevision:changed==='range'?1:0,renderSignature:changed==='signature'?'changed':null,activeJobs:['job','wrong-job-scope'].includes(changed)?[{id:'busy',chapterId:changed==='wrong-job-scope'?'other':chapter.id,status:'running'}]:[]});
    };
    await f.start()('masters','A','整章',chapter.masters[0]);assert.ok(f.players.every(player=>player===null),changed);assert.equal(f.env.playbackPreparation.current,null,changed);assert.ok(f.errors.length>0,changed);assert.equal(refreshed,changed==='disconnected'?0:1,changed);assert.deepEqual(reads,changed==='disconnected'?[]:['/chapters/chapter','/chapters/chapter/playback-status'],changed);
  }
});

test('章节读完前取消整章意图或换工作区，不再发第二次状态GET，也不播放迟到结果',async()=>{
  for(const changed of ['intent','workspace','chapter']) {
    const f=fixture(),read=defer(),reads=[];f.env.api=async path=>{reads.push(path);assert.equal(path,'/chapters/chapter');return read.promise;};
    const pending=f.start()('masters','A','整章',chapter.masters[0]);await new Promise(resolve=>setImmediate(resolve));if(changed==='intent')f.env.playIntent.current++;else if(changed==='workspace')f.env.workspace='other';else f.env.chapterRef.current='other';read.resolve(chapter);await pending;
    assert.deepEqual(reads,['/chapters/chapter']);assert.deepEqual(f.players,[]);assert.deepEqual(f.errors,[]);
  }
});

test('定向状态等待期间观察到更晚版本，不用迟到章快照回滚；先核对章的handoff只读取状态',async()=>{
  const f=fixture(),read=defer(),reads=[];let refreshed=0;f.env.refresh=async()=>{refreshed++;};
  f.env.api=async path=>{reads.push(path);return path.endsWith('/playback-status')?read.promise:chapter;};const pending=f.start()('masters','A','整章',chapter.masters[0]);await new Promise(resolve=>setImmediate(resolve));f.env.stateRef.current={...state,chapters:[{...state.chapters[0],renderRevision:1}]};read.resolve(playbackStatus());await pending;
  assert.ok(f.players.every(player=>player===null));assert.equal(refreshed,1);assert.match(f.errors[0],/版本或任务状态已变化/);
  const checked=fixture(),checkedReads=[];checked.env.api=async path=>{checkedReads.push(path);assert.equal(path,'/chapters/chapter/playback-status');return playbackStatus();};
  await checked.start()('masters','A','整章',chapter.masters[0],false,undefined,undefined,chapter);assert.deepEqual(checkedReads,['/chapters/chapter/playback-status']);assert.equal(checked.players.at(-1).id,'A');
});
