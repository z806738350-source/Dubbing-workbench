import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const read=path=>ts.createSourceFile(path,readFileSync(new URL('../'+path,import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=read('src/App.tsx'),wave=read('src/SegmentWaveform.tsx');
function find(file,predicate){let found;const visit=node=>{if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);};visit(file);assert.ok(found);return found;}
const expression=name=>find(app,node=>ts.isVariableDeclaration(node)&&node.name.getText(app)===name).initializer;
const paint=find(wave,node=>ts.isCallExpression(node)&&node.expression.getText(wave)==='useEffect'&&node.arguments[0]?.getText(wave).includes('const paint ='));
const project=(node,file,env)=>{const code=ts.transpileModule('const result=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+';return result;')(...Object.values(env));};
function sourceTime(player,rowAudio,position){const env={player,rowAudio,position};for(const name of ['mappedAudio','waveMasterFrame','inWaveRange','waveTime'])env[name]=project(expression(name),app,env);return env.waveTime;}
const master={sampleRate:48000,mapping:[{audioId:'one',startFrame:0,endFrame:96000,clipStartFrame:4800},{audioId:'group',startFrame:144000,endFrame:384000,clipStartFrame:9600},{audioId:'last',startFrame:432000,endFrame:480000,clipStartFrame:24000}]};
function canvas(){let width=0,height=0;const stats={width:0,height:0,clears:0,cursors:[],waveWidths:[]},rect={width:200,height:72};let point;
  const context={lineWidth:1,setTransform(){},clearRect(){stats.clears++;},fillRect(){},strokeRect(){},beginPath(){},moveTo(x,y){point=[x,y];},lineTo(x,y){if(this.strokeStyle==='#252d28')stats.cursors.push({from:point,to:[x,y]});else if(this.strokeStyle==='#3e8054'||this.strokeStyle==='#bac9be')stats.waveWidths.push(this.lineWidth);},stroke(){}};
  return {stats,rect,get width(){return width;},set width(value){width=value;stats.width++;},get height(){return height;},set height(value){height=value;stats.height++;},getBoundingClientRect:()=>rect,getContext:()=>context};
}
function painter(){const element=canvas(),env={canvas:{current:element},overview:{current:null},whole:{current:null},waveform:{startFrame:0,bucketFrames:24000,buckets:[{min:[-.3,-.1],max:[.5,.2]},{min:[-.2,-.4],max:[.2,.6]}]},shown:{startFrame:0,endFrame:240000},range:{sampleRate:48000,sourceFrames:240000},size:200,viewStart:0,viewEnd:240000,sourceTime:undefined,window:{devicePixelRatio:2},clamp:(value,low,high)=>Math.max(low,Math.min(high,value))};let previous;
  return {element,env,render(time){env.sourceTime=time;const deps=project(paint.arguments[1],wave,env);if(!previous||deps.some((value,index)=>!Object.is(value,previous[index]))){project(paint.arguments[0],wave,env)();previous=deps;}}};}

test('实际master行表达式仅给当前区间游标，跨段/gap/seek与章末正确，单段/组保持源坐标',()=>{
  const player={id:'master',master};
  for(const [position,expected] of [[1.25,[1.35,undefined,undefined]],[2,[undefined,undefined,undefined]],[3,[undefined,.2,undefined]],[7.5,[undefined,4.7,undefined]],[8,[undefined,undefined,undefined]],[9,[undefined,undefined,.5]],[10,[undefined,undefined,1.5]],[10.00000000001,[undefined,undefined,1.5]],[.5,[.6,undefined,undefined]]]){
    const actual=['one','group','last'].map(audio=>sourceTime(player,audio,position));actual.forEach((value,index)=>expected[index]===undefined?assert.equal(value,undefined):assert.ok(Math.abs(value-expected[index])<1e-9));
  }
  assert.equal(sourceTime({id:'group',sourceStartFrame:9600,sampleRate:48000},'group',1.5),1.7);assert.equal(sourceTime({id:'one',sourceStartFrame:4800,sampleRate:48000},'group',1.5),undefined);
});

test('实际paint依赖让非当前行不随timeupdate重画，前一段离开只清一次',()=>{
  const rows=['one','group','last'].map(()=>painter()),player={id:'master',master};
  for(const position of [.5,1,1.5])rows.forEach((row,index)=>row.render(sourceTime(player,['one','group','last'][index],position)));
  assert.deepEqual(rows.map(row=>row.element.stats.clears),[3,1,1]);
  for(const position of [2,2.25,2.5])rows.forEach((row,index)=>row.render(sourceTime(player,['one','group','last'][index],position)));
  assert.deepEqual(rows.map(row=>row.element.stats.clears),[4,1,1]);
  for(const position of [3,3.25,3.5])rows.forEach((row,index)=>row.render(sourceTime(player,['one','group','last'][index],position)));
  assert.deepEqual(rows.map(row=>row.element.stats.clears),[4,4,1]);
});

test('实际paint固定尺寸连续更新只分配一次，高DPI/Resize/zoom仍调整，游标坐标准确',()=>{
  const f=painter();for(let i=0;i<20;i++)f.render(1+i*.01);
  assert.deepEqual([f.element.stats.width,f.element.stats.height],[1,1]);assert.equal(f.element.stats.clears,20);assert.ok(f.element.stats.waveWidths.every(width=>width===1));
  f.render(2.5);assert.deepEqual(f.element.stats.cursors.at(-1),{from:[100,0],to:[100,72]});
  f.element.rect.width=300;f.env.size=300;f.render(2.5);assert.deepEqual([f.element.stats.width,f.element.stats.height],[2,1]);assert.deepEqual(f.element.stats.cursors.at(-1).from,[150,0]);
  f.env.window.devicePixelRatio=3;f.render(2.51);assert.deepEqual([f.element.width,f.element.height],[900,216]);assert.deepEqual([f.element.stats.width,f.element.stats.height],[3,2]);
  f.env.viewStart=48000;f.env.viewEnd=144000;f.render(2);assert.deepEqual(f.element.stats.cursors.at(-1).from,[150,0]);assert.deepEqual([f.element.stats.width,f.element.stats.height],[3,2]);
});
