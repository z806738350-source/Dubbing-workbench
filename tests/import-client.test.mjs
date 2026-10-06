import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ts from 'typescript';
import {importLimits,importProblems} from '../server/import-validation.mjs';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const component=source.slice(source.indexOf('type ImportDraft ='),source.indexOf('function VoiceLibrary('));
const compiled=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
function setup({records=new Map(),create=async()=>({id:'created'}),navigate=async()=>{},failStorage=false,workspace={current:'/fixture'},projectId='project'}={}){
  let index=0;const hooks=[],effects=[],sent=[],writes=[],opened=[];
  const storage={fail:failStorage},key=(id,identity=workspace.current)=>identity==='/fixture'?id:identity+'\0'+id;
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog:'Dialog',Form:'Form',Field:'Field',Upload:'Upload',TextDecoder,crypto,importLimits,importProblems,
    useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=typeof value==='function'?value():value;return [hooks[i],value=>hooks[i]=typeof value==='function'?value(hooks[i]):value];},useRef:value=>hooks[index++]||={current:value},useEffect:next=>effects.push(next),
    draftWorkspace:()=>workspace.current,readDraft:(id,identity)=>records.has(key(id,identity))?{draft:JSON.parse(records.get(key(id,identity))),revision:0}:null,writeDraft:(id,value,revision,identity)=>{if(storage.fail)throw new Error('quota');records.set(key(id,identity),JSON.stringify(value));writes.push(JSON.parse(JSON.stringify(value)));},clearDraft:(id,expected,abandon,identity)=>records.delete(key(id,identity)),action:async(name,payload)=>{sent.push(payload);return create(payload);}};
  const ImportChapter=new Function(...Object.keys(env),compiled+';return ImportChapter;')(...Object.values(env));
  const props={projectId,onClose(){},onCreated:async(...args)=>{opened.push(args);return await navigate(...args);}};
  const render=()=>{index=0;return ImportChapter(props);};
  const form=()=>nodes(render()).find(node=>node.type==='Form');
  const input=text=>{nodes(render()).find(node=>node.type==='textarea').props.onChange({target:{value:text}});};
  const file=value=>nodes(render()).find(node=>node.type==='input'&&node.props.type==='file').props.onChange({target:{files:[value]}});
  const title=value=>nodes(render()).find(node=>node.type==='input'&&!node.props.type).props.onChange({target:{value}});
  render();const cleanup=effects[0]();return {render,form,input,title,file,records,sent,writes,opened,storage,workspace,close:()=>{nodes(render()).find(node=>node.type==='Dialog').props.onClose();cleanup();}};
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
test('已创建但导航失败只恢复导航，不再创建章；关闭重开可恢复非空草稿',async()=>{let nav=0;const f=setup({navigate:async()=>{if(!nav++)throw new Error('navigation failed');}});f.input('保存正文');await assert.rejects(f.form().props.onSubmit(),/navigation/);assert.equal(f.sent.length,1);await f.form().props.onSubmit();assert.equal(f.sent.length,1);assert.deepEqual(f.opened,[['created',true,f.sent[0].operationId],['created',true,f.sent[0].operationId]]);const draft=setup();draft.input('未导入草稿');draft.close();const restored=setup({records:draft.records});assert.equal(nodes(restored.render()).find(node=>node.type==='textarea').props.value,'未导入草稿');});
test('文件A慢于B只保留B；编辑预览保留原始文件来源',async()=>{const f=setup(),a=defer(),bytes=s=>new TextEncoder().encode(s).buffer;f.file({name:'A.txt',size:1,arrayBuffer:()=>a.promise});f.file({name:'B.md',size:1,arrayBuffer:async()=>bytes('B\r\n原始')});await tick();a.resolve(bytes('A旧文'));await tick();let draft=JSON.parse(f.records.get('import-chapter/project'));assert.equal(draft.title,'B');assert.equal(draft.source,'B\n原始');f.input('B人工预览');draft=JSON.parse(f.records.get('import-chapter/project'));assert.equal(draft.imported.text,'B\r\n原始');assert.equal(draft.source,'B人工预览');});
test('文件大小预检、解码失败、读取失败区分，关闭使迟到读取失效',async()=>{const f=setup();let read=0;f.file({name:'big',size:5*1024*1024,arrayBuffer:async()=>{read++;}});assert.equal(read,0);assert.match(JSON.stringify(f.render()),/超过4 MB/);f.file({name:'bad',size:1,arrayBuffer:async()=>new Uint8Array([255]).buffer});await tick();assert.match(JSON.stringify(f.render()),/UTF-8/);f.file({name:'unread',size:1,arrayBuffer:async()=>{throw Error('disk');}});await tick();assert.match(JSON.stringify(f.render()),/读取失败/);const slow=defer();f.file({name:'slow',size:1,arrayBuffer:()=>slow.promise});f.close();slow.resolve(new TextEncoder().encode('迟到').buffer);await tick();assert.equal(f.records.size,0);assert.equal(f.sent.length,0);});
test('导入等待关页保留已创建回执，不抢导航；重开只打开原章',async()=>{const receipt=defer(),f=setup({create:()=>receipt.promise});f.input('正文');const pending=f.form().props.onSubmit();f.close();receipt.resolve({id:'created'});await pending;assert.equal(f.opened.length,0);const restored=setup({records:f.records});await restored.form().props.onSubmit();assert.equal(restored.sent.length,0);assert.deepEqual(restored.opened,[['created',true,f.sent[0].operationId]]);});

function isolated(t){
  const directory=mkdtempSync(join(tmpdir(),'dubbing-import-client-')),store=openStore(directory),domain=createDomain(store),project=domain.mutate('project.create',{name:'隔离导入回归'});
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  return {store,domain,project,create:async payload=>domain.mutate('chapter.create',JSON.parse(JSON.stringify(payload)))};
}
function frozen(title,changes={}){
  const draft={source:'人工预览正文。',title,prepare:true,imported:{text:'完整文件\r\n正文。',name:'原稿.md'},...changes};
  draft.command={operationId:crypto.randomUUID(),payload:{projectId:'project',title,source:draft.source,importedSource:draft.imported.text,sourceFilename:draft.imported.name,segment:false}};
  return draft;
}
const stored=f=>JSON.parse(f.records.get('import-chapter/project'));
const textarea=f=>nodes(f.render()).find(node=>node.type==='textarea');

test('共享150标题边界：151/200先免费预检，不保存命令；150和相同正文的两次明确意图各创建一章',async t=>{
  const {store,project,create}=isolated(t);
  for(const length of [151,200]){
    const f=setup({projectId:project.id,create});f.input('自拟完整原文。');f.title('章'.repeat(length));await f.form().props.onSubmit();
    assert.equal(f.sent.length,0);assert.equal(textarea(f).props.disabled,false);assert.equal(JSON.parse(f.records.get('import-chapter/'+project.id)).command,undefined);
    const titleField=nodes(f.render()).find(node=>node.type==='Field'&&node.props.label==='章节名称');assert.match(titleField.props.hint,new RegExp(`${length} / 150`));assert.match(JSON.stringify(titleField),/不能超过 150/);
  }
  assert.equal(store.all('chapters').length,0);
  const a=setup({projectId:project.id,create});a.input('同一份自拟正文。');a.title('章'.repeat(150));await a.form().props.onSubmit();
  const b=setup({projectId:project.id,create});b.input('同一份自拟正文。');b.title('章'.repeat(150));await b.form().props.onSubmit();
  assert.equal(store.all('chapters').length,2);assert.notEqual(a.sent[0].operationId,b.sent[0].operationId);
});

test('旧151/200冻结命令得到明确notApplied后可编辑；改正用新ID创建一次，原文/文件及旧结果可追溯',async t=>{
  for(const length of [151,200]){
    const {store,project,create}=isolated(t),draft=frozen('章'.repeat(length));draft.command.payload.projectId=project.id;
    const records=new Map([['import-chapter/'+project.id,JSON.stringify(draft)]]),f=setup({projectId:project.id,records,create});
    await f.form().props.onSubmit();let saved=JSON.parse(records.get('import-chapter/'+project.id));
    assert.equal(store.all('chapters').length,0);assert.equal(saved.command.rejection.fieldErrors.title,'章节名称不能为空，且不能超过 150 个字符');assert.equal(textarea(f).props.disabled,false);assert.equal(f.form().props.label,'修改后重新导入');
    assert.equal(saved.source,draft.source);assert.deepEqual(saved.imported,draft.imported);assert.equal(saved.title,draft.title);
    f.close();const reopened=setup({projectId:project.id,records,create});assert.equal(textarea(reopened).props.disabled,false);assert.equal(textarea(reopened).props.value,draft.source);
    reopened.title('正确章名');await reopened.form().props.onSubmit();assert.equal(store.all('chapters').length,1);assert.notEqual(reopened.sent[0].operationId,draft.command.operationId);
    const chapter=store.all('chapters')[0];assert.equal(chapter.source,draft.source);assert.equal(chapter.importedSource,draft.imported.text);assert.equal(chapter.sourceFilename,draft.imported.name);
    saved=JSON.parse(records.get('import-chapter/'+project.id));assert.equal(saved.source,'');assert.equal(saved.command,undefined);assert.equal(saved.history.length,2);assert.deepEqual(saved.history[0].payload,draft.command.payload);assert.ok(saved.history[0].rejection);assert.equal(saved.history[1].chapterId,chapter.id);
  }
});

test('通用400/409/500/网络和不属于本命令的证明均不解锁，重试保持同ID同payload',async()=>{
  const proof={status:400,code:'import-validation-rejected',outcome:'notApplied',notApplied:true,scope:{action:'chapter.create',operationId:'placeholder',projectId:'project'}};
  const failures=[{status:400},{status:409},{status:500},new TypeError('network'),{...proof,status:500},{...proof,outcome:'unknown'},{...proof,scope:{...proof.scope,operationId:'other'}},{...proof,scope:{...proof.scope,projectId:'other'}}];
  for(const failure of failures){
    const f=setup({create:async payload=>{throw Object.assign(new Error('未确认'),failure.scope?.operationId==='placeholder'?{...failure,scope:{...failure.scope,operationId:payload.operationId}}:failure);}});f.input('原文仍保留。');
    await assert.rejects(f.form().props.onSubmit());assert.equal(textarea(f).props.disabled,true);f.title('不可改');assert.equal(stored(f).title,'');
    await assert.rejects(f.form().props.onSubmit());assert.deepEqual(f.sent[1],f.sent[0]);assert.equal(stored(f).command.rejection,undefined);
  }
});

test('拒绝与编辑后刷新保留新输入及旧命令；未改变有效payload不创建新ID',async()=>{
  const draft=frozen('合法标题'),records=new Map([['import-chapter/project',JSON.stringify(draft)]]),f=setup({records,create:async payload=>{throw Object.assign(new Error('明确验证拒绝'),{status:400,code:'import-validation-rejected',outcome:'notApplied',notApplied:true,scope:{action:'chapter.create',projectId:'project',operationId:payload.operationId}});}});
  await f.form().props.onSubmit();await f.form().props.onSubmit();assert.equal(f.sent.length,1);assert.equal(stored(f).command.operationId,draft.command.operationId);
  f.title('修正的标题');f.close();const reopened=setup({records});assert.equal(nodes(reopened.render()).find(node=>node.type==='input'&&!node.props.type).props.value,'修正的标题');assert.equal(textarea(reopened).props.disabled,false);assert.ok(stored(reopened).command.rejection);
});

test('创建成功丢回执，真实SQLite同ID恢复只有一章；之后明确相同原文仍可新建',async t=>{
  const {store,project,create}=isolated(t);let attempts=0;
  const f=setup({projectId:project.id,create:async payload=>{const result=await create(payload);if(!attempts++)throw TypeError('lost response');return result;}});f.input('重复请求也只一章。');
  await assert.rejects(f.form().props.onSubmit(),/lost/);assert.equal(store.all('chapters').length,1);const original=f.sent[0];f.close();
  const reopened=setup({projectId:project.id,records:f.records,create});await reopened.form().props.onSubmit();assert.deepEqual(reopened.sent[0],original);assert.equal(store.all('chapters').length,1);
  const next=setup({projectId:project.id,records:f.records,create});next.input('重复请求也只一章。');await next.form().props.onSubmit();assert.equal(store.all('chapters').length,2);assert.notEqual(next.sent[0].operationId,original.operationId);
});

test('存储连续失败两次都不发送；恢复存储后先保存同命令再发送',async()=>{
  const f=setup({failStorage:true,create:async payload=>{assert.equal(stored(f).command.operationId,payload.operationId);return {id:'created'};}});f.input('必须保留的原文');
  await assert.rejects(f.form().props.onSubmit(),/可靠保存/);await assert.rejects(f.form().props.onSubmit(),/可靠保存/);assert.equal(f.sent.length,0);assert.equal(textarea(f).props.value,'必须保留的原文');
  f.storage.fail=false;await f.form().props.onSubmit();assert.equal(f.sent.length,1);
});

test('旧请求关闭后另一页已恢复并开始新草稿，迟到回执只留原记录不覆盖新原文或导航',async t=>{
  const {store,project,create}=isolated(t),receipt=defer(),records=new Map();
  const old=setup({projectId:project.id,records,create:()=>receipt.promise});old.input('第一份原文。');const pending=old.form().props.onSubmit();old.close();
  const reopened=setup({projectId:project.id,records,create});await reopened.form().props.onSubmit();const chapter=store.all('chapters')[0];assert.equal(reopened.opened.length,1);
  const fresh=setup({projectId:project.id,records,create});fresh.input('第二份未发送原文。');fresh.title('新标题');receipt.resolve(chapter);await pending;
  const saved=JSON.parse(records.get('import-chapter/'+project.id));assert.equal(saved.source,'第二份未发送原文。');assert.equal(saved.title,'新标题');assert.equal(saved.command,undefined);assert.equal(saved.history[0].chapterId,chapter.id);assert.equal(old.opened.length,0);assert.equal(fresh.opened.length,0);assert.equal(store.all('chapters').length,1);
  fresh.title('再次编辑新标题');assert.equal(JSON.parse(records.get('import-chapter/'+project.id)).history[0].chapterId,chapter.id);await fresh.form().props.onSubmit();assert.equal(store.all('chapters').length,2);assert.equal(JSON.parse(records.get('import-chapter/'+project.id)).history.length,2);
});

test('工作区切换后晚拒绝只解锁原库命令，不修改新库草稿或抢导航',async()=>{
  const receipt=defer(),workspace={current:'/A'},records=new Map(),old=setup({workspace,records,create:()=>receipt.promise});old.input('A库正文。');const pending=old.form().props.onSubmit(),command=old.sent[0];
  workspace.current='/B';const fresh=setup({workspace,records});fresh.input('B库正文。');fresh.title('B库标题');
  receipt.resolve(Promise.reject(Object.assign(new Error('明确未创建'),{status:400,code:'import-validation-rejected',outcome:'notApplied',notApplied:true,scope:{action:'chapter.create',operationId:command.operationId,projectId:'project'},fieldErrors:{title:'错误标题'}})));await pending;
  assert.ok(JSON.parse(records.get('/A\0import-chapter/project')).command.rejection);const saved=JSON.parse(records.get('/B\0import-chapter/project'));assert.equal(saved.source,'B库正文。');assert.equal(saved.title,'B库标题');assert.equal(saved.command,undefined);assert.equal(textarea(fresh).props.value,'B库正文。');assert.equal(old.opened.length,0);
});

test('导航明确未接纳旧项目时保留已创建回执，重开只导航原章',async()=>{
  const f=setup({navigate:async()=>false});f.input('旧项目原文。');await f.form().props.onSubmit();assert.equal(stored(f).command.chapterId,'created');f.close();
  const reopened=setup({records:f.records});await reopened.form().props.onSubmit();assert.equal(reopened.sent.length,0);assert.deepEqual(reopened.opened,[['created',true,f.sent[0].operationId]]);
});

test('正文超限仍保留完整可编辑草稿，预检不冻结命令也不外发',async()=>{
  const f=setup(),source='文'.repeat(importLimits.source+1);f.input(source);await f.form().props.onSubmit();
  assert.equal(textarea(f).props.value,source);assert.equal(textarea(f).props.disabled,false);assert.equal(stored(f).command,undefined);assert.equal(f.sent.length,0);assert.match(JSON.stringify(f.render()),/超过100万/);
});
