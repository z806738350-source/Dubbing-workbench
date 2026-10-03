import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),component=source.slice(source.indexOf('function WorkspaceLocation('),source.indexOf('function RenameProject('));
const code=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
function setup(){let index=0,moved=0;const hooks=[],effects=[],calls=[],report={scope:'current-workspace',counts:{voices:1,audios:2,masters:1,exports:1},bytes:{voices:1024,audios:2097152,masters:1048576,exports:1024},missing:[],primaryAvailable:true};
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Form:'Form',useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=typeof value==='function'?value():value;return [hooks[i],next=>hooks[i]=typeof next==='function'?next(hooks[i]):next];},useEffect:next=>effects.push(next),navigator:{clipboard:{writeText:async()=>{}}},api:async(path,payload)=>{calls.push({path,payload});if(path==='/workspace/diagnostics')return JSON.parse(JSON.stringify(report));if(path==='/workspace/choose')return {directory:'/B'};if(path==='/workspace/move')return {directory:'/B'};assert.fail(path);}};
  const WorkspaceLocation=new Function(...Object.keys(env),code+';return WorkspaceLocation;')(...Object.values(env)),props={directory:'/A',projectCount:1,projectFolders:true,onMoved:async()=>moved++};
  const render=()=>{index=0;return WorkspaceLocation(props);};render();effects[0]();const button=label=>nodes(render()).find(node=>node.type==='button'&&JSON.stringify(node.props.children).includes(label));const form=()=>nodes(render()).find(node=>node.type==='Form');return {report,calls,props,render,button,form,moved:()=>moved};
}
test('核对资料与空间就地列分类数量/大小，缺母版与原件修复不同且不清历史',async()=>{
  const f=setup();f.report.missing=[{kind:'masters',id:'m',path:'master.wav',repairable:true}];await f.button('核对资料与空间').props.onClick();const text=JSON.stringify(f.render());assert.match(text,/参考录音原件/);assert.match(text,/生成声音原件/);assert.match(text,/2.0 MB/);assert.match(text,/可免费重建整章试听母版/);assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/workspace/diagnostics');assert.ok(!f.button('清理'));
});
test('选择新位置先读取诊断；原件缺失禁迁移且真实回调零移动',async()=>{
  const f=setup();f.report.missing=[{kind:'audios',id:'a',path:'original.wav',repairable:false}];f.report.primaryAvailable=false;await f.button('更改位置').props.onClick();assert.deepEqual(f.calls.map(c=>c.path),['/workspace/diagnostics','/workspace/choose']);assert.equal(f.form().props.busy,true);assert.match(JSON.stringify(f.render()),/暂不能迁移/);await assert.rejects(f.form().props.onSubmit(),/处理缺失的原件/);assert.equal(f.calls.filter(c=>c.path==='/workspace/move').length,0);
});
test('完整原件迁移沿现有单层表单；工作区在选择后改变时不迁移旧范围',async()=>{
  const f=setup();await f.button('更改位置').props.onClick();assert.equal(f.form().props.busy,false);await f.form().props.onSubmit();assert.deepEqual(f.calls.at(-1),{path:'/workspace/move',payload:{source:'/A',directory:'/B'}});assert.equal(f.moved(),1);
  const changed=setup();await changed.button('更改位置').props.onClick();changed.props.directory='/new-workspace';assert.equal(changed.form().props.busy,true);await assert.rejects(changed.form().props.onSubmit(),/当前工作区/);assert.equal(changed.calls.filter(c=>c.path==='/workspace/move').length,0);
});
