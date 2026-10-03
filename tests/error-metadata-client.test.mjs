import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compiled=ts.transpileModule(readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {api}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));
test('API保留服务错误元数据与对象范围，500和连接丢回执只核对原操作',async t=>{
  let response,calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;if(response instanceof Error)throw response;return response;});
  response=new Response(JSON.stringify({error:'原处具体提示',code:'state-conflict',scope:{unitId:'unit',mode:'scene'},retryClass:'refresh-and-review'}),{status:409});
  await assert.rejects(api('/action',{action:'unit.restore',chapterId:'chapter',id:'unit',mode:'scene'}),error=>error.status===409&&error.code==='state-conflict'&&error.scope.chapterId==='chapter'&&error.scope.unitId==='unit'&&error.retryClass==='refresh-and-review');
  response=new Response(JSON.stringify({error:'服务中断',code:'operation-result-unconfirmed',scope:{operationId:'stable'},retryClass:'check-existing-operation'}),{status:500});
  await assert.rejects(api('/operations',{operationId:'stable',chapterId:'chapter'}),error=>error.status===500&&error.retryClass==='check-existing-operation'&&error.scope.operationId==='stable'&&/记录/.test(error.message));
  response=new TypeError('lost response');await assert.rejects(api('/operations',{operationId:'same',chapterId:'chapter'}),error=>error.code==='connection-lost'&&error.retryClass==='check-existing-operation'&&error.scope.operationId==='same');
  assert.equal(calls,3,'读取错误不会自动重发原POST');
});

test('无法读取的成功回执保留原操作范围，不伪装为确认失败或再次发送',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{unreadable',{status:200});});
  await assert.rejects(api('/operations',{operationId:'stable',data:{chapterId:'chapter',id:'segment'},action:'segment.update'}),error=>error.code==='response-unreadable'&&error.retryClass==='check-existing-operation'&&error.scope.operationId==='stable'&&error.scope.segmentId==='segment');
  assert.equal(calls,1);
});

test('真实保存错误回调：500未确认不清原操作ID，409确定冲突仍允许核对后保存',async()=>{
  const source=readFileSync(new URL('../src/ObjectDraft.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('ObjectDraft.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let caught;
  function visit(node){if(ts.isCatchClause(node)&&node.getText(file).includes('forgetSaveOperation(key,known.id'))caught=node;else ts.forEachChild(node,visit);}visit(file);assert.ok(caught);
  const code=ts.transpileModule('async function run(){try{throw failure;}'+caught.getText(file)+'}',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  let cleared=0;const env={failure:{status:500,retryClass:'check-existing-operation',message:'先核对原操作'},key:'same',workspaceIdentity:'/A',pendingSaveOperation:()=>({id:'stable'}),forgetSaveOperation:()=>cleared++,report(){},current:{current:{status:'local'}},storageFailure:()=>false};
  const run=()=>new Function(...Object.keys(env),code+';return run;')(...Object.values(env))();
  await assert.rejects(run());assert.equal(cleared,0);env.failure={status:409,retryClass:'refresh-and-review',message:'资料已变化'};await assert.rejects(run());assert.equal(cleared,1);
});
