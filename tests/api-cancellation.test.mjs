import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=ts.transpileModule(readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {api}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));

test('免费GET可取消连接或JSON读取，取消写入仍保留未知回执分类',async t=>{
  for(const bodyPhase of [false,true]){
    const abort=new AbortController(),error=new DOMException('只取消本次读取','AbortError');
    const pending=()=>new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(error),{once:true}));
    t.mock.method(globalThis,'fetch',async(_url,init)=>{assert.equal(init.signal,abort.signal);return bodyPhase?{ok:true,json:pending}:await pending();});
    const reading=api('/state',undefined,undefined,{signal:abort.signal});await new Promise(resolve=>setImmediate(resolve));abort.abort();await assert.rejects(reading,failure=>failure===error);t.mock.restoreAll();
  }
  const abort=new AbortController(),error=new DOMException('发送后连接结束','AbortError');
  t.mock.method(globalThis,'fetch',async(_url,init)=>{assert.equal(init.method,'POST');return new Promise((_resolve,reject)=>abort.signal.addEventListener('abort',()=>reject(error),{once:true}));});
  const writing=api('/operations',{operationId:'original-operation'},undefined,{signal:abort.signal});abort.abort();await assert.rejects(writing,failure=>failure.retryClass==='check-existing-operation'&&failure.scope.operationId==='original-operation'&&failure.cause===error);
});
