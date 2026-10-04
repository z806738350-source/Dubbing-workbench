import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let section;
function visit(node){
  if(ts.isJsxElement(node)&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='className'&&ts.isStringLiteral(attr.initializer)&&attr.initializer.text==='inspector-section inspector-audio-version'))section=node;
  if(!section)ts.forEachChild(node,visit);
}
visit(file);assert.ok(section);
const code=ts.transpileModule('const section=('+section.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
function fixture(p={}){
  const calls={opened:0,restored:[],saved:[]};
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    enhancedUnit:null,activeVariant:null,s:{id:'segment',previous:'previous',approved:'approved',current:'current',latest:'success',validity:'matched',review:'pending'},
    locked:false,dirty:false,connectionReady:true,names:{success:'已生成',matched:'音频匹配',pending:'待检查'},
    Headphones:'Headphones',ChevronRight:'ChevronRight',RotateCcw:'RotateCcw',onUnit:()=>calls.opened++,setRestore:id=>calls.restored.push(id),
    run:fn=>fn(),save:async(...args)=>calls.saved.push(args),basis:()=>({text:'exact'}),...p};
  const tree=new Function(...Object.keys(env),code+'return section;')(...Object.values(env));
  const buttons=nodes(tree).filter(node=>node.type==='button');
  return {calls,tree,buttons,button:label=>buttons.find(node=>text(node)===label)};
}
for(const [kind,mode] of [['single','scene'],['group','scene'],['group','dry']])test(`${kind}/${mode}只保留实际的检查与版本入口，不用恢复标签重复打开同面板`,()=>{
  const f=fixture({enhancedUnit:{kind,mode},activeVariant:{previous:'unit-previous',approved:'unit-approved',latest:'success',status:{validity:'matched',review:'pending'}}});
  assert.deepEqual(f.buttons.map(text),['检查与管理版本']);f.buttons[0].props.onClick();
  assert.equal(f.calls.opened,1);assert.deepEqual(f.calls.restored,[]);assert.deepEqual(f.calls.saved,[]);
});
test('普通单句恢复按钮明确目标，只打开原有恢复预览；返工仍针对当前音频',async()=>{
  const f=fixture();f.button('恢复上一版').props.onClick();f.button('恢复最近通过版').props.onClick();
  assert.deepEqual(f.calls.restored,['previous','approved']);assert.equal(f.calls.opened,0);assert.deepEqual(f.calls.saved,[]);
  await f.button('标记需返工').props.onClick();
  assert.deepEqual(f.calls.saved,[['segment.review',{id:'segment',audioId:'current',basis:{text:'exact'},state:'rework'}]]);
});
test('没有历史/未保存/任务锁定时恢复仍不可用，浏览实际单元的入口可打开',()=>{
  for(const state of [{s:{previous:null,approved:null}},{dirty:true},{locked:true}]){
    const f=fixture(state);for(const label of ['恢复上一版','恢复最近通过版'])assert.equal(f.button(label).props.disabled,true);
  }
  const empty=fixture({s:{previous:null,approved:null}});assert.match(text(empty.tree),/还没有可恢复的历史声音/);assert.equal(empty.button('恢复上一版').props.title,undefined);
  const busy=fixture({locked:true,dirty:true,enhancedUnit:{kind:'single',mode:'scene'}});assert.notEqual(busy.button('检查与管理版本').props.disabled,true);
});
