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
const openHistory=async f=>{const tree=f.render();views(tree).find(node=>text(node).startsWith('历史建议 · ')).props.onClick();f.render();await tick();return f.render();};
const chooseHistory=async(f,id)=>{history(await openHistory(f)).props.onChange(id);f.render();await tick();return f.render();};
const historyArea=tree=>nodes(tree).filter(node=>node.type==='section'&&nodes(node).includes(history(tree))).at(-1);
const checks=tree=>nodes(tree).filter(node=>node.type==='input'&&node.props.type==='checkbox');
const cards=tree=>nodes(tree).filter(node=>node.props.className==='task-event-card');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const item=(id='item')=>({id,description:id+' · 门声',kind:'effect',memberId:'line',position:'during',evidence:'创作建议',reason:'门被推开',sourceQuote:'他推开门。'});
const record=(id='record',items=[])=>({id,kind:'scene',unitId:'unit',unitRevision:2,revision:3,contextRevision:4,draftVersion:1,status:'ready',model:'fixture',items});
const mockCurrentIssues=(i,u)=>{const positions=['before','during','after'];const ranged=i.startMemberId!==undefined||i.endMemberId!==undefined,start=u.members.indexOf(i.startMemberId),end=u.members.indexOf(i.endMemberId),from=positions.indexOf(i.startPosition||'before'),to=positions.indexOf(i.endPosition||'after');return [...(i.issues||[]),...(!u.members.includes(i.memberId)||!positions.includes(i.position)||ranged&&(start<0||end<start||from<0||to<0||start===end&&from>to)?['当前成员或范围无效']:[])];};
let sequence=0;

async function setup(records=[record()]){
  let index=0,effectIndex=0,pendingEffects=[];const hooks=[],effects=[],calls={api:[],previews:[],operations:[],refresh:0,stateWrites:[],saves:[]};
  const runtime={React:{createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'},
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{calls.stateWrites.push(key);hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    useRef:initial=>hooks[index++]||={current:initial},
    useEffect:(callback,deps)=>{const key=effectIndex++;if(!effects[key]||deps.some((value,i)=>value!==effects[key].deps[i]))pendingEffects.push(()=>{effects[key]?.cleanup?.();effects[key]={deps,cleanup:callback()};});},
    Select:'Select',TaskAuthorization:'TaskAuthorization',
    api:async(...args)=>{if(args[0].startsWith('/analysis/reuse-preview?')){calls.previews.push(args);return runtime.preview(...args);}calls.api.push(args);assert.ok(['/analysis/apply','/analysis/reuse'].includes(args[0]));return runtime.apply(...args);},preview:async path=>{const query=new URLSearchParams(path.split('?')[1]),source=props.chapter.suggestions.find(r=>r.id===query.get('id'));return {id:source.id,draftVersion:source.draftVersion,target:{chapterRevision:props.chapter.revision,unitRevision:props.unit.revision,contextRevision:props.contextRevision,sceneRevision:1,sourceVersion:1},items:source.items.map(i=>({itemId:i.id,historicalIssues:i.issues||[],currentIssues:mockCurrentIssues(i,props.unit),warnings:[],canReuse:!mockCurrentIssues(i,props.unit).length,alreadyIncluded:false}))};},apply:async()=>({addedEventIds:['added-event'],skippedItemIds:[]}),
    withSavedDrafts:async(scope,dependencies,next)=>{calls.saves.push([scope,dependencies]);return runtime.save(next);},save:async next=>next(),draftScopeRevision:(_scope,revision)=>runtime.scopeRevision??revision,
    submitOperation:async(...args)=>{calls.operations.push(args);return runtime.receipt(...args);},receipt:async()=>({result:{analysis:{id:'new'}},outcome:'processing'})};
  globalThis.sceneSuggestionsTest=runtime;
  const header='const {React,useState,useRef,useEffect,Select,TaskAuthorization,api,withSavedDrafts,draftScopeRevision,submitOperation}=globalThis.sceneSuggestionsTest;\n';
  const {default:SceneSuggestions}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n// fixture '+sequence++).toString('base64'));
  const props={unit:{id:'unit',revision:2,members:['line'],variants:{scene:{revision:1,backgroundPresence:'subtle',guidance:''}}},chapter:{id:'chapter',projectId:'project',revision:3,segments:[{id:'line',order:0,text:'他推开门。'}],events:[],suggestions:records},contextRevision:4,model:'fixture',enabled:true,refresh:async()=>{calls.refresh++;}};
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
  const f=await setup([old,later]);let tree=await openHistory(f);history(tree).props.onChange('old');checks(f.render())[0].props.onChange({target:{checked:true}});
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');
  f.props.refresh=async()=>{f.calls.refresh++;f.props.chapter.suggestions=[old,later,fresh,record('different-last',[item('wrong-item')])];};
  button(f.render(),'分析声音建议').props.onClick();await tick();tree=f.render();
  assert.equal(button(tree,'本次结果').props['aria-pressed'],true);assert.equal(history(tree),undefined);assert.equal(cards(tree).length,1);assert.match(text(tree),/new-item · 门声/);assert.doesNotMatch(text(tree),/old-item · 门声|wrong-item · 门声/);assert.equal(checks(tree)[0].props.checked,false);
  const shown=await openHistory(f);assert.equal(history(shown).props.value,'new');assert.match(text(historyArea(shown)),/new-item · 门声/);assert.equal(cards(shown).length,1);assert.equal(f.calls.operations.length,1,'切历史不会重发分析或换到列表末项');
  assert.equal(f.calls.operations.length,1);assert.deepEqual(f.calls.operations[0],['scene-analysis:unit',{kind:'prepareChapter',analysisKind:'scene',sceneEnabled:true,chapterId:'chapter',revision:3,unitId:'unit',unitRevision:2,model:'fixture',grantId:'grant'}]);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,1);
});

test('普通刷新增加新记录仍保留明确查看的旧历史与选择，零分析或采用',async()=>{
  const old=record('old',[item('old-item')]),f=await setup([old,record('later',[item('later-item')])]);
  await chooseHistory(f,'old');checks(f.render())[0].props.onChange({target:{checked:true}});
  f.props.chapter={...f.props.chapter,suggestions:[old,record('later',[item('later-item')]),record('new',[item('new-item')])]};
  const tree=f.render();assert.equal(history(tree).props.value,'old');assert.match(text(historyArea(tree)),/old-item · 门声/);assert.doesNotMatch(text(tree),/new-item · 门声/);assert.equal(checks(tree)[0].props.checked,true);assert.equal(button(tree,'本次结果').props['aria-pressed'],false);assert.equal(cards(tree).length,1);
  assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('缺分析回执不猜最新记录；关闭后迟到回执不修改组件状态',async()=>{
  const f=await setup([record('old'),record('last')]);history(await openHistory(f)).props.onChange('old');
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');f.runtime.receipt=async()=>({result:{},outcome:'processing'});
  button(f.render(),'分析声音建议').props.onClick();await tick();const tree=f.render();assert.equal(history(tree).props.value,'old');assert.match(text(nodes(tree).find(node=>node.props.role==='alert')),/未取得这次分析的记录/);assert.equal(f.calls.operations.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,0);
  const closed=await setup([record('old')]);nodes(closed.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');let finish;
  closed.runtime.receipt=()=>new Promise(resolve=>{finish=resolve;});button(closed.render(),'分析声音建议').props.onClick();await tick();closed.unmount();const writes=closed.calls.stateWrites.length;
  finish({result:{analysis:{id:'new'}},outcome:'processing'});await tick();assert.equal(closed.calls.stateWrites.length,writes);assert.equal(closed.calls.operations.length,1);assert.equal(closed.calls.api.length,0);
});

test('两视图按钮让历史选择与内容同区；返回本次恢复最新并清旧选择，零请求',async()=>{
  const old=record('old',[item('old-item')]),latest=record('latest',[item('latest-item')]),f=await setup([old,latest]);
  let tree=f.render();assert.deepEqual(views(tree).map(node=>[text(node),node.props['aria-pressed']]),[['本次结果',true],['历史建议 · 2',false]]);assert.equal(history(tree),undefined);assert.match(text(tree),/latest-item · 门声/);assert.equal(cards(tree).length,1);
  tree=await openHistory(f);assert.deepEqual(views(tree).map(node=>node.props['aria-pressed']),[false,true]);assert.equal(history(tree).props.value,'latest');assert.equal(cards(historyArea(tree)).length,1);assert.equal(cards(tree).length,1,'同一结果不重复挂载到主区');
  tree=await chooseHistory(f,'old');const content=text(historyArea(tree));assert.match(content,/old-item · 门声/);assert.match(content,/门被推开/);assert.match(content,/他推开门/);assert.match(content,/第 1 句期间/);assert.doesNotMatch(text(tree),/latest-item · 门声/);assert.equal(cards(tree).length,1);
  checks(tree)[0].props.onChange({target:{checked:true}});assert.equal(button(f.render(),'重新加入选中的 1 个声音').props.disabled,false);
  button(f.render(),'本次结果').props.onClick();tree=f.render();assert.equal(history(tree),undefined);assert.match(text(tree),/latest-item · 门声/);assert.doesNotMatch(text(tree),/old-item · 门声/);assert.equal(checks(tree)[0].props.checked,false);assert.equal(button(tree,'本次结果').props['aria-pressed'],true);
  tree=await openHistory(f);assert.equal(history(tree).props.value,'latest');assert.equal(cards(historyArea(tree)).length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
});

test('历史过期未采用及曾加入后移除或留草稿均可主动重新加入，精确源版本且零模型请求',async()=>{
  for(const status of ['ready','applied','partial'])for(const state of [null,'removed','draft']){
    const chosen=item('old-item'),old={...record('old',[chosen]),draftVersion:7,revision:1,contextRevision:1,unitRevision:1,status},f=await setup([old,record('latest',[item('latest-item')])]);
    f.props.chapter.events=state?[{...chosen,id:'old-event',unitId:'unit',state,validity:'valid',evidence:{kind:'创作建议',suggestionId:'old',itemId:chosen.id}}]:[];
    let tree=await chooseHistory(f,'old'),content=text(historyArea(tree));assert.match(content,/old-item · 门声/);assert.match(content,/门被推开/);assert.equal(checks(tree)[0].props.disabled,false);assert.equal(button(tree,'重新加入选中的 0 个声音').props.disabled,true);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
    checks(tree)[0].props.onChange({target:{checked:true}});button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();tree=f.render();
    assert.deepEqual(f.calls.api,[['/analysis/reuse',{id:'old',draftVersion:7,chapterId:'chapter',revision:3,unitId:'unit',unitRevision:2,selected:['old-item'],contextRevision:4}]]);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,1);assert.equal(checks(tree)[0].props.checked,false);assert.equal(history(tree).props.value,'old');assert.match(text(tree),/已重新加入 1 个声音，没有模型请求或费用。/);
    if(state)assert.equal(f.props.chapter.events[0].state,state,'测试请求不会改写历史原事件');else assert.equal(f.props.chapter.events.length,0);
  }
});

test('当前已在场景的实际声音定义防重复，跨建议来源仍判同声；需核对和不同定义可重新加入',async()=>{
  const known=item('known'),other={...item('other'),description:known.description,position:'after'},old={...record('old',[known,other]),status:'applied',revision:1};
  for(const validity of ['valid','needsReview']){
    const f=await setup([old]);f.props.chapter.events=[{...known,id:'existing',unitId:'unit',state:'adopted',validity,evidence:{kind:'创作建议',suggestionId:'another-source',itemId:'other-source-item'}}];
    let tree=await openHistory(f);assert.equal(checks(tree)[0].props.disabled,validity==='valid');assert.equal(checks(tree)[1].props.disabled,false,'位置不同不会被定义去重');
    if(validity==='valid'){assert.match(text(cards(tree)[0]),/已在(?:当前)?场景/);assert.equal(checks(tree)[0].props.checked,false);}
    checks(tree)[1].props.onChange({target:{checked:true}});button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.deepEqual(f.calls.api[0][1].selected,['other']);assert.equal(f.calls.api[0][0],'/analysis/reuse');assert.equal(f.calls.operations.length,0);
  }
  const f=await setup([record('current',[known])]);f.props.chapter.events=[{...known,id:'existing',unitId:'unit',state:'adopted',validity:'valid',evidence:{kind:'创作建议'}}];
  const tree=f.render();assert.equal(checks(tree)[0].props.disabled,true);assert.match(text(cards(tree)[0]),/已在(?:当前)?场景/);assert.equal(button(tree,'加入选中的 0 个声音').props.disabled,true);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  f.props.chapter.events[0].unitId='different-unit';assert.equal(checks(f.render())[0].props.disabled,false,'其他单元的同定义声音不算当前已加入');assert.equal(checks(await openHistory(f))[0].props.disabled,false);assert.doesNotMatch(text(cards(f.render())[0]),/已在当前场景/);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  const range={...item('range'),kind:'environment',startMemberId:'line',endMemberId:'line'},ranged=await setup([{...record('old',[range]),status:'applied'}]);
  ranged.props.chapter.events=[{...range,id:'range-event',unitId:'unit',state:'adopted',validity:'valid',startPosition:'before',endPosition:'after',evidence:{kind:'创作建议'}}];
  assert.equal(checks(await openHistory(ranged))[0].props.disabled,true,'省略持续范围位置与 before/after 默认定义相同');ranged.props.chapter.events[0].endPosition='during';assert.equal(checks(ranged.render())[0].props.disabled,false,'不同持续范围仍可选择');assert.equal(ranged.calls.api.length,0);assert.equal(ranged.calls.operations.length,0);
  const skipped=await setup([old]);checks(await openHistory(skipped))[1].props.onChange({target:{checked:true}});skipped.runtime.apply=async()=>({addedEventIds:[],skippedItemIds:['other']});
  button(skipped.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.match(text(skipped.render()),/所选声音已在当前场景，没有重复加入/);assert.equal(checks(skipped.render())[1].props.checked,false);assert.equal(skipped.calls.refresh,1);assert.equal(skipped.calls.api[0][0],'/analysis/reuse');assert.equal(skipped.calls.operations.length,0);
});

test('历史复用只放开合法条目，缺失成员、非法位置与问题建议仍禁选，本次版本守卫不放宽',async()=>{
  const invalid=[{memberId:'missing'},{startMemberId:'missing'},{endMemberId:'missing'},{position:'beside'},{startMemberId:'line',startPosition:'beside'},{endMemberId:'line',endPosition:'beside'},{startMemberId:'line',endMemberId:'line',startPosition:'after',endPosition:'before'},{issues:['位置需要核对']}];
  for(const historyView of [false,true]){
    const f=await setup([record('source',[item('valid'),...invalid.map((change,i)=>({...item('invalid-'+i),...change}))])]),tree=historyView?await openHistory(f):f.render();
    assert.equal(checks(tree)[0].props.disabled,false);assert.ok(checks(tree).slice(1).every(check=>check.props.disabled===true));assert.match(text(tree),/位置需要核对/);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  }
  for(const status of ['running','failed','unknown']){
    const f=await setup([{...record('source',[item()]),status}]),tree=await openHistory(f);assert.equal(checks(tree)[0].props.disabled,true);assert.equal(button(tree,'重新加入选中的 0 个声音'),undefined);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  }
});

test('历史复用等待保存并采用预检已确认的版本；保存失败或旧基准不发送请求',async()=>{
  const f=await setup([{...record('old',[item()]),revision:1,status:'applied'}]),order=[];let finish;
  f.props.chapter.revision=5;f.props.unit.revision=4;await chooseHistory(f,'old');checks(f.render())[0].props.onChange({target:{checked:true}});
  f.runtime.save=async next=>{order.push('save');await new Promise(resolve=>{finish=resolve;});order.push('saved');return next();};
  f.props.savedBase=async()=>{order.push('base');return {revision:5,entityRevision:4};};f.runtime.scopeRevision=5;
  f.runtime.apply=async()=>{order.push('reuse');return {addedEventIds:['event'],skippedItemIds:[]};};
  button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();assert.deepEqual(order,['save']);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  finish();await tick();assert.deepEqual(order,['save','saved','base','reuse']);assert.deepEqual(f.calls.api[0],['/analysis/reuse',{id:'old',draftVersion:1,chapterId:'chapter',revision:5,unitId:'unit',unitRevision:4,selected:['item'],contextRevision:4}]);assert.deepEqual(f.calls.saves[0],['chapter:chapter',['unit:unit/scene','events:unit','segment:line']]);assert.equal(f.calls.operations.length,0);
  for(const failure of ['save','basis']){
    const blocked=await setup([{...record('old',[item()]),revision:1,status:'applied'}]);checks(await openHistory(blocked))[0].props.onChange({target:{checked:true}});
    if(failure==='save')blocked.runtime.save=async()=>{throw new Error('草稿保存失败，请核对');};
    else{blocked.props.savedBase=async()=>({revision:2,entityRevision:1});blocked.runtime.scopeRevision=3;}
    button(blocked.render(),'重新加入选中的 1 个声音').props.onClick();await tick();const tree=blocked.render(),area=nodes(tree).find(node=>node.props.className==='scene-analysis-apply'),alert=nodes(tree).find(node=>node.props.role==='alert');
    assert.ok(nodes(area).includes(alert));assert.match(text(alert),failure==='save'?/草稿保存失败/:/变化|改变|核对/);assert.equal(checks(tree)[0].props.checked,true);assert.equal(blocked.calls.api.length,0);assert.equal(blocked.calls.operations.length,0);assert.equal(blocked.calls.refresh,0);
  }
});

test('历史重新加入有准确进度与就地失败，保留选中且不触发分析或声音',async()=>{
  const f=await setup([{...record('old',[item('chosen'),item('later')]),revision:1,status:'applied'}]);let fail;
  checks(await openHistory(f))[0].props.onChange({target:{checked:true}});f.runtime.apply=()=>new Promise((_resolve,reject)=>{fail=reject;});
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
  await chooseHistory(f,'other');assert.ok(!nodes(f.render()).some(node=>node.props.role==='alert'),'换记录清除上一份加入错误');assert.equal(f.calls.api.length,1);
});

test('重复点击当前本次视图保持勾选与精确回执；历史入口不自动改到列表末项',async()=>{
  const old=record('old'),fresh=record('new',[item('receipt-item')]),f=await setup([old]);
  nodes(f.render()).find(node=>node.type==='TaskAuthorization').props.onReady('grant');f.props.refresh=async()=>{f.calls.refresh++;f.props.chapter.suggestions=[old,fresh,record('different-last',[item('wrong-item')])];};
  button(f.render(),'分析声音建议').props.onClick();await tick();checks(f.render())[0].props.onChange({target:{checked:true}});
  let tree=f.render();assert.equal(button(tree,'本次结果').props['aria-pressed'],true);assert.match(text(tree),/receipt-item · 门声/);const writes=f.calls.stateWrites.length;
  button(tree,'本次结果').props.onClick();tree=f.render();assert.equal(f.calls.stateWrites.length,writes);assert.equal(checks(tree)[0].props.checked,true);assert.match(text(tree),/receipt-item · 门声/);assert.doesNotMatch(text(tree),/wrong-item · 门声/);
  tree=await openHistory(f);assert.equal(history(tree).props.value,'new');assert.equal(checks(tree)[0].props.checked,true);assert.match(text(historyArea(tree)),/receipt-item · 门声/);assert.equal(f.calls.operations.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.refresh,1);
});

test('H01历史旧问题与当前资格分离，免费后端核对允许选择并保留旧问题说明',async()=>{
  const old={...record('old',[{...item('music'),kind:'music',description:'极微弱，几乎不可闻的音乐',issues:['旧clear存在感冲突']}]),revision:1,status:'partial'},f=await setup([old]);
  f.runtime.preview=async()=>({id:'old',draftVersion:1,target:{chapterRevision:3,unitRevision:2,contextRevision:4},items:[{itemId:'music',historicalIssues:['旧clear存在感冲突'],currentIssues:[],warnings:[],canReuse:true,alreadyIncluded:false}]});
  let tree=await openHistory(f);
  assert.equal(checks(tree)[0].props.disabled,false,'当前subtle后端预检通过，旧问题不能继续阻断');
  assert.equal(f.calls.previews.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.match(text(cards(tree)[0]),/旧clear存在感冲突/);
  assert.ok(nodes(cards(tree)[0]).some(node=>node.type==='details'&&text(node).includes('旧clear存在感冲突')),'旧问题保留为折叠说明');
});

test('H01当前冲突和不确定提醒消费后端结果，仅无效项禁选，免费核对不锁其他操作',async()=>{
  const f=await setup([{...record('old',[item('invalid'),item('valid')]),revision:1,status:'partial'}]);let finish;
  f.runtime.preview=()=>new Promise(resolve=>{finish=resolve;});views(f.render())[1].props.onClick();let tree=f.render();
  assert.ok(checks(tree).every(i=>i.props.disabled));assert.match(text(tree),/正在免费核对当前场景/);assert.ok(views(tree).every(i=>!i.props.disabled));assert.equal(history(tree).props.disabled,false);
  nodes(tree).find(node=>node.type==='TaskAuthorization').props.onReady('grant');assert.equal(button(f.render(),'分析声音建议').props.disabled,false,'免费预检pending不冒充付费分析pending');
  finish({id:'old',draftVersion:1,target:{chapterRevision:3,unitRevision:2,contextRevision:4},items:[{itemId:'invalid',historicalIssues:[],currentIssues:['当前clear与背景全程不可闻冲突'],warnings:[],canReuse:false,alreadyIncluded:false},{itemId:'valid',historicalIssues:[],currentIssues:[],warnings:['对象尚不明确，请核对'],canReuse:true,alreadyIncluded:false}]});await tick();tree=f.render();
  assert.equal(checks(tree)[0].props.disabled,true);assert.equal(checks(tree)[1].props.disabled,false);assert.match(text(cards(tree)[0]),/当前clear与背景全程不可闻冲突.*核对/);assert.match(text(cards(tree)[1]),/对象尚不明确/);assert.equal(f.calls.previews.length,1);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
});

test('H01当前presence、指导、成员及原文版本变化撤销旧资格并免费重验，旧回执不能覆盖',async()=>{
  for(const field of ['presence','guidance','member','source']){
    const f=await setup([{...record('old',[item()]),revision:1,status:'applied'}]);let finish;
    await openHistory(f);checks(f.render())[0].props.onChange({target:{checked:true}});f.runtime.preview=()=>new Promise(resolve=>{finish=resolve;});
    f.props.chapter.revision++;f.props.unit.revision++;
    if(field==='presence')f.props.unit.variants.scene.backgroundPresence='clear';
    if(field==='guidance')f.props.unit.variants.scene.guidance='背景清楚可辨';
    if(field==='member')f.props.unit.members=['new-line'];
    if(field==='source')f.props.chapter.sourceVersion=2;
    let tree=f.render();assert.equal(checks(tree)[0].props.disabled,true);assert.equal(button(tree,'重新加入选中的 1 个声音').props.disabled,true);assert.match(text(tree),/正在免费核对/);
    const query=new URLSearchParams(f.calls.previews.at(-1)[0].split('?')[1]);assert.equal(query.get('revision'),'4');assert.equal(query.get('unitRevision'),'3');
    finish({id:'old',draftVersion:1,target:{chapterRevision:4,unitRevision:3,contextRevision:4},items:[{itemId:'item',historicalIssues:[],currentIssues:['当前目标已变化，请重新安排'],warnings:[],canReuse:false,alreadyIncluded:false}]});await tick();tree=f.render();
    assert.equal(checks(tree)[0].props.checked,false);assert.equal(checks(tree)[0].props.disabled,true);assert.match(text(cards(tree)[0]),/当前目标已变化/);assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);
  }
});

test('H01保存后版本推进不能沿用旧预检资格提交，也不扩大原选择',async()=>{
  const f=await setup([{...record('old',[item('chosen'),item('untouched')]),revision:1,status:'applied'}]);await openHistory(f);checks(f.render())[0].props.onChange({target:{checked:true}});
  f.props.savedBase=async()=>({revision:5,entityRevision:4});f.runtime.scopeRevision=5;
  button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();let tree=f.render();assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);assert.match(text(nodes(tree).find(i=>i.props.role==='alert')),/保存后当前场景已变化/);assert.equal(checks(tree)[1].props.checked,false);
  f.props.chapter.revision=5;f.props.unit.revision=4;f.render();await tick();tree=f.render();assert.equal(checks(tree)[0].props.disabled,false);assert.equal(checks(tree)[1].props.checked,false);
  button(tree,'重新加入选中的 1 个声音').props.onClick();await tick();assert.deepEqual(f.calls.api[0][1].selected,['chosen']);assert.equal(f.calls.api[0][1].revision,5);assert.equal(f.calls.api[0][1].unitRevision,4);assert.equal(f.calls.previews.length,3);assert.equal(f.calls.operations.length,0);
});

test('H01关闭历史、换生成目标及卸载均丢弃迟到免费预检，不能重开或覆盖新目标',async()=>{
  for(const transition of ['close','target','unmount']){
    const f=await setup([{...record('old',[item()]),revision:1,status:'applied'}]);const replies=[];
    f.runtime.preview=()=>new Promise(resolve=>replies.push(resolve));views(f.render())[1].props.onClick();f.render();assert.equal(replies.length,1);
    if(transition==='close'){button(f.render(),'本次结果').props.onClick();f.render();}
    if(transition==='target'){f.props.unit.id='next-unit';f.props.chapter.suggestions=[{...record('next',[item('next')]),unitId:'next-unit',revision:1,status:'applied'}];f.render();assert.equal(replies.length,2);}
    if(transition==='unmount')f.unmount();const writes=f.calls.stateWrites.length;
    replies[0]({id:'old',draftVersion:1,target:{chapterRevision:3,unitRevision:2,contextRevision:4},items:[{itemId:'item',historicalIssues:[],currentIssues:[],warnings:['OLD_RECEIPT_SENTINEL'],alreadyIncluded:false,canReuse:true}]});await tick();assert.equal(f.calls.stateWrites.length,writes,'旧预检不写任何新状态');
    if(transition!=='unmount'){const tree=f.render();assert.doesNotMatch(text(tree),/OLD_RECEIPT_SENTINEL/);if(transition==='close')assert.equal(history(tree),undefined);else {assert.equal(history(tree).props.value,'next');assert.equal(checks(tree)[0].props.disabled,true);}}
    assert.equal(f.calls.api.length,0);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.refresh,0);
  }
});

test('H01换目标后正式复用迟到回执也不修改新目标状态或刷新其页面',async()=>{
  const f=await setup([{...record('old',[item()]),revision:1,status:'applied'}]);await openHistory(f);checks(f.render())[0].props.onChange({target:{checked:true}});let finish;
  f.runtime.apply=()=>new Promise(resolve=>{finish=resolve;});button(f.render(),'重新加入选中的 1 个声音').props.onClick();await tick();
  f.props.unit.id='next-unit';f.props.chapter.suggestions=[{...record('next',[item('next')]),unitId:'next-unit',revision:1,status:'applied'}];f.render();await tick();const writes=f.calls.stateWrites.length;
  finish({addedEventIds:['old-event'],skippedItemIds:[]});await tick();assert.equal(f.calls.stateWrites.length,writes);assert.equal(f.calls.refresh,0);assert.equal(history(f.render()).props.value,'next');assert.equal(checks(f.render())[0].props.checked,false);assert.doesNotMatch(text(f.render()),/已重新加入 1/);assert.deepEqual(f.calls.api[0][1].selected,['item']);assert.equal(f.calls.api[0][1].unitId,'unit');assert.equal(f.calls.operations.length,0);
});
