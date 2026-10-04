import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ts from 'typescript';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found);return found;}
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const progress=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='details'&&node.openingElement.attributes.properties.some(a=>ts.isJsxAttribute(a)&&a.name.text==='className'&&a.initializer?.text==='parallel-attempts'));
const text=n=>n==null||typeof n==='boolean'?'':typeof n!=='object'?String(n):(n.props?.children||[]).flat(Infinity).map(text).join('');
const React={createElement:(type,props,...children)=>({type,props:{...props,children}})};
test('逐段快照保留所有并行对象及顺序，投影不携带正文、参考路径或凭据',t=>{
 const directory=mkdtempSync(join(tmpdir(),'task-progress-')),store=openStore(directory),domain=createDomain(store,{});t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
 const p=domain.mutate('project.create',{name:'test'}),c=domain.mutate('chapter.create',{projectId:p.id,title:'test',source:'test',segment:true}),segment=domain.list(c.id)[0];
 store.put('jobs',{id:'j',chapterId:c.id,kind:'unit-generate',status:'running',total:3,done:0,createdAt:new Date().toISOString()},c.id);
 for(const a of [{id:'b',ordinal:1,status:'sending',phase:'processing',deliveryVersion:1},{id:'c',ordinal:2,status:'queued',phase:'queued'},{id:'a',ordinal:0,status:'sending',phase:'receiving',deliveryVersion:1}])store.put('attempts',{...a,jobId:'j',unitId:segment.id,mode:'dry',input:{members:[{id:segment.id,text:'SECRET_TEXT'}],referenceVoiceIds:['SECRET_PATH']},prompt:'SECRET_PROMPT'},'j');
 const job=domain.snapshot().jobs[0];assert.deepEqual(job.attempts.map(a=>a.id),['a','b','c']);assert.deepEqual(job.attempts.map(a=>a.submitted),[true,true,false]);assert.deepEqual(job.attempts[0].memberNumbers,[1]);assert.ok(!JSON.stringify(job.attempts).includes('SECRET'));
 const view=project(progress,{React,j:job,names:{}});assert.match(text(view),/接收音频/);assert.match(text(view),/本机整理/);assert.match(text(view),/等待发送/);assert.match(text(view),/尚未发送/);assert.match(text(view),/已发送，可能计费/);
});
test('助手卸载后才返回入口焦点，同时打开另一浮层不抢焦点',()=>{
 const effect=find(n=>ts.isCallExpression(n)&&n.expression.getText(file)==='useEffect'&&n.arguments[1]?.getText(file)==='[assistantOpen]');let openDialog=false,focused=0;
 const env={assistantWasOpen:{current:false},assistantOpen:false,assistantButton:{current:{focus(){focused++;}}},document:{querySelector(){return openDialog?{}:null;}},useEffect:fn=>fn()};
 project(effect,env);assert.equal(focused,0);env.assistantOpen=true;project(effect,env);assert.equal(focused,0);env.assistantOpen=false;project(effect,env);assert.equal(focused,1);
 env.assistantOpen=true;project(effect,env);env.assistantOpen=false;openDialog=true;project(effect,env);assert.equal(focused,1);
});
