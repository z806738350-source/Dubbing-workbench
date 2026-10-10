import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const React={Fragment:'Fragment',createElement:(type,props,...children)=>({type,props:{...props,children}})};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const words=node=>node==null||typeof node==='boolean'?'':typeof node==='object'?(node.props?.children||[]).flat(Infinity).map(words).join(''):String(node);
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&words(node)===label);
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const source=readFileSync(new URL('../src/AnalysisDialog.tsx',import.meta.url),'utf8').replace(/^import .*;\n/gm,'');
const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.React}}).outputText;
const coverage=(eligibleCount=2,coveredCount=2)=>({eligibleCount,coveredCount,missingIds:[],reviewRequiredIds:[],deletedCount:3,excludedCount:0,retiredCount:0,currentRun:{writtenIds:[],unchangedIds:[],preservedHumanIds:[],skippedChangedIds:[],repairedIds:[]},phase:'complete'});
let sequence=0;
async function fixture({rows=[],drafts=[],mode='smart',persistent=coverage(rows.length,0)}={}){
  const hooks=[],effects=[];let cursor=0,effectCursor=0,pending=[];
  const calls={api:[],grant:[],operations:[],refresh:0,saves:[]};
  const runtime={React,Field:'Field',Form:'Form',Select:'Select',TaskAuthorization:'TaskAuthorization',FidelitySummary:'FidelitySummary',AlertTriangle:'AlertTriangle',crypto,
    useState:initial=>{const index=cursor++;if(!(index in hooks))hooks[index]=typeof initial==='function'?initial():initial;return[hooks[index],next=>hooks[index]=typeof next==='function'?next(hooks[index]):next];},
    useRef:initial=>hooks[cursor++]||={current:initial},
    useEffect:(fn,deps)=>{const index=effectCursor++;if(!effects[index]||deps.some((value,i)=>value!==effects[index].deps[i]))pending.push(()=>{effects[index]?.cleanup?.();effects[index]={deps,cleanup:fn()};});},
    api:async(path,payload)=>{calls.api.push({path,payload});return runtime.read(path,payload);},read:async(path,payload)=>{if(path.endsWith('/experience'))return{policy:{mode,revision:0},grants:[],changes:[]};if(path==='/operations/plan')return{chapterId:'chapter',revision:payload.revision,kind:payload.analysisKind||'extract',memberIds:payload.ids?.length?payload.ids:rows.map(row=>row.id),textRequests:1,repairRequests:1,maxTextRequests:2};return{};},
    ensureTaskGrant:async intent=>{calls.grant.push(intent);return runtime.authorize(intent);},authorize:async()=> 'grant',
    withSavedDrafts:async(scope,ids,fn)=>{calls.saves.push({scope,ids});return fn();},draftScopeRevision:(_scope,revision)=>runtime.savedRevision??revision,
    submitOperation:async(key,payload)=>{calls.operations.push({key,payload});return{result:{analysis:{id:'started'}}};}};
  globalThis.pgUiFixture=runtime;
  const header='const {React,Field,Form,Select,TaskAuthorization,FidelitySummary,AlertTriangle,crypto,useState,useRef,useEffect,api,ensureTaskGrant,withSavedDrafts,draftScopeRevision,submitOperation}=globalThis.pgUiFixture;\n';
  const {default:AnalysisDialog}=await import('data:text/javascript;base64,'+Buffer.from(header+compiled+'\n//'+sequence++).toString('base64'));
  const props={chapter:{id:'chapter',projectId:'project',source:'她展开信纸。\n“先别开门。”',revision:4,segments:rows,suggestions:drafts,performanceCoverage:persistent},roles:[],selected:rows.map(row=>row.id),defaultModel:'fixture-text',contextRevision:1,stateJobs:[],refresh:async()=>{calls.refresh++;}};
  const render=()=>{cursor=effectCursor=0;pending=[];let tree=AnalysisDialog(props);for(const effect of pending)effect();if(pending.length){cursor=effectCursor=0;tree=AnalysisDialog(props);}return tree;};
  render();await tick();return{props,runtime,calls,render,unmount:()=>effects.forEach(effect=>effect.cleanup?.())};
}

test('新章默认smart：一次准备发起联合分析，无policy选择或独立授权前置',async()=>{
  const f=await fixture(),tree=f.render(),start=button(tree,'准备这一章');assert.ok(start);assert.equal(start.props.disabled,false);
  assert.equal(nodes(tree).filter(node=>node.type==='TaskAuthorization').length,0);
  start.props.onClick();await tick();assert.equal(f.calls.operations.length,1);assert.equal(f.calls.grant.length,0);
  assert.equal(f.calls.api.filter(call=>call.path==='/experience/policy').length,0);
  assert.equal(f.calls.operations[0].payload.includePerformance,true);assert.equal(f.calls.operations[0].payload.performanceMode,'initial');assert.equal(f.calls.operations[0].payload.grantId,undefined);assert.doesNotMatch(words(tree),/24小时|已有显式上限|允许文本请求次数/);
});

test('保存后版本或免费计划改变自动重读后继续，不要求再点准备',async()=>{
  const f=await fixture();f.runtime.savedRevision=7;button(f.render(),'准备这一章').props.onClick();await tick();
  assert.equal(f.calls.operations.length,1);assert.equal(f.calls.operations[0].payload.revision,7);assert.equal(f.calls.grant.length,0);
  assert.doesNotMatch(words(f.render()),/请核对.*再次准备/);
});

test('初次结果实际落库后自动切补缺；未采用review候选仍保持初次准备用途',async()=>{
  const f=await fixture();assert.ok(button(f.render(),'准备这一章'));
  f.props.chapter.segments=[{id:'one',text:'她展开信纸。',performance:'平稳叙述'}];f.props.chapter.revision=5;f.render();f.render();await tick();
  const tree=f.render();assert.equal(button(tree,'准备这一章'),undefined);assert.ok(button(tree,'补齐缺失指导'));assert.equal(f.calls.operations.length,0);button(tree,'补齐缺失指导').props.onClick();await tick();assert.equal(f.calls.operations[0].payload.performanceMode,'fillMissing');assert.equal(f.calls.operations[0].payload.analysisKind,'director');
  const review=await fixture({mode:'review',drafts:[{id:'review',kind:'extract',status:'ready',revision:4,contextRevision:1,items:[],performanceCoverage:coverage(2,2)}]});assert.ok(button(review.render(),'准备这一章'));assert.equal(button(review.render(),'补齐缺失指导'),undefined);
  const deleted=await fixture();deleted.props.chapter.deletedSegments=[{id:'deleted'}];deleted.render();deleted.render();await tick();assert.ok(button(deleted.render(),'补齐缺失指导'));assert.equal(button(deleted.render(),'准备这一章'),undefined);
});

test('旧章一次补齐只发fillMissing，不重新提取、重排、换声或请求音频',async()=>{
  const f=await fixture({rows:[{id:'one',text:'信纸平展。',performance:'平稳叙述'},{id:'two',text:'“谁？”',performance:''}]});
  button(f.render(),'补齐缺失指导').props.onClick();await tick();
  const operation=f.calls.operations[0].payload;assert.equal(operation.performanceMode,'fillMissing');assert.equal(operation.analysisKind,'director');assert.deepEqual(operation.ids,[]);assert.equal(operation.includeHumanPerformance,undefined);assert.equal(operation.kind,'prepareChapter');
});

test('明确所选含人工重写直接执行：限定ids与performance用途，没有二次批准',async()=>{
  const f=await fixture({rows:[{id:'one',text:'“先等等。”',performance:'人工克制'},{id:'two',text:'她站住了。',performance:'人工停顿'}]});
  nodes(f.render()).find(node=>node.type==='Select'&&node.props.label==='所选指导操作').props.onChange('human');f.render();await tick();
  const tree=f.render();assert.equal(nodes(tree).filter(node=>node.type==='TaskAuthorization').length,0);button(tree,'重写所选指导，包含人工内容').props.onClick();await tick();
  const payload=f.calls.operations[0].payload;assert.equal(payload.performanceMode,'selectedRewrite');assert.equal(payload.includeHumanPerformance,true);assert.deepEqual(payload.ids,['one','two']);assert.equal(payload.analysisKind,'director');assert.equal(payload.voiceId,undefined);assert.equal(payload.text,undefined);
});

test('先看建议候选与持久覆盖分开，一屏统一采用后自动保存',async()=>{
  const candidate=coverage(2,2),draft={id:'suggestion',kind:'extract',status:'ready',revision:4,contextRevision:1,draftVersion:1,model:'fixture',batches:[],items:[{id:'one',performance:'平稳叙述',text:'她展开信纸。'},{id:'two',performance:'压低声音，制止开门',text:'“先别开门。”'}],performanceCoverage:candidate};
  const f=await fixture({drafts:[draft],mode:'review',persistent:coverage(2,0)}),tree=f.render();
  assert.match(words(tree),/2\/2 段指导候选已准备/);assert.match(words(tree),/当前已保存 0\/2 段/);
  const apply=nodes(tree).find(node=>node.type==='Form'&&node.props.label==='统一采用剧本与指导');assert.ok(apply);assert.equal(nodes(apply).filter(node=>node.type==='input').length,0);
  await apply.props.onSubmit();const call=f.calls.api.find(call=>call.path==='/analysis/apply');assert.deepEqual(call.payload.selected,['one','two']);assert.equal(call.payload.replaceConfirmed,true);assert.equal(call.payload.confirmRoles,true);assert.equal(call.payload.review,undefined);assert.equal(f.calls.refresh,1);
});

test('部分持久结果不冒称整章完成，删除项单列；撤销仅performance且直接执行',async()=>{
  const persistent={...coverage(135,132),missingIds:['a','b','c']},draft={id:'suggestion',kind:'director',status:'applied',revision:4,contextRevision:1,model:'fixture',items:[],performanceReceipt:{writtenIds:['new'],unchangedIds:[],preservedHumanIds:['human'],skippedChangedIds:['later'],repairedIds:[],changeSetId:'changes',coverage:persistent,affectedUnitIds:['unit-one']}};
  const f=await fixture({drafts:[draft],persistent}),tree=f.render();assert.match(words(tree),/132\/135 段表演已安排/);assert.match(words(tree),/3 条已删除不参与/);assert.match(words(tree),/影响 1 个声音单元/);assert.doesNotMatch(words(tree),/135\/135 段表演已安排/);
  const undo=nodes(tree).find(node=>node.type==='Form'&&node.props.label==='撤销本次表演调整');await undo.props.onSubmit();const call=f.calls.api.find(call=>call.path==='/experience/undo-performance');assert.equal(call.payload.changeSetId,'changes');assert.equal(call.payload.revision,4);assert.ok(call.payload.operationId);assert.equal(call.payload.ids,undefined);assert.equal(call.payload.voiceId,undefined);
});

test('准备期间切章卸载不继续提交旧章付费操作',async()=>{
  const f=await fixture();let resolve;const read=f.runtime.read;f.runtime.read=(path,payload)=>path==='/operations/plan'?new Promise(done=>resolve=()=>done({chapterId:'chapter',revision:4,kind:'extract',memberIds:[],textRequests:1})):read(path,payload);button(f.render(),'准备这一章').props.onClick();await tick();f.unmount();resolve();await tick();assert.equal(f.calls.operations.length,0);assert.equal(f.calls.grant.length,0);
});

test('高级整理明确当前所选与用途，一次提交不创建额度授权或改动人工字段',async()=>{
  const f=await fixture({rows:[{id:'one',text:'第一句',performance:'人工克制'},{id:'two',text:'第二句',performance:'人工停顿'}]});nodes(f.render()).find(node=>node.props.className==='analysis-composer-toggle').props.onClick();
  const form=nodes(f.render()).find(node=>node.type==='Form'&&node.props.label==='生成校对草稿');assert.ok(form);await form.props.onSubmit();assert.equal(f.calls.operations.length,1);assert.equal(f.calls.grant.length,0);assert.equal(f.calls.api.some(call=>call.path==='/experience/grant'),false);
  const {key,payload}=f.calls.operations[0];assert.equal(key,'advanced-analysis:chapter');assert.deepEqual(payload.ids,['one','two']);assert.equal(payload.analysisKind,'director');assert.equal(payload.autoApply,false);assert.equal(payload.model,'fixture-text');assert.equal(payload.grantId,undefined);assert.equal(payload.includeHumanPerformance,undefined);assert.equal(payload.text,undefined);assert.equal(payload.voiceId,undefined);
});

test('结果不明分析只在明确重发按钮后继续原draft，保留retryUnknown且不创建额度授权',async()=>{
  const draft={id:'unknown-analysis',kind:'director',status:'unknown',revision:4,contextRevision:1,draftVersion:3,model:'fixture-text',items:[],batches:[{id:'waiting',status:'unknown'}]},f=await fixture({drafts:[draft]});
  const form=nodes(f.render()).find(node=>node.type==='Form'&&node.props.label==='重新发送并继续（可能重复计费）');assert.ok(form);assert.equal(f.calls.api.some(call=>call.path==='/analysis/resume'),false);assert.equal(f.calls.operations.length,0);await form.props.onSubmit(new Map(),form.props.revision);
  const call=f.calls.api.find(call=>call.path==='/analysis/resume');assert.equal(call.payload.id,draft.id);assert.equal(call.payload.draftVersion,3);assert.equal(call.payload.retryUnknown,true);assert.equal(call.payload.grantId,undefined);assert.equal(f.calls.grant.length,0);assert.equal(f.calls.operations.length,0);
});

const appSource=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),appFile=ts.createSourceFile('App.tsx',appSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let importer;function findImport(node){if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(appFile)==='ImportChapter')importer=node;ts.forEachChild(node,findImport);}findImport(appFile);
const importedCallback=importer.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(appFile)==='onCreated').initializer.expression;
function importFixture(existing){
  const calls={api:[],grant:[],notices:[]};let saved=existing;
  const env={projectRef:{current:'project'},projectId:'project',stateRef:{current:{settings:{textModel:'fixture-text'}}},window:{innerWidth:1440},draftWorkspace:()=> 'workspace',pickChapter(){},setModal(){},setPanelMode(){},setInspectorOpen(){},refresh:async()=>{},setNotice:text=>calls.notices.push(text),
    ensureTaskGrant:async intent=>{calls.grant.push(intent);return'grant';},api:async(path,payload)=>{calls.api.push({path,payload});if(path==='/operations/plan')return{kind:'extract',textRequests:1,maxTextRequests:2};if(path.startsWith('/operations/')){if(saved)return saved;throw Object.assign(new Error('not found'),{status:404});}if(path.startsWith('/chapters/'))return{id:'created',revision:1};if(path==='/operations'){saved={outcome:'processing',result:{analysis:{status:'running'}}};return saved;}throw new Error(path);}};
  const code=ts.transpileModule('const callback='+importedCallback.getText(appFile),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const callback=new Function(...Object.keys(env),code+'\nreturn callback;')(...Object.values(env));return{calls,callback};
}

test('导入一次创建后自动准备；导航/回执恢复仍使用原prepare operation，0重复分析授权',async()=>{
  const f=importFixture();await f.callback('created',true,'import-command');assert.equal(f.calls.grant.length,0);assert.equal(f.calls.api.filter(call=>call.path==='/operations').length,1);assert.equal(f.calls.api.find(call=>call.path==='/operations').payload.operationId,'import-command:prepare');
  await f.callback('created',true,'import-command');assert.equal(f.calls.grant.length,0);assert.equal(f.calls.api.filter(call=>call.path==='/operations').length,1);
});

test('导入恢复已有unknown分析只展示原结果，不重发、换ID或扩大费用',async()=>{
  const f=importFixture({outcome:'unknown',result:{analysis:{status:'unknown'}}});await f.callback('created',true,'import-command');assert.equal(f.calls.grant.length,0);assert.equal(f.calls.api.filter(call=>call.path==='/operations').length,0);assert.match(f.calls.notices.at(-1),/尚未再次发送/);
});

function appNode(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(appFile);assert.ok(found);return found;}
function projected(node,env){const code=ts.transpileModule('const projected=('+node.getText(appFile)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+'\nreturn projected;')(...Object.values(env));}
const basicAction=appNode(node=>ts.isVariableDeclaration(node)&&node.name.getText(appFile)==='useBasicPerformance').initializer;
const basicButton=appNode(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(appFile)==='button'&&node.children.some(child=>ts.isJsxText(child)&&child.text.trim()==='所选句按基础朗读（保留空指导）'));
function basicFixture(){
  const calls={saves:[],operations:[],notices:[]};let complete;
  const env={React,chapter:{id:'chapter',revision:4},chapterRef:{current:'chapter'},connectionReady:true,locked:false,busy:false,checked:['two','one'],state:{jobs:[]},draftWorkspace:()=> 'fixture-workspace',
    withSavedDrafts:async(scope,ids,fn)=>{calls.saves.push({scope,ids});if(complete)await complete;return fn();},draftScopeRevision:()=>7,submitOperation:async(...args)=>{calls.operations.push(args);return{result:{waivedIds:['one','two']}};},setNotice:text=>calls.notices.push(text),run:fn=>fn()};
  env.useBasicPerformance=projected(basicAction,env);return{env,calls,button:()=>projected(basicButton,env),waitForSave:()=>{let resolve;complete=new Promise(done=>resolve=done);return resolve;}};
}

test('更多菜单的基础朗读明确动作一次执行：只传当前所选IDs与元信息用途，不清指导或录音',async()=>{
  const f=basicFixture(),menu=f.button();assert.equal(menu.props.disabled,false);await menu.props.onClick();await tick();
  assert.deepEqual(f.calls.saves,[{scope:'chapter:chapter',ids:['segment:one','segment:two']}]);assert.equal(f.calls.operations.length,1);const[key,payload]=f.calls.operations[0];assert.equal(key,'performance-basic:chapter');assert.deepEqual(payload,{kind:'save',action:'segment.performance-basic',data:{chapterId:'chapter',revision:7,ids:['one','two']}});assert.equal(payload.performance,undefined);assert.equal(payload.grantId,undefined);assert.equal(payload.kind,'save');assert.match(f.calls.notices[0],/非空指导.*保持/);
  f.env.checked=[];assert.equal(f.button().props.disabled,true);f.env.checked=['one'];f.env.connectionReady=false;assert.equal(f.button().props.disabled,true);
});

test('基础朗读保存屏障期间切章不提交；点击时目标快照不被后续选择扩大',async()=>{
  const stopped=basicFixture(),finish=stopped.waitForSave(),pending=stopped.env.useBasicPerformance(stopped.env.checked);stopped.env.checked.push('outside');stopped.env.chapterRef.current='other';finish();await pending;assert.equal(stopped.calls.operations.length,0);assert.equal(stopped.calls.notices.length,0);
  const same=basicFixture(),release=same.waitForSave(),current=same.env.useBasicPerformance(same.env.checked);same.env.checked.push('outside');release();await current;assert.deepEqual(same.calls.operations[0][1].data.ids,['one','two']);
});
