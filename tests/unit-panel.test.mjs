import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/UnitPanel.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source+'\nexport {UnitDetails,EventEditor};',{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):[...(node.props?.children||[]),node.props?.footer].flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const check=(tree,label)=>nodes(nodes(tree).find(node=>node.type==='label'&&text(node).includes(label))).find(node=>node.type==='input');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
let sequence=0;
async function setup(api=async()=>[],operation=async()=>({outcome:'processing'}),draftIds=new Set(),mutation=async()=>{}) {
  let index=0;const hooks=[],sent=[],played=[],tasks=[],actions=[],reads=[],drafts=new Map();
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    useEffect(){},useRef:initial=>{const key=index++;return hooks[key]||=( {current:initial});},
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    api:async(...args)=>{reads.push(args);return api(...args);},action:async(...args)=>{actions.push(args);return mutation(...args);},hasDraft:id=>draftIds.has(id),objectDraftId:(kind,id)=>kind+'/'+id,
    useObjectDraft:(kind,id,draft,revision=0,options={})=>{const key=kind+'/'+id;if(!drafts.has(key)){const controller={draft,base:revision,options,dirty:false,status:'saved',frozen:false,composing:false,saving:false,flush:async()=>{},edit(value){controller.draft={...controller.draft,...value};},compositionStart(){},compositionEnd(){},save:async persist=>{const saved=await persist(controller.draft,controller.base,{chapterRevision:controller.draft.chapterRevision,operationId:'fixture-default',replay:false});controller.base=saved.revision;controller.draft=saved.value;return {...saved,dirty:false};}};drafts.set(key,controller);}return drafts.get(key);},
    saveAction:(...args)=>runtime.persistSave(...args),persistSave:async()=>{},withSavedDrafts:async(_scope,_dependencies,fn)=>fn(),draftScopeRevision:(_scope,revision)=>revision,
    submitOperation:async(...args)=>{sent.push(args);return operation(...args);},
    ChevronRight:'ChevronRight',CircleHelp:'CircleHelp',Dialog:'Dialog',Field:'Field',Select:'Select',Status:'Status',ObjectDraftTools:'ObjectDraftTools',SceneSuggestions:'SceneSuggestions',AudioProvenance:'AudioProvenance'};
  globalThis.unitPanelTest=runtime;
  const header='const {React,useEffect,useRef,useState,api,action,hasDraft,objectDraftId,useObjectDraft,saveAction,withSavedDrafts,draftScopeRevision,submitOperation,ChevronRight,CircleHelp,Dialog,Field,Select,Status,ObjectDraftTools,SceneSuggestions,AudioProvenance}=globalThis.unitPanelTest;\n';
  const {UnitDetails,CreateGroup,EventEditor}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// test '+sequence++).toString('base64'));
  const status=()=>({validity:'matched',review:'passed',prompt:'',promptIssues:[],basis:{}});
  const variant=(current,latest)=>({current,previous:'previous',approved:null,latest,revision:1,guidance:'保留要求',backgroundPresence:'unspecified',status:status(),history:[]});
  const unit={id:'group',chapterId:'chapter',kind:'group',state:'active',members:['one','two'],mode:'dry',revision:1,variants:{dry:variant('old-dry','success'),scene:variant(null,'unknown')}};
  const props={unit,chapter:{id:'chapter',projectId:'project',revision:1,segments:[{id:'one',order:0,text:'第一句',roleId:'role',voiceId:'voice'},{id:'two',order:1,text:'第二句',roleId:'role',voiceId:'voice'}],events:[],playbackItems:[]},roles:[{id:'role',name:'角色'}],state:{jobs:[],voices:[],projects:[],settings:{configured:true,audioTools:true,features:{},model:'audio',routeBlocked:false}},locked:false,connected:true,mode:'scene',setMode(){},refresh:async()=>{},close(){},open(){},play:(...args)=>played.push(args),onTask:(...args)=>tasks.push(args)};
  const groups=[];const groupProps={chapter:props.chapter,ids:['one','two'],roles:props.roles,enabled:true,state:props.state,refresh:props.refresh,close:props.close,open:props.open,created:(...args)=>groups.push(args)};
  return {props,groupProps,groups,sent,played,tasks,actions,reads,runtime,render:()=>{index=0;return UnitDetails(props);},renderGroup:()=>{index=0;return CreateGroup(groupProps);},renderEvent:(overrides={})=>{index=0;return EventEditor({unit:props.unit,chapter:props.chapter,locked:false,refresh:props.refresh,close:props.close,created(){},onSaved(){},...overrides});}};
}

test('SVG说明只开关嵌套弹窗；原面板、编辑与生成范围保留，零读取、变更或生成',async()=>{
  for(const mode of ['scene','dry']){
    const f=await setup();f.props.mode=mode;f.props.unit.variants.scene.latest='success';let closed=0;
    f.props.close=()=>closed++;
    let tree=f.render(),controller=nodes(tree).find(node=>node.type==='ObjectDraftTools').props.controller,flushed=0;
    controller.edit({guidance:'尚未完成的表演稿'});controller.dirty=true;controller.composing=true;controller.flush=async()=>{flushed++;};
    const before=JSON.stringify(f.props.unit),trigger=tree.props.headerActions;
    assert.equal(trigger.type,'button');assert.match(trigger.props.className,/\bicon\b/);assert.match(trigger.props.className,/unit-help-trigger/);
    assert.equal(trigger.props['aria-label'],mode==='scene'?'声音背景操作说明':'纯人声操作说明');assert.equal(trigger.props.title,undefined);assert.equal(trigger.props['aria-haspopup'],'dialog');assert.equal(trigger.props['aria-expanded'],false);
    assert.ok(nodes(trigger).some(node=>node.type==='CircleHelp'&&node.props['aria-hidden']==='true'));
    assert.doesNotMatch(text(tree),/已选用，无需再次点击|检查通过只记录人工听评|位置是创作意图/);
    trigger.props.onClick();tree=f.render();
    const help=nodes(tree).find(node=>node.type==='Dialog'&&node.props.title===(mode==='scene'?'声音背景 · 操作说明':'纯人声 · 操作说明'));
    assert.ok(help,'帮助作为现有面板的子弹窗挂载');assert.equal(tree.props.presentation,'sidepanel');assert.equal(tree.props.headerActions.props['aria-expanded'],true);
    assert.match(text(help),/显示“正在使用…”时，已选用，无需再次点击/);assert.match(text(help),/检查通过只记录人工听评/);assert.match(text(help),/旧设置先核对差异/);
    assert.equal(nodes(help).filter(node=>node.type==='section').length,mode==='scene'?5:4);
    if(mode==='scene'){assert.match(text(help),/核对与启用免费/);assert.match(text(help),/位置是创作意图/);assert.match(text(help),/AI 建议只分析，不改台词或自动制作/);assert.match(text(help),/音乐转折需使用存在感模板/);}
    assert.equal(nodes(tree).find(node=>node.type==='ObjectDraftTools').props.controller,controller);assert.ok(!nodes(tree).some(node=>node.type==='TaskAuthorization'));assert.ok(nodes(tree).some(node=>node.props.className?.includes('unit-current-result')));
    help.props.onClose();tree=f.render();assert.equal(tree.props.headerActions.props['aria-expanded'],false);assert.ok(!nodes(tree).some(node=>node.type==='Dialog'&&node.props.title.includes('操作说明')));
    assert.equal(controller.draft.guidance,'尚未完成的表演稿');assert.equal(controller.dirty,true);assert.equal(controller.composing,true);assert.equal(flushed,0);assert.equal(closed,0);assert.equal(JSON.stringify(f.props.unit),before);
    assert.equal(f.reads.length,0);assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);assert.equal(f.played.length,0);assert.equal(f.tasks.length,0);
  }
});

test('说明收起后未知计费与存在感未生效仍就地可见，启用仅一个主按钮且不提交声音',async()=>{
  const f=await setup();Object.assign(f.props.unit.variants.scene,{template:'scene-v2',backgroundPresence:'clear'});

  let tree=f.render(),footer=tree.props.footer;
  assert.match(text(tree),/新结果尚未确认，可能已计费/);assert.ok(button(tree,'查看这次记录'));
  assert.match(text(footer),/明确再次提交 1 次请求，可能再次计费/);assert.match(text(footer),/当前旧模板不支持“清楚”/);
  assert.equal(nodes(footer).find(node=>node.props.className==='task-request-summary').props.children.join(''),'整段 2 句 · 带背景声 · 本次发送 1 次请求');
  assert.equal(button(tree,'查看并切换到 v4'),undefined);assert.equal([...nodes(tree),...nodes(footer)].filter(node=>node.type==='button'&&text(node)==='查看并切换到 v4').length,1);
  const actionRow=nodes(footer).find(node=>node.props.className==='unit-submit-actions');
  assert.equal(nodes(actionRow).find(node=>node.props.className==='unit-presence-required'),undefined,'原因显示在按钮行之前，两按钮直接同层');
  assert.match(text(footer),/切换免费，不会生成声音/);
  const submit=button(footer,'再次提交 1 次请求');assert.equal(submit.props.disabled,true);assert.match(submit.props.className,/button secondary/);assert.match(button(footer,'查看并切换到 v4').props.className,/button primary/);
  const field=nodes(tree).find(node=>node.type==='Field'&&node.props.label==='下一次生成的背景存在感');assert.equal(field.props.hint,undefined);
  assert.doesNotMatch(text(tree),/核对与启用免费|检查通过只记录人工听评|这里记录请求是否成功/);
  tree.props.headerActions.props.onClick();tree=f.render();nodes(tree).find(node=>node.type==='Dialog'&&node.props.title==='声音背景 · 操作说明').props.onClose();tree=f.render();
  assert.equal(check(tree.props.footer,'明确再次提交').props.checked,false);check(tree.props.footer,'明确再次提交').props.onChange({target:{checked:true}});
  button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(f.reads.length,0);assert.match(text(f.render().props.footer),/当前旧模板不支持“清楚”/);
});

test('明确切换后模板选项同步v4；候选未应用时说明状态，保存后使用同一免费预览流程',async()=>{
  const reads=[],f=await setup(async(path,payload)=>{reads.push([path,payload]);return {before:'旧要求',after:'新要求',to:payload.template};},undefined,undefined,async(name,payload)=>{
    if(name==='unit.template') { f.props.unit.variants.scene.template=payload.template; f.props.unit.revision++; }
  });
  Object.assign(f.props.unit.variants.scene,{template:'scene-v1',backgroundPresence:'clear',latest:'success'});
  f.props.state.enhancementTemplates=[{id:'scene-v1',name:'场景 v1',mode:'scene',scope:'unit'},{id:'scene-v4-presence-1',name:'场景 v4 · 背景存在感（试验）',mode:'scene',scope:'unit'}];
  let tree=f.render();
  const choice=()=>nodes(f.render()).find(node=>node.type==='Select'&&node.props.label==='提示模板');
  assert.equal(choice().props.value,'scene-v1','真实旧设置仍保留');
  assert.match(choice().props.options.find(option=>option.value==='scene-v4-presence-1').label,/默认/);
  choice().props.onChange('scene-v4-presence-1');tree=f.render();
  assert.match(nodes(tree).find(node=>node.type==='Field'&&node.props.label==='下一次生成的提示模板').props.hint,/尚未应用/);
  const controller=nodes(tree).find(node=>node.type==='ObjectDraftTools').props.controller;
  let flushes=0;controller.flush=async()=>{flushes++;};
  button(tree,'查看模板差异').props.onClick();await tick();
  assert.equal(flushes,1);assert.equal(reads.length,1);assert.equal(reads[0][0],'/enhancement-preview');assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
  assert.match(text(f.render()),/不发送声音请求/);
  button(f.render(),'使用这个模板').props.onClick();await tick();
  assert.equal(choice().props.value,'scene-v4-presence-1');assert.equal(f.props.unit.variants.scene.template,'scene-v4-presence-1');
  assert.equal(nodes(f.render()).find(node=>node.type==='Field'&&node.props.label==='下一次生成的提示模板').props.hint,undefined);
  assert.equal(button(f.render().props.footer,'查看并切换到 v4'),undefined);assert.equal(f.sent.length,0);
});

test('旧v2及表面v4但历史编译仍旧时，存在感禁生成；免费核对后明确采用才切模板',async()=>{
  for(const [presence,label,template,resolvedCompilerId] of [['subtle','轻','scene-v2'],['natural','自然','scene-v2'],['clear','清楚','scene-v2'],['clear','清楚','scene-v4-presence-1','native3-paragraph-k']]){
    const reads=[],f=await setup(async(path,payload)=>{reads.push([path,payload]);return {before:'旧要求',after:'存在感要求',to:'scene-v4-presence-1'};});
    Object.assign(f.props.unit.variants.scene,{template,resolvedCompilerId,latest:'success',backgroundPresence:presence});

    let tree=f.render(),submit=button(tree.props.footer,'再做一版');
    assert.equal(submit.props.disabled,true);assert.match(text(tree.props.footer),new RegExp('当前旧模板不支持“'+label+'”'));
    submit.props.onClick();await tick();assert.equal(f.sent.length,0,'回调保护也不能发送付费请求');
    const preview=button(f.render().props.footer,'查看并切换到 v4');assert.equal(preview.props.disabled,false);assert.match(preview.props.className,/button primary/);
    preview.props.onClick();await tick();
    assert.equal(reads.length,1);assert.equal(reads[0][0],'/enhancement-preview');assert.equal(reads[0][1].template,'scene-v4-presence-1');assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
    tree=f.render();assert.equal(tree.props.title,'切换提示模板');button(tree,'使用这个模板').props.onClick();await tick();
    assert.equal(f.actions.length,1);assert.equal(f.actions[0][0],'unit.template');assert.equal(f.actions[0][1].template,'scene-v4-presence-1');assert.equal(f.sent.length,0);assert.equal(f.props.unit.variants.scene.current,null);assert.equal(f.props.unit.variants.scene.template,template,'夹具中其他音频与旧设置不被自动迁移');
  }
});

test('选择仍在保存时可核对；预览等flush并使用新章与单元版本，确认沿用该基准',async()=>{
  const order=[],reads=[];let finishSave;
  const saved=new Promise(resolve=>{finishSave=resolve;});
  const f=await setup(async(path,payload)=>{order.push('preview');reads.push([path,payload]);return {before:'旧要求',after:'清楚背景',to:'scene-v4-presence-1'};});
  Object.assign(f.props.unit.variants.scene,{template:'scene-v2',latest:'success'});
  let tree=f.render();nodes(tree).find(node=>node.type==='Select'&&node.props.label==='背景存在感').props.onChange('clear');
  const controller=nodes(f.render()).find(node=>node.type==='ObjectDraftTools').props.controller;
  controller.dirty=true;controller.saving=true;
  f.runtime.persistSave=async()=>saved;
  const pendingSave=controller.options.persist(controller.draft,1,{chapterRevision:1,operationId:'save-presence',replay:false});
  controller.flush=async()=>{order.push('flush');const receipt=await pendingSave;controller.draft=receipt.value;controller.dirty=false;controller.saving=false;order.push('saved');};
  const preview=button(f.render().props.footer,'查看并切换到 v4');assert.equal(preview.props.disabled,false);
  preview.props.onClick();await tick();assert.deepEqual(order,['flush']);assert.equal(reads.length,0);assert.equal(f.sent.length,0);
  finishSave({revision:3,chapterRevision:5,variants:{scene:{guidance:'保留要求',backgroundPresence:'clear'}}});await tick();await tick();
  assert.deepEqual(order,['flush','saved','preview']);assert.equal(reads[0][1].revision,5);assert.equal(reads[0][1].entityRevision,3);assert.equal(reads[0][1].id,'group');assert.equal(reads[0][1].mode,'scene');
  button(f.render(),'使用这个模板').props.onClick();await tick();assert.equal(f.actions[0][1].revision,5);assert.equal(f.actions[0][1].entityRevision,3);assert.equal(f.sent.length,0);
});

test('v4存在感和旧模板未指定仍走正常明确生成，旧模板免费入口保持可发现',async()=>{
  for(const [template,presence] of [['scene-v4-presence-1','clear'],['scene-v4-presence-1','natural'],['scene-v2','unspecified']]){
    const f=await setup();Object.assign(f.props.unit.variants.scene,{template,latest:'success',backgroundPresence:presence});

    const tree=f.render(),submit=button(tree.props.footer,'再做一版');assert.equal(submit.props.disabled,false);
    assert.doesNotMatch(text(tree.props.footer),/尚未生效/);submit.props.onClick();await tick();assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'sceneAndGenerate');
    if(template==='scene-v2')assert.ok(button(tree,'查看并切换到 v4'));
  }
});

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
  const f=await setup();
  button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();assert.equal(f.sent.length,0);
  nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  const submit=button(f.render().props.footer,'再次提交 1 次请求');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].retryUnknown,true);assert.equal(f.sent[0][1].kind,'sceneAndGenerate');assert.equal(f.sent[0][1].unitId,'group');assert.ok(!Object.hasOwn(f.sent[0][1],'grantId'));
  assert.equal(nodes(f.render().props.footer).find(node=>node.type==='input'&&node.props.type==='checkbox').props.checked,false);
});

test('切换声音版本撤回此前重试意图，新版本仍需明确重新勾选',async()=>{
  const f=await setup();f.props.unit.variants.dry.latest='unknown';
  f.props.setMode=mode=>{f.props.mode=mode;};

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

test('暂停组任务仍默认不可提交；明确恢复后仅点击发送一次并清除确认',async()=>{
  const f=await setup();f.props.mode='dry';f.props.state.settings.routeBlocked=true;

  let tree=f.render();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'再做一版').props.disabled,true);
  button(tree.props.footer,'再做一版').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  const submit=button(f.render().props.footer,'再做一版');assert.equal(submit.props.disabled,false);submit.props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'generateSelection');assert.equal(f.sent[0][1].unitId,'group');assert.equal(f.sent[0][1].resumeRoute,true);assert.ok(!Object.hasOwn(f.sent[0][1],'grantId'));assert.equal(f.sent[0][1].retryUnknown,undefined);
  tree=f.render();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'再做一版').props.disabled,true);
  button(tree.props.footer,'再做一版').props.onClick();await tick();assert.equal(f.sent.length,1);
});

test('暂停且结果不明的场景分别确认；失败后两项清除，模式切换不移交恢复确认',async()=>{
  const f=await setup(undefined,async()=>({error:'测试接口再次暂停'}));f.props.state.settings.routeBlocked=true;f.props.unit.variants.dry.latest='unknown';f.props.setMode=mode=>{f.props.mode=mode;};

  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});
  assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,true);button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});check(f.render().props.footer,'再次提交 1 次请求').props.onChange({target:{checked:true}});
  button(f.render().props.footer,'再次提交 1 次请求').props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'sceneAndGenerate');assert.equal(f.sent[0][1].resumeRoute,true);assert.equal(f.sent[0][1].retryUnknown,true);assert.ok(!Object.hasOwn(f.sent[0][1],'grantId'));
  assert.equal(check(f.render().props.footer,'恢复本次声音请求').props.checked,false);assert.equal(check(f.render().props.footer,'再次提交 1 次请求').props.checked,false);assert.match(text(f.render()),/测试接口再次暂停/);
  check(f.render().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});check(f.render().props.footer,'再次提交 1 次请求').props.onChange({target:{checked:true}});button(f.render(),'纯人声').props.onClick();
  assert.equal(f.props.mode,'dry');assert.equal(check(f.render().props.footer,'恢复本次声音请求').props.checked,false);assert.equal(check(f.render().props.footer,'再次提交 1 次请求').props.checked,false);assert.equal(button(f.render().props.footer,'再次提交 1 次请求').props.disabled,true);assert.equal(f.sent.length,1);
});

test('新建对戏只在明确恢复后创建一次，已保存组不因重复点击再创建',async()=>{
  const f=await setup(undefined,async()=>({outcome:'processing',result:{unit:{id:'created-group',members:['one','two'],revision:1,chapterRevision:2,variants:{dry:{guidance:''}}}}}));f.props.state.settings.routeBlocked=true;

  let tree=f.renderGroup();assert.equal(button(tree.props.footer,'生成这段对话').props.disabled,true);button(tree.props.footer,'生成这段对话').props.onClick();await tick();assert.equal(f.sent.length,0);
  check(f.renderGroup().props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});assert.equal(f.sent.length,0);
  button(f.renderGroup().props.footer,'生成这段对话').props.onClick();await tick();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].kind,'groupAndGenerate');assert.equal(f.sent[0][1].resumeRoute,true);assert.ok(!Object.hasOwn(f.sent[0][1],'grantId'));assert.equal(f.groups.length,1);assert.equal(f.groups[0][0].id,'created-group');
  tree=f.renderGroup();assert.equal(check(tree.props.footer,'恢复本次声音请求').props.checked,false);assert.equal(button(tree.props.footer,'生成这段对话').props.disabled,true);check(tree.props.footer,'恢复本次声音请求').props.onChange({target:{checked:true}});
  assert.equal(button(f.renderGroup().props.footer,'生成这段对话').props.disabled,true,'A saved group cannot be created again through its visible primary action');assert.equal(f.sent.length,1);assert.equal(f.groups.length,1);
});

test('未添加的新声音草稿保留且不阻已配置场景；现有相关编辑仍阻断，并在按钮旁提示',async()=>{
  const draftIds=new Set(['sound-event/new-group','sound-event/removed']);
  const f=await setup(undefined,undefined,draftIds);
  f.props.unit.variants.scene.latest='success';f.props.unit.variants.scene.status.validity='stale';
  f.props.chapter.events=[{id:'removed',state:'removed',revision:2},{id:'ambient',state:'adopted',revision:1},{id:'unused',state:'draft',revision:1}].map(event=>({...event,unitId:'group',kind:'environment',memberId:'one',position:'during',description:'山洞水滴声',evidence:{kind:'用户创作选择'}}));

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
  assert.equal(selected.props.disabled,true);assert.doesNotMatch(text(tree),/这份声音已经选用，无需再次点击/);assert.match(text(tree),/人工听评通过/);
  assert.equal(selected.props['aria-describedby'],undefined);
  assert.equal(button(tree,'使用这份带背景声'),undefined);
  f.props.mode='dry';f.props.unit.mode='dry';f.props.chapter.playbackItems=[{id:'group',mode:'dry',audioId:'old-dry',validity:'matched'}];
  tree=f.render();assert.equal(button(tree,'正在使用纯人声').props.disabled,true);
  assert.equal(f.actions.length,0);assert.equal(f.sent.length,0);
});

test('选用另一份匹配声音只切换一次；刷新后改为正在使用，未进入编排不冒充已使用',async()=>{
  const f=await setup();f.props.unit.variants.scene.current='scene';f.props.unit.variants.scene.latest='success';
  f.props.chapter.playbackItems=[{id:'group',unitId:'group',mode:'dry',audioId:'old-dry',validity:'matched'}];
  let tree=f.render();assert.equal(button(tree,'使用这份带背景声').props.disabled,false);assert.doesNotMatch(text(tree),/不会重新生成或产生费用/);
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
  assert.ok(position('unit-edit-settings')<position('unit-advanced'));
  assert.equal(position('unit-submit-authorization'),-1);
  assert.ok(!all.some(node=>node.props.className==='task-outcome'));assert.equal(button(tree,'试听这次结果'),undefined);
  for(const label of ['人工听评已通过','标记需要重做','恢复上一版','恢复最近通过版'])assert.match(button(tree,label).props.className,/button secondary/);
  assert.doesNotMatch(text(tree),/修改背景设置不会改变已生成的音频/);
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


test('存在感独立位于历史下方且默认清楚，编辑区有显式SVG展开标记；打开不写设置',async()=>{
  const f=await setup();delete f.props.unit.variants.scene.backgroundPresence;f.props.unit.variants.scene.latest='success';
  const tree=f.render(),all=nodes(tree),presence=all.find(node=>node.props.className?.includes('unit-background-presence'));
  const history=all.find(node=>node.props.className?.includes('unit-history'));
  const members=all.find(node=>node.props.className?.includes('unit-member-context'));
  const editor=all.find(node=>node.props.className==='unit-edit-settings');
  assert.ok(presence);assert.ok(all.indexOf(history)<all.indexOf(presence));assert.ok(all.indexOf(presence)<all.indexOf(members));
  assert.ok(!nodes(editor).some(node=>node.type==='Select'&&node.props.label==='背景存在感'));
  const select=nodes(presence).find(node=>node.type==='Select');assert.equal(select.props.value,'clear');assert.equal(select.props.options[0].value,'clear');
  assert.ok(nodes(editor).some(node=>node.type==='ChevronRight'&&node.props['aria-hidden']==='true'));
  assert.equal(f.actions.length+f.reads.length+f.sent.length,0);
  assert.equal(f.props.unit.variants.scene.backgroundPresence,undefined);
  for(const value of ['subtle','natural','unspecified']){const old=await setup();old.props.unit.variants.scene.backgroundPresence=value;assert.equal(nodes(old.render()).find(node=>node.type==='Select'&&node.props.label==='背景存在感').props.value,value);}
});

test('缺省清楚在明确分析操作前保存，用返回版本而非旧版本，已有音频不删',async()=>{
  const f=await setup();delete f.props.unit.variants.scene.backgroundPresence;
  const saved=[];f.runtime.persistSave=async(kind,payload)=>{saved.push([kind,payload]);return {...f.props.unit,revision:2,chapterRevision:3,variants:{...f.props.unit.variants,scene:{...f.props.unit.variants.scene,backgroundPresence:'clear'}}};};
  let tree=f.render();assert.equal(saved.length,0);
  const analysis=nodes(tree).find(node=>node.type==='SceneSuggestions');
  assert.deepEqual(await analysis.props.savedBase(),{revision:3,entityRevision:2});assert.equal(saved.length,1);assert.equal(saved[0][0],'unit.update');assert.equal(saved[0][1].backgroundPresence,'clear');
  assert.deepEqual(await analysis.props.savedBase(),{revision:3,entityRevision:2});assert.equal(saved.length,1,'同一已确认设置不再次写');
  assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(f.props.unit.variants.scene.current,null);
});


test('原件折叠到处理版下；试听不改变选版，匹配原件沿现有单元选用校验', async () => {
  const f = await setup(); f.props.unit.variants.scene.latest = 'success';
  const original = {id:'raw',matched:true,available:true,selected:false,provenance:'provider-original'}, processed = {id:'processed',matched:true,available:true,selected:false,originalAudioId:'raw',originalAvailability:'retained'};
  f.props.unit.variants.scene.history = [original, processed];
  let tree = f.render(), card = nodes(tree).find(node => node.type === 'AudioProvenance');
  assert.equal(card.props.record.id, 'processed'); assert.equal(card.props.original.id, 'raw'); assert.match(text(tree), /历史声音 · 1 版/);
  card.props.preview('raw'); assert.deepEqual(f.played, [['raw','清理前声音',true]]); assert.equal(f.actions.length, 0); assert.equal(f.sent.length, 0);
  card.props.useOriginal(original); await tick();
  assert.deepEqual(f.actions[0], ['unit.select-result', {chapterId:'chapter',revision:1,id:'group',entityRevision:1,mode:'scene',audioId:'raw'}]);
  assert.equal(f.sent.length, 0);
  original.selected = true; tree = f.render(); assert.match(text(tree), /历史声音 · 2 版/);
});

test('原件设置过期先走现有恢复预览；编辑未完成禁用原件选用', async () => {
  const f = await setup(async () => ({differences:['声音设置已变化']})); f.props.unit.variants.scene.latest = 'success';
  const original = {id:'raw',matched:false,available:true,selected:false};
  f.props.unit.variants.scene.history = [original, {id:'processed',matched:true,available:true,selected:false,originalAudioId:'raw',originalAvailability:'retained'}];
  nodes(f.render()).find(node => node.type === 'AudioProvenance').props.useOriginal(original); await tick();
  assert.equal(f.reads[0][0], '/enhancement-preview'); assert.equal(f.reads[0][1].audioId, 'raw'); assert.equal(f.actions.length, 0); assert.equal(f.sent.length, 0);
  const drafts = await setup(undefined, undefined, new Set(['one'])); drafts.props.unit.variants.scene.history = f.props.unit.variants.scene.history;
  assert.equal(nodes(drafts.render()).find(node => node.type === 'AudioProvenance').props.locked, true);
});


test('已收到原件的未登记结果优先免费恢复，不提供再次计费确认', async () => {
  const f = await setup(async () => [{id:'pending',unitId:'group',mode:'scene',status:'unknown',phase:'localRecoveryPending'}]);
  f.props.unit.variants.scene.outstandingAttemptIds = ['pending'];
  f.props.state.jobs = [{id:'job',unitId:'group',localRecoveryAttemptIds:['pending'],status:'unknown',createdAt:'2026-10-04T00:00:00Z'}];
  const tree = f.render(); assert.match(text(tree), /原件已接收，待本地恢复/); assert.equal(button(tree.props.footer,'再次提交 1 次请求'), undefined);
  assert.doesNotMatch(text(tree.props.footer), /明确再次提交/);
  button(tree.props.footer,'查看并免费恢复').props.onClick(); await tick();
  assert.deepEqual(f.tasks,[['job','pending']]); assert.equal(f.sent.length,0);
});

test('普通单句、对戏组和场景点击生成即提交当前范围，不需要次数或有效期授权',async()=>{
  for(const [kind,mode,id,members] of [['single','dry','one',['one']],['group','dry','group',['one','two']],['group','scene','group',['one','two']]]){
    const f=await setup();Object.assign(f.props.unit,{kind,id,members});f.props.mode=mode;f.props.unit.variants[mode].latest='success';
    const tree=f.render(),submit=button(tree.props.footer,'再做一版');assert.equal(submit.props.disabled,false);assert.ok(!nodes(tree).some(node=>node.type==='TaskAuthorization'));assert.doesNotMatch(text(tree),/生成权限与剩余次数|24\s*小时|先.*允许本次制作范围/);
    submit.props.onClick();await tick();assert.equal(f.sent.length,1);const payload=f.sent[0][1];assert.ok(!Object.hasOwn(payload,'grantId'));assert.equal(payload.chapterId,'chapter');assert.equal(payload.unitId,id);assert.equal(payload.kind,mode==='scene'?'sceneAndGenerate':'generateSelection');
    if(mode==='dry')assert.deepEqual(payload.ids,members);else assert.deepEqual(payload.eventIds,[]);
  }
});

test('新建对戏点击一次直接创建并生成所选成员，保留保存与已有组去重',async()=>{
  const f=await setup(undefined,async()=>({outcome:'processing',result:{unit:{id:'created-group',members:['one','two'],revision:1,chapterRevision:2,variants:{dry:{guidance:''}}}}}));
  const tree=f.renderGroup(),submit=button(tree.props.footer,'生成这段对话');assert.equal(submit.props.disabled,false);assert.ok(!nodes(tree).some(node=>node.type==='TaskAuthorization'));
  submit.props.onClick();await tick();assert.equal(f.sent.length,1);assert.deepEqual(f.sent[0][1].ids,['one','two']);assert.equal(f.sent[0][1].kind,'groupAndGenerate');assert.ok(!Object.hasOwn(f.sent[0][1],'grantId'));assert.equal(f.groups.length,1);assert.equal(button(f.renderGroup().props.footer,'生成这段对话').props.disabled,true);
});

test('默认恢复v4且历史v5仍支持存在感、试听和手动选择，不自动迁移或推广v5',async()=>{
  for(const template of ['scene-v4-presence-1','scene-v5-relations-1']){
    const f=await setup();f.props.state.sceneContract={defaultTemplate:'scene-v4-presence-1'};
    f.props.state.enhancementTemplates=[{id:'scene-v4-presence-1',name:'场景 v4',mode:'scene',scope:'unit'},{id:'scene-v5-relations-1',name:'场景 v5 · 试验',mode:'scene',scope:'unit'}];
    Object.assign(f.props.unit.variants.scene,{template,backgroundPresence:'clear',latest:'success',current:'retained-audio'});
    const before=JSON.stringify(f.props.unit),tree=f.render(),select=nodes(tree).find(node=>node.type==='Select'&&node.props.label==='提示模板');assert.equal(select.props.value,template);assert.match(select.props.options.find(option=>option.value==='scene-v4-presence-1').label,/默认/);assert.doesNotMatch(select.props.options.find(option=>option.value==='scene-v5-relations-1').label,/默认/);
    assert.equal(button(tree.props.footer,'再做一版').props.disabled,false);assert.equal(button(tree.props.footer,'查看并切换到 v4'),undefined,'历史v5无需先换模板才能生成');assert.doesNotMatch(text(tree),/新声景模板/);
    button(tree,'试听这份声音').props.onClick();assert.equal(f.played.at(-1)[0],'retained-audio');assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(JSON.stringify(f.props.unit),before);
    if(template==='scene-v5-relations-1'){button(tree,'查看并切换到 v4').props.onClick();await tick();assert.equal(f.reads.at(-1)[1].template,'scene-v4-presence-1');assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(f.props.unit.variants.scene.template,template);}
    else{select.props.onChange('scene-v5-relations-1');assert.equal(f.sent.length,0);assert.equal(f.actions.length,0);assert.equal(f.props.unit.variants.scene.template,template);}
  }
});

test('默认为v4时历史v5环境与音效仍按真实引文保存，v4仍拒绝非音乐转折',async()=>{
  for(const kind of ['environment','effect']){
    const f=await setup();f.props.state.sceneContract={defaultTemplate:'scene-v4-presence-1'};f.props.unit.variants.scene.template='scene-v5-relations-1';
    const tree=f.renderEvent(),controller=nodes(tree).find(node=>node.type==='ObjectDraftTools').props.controller;
    const transition={memberId:'one',quote:'第一句',occurrence:1,development:'在这个动作触发，随后余响消散。',volumeChange:''};
    const data={...controller.draft,kind,description:'已采用声音',transitionEnabled:true,transition};assert.equal(controller.options.validate(data),null);assert.match(text(tree),/声音发展与触发/);
    let request;f.runtime.persistSave=async(name,payload)=>{request={name,payload};return{...payload,id:'event',revision:1,chapterRevision:2,unitRevision:2};};
    await controller.options.persist(data,0,{chapterRevision:1,operationId:'save-event'});assert.deepEqual(request.payload.transition,transition);assert.equal(request.payload.kind,kind);assert.equal(request.name,'event.create');assert.equal(f.sent.length,0);
    const old=await setup();old.props.state.sceneContract={defaultTemplate:'scene-v4-presence-1'};old.props.unit.variants.scene.template='scene-v4-presence-1';const previous=nodes(old.renderEvent()).find(node=>node.type==='ObjectDraftTools').props.controller;
    assert.match(previous.options.validate({...previous.draft,...data}),/真实短引文/);assert.doesNotMatch(text(old.renderEvent()),/声音发展与触发/);assert.equal(old.sent.length,0);
  }
});
