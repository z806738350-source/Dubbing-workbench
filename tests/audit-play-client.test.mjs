import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,env){let found;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(file)===name)found=node.initializer;ts.forEachChild(node,visit);}visit(file);assert.ok(found);const code=ts.transpileModule('const projected=('+found.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:value=>resolve(value)}};
const chapter={id:'chapter',title:'夹具',arrangement:1,playbackItems:[],units:[]};
function fixture(){const players=[],errors=[],env={playIntent:{current:0},pendingPlay:{current:null},pendingPlaySnapshot:{current:null},connectionReady:true,chapter,chapterId:'chapter',chapterRef:{current:'chapter'},api:async path=>path==='/state'?{jobs:[]}:chapter,active:()=>false,refresh:async()=>{},playerRef:{current:null},audio:{current:{pause(){},paused:true,play:async()=>{}}},bookmarks:{current:{}},playbackIdentity:items=>JSON.stringify(items),setError:e=>errors.push(e),setNotice(){},setPosition(){},setDuration(){},setTransitioning(){},setPlaying(){},setPlayer:p=>{players.push(p);env.playerRef.current=p;}};return {env,players,errors,start:()=>callback('startPlay',env)};}
test('实际播放回调：慢A不能抢回后选B或参考的播放意图',async()=>{for(const kind of ['audios','voices']){const f=fixture(),read=defer();f.env.api=async path=>path==='/state'?{jobs:[]}:read.promise;const a=f.start()('audios','A','A');await f.start()(kind,'B','B',undefined,true);read.resolve(chapter);await a;assert.deepEqual(f.players.map(p=>p.id),['B']);}});
test('实际播放回调：准备中停止使迟到声音和错误失效',async()=>{const f=fixture(),read=defer();f.env.api=async()=>read.promise;const a=f.start()('audios','A','A');f.env.playIntent.current++;read.resolve(chapter);await a;assert.deepEqual(f.players,[]);assert.deepEqual(f.errors,[]);});
test('实际播放回调：再次点正在试听的来源立即暂停，不等待预检或媒体下载',async()=>{const f=fixture();let paused=0,reads=0;f.env.playerRef.current={kind:'audios',id:'A'};f.env.audio.current.paused=false;f.env.audio.current.pause=()=>paused++;f.env.api=async()=>{reads++;throw Error('不应读取');};await f.start()('audios','A','A');assert.equal(paused,1);assert.equal(reads,0);assert.equal(f.players.length,0);assert.equal(f.env.playIntent.current,1);});
