import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/SegmentSplitDialog.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('SegmentSplitDialog.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function nodes(predicate){const found=[];function visit(node){if(predicate(node))found.push(node);ts.forEachChild(node,visit);}visit(file);return found;}
function projected(name,env){const node=nodes(node=>ts.isFunctionDeclaration(node)&&node.name?.text===name||ts.isVariableDeclaration(node)&&node.name.getText(file)===name)[0];assert.ok(node,`真实${name}函数应存在`);const expression=ts.isVariableDeclaration(node)?node.initializer:node,code=ts.transpileModule('const projected=('+expression.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;return new Function(...Object.keys(env),code+'\nreturn projected;')(...Object.values(env));}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const draft=()=>({id:'analysis',kind:'director',splitOnly:true,revision:4,contextRevision:2,draftVersion:3,status:'ready',model:'text-model',items:[{id:'item',segmentId:'segment',splitParts:['前段🙂。','后段。'],splitRequiresPerformanceConfirmation:true}],batches:[{id:'batch',status:'received'}]});
function fixture(){
  const calls={api:[],operations:[],drafts:[],applied:[],appliedGuards:[],closed:0,errors:[]};const waiting=new Map();
  const env={chapter:{id:'chapter',projectId:'project',revision:4},segment:{id:'segment',performance:'前半克制，后半哽咽'},scope:'chapter:chapter',plan:{kind:'director',memberIds:['segment'],textRequests:1},draft:null,item:null,parts:[],grantId:'grant',pending:false,running:false,unknown:false,retryUnknown:false,currentDraft:true,needsPerformanceConfirmation:false,inheritPerformanceConfirmed:false,applyUncertain:false,defaultModel:'text-model',stateJobs:[],alive:{current:true},intent:{current:0},
    draftScopeRevision:(_scope,revision)=>revision,withSavedDrafts:async(_scope,deps,next)=>{assert.deepEqual(deps,['segment:segment']);return next();},
    api:async(path,payload)=>{calls.api.push({path,payload});const deferred=waiting.get(path);if(deferred)return deferred.promise;if(path==='/operations/plan')return env.plan;if(path==='/analysis/apply')return {...env.draft,status:'applied',splitResults:[{segmentId:'segment',itemId:'item',childIds:['child-one','child-two']}]};if(path.startsWith('/chapters/'))return {suggestions:[env.draft]};return {};},
    submitOperation:async(key,payload,jobs)=>{calls.operations.push({key,payload,jobs});const deferred=waiting.get('submit');return deferred?deferred.promise:{result:{analysis:draft()}};},
    setPending:value=>{env.pending=value;},setError:value=>calls.errors.push(value),setApplyUncertain:value=>{env.applyUncertain=value;},setRecordsOpen(){},setRetryUnknown:value=>{env.retryUnknown=value;},setPlan:value=>{env.plan=value;},setDraft:value=>{env.draft=value;calls.drafts.push(value);},
    onApplied:async (id,isCurrent)=>{calls.applied.push(id);calls.appliedGuards.push(isCurrent);},onClose:()=>{calls.closed++;},
  };
  function render(){env.base=projected('base',env);env.close=projected('close',env);env.readRecord=projected('readRecord',env);return {prepare:projected('prepare',env),apply:projected('apply',env),close:env.close};}
  function preview(){env.draft=draft();env.item=env.draft.items[0];env.parts=env.item.splitParts;env.needsPerformanceConfirmation=true;}
  function defer(key){let resolve;const pending={promise:new Promise(yes=>{resolve=yes;}),resolve:value=>resolve(value)};waiting.set(key,pending);return pending;}
  return {calls,env,render,preview,defer};
}

test('AI拆短只准备独立语义预览，unknown未明确决定不会重新发送',async()=>{
  const f=fixture();await f.render().prepare();assert.equal(f.calls.operations.length,1);
  assert.deepEqual(f.calls.operations[0].payload,{kind:'prepareChapter',analysisKind:'director',chapterId:'chapter',revision:4,ids:['segment'],splitOnly:true,autoApply:false,model:'text-model',grantId:'grant',requireGrant:true});
  assert.equal(f.calls.api.filter(call=>call.path==='/analysis/apply').length,0);assert.deepEqual(f.calls.applied,[]);
  const numericInputs=nodes(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='input'&&node.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='type'&&attr.initializer?.getText(file)==='"number"'));
  assert.equal(numericInputs.length,0,'The user chooses a semantic preview, never a numeric offset');
  f.env.unknown=true;f.env.draft={...draft(),status:'partial',batches:[{id:'batch',status:'unknown'}]};f.env.pending=false;
  await f.render().prepare();await f.render().prepare(true);
  assert.equal(f.calls.operations.length,1);assert.equal(f.calls.api.filter(call=>call.path==='/analysis/resume').length,0);
});

test('位置性表演需明确沿用，应用一次真实预览且直接定位第一个子条',async()=>{
  const f=fixture();f.preview();await f.render().apply();assert.equal(f.calls.api.length,0);
  f.env.inheritPerformanceConfirmed=true;await f.render().apply();
  assert.deepEqual(f.calls.api,[{path:'/analysis/apply',payload:{id:'analysis',draftVersion:3,revision:4,selected:['item'],inheritPerformanceConfirmed:true}}]);
  assert.deepEqual(f.calls.applied,['child-one']);assert.equal(f.calls.closed,1);assert.equal(f.calls.operations.length,0);assert.equal(f.calls.appliedGuards[0](),false,'The parent callback can suppress delayed selection after closing');
});

test('关闭拆分面板后，迟到预览或应用回执不重开、不换选中台词',async()=>{
  for(const action of ['prepare','apply']){
    const f=fixture();if(action==='apply'){f.preview();f.env.inheritPerformanceConfirmed=true;}
    const read=f.defer(action==='prepare'?'submit':'/analysis/apply'),callbacks=f.render(),pending=callbacks[action]();await tick();callbacks.close();
    read.resolve(action==='prepare'?{result:{analysis:draft()}}:{...draft(),status:'applied',splitResults:[{segmentId:'segment',itemId:'item',childIds:['child-one']}]});await pending;
    assert.deepEqual(f.calls.drafts,[]);assert.deepEqual(f.calls.applied,[]);assert.equal(f.calls.closed,1);assert.deepEqual(f.calls.errors,['']);
  }
});
