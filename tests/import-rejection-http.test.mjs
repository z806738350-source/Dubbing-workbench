import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {startServer} from '../server/index.mjs';
import {uid} from '../server/store.mjs';

const compiled=ts.transpileModule(readFileSync(new URL('../src/api.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
const {action}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('H03真实HTTP/API：验证拒绝绑定命令且零创建，纠正新ID；丢回执同ID、冲突和内部失败不冒充notApplied',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-import-http-'));
  const app=await startServer({port:0,directory,config:{key:'fixture-no-provider',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'}});
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`,native=globalThis.fetch;let providerCalls=0,lostId;
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    const path=String(url),target=path.startsWith('/api/')?base+path:path;
    if(!target.startsWith(base+'/')){providerCalls++;throw Error('本测试禁止供应商请求');}
    const response=await native(target,init);
    if(lostId&&init?.body&&JSON.parse(init.body).operationId===lostId){lostId=null;await response.arrayBuffer();throw TypeError('fixture response lost after commit');}
    return response;
  });
  const project=await action('project.create',{name:'HTTP导入边界'});
  for(const length of [151,200]){
    const payload={projectId:project.id,operationId:uid(),title:'章'.repeat(length),source:'自拟完整正文。',importedSource:'自拟文件\r\n正文。',sourceFilename:'原稿.md',segment:false};
    await assert.rejects(action('chapter.create',payload),error=>error.status===400&&error.code==='import-validation-rejected'&&error.outcome==='notApplied'&&error.notApplied===true&&error.scope.action==='chapter.create'&&error.scope.operationId===payload.operationId&&error.scope.projectId===project.id&&/150/.test(error.fieldErrors.title));
    assert.equal(app.store.all('chapters').length,length===151?0:1);assert.equal(app.store.maybe('settings','ux-chapter-create:'+payload.operationId),null);
    const corrected=await action('chapter.create',{...payload,title:'章'.repeat(150),operationId:uid()});assert.equal(corrected.title.length,150);assert.equal(corrected.importedSource,payload.importedSource);assert.equal(corrected.sourceFilename,payload.sourceFilename);
  }
  const tooLong={projectId:project.id,operationId:uid(),title:'正文边界',source:'文'.repeat(1000001)};
  await assert.rejects(action('chapter.create',tooLong),error=>error.notApplied===true&&error.fieldErrors.source&&error.scope.operationId===tooLong.operationId);assert.equal(app.store.all('chapters').length,2);
  const payload={projectId:project.id,operationId:uid(),title:'丢回执',source:'自拟正文。'};lostId=payload.operationId;
  await assert.rejects(action('chapter.create',payload),error=>error.code==='connection-lost'&&error.notApplied===undefined&&error.scope.operationId===payload.operationId);assert.equal(app.store.all('chapters').length,3);
  const restored=await action('chapter.create',payload);assert.equal(app.store.all('chapters').length,3);assert.equal(restored.id,app.store.get('settings','ux-chapter-create:'+payload.operationId).chapterId);
  await assert.rejects(action('chapter.create',{...payload,title:'同ID改成另一个标题'}),error=>error.status===409&&error.notApplied===undefined&&error.outcome===undefined);assert.equal(app.store.all('chapters').length,3);
  const original=app.store.put.bind(app.store),brokenId=uid();t.mock.method(app.store,'put',(table,value,...args)=>{if(value.id==='ux-chapter-create:'+brokenId)throw Error('synthetic commit failure');return original(table,value,...args);});
  await assert.rejects(action('chapter.create',{...payload,operationId:brokenId}),error=>error.status===500&&error.retryClass==='check-existing-operation'&&error.notApplied===undefined);assert.equal(app.store.all('chapters').length,3);
  assert.equal(providerCalls,0);assert.equal(app.store.all('jobs').length,0);assert.equal(app.store.all('attempts').length,0);
});
