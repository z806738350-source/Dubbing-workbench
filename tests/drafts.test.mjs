import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/drafts.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
class Storage {
  data = new Map();
  get length(){return this.data.size;}
  key(i){return [...this.data.keys()][i]??null;}
  getItem(k){return this.data.get(k)??null;}
  setItem(k,v){this.data.set(k,String(v));}
  removeItem(k){this.data.delete(k);}
}
class Locks {
  held = new Set();
  async request(name, options, callback){
    assert.equal(options.ifAvailable,true);
    if(this.held.has(name))return callback(null);
    this.held.add(name);
    return callback({name});
  }
  close(session){this.held.delete('workbench-drafts-'+session.getItem('draft-owner'));}
}
async function page(storage,session,locks){
  const originals=['localStorage','sessionStorage','navigator'].map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]);
  Object.defineProperties(globalThis,{localStorage:{value:storage,configurable:true},sessionStorage:{value:session,configurable:true},navigator:{value:{locks},configurable:true}});
  try{
    const module=await import('data:text/javascript;base64,'+Buffer.from(source+'\n// '+crypto.randomUUID()).toString('base64'));
    await module.initDrafts();return module;
  }finally{for(const [key,descriptor]of originals)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
}

test('两页草稿各自持久化；保存或放弃只清本页，所有页面仍阻断生成',async()=>{
  const storage=new Storage(),locks=new Locks(),aSession=new Storage(),bSession=new Storage();
  const a=await page(storage,aSession,locks),b=await page(storage,bSession,locks);
  a.writeDraft('one',{text:'A'},4);b.writeDraft('one',{text:'B'},5);
  assert.deepEqual(a.readDraft('one'),{draft:{text:'A'},revision:4});assert.deepEqual(b.readDraft('one'),{draft:{text:'B'},revision:5});
  b.clearDraft('one');assert.equal(a.hasDraft('one'),true);assert.equal(b.hasDraft('one'),true);assert.equal(a.readDraft('one').draft.text,'A');
  locks.close(aSession);const reloaded=await page(storage,aSession,locks);assert.equal(reloaded.readDraft('one').revision,4);
  reloaded.clearDraft('one');assert.equal(b.hasDraft('one'),false);
});

test('复制标签页的session归属分离，不覆盖或删除原页草稿',async()=>{
  const storage=new Storage(),locks=new Locks(),session=new Storage(),a=await page(storage,session,locks);
  a.writeDraft('one',{text:'原页'},2);a.writeDraft('two',{text:'另一片段'},3);
  const copiedSession=new Storage();copiedSession.data=new Map(session.data);
  const copy=await page(storage,copiedSession,locks);assert.notEqual(copiedSession.getItem('draft-owner'),session.getItem('draft-owner'));
  assert.equal(copy.readDraft('one').draft.text,'原页');assert.equal(copy.readDraft('two').revision,3);
  copy.writeDraft('one',{text:'复制页'},2);copy.clearDraft('two');assert.equal(a.readDraft('one').draft.text,'原页');assert.equal(a.readDraft('two').draft.text,'另一片段');
  a.clearDraft('one');assert.equal(copy.readDraft('one').draft.text,'复制页');assert.equal(a.hasDraft('one'),true);
});

test('关闭后新页面认领遗留草稿；干净页面不读取活动页内容',async()=>{
  const storage=new Storage(),locks=new Locks(),session=new Storage(),a=await page(storage,session,locks);
  a.writeDraft('one',{text:'关闭前草稿'},9);
  const clean=await page(storage,new Storage(),locks);assert.equal(clean.readDraft('one'),null);assert.equal(clean.hasDraft('one'),true);
  locks.close(session);const reopened=await page(storage,new Storage(),locks);assert.equal(reopened.readDraft('one').draft.text,'关闭前草稿');assert.equal(reopened.readDraft('one').revision,9);
});

test('旧缓存完整迁移后才删除，保留修订且其他页不能清除',async()=>{
  const storage=new Storage(),locks=new Locks();storage.setItem('draft-one',JSON.stringify({draft:{text:'旧版草稿'},revision:3}));
  const a=await page(storage,new Storage(),locks),b=await page(storage,new Storage(),locks);
  assert.deepEqual(a.readDraft('one'),{draft:{text:'旧版草稿'},revision:3});assert.equal(storage.getItem('draft-one'),null);
  b.clearDraft('one');assert.equal(a.hasDraft('one'),true);assert.equal(a.readDraft('one').draft.text,'旧版草稿');
});

test('保存请求等待期间的新输入不会被旧成功响应清除',async()=>{
  const a=await page(new Storage(),new Storage(),new Locks());a.writeDraft('one',{text:'已提交'},1);
  const submitted=JSON.stringify({draft:{text:'已提交'},revision:1});a.writeDraft('one',{text:'随后输入'},1);
  assert.equal(a.clearDraft('one',submitted),false);assert.equal(a.readDraft('one').draft.text,'随后输入');
  assert.equal(a.clearDraft('one',JSON.stringify(a.readDraft('one'))),true);assert.equal(a.hasDraft('one'),false);
});

test('旧缓存迁移写入失败时原数据保留',async()=>{
  const storage=new Storage(),session=new Storage(),a=await page(storage,session,new Locks());
  const raw=JSON.stringify({draft:{text:'保留'},revision:7});storage.setItem('draft-one',raw);storage.setItem=()=>{throw new Error('quota');};
  assert.throws(()=>a.readDraft('one'),/quota/);assert.equal(storage.getItem('draft-one'),raw);
});

test('跨页删除期间枚举返回空键不会中断草稿检查',async()=>{
  const storage=new Storage(),a=await page(storage,new Storage(),new Locks());a.writeDraft('one',{text:'未保存'},1);
  storage.key=()=>null;assert.equal(a.hasDraft('one'),false);
});
