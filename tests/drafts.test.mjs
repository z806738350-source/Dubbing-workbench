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
    try{return await callback({name});}finally{this.held.delete(name);}
  }
  async query(){return {held:[...this.held].map(name=>({name})),pending:[]};}
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

test('已打开页面可分别查看、恢复和放弃多个关闭页遗留，活动页面保护不变',async()=>{
  const storage=new Storage(),locks=new Locks(),aSession=new Storage(),bSession=new Storage(),cSession=new Storage();
  const a=await page(storage,aSession,locks),b=await page(storage,bSession,locks),c=await page(storage,cSession,locks);
  a.writeDraft('one',{text:'A遗留'},4);c.writeDraft('one',{text:'C遗留'},6);
  let entries=await b.listDrafts('one');assert.deepEqual(entries.map(x=>x.status),['active','active']);assert.equal(b.readDraft('one'),null);
  locks.close(aSession);locks.close(cSession);
  entries=await b.listDrafts('one');assert.deepEqual(entries.map(x=>x.status),['orphan','orphan']);
  const [first,second]=entries;
  assert.deepEqual(await b.recoverDraft('one',first),{draft:{text:'A遗留'},revision:4});
  assert.equal(storage.getItem(first.key),null);assert.equal(storage.getItem(second.key),second.raw);
  assert.deepEqual((await b.listDrafts('one')).map(x=>x.status).sort(),['current','orphan']);
  await assert.rejects(b.recoverDraft('one',second),/本页已有/);
  assert.equal(b.readDraft('one').draft.text,'A遗留');assert.equal(storage.getItem(second.key),second.raw);
  await b.discardDraft('one',second);assert.equal(storage.getItem(second.key),null);assert.equal(b.hasDraft('one'),true);
  b.clearDraft('one');assert.equal(b.hasDraft('one'),false);
});

test('遗留操作重新检查活动归属与原始值，拒绝过期列表和越界记录',async()=>{
  const storage=new Storage(),locks=new Locks(),session=new Storage(),a=await page(storage,session,locks),b=await page(storage,new Storage(),locks);
  a.writeDraft('one',{text:'仍在原页'},2);const [entry]=await b.listDrafts('one');
  await assert.rejects(b.recoverDraft('one',entry),/仍在使用/);await assert.rejects(b.discardDraft('one',entry),/仍在使用/);
  assert.equal(a.readDraft('one').draft.text,'仍在原页');
  locks.close(session);const changed=JSON.stringify({draft:{text:'列表之后更新'},revision:3});storage.setItem(entry.key,changed);
  await assert.rejects(b.recoverDraft('one',entry),/草稿已改变/);await assert.rejects(b.discardDraft('one',entry),/草稿已改变/);
  await assert.rejects(b.recoverDraft('other',entry),/本片段/);assert.equal(storage.getItem(entry.key),changed);assert.equal(b.readDraft('one'),null);
  const own=await page(storage,new Storage(),locks);const [current]=await own.listDrafts('one');assert.equal(current.status,'current');
  await assert.rejects(own.discardDraft('one',current),/其他页面/);
});

test('恢复写入失败或源值中途改变时保留原记录，不覆盖本页内容',async()=>{
  const storage=new Storage(),locks=new Locks(),session=new Storage(),a=await page(storage,session,locks),b=await page(storage,new Storage(),locks);
  a.writeDraft('one',{text:'不能丢失'},7);locks.close(session);const [entry]=await b.listDrafts('one'),put=storage.setItem.bind(storage);
  storage.setItem=(key,value)=>{if(key!==entry.key)throw new Error('quota');put(key,value);};
  await assert.rejects(b.recoverDraft('one',entry),/quota/);assert.equal(storage.getItem(entry.key),entry.raw);assert.equal(b.readDraft('one'),null);
  const changed=JSON.stringify({draft:{text:'更新后的来源'},revision:8});
  storage.setItem=(key,value)=>{put(key,value);if(key!==entry.key)put(entry.key,changed);};
  await assert.rejects(b.recoverDraft('one',entry),/草稿已改变/);assert.equal(storage.getItem(entry.key),changed);assert.equal(b.readDraft('one'),null);
});

test('旧格式遗留可显式恢复或放弃，恢复保留原修订',async()=>{
  const storage=new Storage(),a=await page(storage,new Storage(),new Locks()),raw=JSON.stringify({draft:{text:'旧格式'},revision:9});
  storage.setItem('draft-one',raw);const [entry]=await a.listDrafts('one');assert.equal(entry.status,'orphan');
  assert.deepEqual(await a.recoverDraft('one',entry),{draft:{text:'旧格式'},revision:9});assert.equal(storage.getItem('draft-one'),null);
  storage.setItem('draft-two',raw);const [second]=await a.listDrafts('two');await a.discardDraft('two',second);assert.equal(a.hasDraft('two'),false);
});

test('自己保存成功后后续输入承接确切修订，已删除或不同基准草稿不复活不改基准',async()=>{
  const storage=new Storage(),a=await page(storage,new Storage(),new Locks()),submitted=JSON.stringify({draft:{text:'已提交'},revision:4});
  a.writeDraft('one',{text:'已提交'},4);assert.equal(a.finishDraftSave('one',submitted,5),null);assert.equal(a.readDraft('one'),null);
  a.writeDraft('one',{text:'随后输入'},4);assert.deepEqual(a.finishDraftSave('one',submitted,5),{draft:{text:'随后输入'},revision:5});assert.equal(a.readDraft('one').revision,5);
  a.writeDraft('one',{text:'不同基准'},6);assert.equal(a.finishDraftSave('one',submitted,5).revision,6);
  a.clearDraft('one');storage.setItem('draft-one',submitted);assert.equal(a.finishDraftSave('one',submitted,5),null);assert.equal(storage.getItem('draft-one'),submitted);
  storage.removeItem('draft-one');a.writeDraft('one',{text:'缺少版本时保留'},4);
  for(const revision of [undefined,NaN,Infinity,0,-1,1.5])assert.throws(()=>a.finishDraftSave('one',JSON.stringify(a.readDraft('one')),revision),/缺少有效版本/);
  assert.throws(()=>a.finishDraftSave('one',JSON.stringify(a.readDraft('one')),6),/与本次提交不一致/);
  assert.equal(a.readDraft('one').draft.text,'缺少版本时保留');assert.equal(a.readDraft('one').revision,4);
});

test('集中恢复读取全部对象与旧键，准确保留页面归属；坏记录不遮住其他编辑',async()=>{
  const storage=new Storage(),locks=new Locks(),session=new Storage();const a=await page(storage,session,locks),b=await page(storage,new Storage(),locks);
  a.writeDraft('unit-v1/u/scene',{type:'unit',version:1,value:{guidance:'场景'}},2);
  b.writeDraft('segment-one',{text:'本页'},3);
  storage.setItem('draft-legacy:custom',JSON.stringify({draft:{text:'旧记录'},revision:4}));
  storage.setItem('draft-broken','{broken');
  const records=await b.listAllDrafts();
  assert.deepEqual(records.map(r=>[r.id,r.entry.status]),[['unit-v1/u/scene','active'],['segment-one','current'],['legacy:custom','orphan'],['broken','orphan']]);
  assert.match(records.find(r=>r.id === 'broken').entry.error,/无法解析/);
  assert.equal(storage.getItem('draft-broken'),'{broken');
  assert.equal((await b.listDrafts('unit-v1/u/scene'))[0].data.draft.value.guidance,'场景');
});

test('关闭页恢复与复制页携带未确认操作ID，显式弃稿清对应记录不重复创建',async()=>{
  const storage=new Storage(),locks=new Locks(),aSession=new Storage(),bSession=new Storage();
  const a=await page(storage,aSession,locks),b=await page(storage,bSession,locks),id='voice-session-v1/new';
  const source='pending-save:'+aSession.getItem('draft-owner')+':'+id,target='pending-save:'+bSession.getItem('draft-owner')+':'+id;
  const command=JSON.stringify({id:'same-create-id',signature:JSON.stringify({value:{description:'原创建'},revision:0})});
  a.writeDraft(id,{description:'续写'},0);storage.setItem(source,command);
  const copied=new Storage();copied.data=new Map(aSession.data);const copy=await page(storage,copied,locks);
  assert.equal(storage.getItem('pending-save:'+copied.getItem('draft-owner')+':'+id),command);
  copy.clearDraft(id,undefined,true);assert.equal(storage.getItem(source),command);
  locks.close(aSession);const [entry]=await b.listDrafts(id);await b.recoverDraft(id,entry);
  assert.equal(storage.getItem(target),command);assert.equal(storage.getItem(source),null);
  b.clearDraft(id,undefined,true);assert.equal(storage.getItem(target),null);
});

test('恢复操作ID暂存失败时来源草稿和原操作ID都保留',async()=>{
  const storage=new Storage(),locks=new Locks(),aSession=new Storage(),bSession=new Storage();
  const a=await page(storage,aSession,locks),b=await page(storage,bSession,locks),id='new-event';
  const source='pending-save:'+aSession.getItem('draft-owner')+':'+id,target='pending-save:'+bSession.getItem('draft-owner')+':'+id;
  a.writeDraft(id,{description:'不丢'},0);storage.setItem(source,'original-operation');locks.close(aSession);
  const [entry]=await b.listDrafts(id),set=storage.setItem.bind(storage);
  storage.setItem=(key,value)=>{if(key === target)throw new Error('quota');set(key,value);};
  await assert.rejects(b.recoverDraft(id,entry),/quota/);
  assert.equal(storage.getItem(entry.key),entry.raw);assert.equal(storage.getItem(source),'original-operation');assert.equal(b.readDraft(id),null);
});

test('集中恢复和明确弃稿通知已挂载编辑器，取消旧暂存而不复活',async()=>{
  const storage=new Storage(),locks=new Locks(),aSession=new Storage(),bSession=new Storage(),events=[];
  const a=await page(storage,aSession,locks),b=await page(storage,bSession,locks),originalWindow=globalThis.window,originalEvent=globalThis.CustomEvent;
  globalThis.window={dispatchEvent:event=>events.push(event)};globalThis.CustomEvent=class{constructor(type,{detail}){this.type=type;this.detail=detail;}};
  try{
    a.writeDraft('one',{text:'恢复'},3);locks.close(aSession);const [entry]=await b.listDrafts('one');await b.recoverDraft('one',entry);
    assert.deepEqual(events.map(e=>[e.type,e.detail]),[['workbench-draft-restored',{id:'one',data:{draft:{text:'恢复'},revision:3}}]]);
    b.clearDraft('one',JSON.stringify(b.readDraft('one')),true);assert.equal(events.at(-1).type,'workbench-draft-discarded');assert.equal(events.at(-1).detail.id,'one');
    const count=events.length;b.writeDraft('one',{text:'正常保存'},3);b.finishDraftSave('one',JSON.stringify(b.readDraft('one')),4);assert.equal(events.length,count);
  }finally{if(originalWindow === undefined)delete globalThis.window;else globalThis.window=originalWindow;if(originalEvent === undefined)delete globalThis.CustomEvent;else globalThis.CustomEvent=originalEvent;}
});
