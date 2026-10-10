import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'实际播放节点应存在');return found;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const attribute=(node,name)=>node.attributes.properties.find(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)===name);
const audio=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='audio');
const timeUpdate=attribute(audio,'onTimeUpdate').initializer.expression;
const effect=dependencies=>find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[1]&&ts.isArrayLiteralExpression(node.arguments[1])&&node.arguments[1].elements.map(x=>x.getText(file)).join(',')===dependencies).arguments[0];
const scrollEffect=effect('currentSegment,follow,filter,search'),mediaEffect=effect('player');
const startPlay=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='startPlay').initializer;
const beginPlayback=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='beginPlayback').initializer;
const finishPlayback=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='finishPlayback').initializer;
const chapterPlaybackSnapshot=project(find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='chapterPlaybackSnapshot').initializer,{});
const readyPoint=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='point').initializer;
const list=find(node=>ts.isJsxOpeningElement(node)&&node.tagName.getText(file)==='div'&&attribute(node,'className')?.initializer?.text==='script-list');
const followButton=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='button'&&attribute(node.openingElement,'aria-pressed')?.initializer?.expression?.getText(file)==='follow');
const playbackButton=find(node=>ts.isJsxOpeningElement(node)&&node.tagName.getText(file)==='button'&&attribute(node,'className')?.initializer?.text==='play-button');
const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props.children||[]).flat(Infinity).map(text).join('');
const tick=()=>new Promise(resolve=>setImmediate(resolve));

// Match buildMaster's stored mapping: groups have memberIds and no segmentId.
const master={id:'master',arrangement:1,sampleRate:48000,mapping:[
  {segmentId:'single',unitId:'single-unit',memberIds:['single'],audioId:'single-audio',startFrame:0,endFrame:96000},
  {unitId:'group',memberIds:['one','two'],audioId:'group-audio',startFrame:144000,endFrame:384000},
  {segmentId:'next',unitId:'next-unit',memberIds:['next'],audioId:'next-audio',startFrame:432000,endFrame:480000},
]};
function fixture(){
  const calls={scroll:[],otherScroll:[],writes:[],players:[],errors:[],notices:[],loads:0,plays:0,pauses:0},rows=new Map();
  const frame={scrollTop:26,scrollTo:options=>calls.otherScroll.push(['frame',options])};
  const scriptList={scrollTop:75,clientHeight:300,parentElement:frame,getBoundingClientRect:()=>({top:100}),contains:row=>[...rows.values()].includes(row)};
  for(const [id,offsetTop] of [['single',0],['one',500],['two',700],['next',900]]){
    const row={offsetTop,offsetHeight:80,parentElement:scriptList,scrollIntoView:options=>calls.otherScroll.push(['scrollIntoView',options])};
    row.getBoundingClientRect=()=>({top:100+row.offsetTop-scriptList.scrollTop});rows.set('segment-'+id,row);
  }
  const chapter={id:'chapter',title:'隔离播放夹具',workspaceIdentity:'workspace',revision:1,arrangement:1,segments:[],playbackItems:[],units:[],masters:[master]};
  const state={settings:{workspaceIdentity:'workspace'},jobs:[],chapters:[{id:chapter.id,revision:chapter.revision,arrangement:chapter.arrangement}]};
  const env={React,chapterPlaybackSnapshot,useCallback:fn=>fn,Link2:'Link2',master,chapter,chapterId:chapter.id,chapterRef:{current:chapter.id},connectionReady:true,playPreparing:false,playbackPreparation:{current:null},pendingPlaybackRead:{current:null},rangeResume:{current:null},
    player:{kind:'masters',id:master.id,title:chapter.title,master,chapterId:chapter.id,arrangement:chapter.arrangement,playbackItems:chapter.playbackItems,intent:1},playerRef:{current:null},playIntent:{current:1},
    follow:true,playing:true,currentSegment:'',currentMembers:[],currentHidden:false,filter:'all',search:'',bookmarks:{current:{}},chapterPlaybackSnapshots:{current:{}},
    pendingPlay:{current:null},pendingPlaySnapshot:{current:null},playbackIdentity:items=>JSON.stringify(items),active:()=>false,refresh:async()=>{},
    stateRef:{current:state},api:async path=>path==='/state'?state:path.endsWith('/playback-status')?{chapterId:chapter.id,workspaceIdentity:'workspace',revision:chapter.revision,arrangement:chapter.arrangement,renderRevision:0,renderSignature:null,activeJobs:[]}:chapter,
    applyChapter:value=>{env.chapter=value;},setChapter:value=>{env.chapter=value;},
    document:{getElementById:id=>rows.get(id),body:frame,documentElement:frame},window:{scrollTo:options=>calls.otherScroll.push(['window',options])},listRef:{current:scriptList},
    audio:{current:{src:'',currentTime:0,duration:10,readyState:4,paused:true,ended:false,getAttribute(name){return name==='src'?this.src||null:null;},load(){calls.loads++;this.currentTime=0;this.readyState=0;},play(){calls.plays++;this.paused=false;this.ended=false;this.readyState=4;return Promise.resolve();},pause(){calls.pauses++;this.paused=true;}}},
    setPlayer:value=>{calls.players.push(value);env.player=value;env.playerRef.current=value;},
    setError:value=>calls.errors.push(value),setNotice:value=>calls.notices.push(value),setDuration(){},
  };
  scriptList.scrollTo=options=>{calls.scroll.push({id:env.currentSegment,options});scriptList.scrollTop=Math.max(0,options.top);};
  for(const [setter,key] of [['setFollow','follow'],['setPlaying','playing'],['setPlayPreparing','playPreparing'],['setCurrentSegment','currentSegment'],['setCurrentMembers','currentMembers'],['setTransitioning','transitioning'],['setPosition','position'],['setFilter','filter'],['setSearch','search']])env[setter]=value=>{calls.writes.push([setter,value]);env[key]=value;};
  env.beginPlayback=project(beginPlayback,env);env.finishPlayback=project(finishPlayback,env);
  env.draftWorkspace=()=> 'workspace';env.readPlaybackChapter=(...args)=>project(find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='readPlaybackChapter').initializer,env)(...args);env.acceptPlaybackChapter=context=>{env.chapter=context.chapter;return true;};
  env.playerRef.current=env.player;
  return {env,calls,rows,time:t=>{env.audio.current.currentTime=t;project(timeUpdate,env)();},scroll:()=>{project(scrollEffect,env)();assert.deepEqual(calls.otherScroll,[],'只能滚动剧本列表，不能滚动页面或祖先容器');assert.equal(frame.scrollTop,26);},mount:()=>project(mediaEffect,env)(),start:(...args)=>project(startPlay,env)(...args),button:()=>project(followButton,env),input:(name,event)=>project(attribute(list,name).initializer.expression,env)(event)};
}
test('播放键读取媒体即时状态，快速暂停后React状态未更新也能一次续播',()=>{
  const f=fixture(),resumes=[];Object.assign(f.env,{startPlay:(...args)=>resumes.push(args),playChapter:()=>assert.fail('已有播放器不能重启整章')});
  f.env.audio.current.paused=false;f.env.playing=false;
  project(attribute(playbackButton,'onClick').initializer.expression,f.env)();
  assert.equal(f.env.audio.current.paused,true);assert.equal(f.calls.pauses,1);assert.equal(resumes.length,0);
  f.env.playing=true;
  project(attribute(playbackButton,'onClick').initializer.expression,f.env)();
  assert.equal(resumes.length,1);assert.equal(resumes[0][1],master.id);assert.equal(f.calls.pauses,1);
});

test('真实时间轴按memberIds定位单句和组，间隙书签进入下一单元且后续单句清组高亮',()=>{
  const f=fixture();f.time(.5);assert.equal(f.env.currentSegment,'single');assert.deepEqual(f.env.currentMembers,[]);f.scroll();
  f.time(4);assert.equal(f.env.currentSegment,'one');assert.deepEqual(f.env.currentMembers,['one','two']);assert.equal(f.env.bookmarks.current.chapter,'group');f.scroll();
  assert.deepEqual(f.calls.scroll.map(x=>x.id),['single','one']);assert.equal(f.env.transitioning,false);
  f.time(8.5);assert.equal(f.env.currentSegment,'one');assert.equal(f.env.transitioning,true);assert.equal(f.env.bookmarks.current.chapter,'next-unit');
  f.time(9.5);assert.equal(f.env.currentSegment,'next');assert.deepEqual(f.env.currentMembers,[]);assert.equal(f.env.transitioning,false);f.scroll();assert.equal(f.calls.scroll.at(-1).id,'next');
});

test('组内任一成员断点用于直接续播和母版迟到就绪定位，不被误判为断点失效',async()=>{
  const f=fixture();f.env.bookmarks.current.chapter='two';await f.start('masters',master.id,'整章',master);
  assert.equal(f.calls.players.length,1);assert.equal(f.calls.players[0].resumeAt,3);assert.deepEqual(f.calls.errors,[]);assert.deepEqual(f.calls.notices,[]);assert.equal(f.env.bookmarks.current.chapter,'two');
  assert.equal(project(readyPoint,{master,bookmark:'two'}),master.mapping[1]);
  f.time(4);assert.equal(f.env.bookmarks.current.chapter,'group');
  const legacy=fixture();legacy.env.player={...legacy.env.player,master:{...master,mapping:[{segmentId:'single',startFrame:0,endFrame:48000}]}};legacy.time(.5);assert.equal(legacy.env.currentSegment,'single');assert.deepEqual(legacy.env.currentMembers,[]);
});

test('旧播放意图的timeupdate不改变当前段落、组高亮、进度或断点',()=>{
  const f=fixture();f.env.currentSegment='next';f.env.currentMembers=[];f.env.bookmarks.current.chapter='next-unit';f.env.playIntent.current=2;
  f.time(4);assert.deepEqual(f.calls.writes,[]);assert.equal(f.env.currentSegment,'next');assert.deepEqual(f.env.currentMembers,[]);assert.equal(f.env.bookmarks.current.chapter,'next-unit');
});

test('手动滚轮、触摸、空白拖动和导航键暂停跟随，后续时间轴仍更新但不抢滚动',()=>{
  for(const [name,event] of [['onWheel',{}],['onTouchMove',{}],['onPointerDown',{target:'list',currentTarget:'list'}],['onKeyDown',{key:'PageDown'}]]){
    const f=fixture();f.time(4);f.scroll();f.input(name,event);assert.equal(f.env.follow,false);f.time(9.5);f.scroll();assert.equal(f.env.currentSegment,'next');assert.equal(f.calls.scroll.length,1,name);
  }
  const f=fixture();f.input('onPointerDown',{target:'child',currentTarget:'list'});f.input('onKeyDown',{key:'Enter'});assert.equal(f.env.follow,true,'点击行内动作和非导航键不会暂停跟随');
});

test('新母版及同母版重新播放恢复跟随并清旧定位，再由首个实际时间事件定位',async()=>{
  const f=fixture();
  for(let i=0;i<2;i++){
    f.env.follow=false;f.env.currentSegment='one';f.env.currentMembers=['one','two'];await f.start('masters',master.id,'整章',master);f.mount();await tick();
    assert.equal(f.env.follow,true);assert.equal(f.env.currentSegment,'');assert.deepEqual(f.env.currentMembers,[]);f.scroll();assert.equal(f.calls.scroll.length,i);
    f.time(4);f.scroll();assert.equal(f.calls.scroll.length,i+1);assert.equal(f.calls.scroll.at(-1).id,'one');
  }
  assert.equal(f.calls.loads,1,'同母版复用现有媒体资源');assert.equal(f.calls.plays,2);assert.deepEqual(f.calls.errors,[]);
});
test('同src暂停续播不重load，自然结束后仍复用媒体并从0重新播放',async()=>{
  const f=fixture();f.mount();await tick();assert.equal(f.calls.loads,1);
  f.env.audio.current.pause();f.env.audio.current.currentTime=4.25;
  await f.start('masters',master.id,'整章');f.mount();await tick();
  assert.equal(f.calls.loads,1);assert.equal(f.calls.plays,2);assert.equal(f.env.audio.current.currentTime,4.25);assert.equal(f.env.player.master,master);
  Object.assign(f.env.audio.current,{paused:true,ended:true,currentTime:10});
  await f.start('masters',master.id,'整章');f.mount();await tick();
  assert.equal(f.calls.loads,1);assert.equal(f.calls.plays,3);assert.equal(f.env.audio.current.currentTime,0);assert.equal(f.env.player.resumeAt,0);assert.deepEqual(f.calls.errors,[]);
});
test('裁剪后的自动母版续播保持用户浏览位置，只有主动播放恢复文字跟随',async()=>{
  const f=fixture();f.env.follow=false;f.env.player={...f.env.player,preserveBrowse:true};f.env.playerRef.current=f.env.player;f.mount();await tick();
  assert.equal(f.env.follow,false);f.time(4);f.scroll();assert.equal(f.calls.scroll.length,0);assert.equal(f.calls.plays,1);
});

test('只滚剧本列表：长段落对齐顶部、短段落居中；暂停恢复仍定位，关闭跟随或列表外不滚动',()=>{
  const f=fixture();f.time(4);f.scroll();assert.deepEqual(f.calls.scroll[0],{id:'one',options:{top:390,behavior:'instant'}});assert.equal(f.env.listRef.current.scrollTop,390);
  f.rows.get('segment-one').offsetHeight=301;f.scroll();assert.deepEqual(f.calls.scroll[1],{id:'one',options:{top:500,behavior:'instant'}});assert.equal(f.env.listRef.current.scrollTop,500);
  f.env.playing=false;f.env.follow=false;f.scroll();assert.equal(f.calls.scroll.length,2);
  const button=f.button();assert.equal(text(button),'回到当前播放');button.props.onClick();assert.equal(f.env.follow,true);assert.equal(f.env.playing,false);assert.equal(f.calls.scroll.length,2);
  f.scroll();assert.deepEqual(f.calls.scroll[2],{id:'one',options:{top:500,behavior:'instant'}});
  f.env.listRef.current.contains=()=>false;f.scroll();assert.equal(f.calls.scroll.length,3);
});

test('筛选隐藏不滚动；文字跟随按钮先恢复筛选，再由DOM更新后的效果定位',()=>{
  const f=fixture();f.time(4);const row=f.rows.get('segment-one');f.rows.delete('segment-one');f.env.currentHidden=true;f.env.filter='failed';f.env.search='其他台词';f.scroll();assert.deepEqual(f.calls.scroll,[]);
  let button=f.button();assert.equal(text(button),'回到当前播放');assert.equal(button.props['aria-pressed'],true);assert.equal(button.props.disabled,false);button.props.onClick();
  assert.equal(f.env.filter,'all');assert.equal(f.env.search,'');assert.equal(f.env.follow,true);assert.deepEqual(f.calls.scroll,[],'按钮不在隐藏DOM上直接滚动');
  f.rows.set('segment-one',row);f.env.currentHidden=false;f.scroll();assert.equal(f.calls.scroll[0].id,'one');button=f.button();assert.equal(text(button),'跟随播放');button.props.onClick();assert.equal(f.env.follow,false);f.time(9.5);f.scroll();assert.equal(f.calls.scroll.length,1);
  button=f.button();assert.equal(text(button),'回到当前播放');assert.equal(button.props['aria-pressed'],false);button.props.onClick();assert.equal(f.env.follow,true);f.scroll();assert.equal(f.calls.scroll.at(-1).id,'next');
  f.env.currentSegment='';assert.equal(f.button().props.disabled,true);
});
