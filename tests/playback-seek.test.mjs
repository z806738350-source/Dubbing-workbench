import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'实际播放节点应存在');return found;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const attr=(node,name)=>node.attributes.properties.find(a=>ts.isJsxAttribute(a)&&a.name.getText(file)===name);
const seekNode=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='seekPlayback').initializer;
const keyEffect=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[1]?.getText(file)==='[seekPlayback]').arguments[0];
const button=label=>find(node=>ts.isJsxOpeningElement(node)&&node.tagName.getText(file)==='button'&&attr(node,'aria-label')?.initializer?.text===label);
const progress=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='input'&&attr(node,'aria-label')?.initializer?.text==='播放进度');

// Supply selector membership and ancestor traversal at the DOM boundary;
// execute the production listener itself, including its actual selector list.
class Target {
  constructor(selectors=[],parent=null){this.selectors=selectors;this.parent=parent;}
  matches(selector){return selector.split(',').some(part=>this.selectors.includes(part.trim()));}
  closest(selector){return this.matches(selector)?this:this.parent?.closest(selector)||null;}
}
function fixture(){
  const writes=[],listeners=new Map(),player={kind:'masters',id:'chapter-audio',intent:4},intent={current:5};
  const media={currentTime:12.5,duration:30,readyState:4,paused:true,ended:false,play(){assert.fail('快进退不应开始播放');},pause(){assert.fail('快进退不应暂停');},load(){assert.fail('快进退不应重载音频');}};
  const env={useCallback:callback=>callback,audio:{current:media},playerRef:{current:player},playIntent:intent,setPosition:value=>writes.push(value),Element:Target,
    window:{addEventListener(name,handler){assert.equal(name,'keydown');assert.equal(listeners.has(name),false);listeners.set(name,handler);},removeEventListener(name,handler){assert.equal(listeners.get(name),handler);listeners.delete(name);}}};
  env.seekPlayback=project(seekNode,env);
  return {env,media,writes,player,intent,listeners,seek:env.seekPlayback,mount:()=>project(keyEffect,env)(),key(key,extra={}){const event={key,target:new Target(),defaultPrevented:false,isComposing:false,altKey:false,ctrlKey:false,metaKey:false,shiftKey:false,preventDefault(){this.defaultPrevented=true;},...extra};listeners.get('keydown')?.(event);return event;}};
}

test('左右键各移动五秒，单段和整章在播放或暂停时都保留原状态和播放意图',()=>{
  for(const kind of ['audios','masters'])for(const paused of [false,true]){
    const f=fixture();f.player.kind=kind;f.media.paused=paused;f.mount();
    assert.equal(f.key('ArrowRight').defaultPrevented,true);assert.equal(f.media.currentTime,17.5);
    assert.equal(f.key('ArrowLeft').defaultPrevented,true);assert.equal(f.media.currentTime,12.5);
    assert.deepEqual(f.writes,[17.5,12.5]);assert.equal(f.media.paused,paused);assert.equal(f.env.playerRef.current,f.player);assert.equal(f.intent.current,5);
  }
});

test('五秒定位限制在音频两端，短音频、自然结束及再次后退均可用',()=>{
  const f=fixture();f.media.duration=3;f.media.currentTime=1;f.mount();
  f.key('ArrowLeft');assert.equal(f.media.currentTime,0);f.key('ArrowRight');assert.equal(f.media.currentTime,3);
  f.media.ended=true;f.key('ArrowRight');assert.equal(f.media.currentTime,3);f.key('ArrowLeft');assert.equal(f.media.currentTime,0);
  assert.deepEqual(f.writes,[0,3,3,0]);assert.equal(f.media.paused,true);
});

test('连续按键使用媒体最新时间，新音频也通过引用读取而不会被旧闭包定位',()=>{
  const f=fixture();f.mount();f.key('ArrowRight');f.media.currentTime=18.25;
  f.key('ArrowRight',{repeat:true});assert.equal(f.media.currentTime,23.25);
  f.env.audio.current={...f.media,currentTime:100,duration:180};f.env.playerRef.current={kind:'audios',id:'new-audio'};
  f.key('ArrowLeft');assert.equal(f.env.audio.current.currentTime,95);assert.equal(f.media.currentTime,23.25);
  assert.deepEqual(f.writes,[17.5,23.25,95]);
});

test('没有当前音频、媒体未就绪或时长不可用时不定位也不拦截方向键',()=>{
  for(const configure of [f=>f.env.playerRef.current=null,f=>f.env.audio.current=null,f=>f.media.readyState=0,...[NaN,Infinity,0,-1].map(duration=>f=>f.media.duration=duration)]){
    const f=fixture();configure(f);f.mount();assert.equal(f.seek(5),false);assert.equal(f.key('ArrowRight').defaultPrevented,false);assert.deepEqual(f.writes,[]);assert.equal(f.media.currentTime,12.5);
  }
});

test('输入文字、选择选项和其他交互控件的方向键不改变播放器',()=>{
  for(const selector of ['input','textarea','select','[contenteditable]:not([contenteditable="false"])',...['textbox','combobox','slider','spinbutton','listbox','tablist','menu'].map(role=>'[role="'+role+'"]')]){
    for(const nested of [false,true]){
      const f=fixture();f.mount();const control=new Target([selector]),target=nested?new Target([],control):control;
      assert.equal(f.key('ArrowRight',{target}).defaultPrevented,false,selector);assert.equal(f.media.currentTime,12.5,selector);assert.deepEqual(f.writes,[]);
    }
  }
});

test('播放进度条获得焦点时依然移动五秒，并拦截原生百分之一秒的默认移动',()=>{
  assert.ok(attr(progress,'data-playback-progress'),'实际进度条必须带有快捷键定位标识');
  assert.equal(attr(progress,'aria-keyshortcuts').initializer.text,'ArrowLeft ArrowRight');
  const f=fixture();f.mount();const target=new Target(['input','input[data-playback-progress]']);
  assert.equal(f.key('ArrowRight',{target}).defaultPrevented,true);assert.equal(f.media.currentTime,17.5);
  assert.equal(f.key('ArrowLeft',{target}).defaultPrevented,true);assert.equal(f.media.currentTime,12.5);
});

test('组合键、输入法、已经消费的事件及其他按键不触发跳转',()=>{
  for(const extra of [{altKey:true},{ctrlKey:true},{metaKey:true},{shiftKey:true},{isComposing:true},{defaultPrevented:true}]){
    const f=fixture();f.mount();f.key('ArrowLeft',extra);assert.deepEqual(f.writes,[]);assert.equal(f.media.currentTime,12.5);
  }
  const f=fixture();f.mount();for(const key of ['ArrowUp','ArrowDown',' ','Enter','Home','End'])assert.equal(f.key(key).defaultPrevented,false);assert.deepEqual(f.writes,[]);
});

test('非输入区域和没有Element目标的事件可定位，卸载后不留下监听器',()=>{
  const f=fixture();const cleanup=f.mount();f.key('ArrowRight',{target:null});assert.equal(f.media.currentTime,17.5);
  f.key('ArrowLeft',{target:new Target(['button'])});assert.equal(f.media.currentTime,12.5);
  cleanup();assert.equal(f.listeners.size,0);f.key('ArrowRight');assert.equal(f.media.currentTime,12.5);
  const secondCleanup=f.mount();f.key('ArrowRight');assert.equal(f.media.currentTime,17.5);secondCleanup();assert.equal(f.listeners.size,0);
});

test('前进后退按钮使用与键盘同一个定位动作并标注快捷键',()=>{
  const f=fixture();for(const [label,key,expected] of [['后退五秒','ArrowLeft',7.5],['前进五秒','ArrowRight',12.5]]){
    const node=button(label);assert.equal(attr(node,'aria-keyshortcuts').initializer.text,key);
    project(attr(node,'onClick').initializer.expression,f.env)();assert.equal(f.media.currentTime,expected);
  }
  assert.deepEqual(f.writes,[7.5,12.5]);assert.equal(f.media.paused,true);assert.equal(f.intent.current,5);
});
