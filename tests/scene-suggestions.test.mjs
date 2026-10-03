import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/SceneSuggestions.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);
const history=tree=>nodes(tree).find(node=>node.type==='Select'&&node.props.label==='历史声音建议');
const views=tree=>nodes(nodes(tree).find(node=>node.props.role==='group'&&node.props['aria-label']==='声音建议结果')).filter(node=>node.type==='button');
const openHistory=f=>{const tree=f.render();views(tree).find(node=>text(node).startsWith('历史建议 · ')).props.onClick();return f.render();};
const historyArea=tree=>nodes(tree).filter(node=>node.type==='section'&&nodes(node).includes(history(tree))).at(-1);
const checks=tree=>nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox');
const cards=tree=>nodes(tree).filter(node=>node.props.className==='task-event-card');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const item=(id='item')=>({id,description:id+' · 门声',kind:'effect',memberId:'line',position:'during',evidence:'创作建议',reason:'门被推开',sourceQuote:'他推开门。'});
const record=(id='record',items=[])=>({id,kind:'scene',unitId:'unit',unitRevision:2,revision:3,contextRevision:4,draftVersion:1,status:'ready',model:'fixture',items});
let sequence=0;

async function setup(records=[record()]){
  let index=0,effectIndex=0,pendingEffects=[];const hooks=[],effects=[],calls={api:[],operations:[],refresh:0,stateWrites:[],saves:[]};
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{calls.stateWrites.push(key);hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    useRef:initial=>hooks[index++]||={current:initial},
    useEffect:(callback,deps)=>{const key=effectIndex++;if(!effects[key]||deps.some((value,i)=>value!==effects[key].deps[i]))pendingEffects.push(()=>{effects[key]?.cleanup?.();effects[key]={deps,cleanup:callback()};});},
    Select:'Select',TaskAuthorization:'TaskAuthorization',
    api:async(...args)=>{calls.api.push(args);assert.ok(['/analysis/apply','/analysis/reuse'].includes(args[0]));return runtime.apply(...args);},apply:async()=>({addedEventIds:['added-event'],skippedItemIds:[]}),
    withSavedDrafts:async(scope,dependencies,next)=>{calls.saves.push([scope,dependencies]);return runtime.save(next);},save:async next=>next(),draftScopeRevision:(_scope,revision)=>runtime.scopeRevision??revision,
    submitOperation:async(...args)=>{calls.operations.push(args);return runtime.receipt(...args);},receipt:async()=>({result:{analysis:{id:'new'}},outcome:'processing'})};
  globalThis.sceneSuggestionsTest=runtime;
  const header='const {React,useState,useRef,useEffect,Select,TaskAuthorization,api,withSavedDrafts,draftScopeRevision,submitOperation}=globalThis.sceneSuggestionsTest;\n';
  const {default:SceneSuggestions}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// fixture '+sequence++).toString('base64'));
  const props={unit:{id:'unit',revision:2,members:['line']},chapter:{id:'chapter',projectId:'project',revision:3,segments:[{id:'line',order:0,text:'他推开门。'}],events:[],suggestions:records},contextRevision:4,model:'fixture',enabled:true,refresh:async()=>{calls.refresh++;}};
  const render=()=>{index=0;effectIndex=0;pendingEffects=[];let tree=SceneSuggestions(props);for(const effect of pendingEffects)effect();if(pendingEffects.length){index=0;effectIndex=0;tree=SceneSuggestions(props);}return tree;};
  return {props,calls,runtime,render,unmount:()=>effects.forEach(effect=>effect.cleanup?.())};
}

test('当前已完成空建议有明确结果，无加入0、无分析或采用请求',async()=>{
  const f=await setup(),before=JSON.stringify(f.props),tree=f.render();
  assert.match(text(tree),/分析完成，本次没有新增声音建议。/);
  assert.doesNotMatch(text(tree),/请选择想加入|加入选中的 0 个声音/);assert.equal(cards(tree).length,0);
  assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);assert.equal(JSON.stringify(f.props),before);
});

test('当前非空建议正常选择，加入只采用明确条目且不发分析或声音请求',async()=>{
  const f=await setup([record('ready',[item('chosen'),{...item('invalid'),issues:['位置需要核对']}])]);
  let tree=f.render();assert.equal(cards(tree).length,2);assert.match(text(tree),/请选择想加入/);assert.doesNotMatch(text(tree),/本次没有新增声音建议/);
  assert.equal(checks(tree)[0].props.disabled,false);assert.equal(checks(tree)[1].props.disabled,true);assert.equal(button(tree,'加入选中的 0 个声音').props.disabled,true);
  checks(tree)[0].props.onChange({target:{checked:true}});tree=f.render();assert.equal(checks(tree)[0].props.checked,true);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  const apply=button(tree,'加入选中的 1 个声音');assert.equal(apply.props.disabled,false);apply.props.onClick();await tick();
  assert.deepEqual(f.calls.api,[['/analysis/apply',{id:'ready',draftVersion:1,revision:3,unitRevision:2,selected:['chosen']}]]);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,1);assert.equal(checks(f.render())[0].props.checked,false);
});

test('过期、部分失败、运行中和已加入均不冒充当前完成空结果或提供采用',async()=>{
  const cases=[
    ['chapter stale',{revision:2},/已保留，可在「历史建议」中重新加入/],
    ['context stale',{contextRevision:3},/已保留，可在「历史建议」中重新加入/],
    ['unit stale',{unitRevision:1},/已保留，可在「历史建议」中重新加入/],
    ['partial',{status:'partial',error:'本批连接中断，可能已计费',issues:['建议需核对']},/已保留，可在「历史建议」中重新加入/],
    ['running',{status:'running'},/正在分析，关闭面板不会取消/],
    ['applied',{status:'applied'},/已保留，可在「历史建议」中重新加入/],
  ];
  for(const [name,change,message] of cases)for(const items of [[],[item()]]){
    const f=await setup([{...record(name,items),...change}]),tree=f.render();
    assert.match(text(tree),message,name);assert.doesNotMatch(text(tree),/分析完成，本次没有新增声音建议|请选择想加入|加入选中的/,name);
    assert.ok(checks(tree).every(check=>check.props.disabled===true),name);
    if(change.error)assert.match(text(tree),/本批连接中断，可能已计费/);if(change.issues)assert.match(text(tree),/建议需核对/);
    if(change.status==='running'){assert.equal(button(tree,'正在分析…').props.disabled,true);assert.equal(nodes(tree).find(node=>node.type==='TaskAuthorization').props.disabled,true);}
    assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
  }
});

test('从旧历史明确新分析后按回执ID显示新建议，清空旧选择，不猜列表末项',async()=>{
  const old=record('old',[item('old-item')]),later=record('later',[item('later-item')]),fresh=record('new',[item('new-item')]);
  const f=await setup([old,later]);let tree=openHistory(f);history(tree).props.onChange('old');checks(f.render())[0].props.onChange({target:{checked:true}});
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  f.props.refresh=async()=>{f.calls.refresh++;f.props.chapter.suggestions=[old,later,fresh,record('different-last',[item('wrong-item')])];};
  button(f.render(),'分析声音建议').props.onClick();await tick();tree=f.render();
  assert.equal(button(tree,'本次结果').props['aria-pressed'],true);assert.equal(history(tree),undefined);assert.equal(cards(tree).length,1);assert.match(text(tree),/new-item · 门声/);assert.doesNotMatch(text(tree),/old-item · 门声|wrong-item · 门声/);assert.equal(checks(tree)[0].props.checked,false);
  const shown=openHistory(f);assert.equal(history(shown).props.value,'new');assert.match(text(historyArea(shown)),/new-item · 门声/);assert.equal(cards(shown).length,1);assert.equal(f.calls.operations.length,1,'切历史不会重发分析或换到列表末项');
  assert.equal(f.calls.operations.length,1);assert.deepEqual(f.calls.operations[0],['scene-analysis:unit',{kind:'prepareChapter',analysisKind:'scene',sceneEnabled:true,chapterId:'chapter',revision:3,unitId:'unit',unitRevision:2,model:'fixture',grantId:'grant'}]);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,1);
});

test('普通刷新增加新记录仍保留明确查看的旧历史与选择，零分析或采用',async()=>{
  const old=record('old',[item('old-item')]),f=await setup([old,record('later',[item('later-item')])]);
  history(openHistory(f)).props.onChange('old');checks(f.render())[0].props.onChange({target:{checked:true}});
  f.props.chapter={...f.props.chapter,suggestions:[old,record('later',[item('later-item')]),record('new',[item('new-item')])]};
  const tree=f.render();assert.equal(history(tree).props.value,'old');assert.match(text(historyArea(tree)),/old-item · 门声/);assert.doesNotMatch(text(tree),/new-item · 门声/);assert.equal(checks(tree)[0].props.checked,true);assert.equal(button(tree,'本次结果').props['aria-pressed'],false);assert.equal(cards(tree).length,1);
  assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('缺分析回执不猜最新记录；关闭后迟到回执不修改组件状态',async()=>{
  const f=await setup([record('old'),record('last')]);history(openHistory(f)).props.onChange('old');
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');f.runtime.receipt=async()=>({result:{},outcome:'processing'});
  button(f.render(),'分析声音建议').props.onClick();await tick();const tree=f.render();assert.equal(history(tree).props.value,'old');assert.match(text(nodes(tree).find(node=>node.props.role==='alert')),/未取得这次分析的记录/);assert.equal(f.calls.operations.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,0);
  const closed=await setup([record('old')]);nodes(closed.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');let finish;
  closed.runtime.receipt=()=>new Promise(resolve=>{finish=resolve;});button(closed.render(),'分析声音建议').props.onClick();await tick();closed.unmount();const writes=closed.calls.stateWrites.length;
  finish({result:{analysis:{id:'new'}},outcome:'processing'});await tick();assert.equal(closed.calls.stateWrites.length,writes);assert.equal(closed.calls.operations.length,1);assert.equal(closed.calls.api.length,0);
});

test('两视图按钮让历史选择与内容同区；返回本次恢复最新并清旧选择，零请求',async()=>{
  const old=record('old',[item('old-item')]),latest=record('latest',[item('latest-item')]),f=await setup([old,latest]);
  let tree=f.render();assert.deepEqual(views(tree).map(node=>[text(node),node.props['aria-pressed']]),[['本次结果',true],['历史建议 · 2',false]]);assert.equal(history(tree),undefined);assert.match(text(tree),/latest-item · 门声/);assert.equal(cards(tree).length,1);
  tree=openHistory(f);assert.deepEqual(views(tree).map(node=>node.props['aria-pressed']),[false,true]);assert.equal(history(tree).props.value,'latest');assert.equal(cards(historyArea(tree)).length,1);assert.equal(cards(tree).length,1,'同一结果不重复挂载到主区');
  history(tree).props.onChange('old');tree=f.render();const content=text(historyArea(tree));assert.match(content,/old-item · 门声/);assert.match(content,/门被推开/);assert.match(content,/他推开门/);assert.match(content,/第 1 句期间/);assert.doesNotMatch(text(tree),/latest-item · 门声/);assert.equal(cards(tree).length,1);
  checks(tree)[0].props.onChange({target:{checked:true}});assert.equal(button(f.render(),'重新加入选中的 1 个声音').props.disabled,false);
  button(f.render(),'本次结果').props.onClick();tree=f.render();assert.equal(history(tree),undefined);assert.match(text(tree),/latest-item · 门声/);assert.doesNotMatch(text(tree),/old-item · 门声/);assert.equal(checks(tree)[0].props.checked,false);assert.equal(button(tree,'本次结果').props['aria-pressed'],true);
  tree=openHistory(f);assert.equal(history(tree).props.value,'latest');assert.equal(cards(historyArea(tree)).length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('历史过期未采用及曾加入后移除或留草稿均可主动重新加入，精确源版本且零模型请求',async()=>{
  for(const status of ['ready','applied','partial'])for(const state of [null,'removed','draft']){
    const chosen=item('old-item'),old={...record('old',[chosen]),draftVersion:7,revision:1,contextRevision:1,unitRevision:1,status},f=await setup([old,record('latest',[item('latest-item')])]);
    f.props.chapter.events=state?[{...chosen,id:'old-event',unitId:'unit',state,validity:'valid',evidence:{kind:'创作建议',suggestionId:'old',itemId:chosen.id}}]:[];
    history(openHistory(f)).props.onChange('old');let tree=f.render(),content=text(historyArea(tree));assert.match(content,/old-item · 门声/);assert.match(content,/门被推开/);assert.equal(checks(tree)[0].props.disabled,false);assert.equal(button(tree,'重新加入选中的 0 个声音').props.disabled,true);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
    checks(tree)[0].props.onChange({target:{checked:true}});button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();tree=f.render();
    assert.deepEqual(f.calls.api,[['/analysis/reuse',{id:'old',draftVersion:7,chapterId:'chapter',revision:3,unitId:'unit',unitRevision:2,selected:['old-item']}]]);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,1);assert.equal(checks(tree)[0].props.checked,false);assert.equal(history(tree).props.value,'old');assert.match(text(tree),/已重新加入 1 个声音，没有模型请求或费用。/);
    if(state)assert.equal(f.props.chapter.events[0].state,state,'测试请求不会改写历史原事件');else assert.equal(f.props.chapter.events.length,0);
  }
});

test('当前已在场景的实际声音定义防重复，跨建议来源仍判同声；需核对和不同定义可重新加入',async()=>{
  const known=item('known'),other={...item('other'),description:known.description,position:'after'},old={...record('old',[known,other]),status:'applied',revision:1};
  for(const validity of ['valid','needsReview']){
    const f=await setup([old]);f.props.chapter.events=[{...known,id:'existing',unitId:'unit',state:'adopted',validity,evidence:{kind:'创作建议',suggestionId:'another-source',itemId:'other-source-item'}}];
    let tree=openHistory(f);assert.equal(checks(tree)[0].props.disabled,validity==='valid');assert.equal(checks(tree)[1].props.disabled,false,'位置不同不会被定义去重');
    if(validity==='valid'){assert.match(text(cards(tree)[0]),/已在(?:当前)?场景/);assert.equal(checks(tree)[0].props.checked,false);}
    checks(tree)[1].props.onChange({target:{checked:true}});button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.deepEqual(f.calls.api[0][1].selected,['other']);assert.equal(f.calls.api[0][0],'/analysis/reuse');assert.equal(f.calls.operations.length,0);
  }
  const f=await setup([record('current',[known])]);f.props.chapter.events=[{...known,id:'existing',unitId:'unit',state:'adopted',validity:'valid',evidence:{kind:'创作建议'}}];
  const tree=f.render();assert.equal(checks(tree)[0].props.disabled,true);assert.match(text(cards(tree)[0]),/已在(?:当前)?场景/);assert.equal(button(tree,'加入选中的 0 个声音').props.disabled,true);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  f.props.chapter.events[0].unitId='different-unit';assert.equal(checks(f.render())[0].props.disabled,false,'其他单元的同定义声音不算当前已加入');assert.equal(checks(openHistory(f))[0].props.disabled,false);assert.doesNotMatch(text(cards(f.render())[0]),/已在当前场景/);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  const range={...item('range'),kind:'environment',startMemberId:'line',endMemberId:'line'},ranged=await setup([{...record('old',[range]),status:'applied'}]);
  ranged.props.chapter.events=[{...range,id:'range-event',unitId:'unit',state:'adopted',validity:'valid',startPosition:'before',endPosition:'after',evidence:{kind:'创作建议'}}];
  assert.equal(checks(openHistory(ranged))[0].props.disabled,true,'省略持续范围位置与 before/after 默认定义相同');ranged.props.chapter.events[0].endPosition='during';assert.equal(checks(ranged.render())[0].props.disabled,false,'不同持续范围仍可选择');assert.equal(ranged.calls.api.length,0);assert.equal(ranged.calls.operations.length,0);
  const skipped=await setup([old]);checks(openHistory(skipped))[1].props.onChange({target:{checked:true}});skipped.runtime.apply=async()=>({addedEventIds:[],skippedItemIds:['other']});
  button(skipped.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.match(text(skipped.render()),/所选声音已在当前场景，没有重复加入/);assert.equal(checks(skipped.render())[1].props.checked,false);assert.equal(skipped.calls.refresh,1);assert.equal(skipped.calls.api[0][0],'/analysis/reuse');assert.equal(skipped.calls.operations.length,0);
});

test('历史复用只放开合法条目，缺失成员、非法位置与问题建议仍禁选，本次版本守卫不放宽',async()=>{
  const invalid=[{memberId:'missing'},{startMemberId:'missing'},{endMemberId:'missing'},{position:'beside'},{startMemberId:'line',startPosition:'beside'},{endMemberId:'line',endPosition:'beside'},{startMemberId:'line',endMemberId:'line',startPosition:'after',endPosition:'before'},{issues:['位置需要核对']}];
  for(const historyView of [false,true]){
    const f=await setup([record('source',[item('valid'),...invalid.map((change,i)=>({...item('invalid-'+i),...change}))])]),tree=historyView?openHistory(f):f.render();
    assert.equal(checks(tree)[0].props.disabled,false);assert.ok(checks(tree).slice(1).every(check=>check.props.disabled===true));assert.match(text(tree),/位置需要核对/);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  }
  for(const status of ['running','failed','unknown']){
    const f=await setup([{...record('source',[item()]),status}]),tree=openHistory(f);assert.equal(checks(tree)[0].props.disabled,true);assert.equal(button(tree,'重新加入选中的 0 个声音'),undefined);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  }
});

test('历史复用等待保存并采用已确认的新版本；保存失败或旧基准不发送请求',async()=>{
  const f=await setup([{...record('old',[item()]),revision:1,status:'applied'}]),order=[];let finish;
  history(openHistory(f)).props.onChange('old');checks(f.render())[0].props.onChange({target:{checked:true}});
  f.runtime.save=async next=>{order.push('save');await new Promise(resolve=>{finish=resolve;});order.push('saved');return next();};
  f.props.savedBase=async()=>{order.push('base');return {revision:5,entityRevision:4};};f.runtime.scopeRevision=5;
  f.runtime.apply=async()=>{order.push('reuse');return {addedEventIds:['event'],skippedItemIds:[]};};
  button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.deepEqual(order,['save']);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  finish();await tick();assert.deepEqual(order,['save','saved','base','reuse']);assert.deepEqual(f.calls.api[0],['/analysis/reuse',{id:'old',draftVersion:1,chapterId:'chapter',revision:5,unitId:'unit',unitRevision:4,selected:['item']}]);assert.deepEqual(f.calls.saves[0],['chapter:chapter',['unit:unit/scene','events:unit','segment:line']]);assert.equal(f.calls.operations.length,0);
  for(const failure of ['save','basis']){
    const blocked=await setup([{...record('old',[item()]),revision:1,status:'applied'}]);checks(openHistory(blocked))[0].props.onChange({target:{checked:true}});
    if(failure==='save')blocked.runtime.save=async()=>{throw new Error('草稿保存失败，请核对');};
    else{blocked.props.savedBase=async()=>({revision:2,entityRevision:1});blocked.runtime.scopeRevision=3;}
    button(blocked.render(),'重新加入选中的 1 个声音').props.onClick();await tick();const tree=blocked.render(),area=nodes(tree).find(node=>node.props.className==='scene-analysis-apply'),alert=nodes(tree).find(node=>node.props.role==='alert');
    assert.ok(nodes(area).includes(alert));assert.match(text(alert),failure==='save'?/草稿保存失败/:/变化|改变|核对/);assert.equal(checks(tree)[0].props.checked,true);assert.equal(blocked.calls.api.length,0);assert.equal(blocked.calls.operations.length,0);assert.equal(blocked.calls.refresh,0);
  }
});

test('历史重新加入有准确进度与就地失败，保留选中且不触发分析或声音',async()=>{
  const f=await setup([{...record('old',[item('chosen'),item('later')]),revision:1,status:'applied'}]);let fail;
  checks(openHistory(f))[0].props.onChange({target:{checked:true}});f.runtime.apply=()=>new Promise((_resolve,reject)=>{fail=reject;});
  button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();let tree=f.render();const pending=button(tree,'正在重新加入…');assert.equal(pending.props.disabled,true);assert.equal(pending.props['aria-busy'],true);assert.ok(checks(tree).every(check=>check.props.disabled));assert.ok(views(tree).every(view=>view.props.disabled===true));assert.equal(history(tree).props.disabled,true);assert.equal(button(tree,'正在分析…'),undefined);assert.equal(f.calls.operations.length,0);
  fail(new Error('成员已改变，请重新核对'));await tick();tree=f.render();const area=nodes(tree).find(node=>node.props.className==='scene-analysis-apply'),alert=nodes(tree).find(node=>node.props.role==='alert');assert.ok(nodes(area).includes(alert));assert.match(text(alert),/成员已改变/);assert.equal(checks(tree)[0].props.checked,true);assert.equal(checks(tree)[0].props.disabled,false);assert.equal(button(tree,'重新加入选中的 1 个声音').props.disabled,false);assert.equal(f.calls.api.length,1);assert.equal(f.calls.api[0][0],'/analysis/reuse');assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('分析权限独立折叠但持续挂载，旁边保留一次文本请求与实际授权状态',async()=>{
  const f=await setup(),tree=f.render(),permissions=nodes(tree).find(node=>node.type==='details'&&nodes(node).some(child=>child.type==='summary'&&text(child)==='分析权限与模型'));
  assert.ok(permissions);assert.equal(!!permissions.props.open,false);assert.match(text(tree),/先允许 · 本次 1 次文本请求/);assert.equal(button(tree,'分析声音建议').props.disabled,true);
  const authorization=nodes(permissions).find(node=>node.type==='TaskAuthorization');assert.ok(authorization);assert.equal(authorization.props.model,'fixture');assert.deepEqual(authorization.props.steps,['scene']);
  authorization.props.onReady('grant');const allowed=f.render();assert.match(text(allowed),/已允许 · 本次 1 次文本请求/);assert.equal(button(allowed,'分析声音建议').props.disabled,false);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('加入期间明确显示正在加入并锁住勾选；失败留在加入行，保留原选择且不发分析',async()=>{
  const f=await setup([record('other',[item('other-item')]),record('ready',[item('chosen'),item('later')])]);let fail;
  f.runtime.apply=()=>new Promise((_resolve,reject)=>{fail=reject;});nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  assert.equal(button(f.render(),'分析声音建议').props.disabled,false);checks(f.render())[0].props.onChange({target:{checked:true}});
  button(f.render(),'加入选中的 1 个声音').props.onClick();let tree=f.render();
  const applying=button(tree,'正在加入…'),analyze=button(tree,'分析声音建议');assert.equal(applying.props.disabled,true);assert.equal(applying.props['aria-busy'],true);assert.equal(analyze.props.disabled,true);assert.equal(analyze.props['aria-busy'],false);assert.equal(button(tree,'正在分析…'),undefined);
  assert.ok(checks(tree).every(check=>check.props.disabled===true));assert.ok(views(tree).every(view=>view.props.disabled===true));assert.equal(checks(tree)[0].props.checked,true);assert.equal(f.calls.operations.length,0);assert.deepEqual(f.calls.api[0][1].selected,['chosen']);
  fail(new Error('当前声音背景已改变，请重新核对'));await tick();tree=f.render();
  const alert=nodes(tree).find(node=>node.props.role==='alert'),area=nodes(tree).find(node=>node.props.className==='scene-analysis-apply');assert.ok(nodes(area).includes(alert));assert.match(text(alert),/当前声音背景已改变，请重新核对/);assert.equal(nodes(tree).filter(node=>node.props.role==='alert').length,1);
  assert.equal(checks(tree)[0].props.checked,true);assert.equal(checks(tree)[1].props.checked,false);assert.equal(checks(tree)[0].props.disabled,false);assert.equal(button(tree,'分析声音建议').props.disabled,false);assert.equal(f.calls.api.length,1);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
  history(openHistory(f)).props.onChange('other');assert.ok(!nodes(f.render()).some(node=>node.props.role==='alert'),'换记录清除上一份加入错误');assert.equal(f.calls.api.length,1);
});

test('重复点击当前本次视图保持勾选与精确回执；历史入口不自动改到列表末项',async()=>{
  const old=record('old'),fresh=record('new',[item('receipt-item')]),f=await setup([old]);
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');f.props.refresh=async()=>{f.calls.refresh++;f.props.chapter.suggestions=[old,fresh,record('different-last',[item('wrong-item')])];};
  button(f.render(),'分析声音建议').props.onClick();await tick();checks(f.render())[0].props.onChange({target:{checked:true}});
  let tree=f.render();assert.equal(button(tree,'本次结果').props['aria-pressed'],true);assert.match(text(tree),/receipt-item · 门声/);const writes=f.calls.stateWrites.length;
  button(tree,'本次结果').props.onClick();tree=f.render();assert.equal(f.calls.stateWrites.length,writes);assert.equal(checks(tree)[0].props.checked,true);assert.match(text(tree),/receipt-item · 门声/);assert.doesNotMatch(text(tree),/wrong-item · 门声/);
  tree=openHistory(f);assert.equal(history(tree).props.value,'new');assert.equal(checks(tree)[0].props.checked,true);assert.match(text(historyArea(tree)),/receipt-item · 门声/);assert.equal(f.calls.operations.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,1);
});
