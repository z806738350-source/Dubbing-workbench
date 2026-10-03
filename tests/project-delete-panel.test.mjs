import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const component=source.slice(source.indexOf('type ProjectDeletionPlan='),source.indexOf('/* Hallmark · component: workspace location'));
const code=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const tick=()=>new Promise(r=>setImmediate(r));
function setup(){let index=0,close=0,reads=0;const hooks=[],effects=[],sent=[],scope={project:{revision:1},chapters:[{id:'one',revision:1}]};
  const plan={projectId:'project',name:'测试项目',scope,counts:{chapters:1,audios:2,masters:1,exports:1},chapters:[{id:'one',title:'原章节',revision:1,arrangement:2}]};
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog:'Dialog',useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>hooks[i]=typeof next==='function'?next(hooks[i]):next];},useRef:value=>hooks[index++]||={current:value},useEffect:next=>effects.push(next),api:async path=>{assert.equal(path,'/projects/project/deletion-plan');reads++;return {...plan,scope:JSON.parse(JSON.stringify(plan.scope))};}};
  const ProjectDeleteDialog=new Function(...Object.keys(env),code+';return ProjectDeleteDialog;')(...Object.values(env));
  const props={project:{id:'project',name:'测试项目'},onClose:()=>close++,onDelete:async value=>{sent.push(value);if(JSON.stringify(value)!==JSON.stringify(plan.scope))throw Object.assign(new Error('删除范围已变化'),{status:409});}};
  const render=()=>{index=0;return ProjectDeleteDialog(props);};render();const cleanup=effects[0]();
  const button=()=>nodes(render().props.footer).find(node=>node.type==='button');return {props,plan,sent,render,button,cleanup,close:()=>close,reads:()=>reads};}
test('单层项目预览明确列章与文件数量，最终删除使用同一opaque scope',async()=>{const f=setup();await tick();assert.match(JSON.stringify(f.render()),/原章节/);assert.match(JSON.stringify(f.render()),/2.*份原始音频/);assert.equal(f.sent.length,0);await f.button().props.onClick();await tick();assert.deepEqual(f.sent,[f.plan.scope]);assert.equal(f.close(),1);assert.equal(f.reads(),1);});
test('预览后另一页新增章，409仅原处重核对，重新明确点击才删新范围',async()=>{const f=setup();await tick();f.plan.scope.chapters.push({id:'two',revision:1});f.plan.chapters.push({id:'two',title:'新增章节',revision:1,arrangement:1});f.plan.counts.chapters=2;f.button().props.onClick();await tick();assert.equal(f.close(),0);assert.equal(f.sent.length,1);assert.match(JSON.stringify(f.render()),/本次未删除/);assert.match(JSON.stringify(f.button()),/重新核对删除范围/);f.button().props.onClick();await tick();assert.equal(f.sent.length,1);assert.match(JSON.stringify(f.render()),/新增章节/);f.button().props.onClick();await tick();assert.equal(f.sent.length,2);assert.deepEqual(f.sent[1],f.plan.scope);assert.equal(f.close(),1);});
test('已发删除回执晚到时，关闭的预览不会关闭后来新页面',async()=>{const f=setup();await tick();let resolve;f.props.onDelete=value=>{f.sent.push(value);return new Promise(r=>resolve=r);};f.button().props.onClick();f.cleanup();resolve();await tick();assert.equal(f.close(),0);assert.equal(f.sent.length,1);});
