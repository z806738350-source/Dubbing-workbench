import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/UnitPanel.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source+'\nexport {UnitDetails};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):[...(node.props?.children||[]),node.props?.footer].flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const check=(tree,label)=>nodes(nodes(tree).find(node=>node.type==='label'&&text(node).includes(label))).find(node=>node.type==='input');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let sequence=0;
async function setup(api=async()=>[],operation=async()=>({outcome:'processing'}),draftIds=new Set(),mutation=async()=>{}) {
  let index=0;const hooks=[],sent=[],played=[],tasks=[],actions=[],drafts=new Map();
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    useEffect(){},useRef:initial=>{const key=index++;return hooks[key]||=( {current:initial});},
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    api,action:async(...args)=>{actions.push(args);return mutation(...args);},hasDraft:id=>draftIds.has(id),objectDraftId:(kind,id)=>kind+'/'+id,
    useObjectDraft:(kind,id,draft,revision=0)=>{const key=kind+'/'+id;if(!drafts.has(key)){const controller={draft,base:revision,dirty:false,status:'saved',frozen:false,composing:false,saving:false,flush:async()=>{},edit(value){controller.draft={...controller.draft,...value};},compositionStart(){},compositionEnd(){},save:async persist=>{const saved=await persist(controller.draft);controller.base=saved.revision;controller.draft=saved.value;return {...saved,dirty:false};}};drafts.set(key,controller);}return drafts.get(key);},
    saveAction:async()=>{},withSavedDrafts:async(_scope,_dependencies,fn)=>fn(),draftScopeRevision:(_scope,revision)=>revision,
    submitOperation:async(...args)=>{sent.push(args);return operation(...args);},
    Dialog:'Dialog',Field:'Field',Select:'Select',Status:'Status',ObjectDraftTools:'ObjectDraftTools',TaskAuthorization:'TaskAuthorization',SceneSuggestions:'SceneSuggestions'};
  globalThis.unitPanelTest=runtime;
  const header='const {React,useEffect,useRef,useState,api,action,hasDraft,objectDraftId,useObjectDraft,saveAction,withSavedDrafts,draftScopeRevision,submitOperation,Dialog,Field,Select,Status,ObjectDraftTools,TaskAuthorization,SceneSuggestions}=globalThis.unitPanelTest;\n';
  const {UnitDetails,CreateGroup}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// test '+sequence++).toString('base64'));
  const status=()=>({validity:'matched',review:'passed',prompt:'',promptIssues:[],basis:{}});
  const variant=(current,latest)=>({current,previous:'previous',approved:null,latest,revision:1,guidance:'保留要求',status:status(),history:[]});
  const unit={id:'group',chapterId:'chapter',kind:'group',state:'active',members:['one','two'],mode:'dry',revision:1,variants:{dry:variant('old-dry','success'),scene:variant(null,'unknown')}};
  const props={unit,chapter:{id:'chapter',projectId:'project',revision:1,segments:[{id:'one',order:0,text:'第一句',roleId:'role',voiceId:'voice'},{id:'two',order:1,text:'第二句',roleId:'role',voiceId:'voice'}],events:[],playbackItems:[]},roles:[{id:'role',name:'角色'}],state:{jobs:[],voices:[],projects:[],settings:{configured:true,audioTools:true,features:{},model:'audio',routeBlocked:false}},locked:false,connected:true,mode:'scene',setMode(){},refresh:async()=>{},close(){},open(){},play:(...args)=>played.push(args),onTask:(...args)=>tasks.push(args)};
  const groups=[];const groupProps={chapter:props.chapter,ids:['one','two'],roles:props.roles,enabled:true,state:props.state,refresh:props.refresh,close:props.close,open:props.open,created:(...args)=>groups.push(args)};
  return {props,groupProps,groups,sent,played,tasks,actions,render:()=>{index=0;return UnitDetails(props);},renderGroup:()=>{index=0;return CreateGroup(groupProps);}};
}

test('unknown 先试听保留纯人声，范围可见、全文与修改按需展开，重试默认未选择',async()=>{
  const f=await setup(),tree=f.render();
  const all=nodes(tree),safe=all.findIndex(node=>node.props.className==='unit-safe-result'),settings=all.findIndex(node=>node.props.className==='unit-edit-settings');
  assert.ok(safe>=0&&safe<settings);assert.match(text(all[safe]),/新结果尚未确认，可能已计费/);
  assert.match(text(all.find(node=>node.props.className==='unit-member-range')),/覆盖第 1、2 句 · 共 2 句/);
  assert.equal(all[settings].props.open,false);assert.equal(!!all.find(node=>node.type==='details'&&text(node).startsWith('查看全文')).props.open,false);
  const play=button(tree,'试听已有声音');assert.equal(play.props.disabled,false);play.props.onClick();
  assert.deepEqual(f.played,[['old-dry','纯人声 · 已有声音',false]]);assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);
  const footer=tree.props.footer;assert.equal(nodes(footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
  assert.equal(button(footer,'再次提交 1 次请求').props.disabled,true);assert.ok(nodes(footer).some(node=>node.props.className==='unit-submit-scope'));assert.ok(nodes(footer).some(node=>node.props.className==='unit-submit-actions'));
});
test('背景与历史试听在原按钮显示暂停，使用同一播放回调，不需要关闭面板',async()=>{
  const f=await setup();f.props.unit.variants.scene.current='scene-audio';f.props.unit.variants.scene.latest='success';f.props.playingId='scene-audio';
  let tree=f.render();const current=button(tree,'暂停这份声音');assert.equal(current.props.disabled,false);current.props.onClick();assert.equal(f.played[0][0],'scene-audio');
  f.props.unit.variants.scene.history=[{id:'old-audio',matched:true,selected:false,available:true}];f.props.playingId='old-audio';tree=f.render();const old=button(tree,'暂停声音 1');assert.equal(old.props.disabled,false);old.props.onClick();assert.equal(f.played[1][0],'old-audio');assert.equal(f.played[1][2],true);
  f.props.unit.variants.scene.latest='unknown';f.props.playingId='scene-audio';tree=f.render();button(tree,'暂停已有声音').props.onClick();assert.equal(f.played[2][0],'scene-audio');assert.equal(f.sent.length,0);
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

test('正常状态先展示试听与历史，全文按需展开，编辑仍展开，unknown仍可进入已有声音恢复预览',async()=>{
  const f=await setup(async()=>({differences:[]}));f.props.unit.variants.scene.latest='success';
  let tree=f.render();assert.ok(!nodes(tree).some(node=>node.props.className==='unit-safe-result'));assert.equal(nodes(tree).find(node=>node.props.className==='unit-edit-settings').props.open,true);
  assert.equal(!!nodes(tree).find(node=>node.type==='details'&&text(node).startsWith('查看全文')).props.open,false);
  f.props.unit.variants.scene.latest='unknown';tree=f.render();button(tree,'恢复上一版').props.onClick();await tick();
  tree=f.render();assert.equal(tree.props.title,'恢复历史声音');button(tree,'恢复并使用这份声音').props.onClick();await tick();
  assert.equal(f.actions[0][0],'unit.restore');assert.equal(f.actions[0][1].audioId,'previous');assert.equal(f.sent.length,0);
});

test('已授权的暂停组任务仍默认不可提交；明确恢复后仅点击发送一次并清除确认',async()=>{
  const f=await setup();f.props.mode='dry';f.props.state.settings.routeBlocked=true;
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  let tree=f.render();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'再做一版').props.disabled,true);
  button(tree.props.footer,'再做一版').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  const submit=button(f.render().props.footer,'再做一版');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'generateSelection');assert.equal(f.sent[0][1].unitId,'group');assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].grantId,'grant');assert.equal(f.sent[0][1].retryUnknown,undefined);
  tree=f.render();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'再做一版').props.disabled,true);
  button(tree.props.footer,'再做一版').props.onClick();await tick();assert.equal(f.sent.length,1);
});

test('暂停且结果不明的场景分别确认；失败后两项清除，模式切换不移交恢复确认',async()=>{
  const f=await setup(undefined,async()=>({error:'测试接口再次暂停'}));f.props.state.settings.routeBlocked=true;f.props.unit.variants.dry.latest='unknown';f.props.setMode=mode=>{f.props.mode=mode;};
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});
  assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,true);button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});check(f.render().props.footer,'再次提交 1 次请求').props.onChange({target:{checked:true}});
  button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'sceneAndGenerate');assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].retryUnknown,true);assert.equal(f.sent[0][1].grantId,'grant');
  assert.equal(check(f.render().props.footer,'恢复本次声音请求').props.checked,false);assert.equal(check(f.render().props.footer,'再次提交 1 次请求').props.checked,false);assert.match(text(f.render()),/测试接口再次暂停/);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});check(f.render().props.footer,'再次提交 1 次请求').props.onChange({target:{checked:true}});button(f.render(),'纯人声').props.onClick();
  assert.equal(f.props.mode,'dry');assert.equal(check(f.render().props.footer,'恢复本次声音请求').props.checked,false);assert.equal(check(f.render().props.footer,'再次提交 1 次请求').props.checked,false);assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,true);assert.equal(f.sent.length,1);
});

test('新建对戏只在明确恢复后创建一次，已保存组不因重复点击再创建',async()=>{
  const f=await setup(undefined,async()=>({outcome:'processing',result:{unit:{id:'created-group',members:['one','two'],revision:1,chapterRevision:2,variants:{dry:{guidance:''}}}}}));f.props.state.settings.routeBlocked=true;
  nodes(f.renderGroup()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  let tree=f.renderGroup();assert.equal(button(tree.props.footer,'生成这段对话').props.disabled,true);button(tree.props.footer,'生成这段对话').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.renderGroup().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  button(f.renderGroup().props.footer,'生成这段对话').props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'groupAndGenerate');assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].grantId,'grant');assert.equal(f.groups.length,1);assert.equal(f.groups[0][0].id,'created-group');
  tree=f.renderGroup();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'生成这段对话').props.disabled,true);check(tree.props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});
  assert.equal(button(f.renderGroup().props.footer,'生成这段对话').props.disabled,true,'A saved group cannot be created again through its visible primary action');assert.equal(f.sent.length,1);assert.equal(f.groups.length,1);
});

test('未添加的新声音草稿保留且不阻已配置场景；现有相关编辑仍阻断，并在按钮旁提示',async()=>{
  const draftIds=new Set(['sound-event/new-group','sound-event/removed']);
  const f=await setup(undefined,undefined,draftIds);
  f.props.unit.variants.scene.latest='success';f.props.unit.variants.scene.status.validity='stale';
  f.props.chapter.events=[{id:'removed',state:'removed',revision:2},{id:'ambient',state:'adopted',revision:1},{id:'unused',state:'draft',revision:1}].map(event=>({...event,unitId:'group',kind:'environment',memberId:'one',position:'during',description:'山洞水滴声',evidence:{kind:'用户创作选择'}}));
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  assert.match(text(f.render().props.footer),/未添加的声音草稿已保留，不加入本次生成/);
  button(f.render().props.footer,'应用并生成带背景声').props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0][1].eventIds,['ambient']);
  assert.ok(draftIds.has('sound-event/new-group'));assert.ok(draftIds.has('sound-event/removed'));
  for(const id of ['one','unit/group/scene','sound-event/ambient']){
    draftIds.add(id);button(f.render().props.footer,'应用并生成带背景声').props.onClick();await tick();
    const footer=f.render().props.footer;
    assert.equal(f.sent.length,1);assert.match(text(nodes(footer).find(node=>node.props.role==='alert')),/还有相关未完成编辑/);
    assert.equal(button(footer,'应用并生成带背景声').props.disabled,false);assert.ok(draftIds.has(id));draftIds.delete(id);
  }
});

test('移除的背景不占配置列表，暂不使用仍保留；全移除后显示空态，明确恢复草稿仍能编辑',async()=>{
  const f=await setup();f.props.unit.variants.scene.latest='success';
  f.props.chapter.events=[{id:'removed',state:'removed',description:'已移除水滴'},{id:'ambient',state:'adopted',description:'当前山洞环境'},{id:'unused',state:'draft',description:'暂不使用音乐'}].map(event=>({...event,unitId:'group',kind:'environment',revision:1,memberId:'one',position:'during',evidence:{kind:'用户创作选择'}}));
  const cards=tree=>nodes(tree).filter(node=>node.props.className==='task-event-card');
  let tree=f.render();assert.equal(cards(tree).length,2);assert.doesNotMatch(text(tree),/已移除水滴/);assert.match(text(tree),/当前山洞环境/);assert.match(text(tree),/暂不使用音乐/);
  button(cards(tree)[0],'移除').props.onClick();await tick();assert.equal(f.actions[0][0],'event.remove');assert.equal(f.actions[0][1].id,'ambient');
  f.props.chapter.events=f.props.chapter.events.map(event=>({...event,state:'removed',revision:2}));
  tree=f.render();assert.equal(cards(tree).length,0);assert.match(text(tree),/还没有声音背景/);assert.equal(f.props.chapter.events.length,3,'显示过滤不删除历史记录');
  const restored=await setup();Object.assign(restored.props,{chapter:f.props.chapter,initialEventId:'removed'});
  tree=restored.render();assert.equal(cards(tree).length,1);assert.ok(nodes(tree).some(node=>typeof node.type==='function'&&node.type.name==='EventEditor'&&node.props.event.id==='removed'),'仅明确恢复该事件草稿时提供原编辑器');
  assert.equal(f.sent.length,0);assert.equal(restored.sent.length,0);
});

test('实际选用的背景声和纯人声显示正在使用；听评明确为人工记录',async()=>{
  const f=await setup();f.props.unit.mode='scene';f.props.unit.variants.scene.current='current-scene';f.props.unit.variants.scene.latest='success';
  f.props.chapter.playbackItems=[{id:'group',unitId:'group',mode:'scene',audioId:'current-scene',validity:'matched'}];
  let tree=f.render(),selected=button(tree,'正在使用带背景声');
  assert.equal(selected.props.disabled,true);assert.match(text(tree),/这份声音已经选用，无需再次点击/);assert.match(text(tree),/人工听评通过/);
  assert.ok(nodes(tree).some(node=>node.type==='p'&&node.props.id===selected.props['aria-describedby']));
  assert.equal(button(tree,'使用这份带背景声'),undefined);
  f.props.mode='dry';f.props.unit.mode='dry';f.props.chapter.playbackItems=[{id:'group',mode:'dry',audioId:'old-dry',validity:'matched'}];
  tree=f.render();assert.equal(button(tree,'正在使用纯人声').props.disabled,true);
  assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
});

test('选用另一份匹配声音只切换一次；刷新后改为正在使用，未进入编排不冒充已使用',async()=>{
  const f=await setup();f.props.unit.variants.scene.current='scene';f.props.unit.variants.scene.latest='success';
  f.props.chapter.playbackItems=[{id:'group',unitId:'group',mode:'dry',audioId:'old-dry',validity:'matched'}];
  let tree=f.render();assert.equal(button(tree,'使用这份带背景声').props.disabled,false);assert.match(text(tree),/不会重新生成或产生费用/);
  button(tree,'使用这份带背景声').props.onClick();await tick();
  assert.equal(f.actions.length,1);assert.equal(f.actions[0][0],'unit.switch');assert.equal(f.actions[0][1].mode,'scene');assert.equal(f.sent.length,0);
  f.props.unit.mode='scene';tree=f.render();assert.equal(button(tree,'使用这份带背景声').props.disabled,true);assert.equal(button(tree,'正在使用带背景声'),undefined);assert.match(text(tree),/未进入当前整章编排/);
  f.props.chapter.playbackItems=[{id:'group',unitId:'group',mode:'scene',audioId:'scene',validity:'matched'}];
  tree=f.render();assert.equal(button(tree,'正在使用带背景声').props.disabled,true);
  f.props.chapter.playbackItems[0].audioId='different-result';assert.equal(button(f.render(),'正在使用带背景声'),undefined);
  f.props.chapter.playbackItems[0].audioId='scene';f.props.chapter.playbackItems[0].unitId='another-unit';assert.equal(button(f.render(),'正在使用带背景声'),undefined);
});

test('不能选用时就近说明缺失、过期、损坏、未保存、制作中及历史状态',async()=>{
  const f=await setup(undefined,undefined,new Set(['unit/group/scene']));f.props.unit.mode='dry';f.props.unit.variants.scene.current='scene';f.props.unit.variants.scene.latest='success';
  let tree=f.render();assert.equal(button(tree,'使用这份带背景声').props.disabled,true);assert.match(text(tree),/相关修改尚未完成/);
  const clean=await setup();clean.props.unit.mode='scene';clean.props.unit.variants.scene.current='scene';clean.props.unit.variants.scene.latest='success';
  clean.props.chapter.playbackItems=[{id:'group',unitId:'group',mode:'scene',audioId:'scene',validity:'matched'}];
  for(const [validity,reason] of [['missing',/还没有带背景声版本，请先生成/],['stale',/设置已修改，请按当前设置生成/],['broken',/声音文件不可用，请恢复已有声音/]]){
    clean.props.unit.variants.scene.status.validity=validity;tree=clean.render();assert.equal(button(tree,'使用这份带背景声').props.disabled,true);assert.equal(button(tree,'正在使用带背景声'),undefined);assert.match(text(tree),reason);
  }
  clean.props.unit.variants.scene.status.validity='matched';clean.props.locked=true;assert.match(text(clean.render()),/本章正在制作，完成后才能切换声音/);
  clean.props.locked=false;clean.props.unit.state='dissolved';tree=clean.render();assert.match(text(tree),/这段对戏已取消，这里仅保留历史声音/);assert.equal(button(tree,'正在使用带背景声'),undefined);
  clean.props.unit.diagnostics=['缺少成员'];assert.match(text(clean.render()),/这段声音需要修复/);
  assert.equal(f.actions.length,0);assert.equal(clean.actions.length,0);assert.equal(f.sent.length,0);assert.equal(clean.sent.length,0);
});

test('声音面板先试听再历史与下一版编辑，请求记录不冒充可选音频，动作有按钮外观',async()=>{
  const f=await setup();f.props.unit.variants.scene.latest='success';
  f.props.state.jobs=[{id:'request',unitId:'group',status:'success',createdAt:'2026-10-03T00:00:00Z',resultAudioId:'audio'}];
  const tree=f.render(),all=nodes(tree),position=cls=>all.findIndex(node=>node.props.className?.split(' ').includes(cls));
  assert.ok(position('unit-current-result')<position('unit-history'));
  assert.ok(position('unit-history')<position('unit-edit-settings'));
  assert.ok(position('unit-edit-settings')<position('unit-submit-authorization'));
  assert.ok(!all.some(node=>node.props.className==='task-outcome'));assert.equal(button(tree,'试听这次结果'),undefined);
  for(const label of ['人工听评已通过','标记需要重做','恢复上一版','恢复最近通过版'])assert.match(button(tree,label).props.className,/button secondary/);
  assert.match(text(tree),/修改背景设置不会改变已生成的音频/);
});

test('任意旧设置历史先免费核对，预览具体背景，明确恢复才改变当前声音',async()=>{
  const reads=[],f=await setup(async(path,payload)=>{reads.push([path,payload]);return {differences:['已采用声音事件不同'],input:{guidance:'当时的表演',events:[{kind:'environment',description:'旧版水滴声'}]}};});
  f.props.unit.variants.scene.latest='success';f.props.unit.variants.scene.history=[{id:'oldest',matched:false,selected:false,available:true,prompt:'旧要求'}];
  button(f.render(),'核对并恢复声音 1').props.onClick();await tick();
  assert.equal(reads.length,1);assert.equal(reads[0][1].audioId,'oldest');assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
  let tree=f.render();assert.equal(tree.props.title,'恢复历史声音');assert.match(text(tree),/旧版水滴声/);assert.match(text(tree),/不重新生成，不产生 API 费用/);
  button(tree,'恢复并使用这份声音').props.onClick();await tick();
  assert.equal(f.actions.length,1);assert.equal(f.actions[0][0],'unit.restore');assert.equal(f.actions[0][1].audioId,'oldest');assert.equal(f.actions[0][1].restoreSettings,true);assert.equal(f.sent.length,0);
  tree=f.render();assert.notEqual(tree.props.title,'恢复历史声音');assert.match(text(nodes(tree).find(node=>node.props.className?.includes('unit-current-result'))),/已恢复并选用/);
});

test('匹配历史直接选用，当前版本选中但未进入编排时切换；零生成，失败就在被点卡片旁',async()=>{
  const f=await setup(undefined,undefined,new Set(),async()=>{throw new Error('当前章节已变化，请重新核对');});
  f.props.unit.variants.scene.latest='success';f.props.unit.variants.scene.history=[{id:'old',matched:true,selected:false,available:true}];
  button(f.render(),'使用声音 1').props.onClick();await tick();
  assert.equal(f.actions[0][0],'unit.select-result');assert.equal(f.sent.length,0);
  const tree=f.render(),card=nodes(tree).find(node=>node.props['aria-label']==='声音 1');
  assert.match(text(card),/当前章节已变化/);assert.doesNotMatch(text(tree.props.footer),/当前章节已变化/);
  f.props.unit.variants.scene.history[0].selected=true;button(f.render(),'使用声音 1').props.onClick();await tick();assert.equal(f.actions[1][0],'unit.switch');
});

test('不可兼容旧版核对错误就近展示，文件不可用与未完成编辑有明确禁用状态',async()=>{
  const f=await setup(async()=>{throw new Error('台词已修改，旧声音仅供试听');});f.props.unit.variants.scene.latest='success';
  f.props.unit.variants.scene.history=[{id:'older',matched:false,selected:false,available:true},{id:'broken',matched:false,selected:false,available:false}];
  let tree=f.render();assert.equal(button(tree,'试听声音 2').props.disabled,true);assert.equal(button(tree,'核对并恢复声音 2').props.disabled,true);
  button(tree,'核对并恢复声音 1').props.onClick();await tick();tree=f.render();
  assert.match(text(nodes(tree).find(node=>node.props['aria-label']==='声音 1')),/台词已修改，旧声音仅供试听/);assert.doesNotMatch(text(tree.props.footer),/台词已修改/);assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
  const drafts=await setup(undefined,undefined,new Set(['one']));drafts.props.unit.variants.scene.history=f.props.unit.variants.scene.history;
  tree=drafts.render();assert.equal(button(tree,'核对并恢复声音 1').props.disabled,true);assert.match(text(nodes(tree).find(node=>node.props.className?.includes('unit-history'))),/先完成相关编辑/);
});

test('底部恢复草稿和停止请求的失败都在原按钮附近显示，不触发生成',async()=>{
  const f=await setup(undefined,undefined,new Set(['sound-event/new-group']),async()=>{throw new Error('停止请求失败');});
  const tree=f.render();
  nodes(tree).find(node=>node.type==='ObjectDraftTools').props.controller.flush=async()=>{throw new Error('草稿保存失败');};
  const edit=button(tree.props.footer,'继续编辑草稿');assert.match(edit.props.className,/button secondary/);
  edit.props.onClick();await tick();
  assert.match(text(f.render().props.footer),/草稿保存失败/);assert.doesNotMatch(text(f.render().props.children),/草稿保存失败/);
  f.props.state.jobs=[{id:'job',unitId:'group',status:'queued',done:0,total:1}];
  button(f.render().props.footer,'停止后续请求').props.onClick();await tick();
  assert.match(text(f.render().props.footer),/停止请求失败/);assert.equal(f.sent.length,0);
});
