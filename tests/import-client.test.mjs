import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const component=source.slice(source.indexOf('type ImportDraft ='),source.indexOf('function VoiceLibrary('));
const compiled=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
function setup({records=new Map(),create=async()=>({id:'created'}),navigate=async()=>{},failStorage=false}={}){
  let index=0;const hooks=[],effects=[],sent=[],writes=[],opened=[];
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog:'Dialog',Form:'Form',Field:'Field',Upload:'Upload',TextDecoder,crypto,
    useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=typeof value==='function'?value():value;return [hooks[i],value=>hooks[i]=typeof value==='function'?value(hooks[i]):value];},useRef:value=>hooks[index++]||={current:value},useEffect:next=>effects.push(next),
    draftWorkspace:()=>'/fixture',readDraft:id=>records.has(id)?{draft:JSON.parse(records.get(id))}:null,writeDraft:(id,value)=>{if(failStorage)throw new Error('quota');records.set(id,JSON.stringify(value));writes.push(JSON.parse(JSON.stringify(value)));},clearDraft:id=>records.delete(id),action:async(name,payload)=>{sent.push(payload);return create(payload);}};
  const ImportChapter=new Function(...Object.keys(env),compiled+';return ImportChapter;')(...Object.values(env));
  const props={projectId:'project',onClose(){},onCreated:async(...args)=>{opened.push(args);await navigate(...args);}};
  const render=()=>{index=0;return ImportChapter(props);};
  const form=()=>nodes(render()).find(node=>node.type==='Form');
  const input=text=>{nodes(render()).find(node=>node.type==='textarea').props.onChange({target:{value:text}});};
  const file=value=>nodes(render()).find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[value]}});
  render();const cleanup=effects[0]();return {render,form,input,file,records,sent,writes,opened,close:cleanup};
}
const tick=()=>new Promise(r=>setImmediate(r));
test('导入持久命令先于发送，丢回执重试同operationId和payload；明确再导入生成新ID',async()=>{
  let calls=0;const f=setup({create:async()=>{if(!calls++)throw new TypeError('lost response');return {id:'created'};}});f.input('完整正文');
  await assert.rejects(f.form().props.onSubmit(),/lost/);const command=JSON.parse(f.records.get('import-chapter/project')).command;
  assert.deepEqual(command.payload.source,'完整正文');assert.equal(f.sent[0].operationId,command.operationId);
  await f.form().props.onSubmit();assert.equal(f.sent[1].operationId,command.operationId);assert.deepEqual(f.sent[0],f.sent[1]);assert.equal(f.records.size,0);
  const again=setup();again.input('完整正文');await again.form().props.onSubmit();assert.notEqual(again.sent[0].operationId,command.operationId);
});
test('存储失败不先建章；原文留在编辑框可复制',async()=>{const f=setup({failStorage:true});f.input('不能丢的正文');await assert.rejects(f.form().props.onSubmit(),/可靠保存/);assert.equal(f.sent.length,0);assert.equal(nodes(f.render()).find(node=>node.type==='textarea').props.value,'不能丢的正文');});
test('已创建但导航失败只恢复导航，不再创建章；关闭重开可恢复非空草稿',async()=>{let nav=0;const f=setup({navigate:async()=>{if(!nav++)throw new Error('navigation failed');}});f.input('保存正文');await assert.rejects(f.form().props.onSubmit(),/navigation/);assert.equal(f.sent.length,1);await f.form().props.onSubmit();assert.equal(f.sent.length,1);assert.deepEqual(f.opened,[['created',true],['created',true]]);const draft=setup();draft.input('未导入草稿');draft.close();const restored=setup({records:draft.records});assert.equal(nodes(restored.render()).find(node=>node.type==='textarea').props.value,'未导入草稿');});
test('文件A慢于B只保留B；编辑预览保留原始文件来源',async()=>{const f=setup(),a=defer(),bytes=s=>new TextEncoder().encode(s).buffer;f.file({name:'A.txt',size:1,arrayBuffer:()=>a.promise});f.file({name:'B.md',size:1,arrayBuffer:async()=>bytes('B\r\n原始')});await tick();a.resolve(bytes('A旧文'));await tick();let draft=JSON.parse(f.records.get('import-chapter/project'));assert.equal(draft.title,'B');assert.equal(draft.source,'B\n原始');f.input('B人工预览');draft=JSON.parse(f.records.get('import-chapter/project'));assert.equal(draft.imported.text,'B\r\n原始');assert.equal(draft.source,'B人工预览');});
test('文件大小预检、解码失败、读取失败区分，关闭使迟到读取失效',async()=>{const f=setup();let read=0;f.file({name:'big',size:5*1024*1024,arrayBuffer:async()=>{read++;}});assert.equal(read,0);assert.match(JSON.stringify(f.render()),/超过4 MB/);f.file({name:'bad',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer});await tick();assert.match(JSON.stringify(f.render()),/UTF-8/);f.file({name:'unread',size:1,arrayBuffer:async()=>{throw Error('disk');}});await tick();assert.match(JSON.stringify(f.render()),/读取失败/);const slow=defer();f.file({name:'slow',size:1,arrayBuffer:()=>slow.promise});f.close();slow.resolve(new TextEncoder().encode('迟到').buffer);await tick();assert.equal(f.records.size,0);assert.equal(f.sent.length,0);});
test('导入等待关页保留已创建回执，不抢导航；重开只打开原章',async()=>{const receipt=defer(),f=setup({create:()=>receipt.promise});f.input('正文');const pending=f.form().props.onSubmit();f.close();receipt.resolve({id:'created'});await pending;assert.equal(f.opened.length,0);const restored=setup({records:f.records});await restored.form().props.onSubmit();assert.equal(restored.sent.length,0);assert.deepEqual(restored.opened,[['created',true]]);});
