import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/UnitPanel.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source+'\nexport {UnitDetails};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let sequence=0;
async function setup(api=async()=>[]) {
  let index=0;const hooks=[],sent=[],played=[],tasks=[],actions=[];
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    useEffect(){},useRef:initial=>{const key=index++;return hooks[key]||=( {current:initial});},
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    api,action:async(...args)=>{actions.push(args);},hasDraft:()=>false,objectDraftId:(kind,id)=>kind+'/'+id,
    useObjectDraft:(_kind,_id,draft)=>({draft,dirty:false,status:'saved',frozen:false,composing:false,saving:false,flush:async()=>{},edit(){},compositionStart(){},compositionEnd(){}}),
    saveAction:async()=>{},withSavedDrafts:async(_scope,_dependencies,fn)=>fn(),draftScopeRevision:(_scope,revision)=>revision,
    submitOperation:async(...args)=>{sent.push(args);return {outcome:'processing'};},
    Dialog:'Dialog',Field:'Field',Select:'Select',Status:'Status',ObjectDraftTools:'ObjectDraftTools',TaskAuthorization:'TaskAuthorization',SceneSuggestions:'SceneSuggestions'};
  globalThis.unitPanelTest=runtime;
  const header='const {React,useEffect,useRef,useState,api,action,hasDraft,objectDraftId,useObjectDraft,saveAction,withSavedDrafts,draftScopeRevision,submitOperation,Dialog,Field,Select,Status,ObjectDraftTools,TaskAuthorization,SceneSuggestions}=globalThis.unitPanelTest;\n';
  const {UnitDetails}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// test '+sequence++).toString('base64'));
  const status=()=>({validity:'matched',review:'passed',prompt:'',promptIssues:[],basis:{}});
  const variant=(current,latest)=>({current,previous:'previous',approved:null,latest,revision:1,guidance:'保留要求',status:status(),history:[]});
  const unit={id:'group',chapterId:'chapter',kind:'group',state:'active',members:['one','two'],mode:'dry',revision:1,variants:{dry:variant('old-dry','success'),scene:variant(null,'unknown')}};
  const props={unit,chapter:{id:'chapter',projectId:'project',revision:1,segments:[{id:'one',order:0,text:'第一句',roleId:'role',voiceId:'voice'},{id:'two',order:1,text:'第二句',roleId:'role',voiceId:'voice'}],events:[],playbackItems:[]},roles:[{id:'role',name:'角色'}],state:{jobs:[],voices:[],projects:[],settings:{configured:true,audioTools:true,features:{},model:'audio',routeBlocked:false}},locked:false,connected:true,mode:'scene',setMode(){},refresh:async()=>{},close(){},open(){},play:(...args)=>played.push(args),onTask:(...args)=>tasks.push(args)};
  return {props,sent,played,tasks,actions,render:()=>{index=0;return UnitDetails(props);}};
}

test('unknown 先试听保留纯人声，范围可见、全文与修改按需展开，重试默认未选择',async()=>{
  const f=await setup(),tree=f.render();
  const all=nodes(tree),safe=all.findIndex(node=>node.props.className==='unit-safe-result'),settings=all.findIndex(node=>node.props.className==='unit-edit-settings');
  assert.ok(safe>=0&&safe<settings);assert.match(text(all[safe]),/新结果尚未确认，可能已计费/);
  assert.match(text(all.find(node=>node.props.className==='unit-member-range')),/覆盖第 1、2 句 · 共 2 句/);
  assert.equal(all[settings].props.open,false);assert.equal(all.find(node=>node.type==='details'&&text(node).startsWith('查看全文')).props.open,false);
  const play=button(tree,'试听已有声音');assert.equal(play.props.disabled,false);play.props.onClick();
  assert.deepEqual(f.played,[['old-dry','纯人声 · 已有声音',false]]);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
  const footer=tree.props.footer;assert.equal(nodes(footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  assert.equal(button(footer,'再次提交 1 次请求').props.disabled,true);assert.ok(nodes(footer).some(node=>node.props.className==='unit-submit-scope'));assert.ok(nodes(footer).some(node=>node.props.className==='unit-submit-actions'));
});

test('查看这次记录按真实最新单元和版本定位，跳过混合任务其他模式/其他成员',async()=>{
  const looked=[];
  const f=await setup(async path=>{looked.push(path);return path.endsWith('/newer')?[{id:'other-unit',unitId:'elsewhere',mode:'scene',status:'unknown'},{id:'wrong-mode',unitId:'group',mode:'dry',status:'unknown'}]:[{id:'earlier',unitId:'group',mode:'scene',status:'unknown'},{id:'actual',targetId:'group',input:{mode:'scene'},status:'unknown'}];});
  f.props.state.jobs=[{id:'correct',unitIds:['group'],status:'unknown',createdAt:'2026-10-02T00:00:00Z'},{id:'newer',unitIds:['group'],status:'failed',createdAt:'2026-10-02T01:00:00Z'}];
  button(f.render(),'查看这次记录').props.onClick();await tick();
  assert.deepEqual(looked,['/attempts/newer','/attempts/correct']);assert.deepEqual(f.tasks,[['correct','actual']]);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
});

test('旧单句记录按segmentId与默认纯人声定位；读取失败不猜选其他记录',async()=>{
  const f=await setup(async()=>[{id:'legacy-attempt',segmentId:'one',status:'unknown'}]);
  Object.assign(f.props.unit,{id:'one',kind:'single',members:['one']});f.props.mode='dry';f.props.unit.variants.dry.latest='unknown';
  f.props.state.jobs=[{id:'legacy',kind:'generate',ids:['one'],status:'unknown',createdAt:'2026-10-02T00:00:00Z'}];
  button(f.render(),'查看这次记录').props.onClick();await tick();assert.deepEqual(f.tasks,[['legacy','legacy-attempt']]);
  const failed=await setup(async()=>{throw new Error('连接暂时中断');});failed.props.state.jobs=[{id:'latest',unitId:'group',status:'unknown',createdAt:'2026-10-02T00:00:00Z'}];
  button(failed.render(),'查看这次记录').props.onClick();await tick();assert.equal(failed.tasks.length,0);assert.match(text(failed.render()),/连接暂时中断/);assert.equal(failed.sent.length,0);
});

test('unknown 勾选只表达重试意图，明确点击后才提交一次并重置意图',async()=>{
  const f=await setup();nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();assert.equal(f.sent.length,0);
  nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  const submit=button(f.render().props.footer,'再次提交 1 次请求');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].retryUnknown,true);assert.equal(f.sent[0][1].kind,'sceneAndGenerate');assert.equal(f.sent[0][1].unitId,'group');assert.equal(f.sent[0][1].grantId,'grant');
  assert.equal(nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
});

test('切换声音版本撤回此前重试意图，新版本仍需明确重新勾选',async()=>{
  const f=await setup();f.props.unit.variants.dry.latest='unknown';
  f.props.setMode=mode=>{f.props.mode=mode;};
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});
  assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,false);
  button(f.render(),'纯人声').props.onClick();
  assert.equal(f.props.mode,'dry');assert.equal(nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,true);assert.equal(f.sent.length,0);
});

test('首次对戏未确认仍能试听当前保留单句，明确只试听其中一句',async()=>{
  const f=await setup();f.props.unit.state='pending';f.props.unit.variants.dry.current=null;
  f.props.chapter.playbackItems=[{id:'one',members:['one'],audioId:'retained-single',validity:'matched',mode:'dry'}];
  const tree=f.render(),play=button(tree,'试听已有声音');assert.equal(play.props.disabled,false);play.props.onClick();
  assert.deepEqual(f.played,[['retained-single','第 1 句 · 已有纯人声',true]]);assert.match(text(tree),/尚无整段声音，可先试听第 1 句/);assert.equal(f.sent.length,0);
});

test('正常状态保持全文与编辑展开，unknown仍可进入已有声音恢复预览',async()=>{
  const f=await setup(async()=>({differences:[]}));f.props.unit.variants.scene.latest='success';
  let tree=f.render();assert.ok(!nodes(tree).some(node=>node.props.className==='unit-safe-result'));assert.equal(nodes(tree).find(node=>node.props.className==='unit-edit-settings').props.open,true);
  assert.equal(nodes(tree).find(node=>node.type==='details'&&text(node).startsWith('查看全文')).props.open,true);
  f.props.unit.variants.scene.latest='unknown';tree=f.render();button(tree,'恢复上一版').props.onClick();await tick();
  tree=f.render();assert.equal(tree.props.title,'恢复历史声音');button(tree,'恢复这份设置与声音').props.onClick();await tick();
  assert.equal(f.actions[0][0],'unit.restore');assert.equal(f.actions[0][1].audioId,'previous');assert.equal(f.sent.length,0);
});
