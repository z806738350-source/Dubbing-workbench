import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(!result&&predicate(node))result=node;if(!result)ts.forEachChild(node,visit);}visit(file);assert.ok(result,'所测界面节点仍应存在');return result;}
function project(node,env){const compiled=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),compiled+'\nreturn projected;')(...Object.values(env));}
const rows=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='visible.map').arguments[0];
const panel=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='UnitPanel');
const onTask=panel.attributes.properties.find(node=>ts.isJsxAttribute(node)&&node.name.getText(file)==='onTask').initializer.expression;
const tasks=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='Dialog'&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='title'&&ts.isStringLiteral(attr.initializer)&&attr.initializer.text==='任务记录'));
const focus=find(node=>ts.isCallExpression(node)&&node.expression.getText(file)==='useEffect'&&node.arguments[0]?.getText(file).includes('taskRecordRef.current'));
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);

function fixture(mode='dry'){
  const calls={play:[],generate:[],members:[],open:[],voice:[]};
  const segments=['one','two','three','outside'].map((id,order)=>({id,order,roleId:'role',voiceId:'voice',text:'自拟台词'+order,roleConfirmed:true,identityConfirmed:true,current:'single-'+id,validity:'matched',latest:'success'}));
  const group={id:'group',kind:'group',state:'active',members:['one','two','three'],mode,variants:{dry:{current:'group-dry',status:{basis:{version:'dry'}}},scene:{current:'group-scene',status:{basis:{version:'scene'}}}}};
  const env={React,visible:segments,segments,roles:[{id:'role',name:'角色'}],voices:[{id:'voice',name:'声音'}],chapter:{id:'chapter',units:[group]},
    effectiveStatus:()=>({validity:'matched',review:'passed'}),currentMembers:[],currentSegment:'',selected:'',checked:[],connectionReady:true,locked:false,busy:false,
    setCurrentMembers:value=>calls.members.push(value),setCurrentSegment(){},startPlay:(...args)=>calls.play.push(args),openUnit:(...args)=>calls.open.push(args),
    run:fn=>fn(),generate:async(...args)=>calls.generate.push(args),setChecked(){},setSelected(){},setPanelMode(){},setInspectorOpen(){},
    openVoice:(...args)=>calls.voice.push(args),bookmarks:{current:{}},chapterId:'chapter',setOldPreview(){},mutate:async()=>{},basis:()=>({}),names:{passed:'已检查',matched:'声音已更新'},
    Play:'Play',Users:'Users',RefreshCw:'RefreshCw',Check:'Check',SlidersHorizontal:'SlidersHorizontal',Status:'Status'};
  return {env,calls,group,render:()=>env.visible.map(project(rows,env))};
}

for(const mode of ['dry','scene'])test(`筛选后的组头${mode}试听/重做仍覆盖完整成员，成员单句动作不冒充组动作`,async()=>{
  const f=fixture(mode);f.env.visible=f.env.segments.slice(1);
  const rendered=f.render(),headers=rendered.flatMap(nodes).filter(node=>node.props.className==='group-strip');assert.equal(headers.length,1);assert.match(text(headers[0]),/第 1—3 句/);
  button(headers[0],'试听整段').props.onClick();assert.deepEqual(f.calls.members,[f.group.members]);
  assert.equal(f.calls.play[0][1],'group-'+mode);assert.equal(f.calls.play[0][5].id,'group');assert.equal(f.calls.play[0][5].mode,mode);
  button(headers[0],'重做这 3 句').props.onClick();assert.deepEqual(f.calls.generate,[ [f.group.members,false,{regenerate:true}] ]);
  button(headers[0],'调整这段').props.onClick();assert.deepEqual(f.calls.open,[['group']]);
  for(const row of rendered.slice(0,2)){const labels=nodes(row).filter(node=>node.type==='button').map(node=>node.props['aria-label']||'');assert.ok(!labels.some(label=>/^(试听第|重新生成第|检查通过第)/.test(label)));assert.ok(labels.some(label=>/^为第 .*选声音/.test(label)));}
  const outside=nodes(rendered[2]).filter(node=>node.type==='button').map(node=>node.props['aria-label']||'');assert.ok(outside.includes('试听第 4 条'));assert.ok(outside.includes('重新生成第 4 条'));
});

test('组头离线或忙碌时不提供误导的试听/重做可用状态',()=>{
  const f=fixture();f.env.connectionReady=false;f.env.locked=true;
  const header=f.render().flatMap(nodes).find(node=>node.props.className==='group-strip');
  assert.equal(button(header,'试听整段').props.disabled,true);assert.equal(button(header,'重做这 3 句').props.disabled,true);
});

test('任务定位两次读取期间关闭单元或切章，都不迟到重新打开记录',async()=>{
  for(const stage of ['lookup','refresh']){
    const changes=[],chapterRef={current:'chapter'},unitPanelRef={current:'group'};let release;
    const env={chapter:{id:'chapter'},unitPanelId:'group',chapterRef,unitPanelRef,
      api:async()=>stage==='lookup'?new Promise(resolve=>release=()=>resolve([{id:'wanted',status:'unknown',mode:'scene'}])):[{id:'wanted',status:'unknown',mode:'scene'}],
      refresh:async()=>stage==='refresh'?new Promise(resolve=>release=resolve):undefined,
      setTaskRecord:value=>changes.push(value),setUnitPanelId:value=>changes.push(value),setModal:value=>changes.push(value)};
    const pending=project(onTask,env)('job','wanted');await new Promise(resolve=>setImmediate(resolve));
    if(stage==='lookup')chapterRef.current='other';else unitPanelRef.current=null;
    release();await pending;assert.deepEqual(changes,[]);
  }
});

test('任务记录按所选attempt显示版本并突出对应job，不输出请求正文或凭据字段',async()=>{
  let record;
  const attempt={id:'wanted',mode:'scene',status:'unknown',prompt:'PRIVATE_PROMPT_MARKER',input:{text:'PRIVATE_TEXT_MARKER',key:'PRIVATE_CREDENTIAL_MARKER'}};
  const env={chapter:{id:'chapter'},unitPanelId:'group',chapterRef:{current:'chapter'},unitPanelRef:{current:'group'},api:async()=>[attempt],refresh:async()=>{},setTaskRecord:value=>record=value,setUnitPanelId(){},setModal(){}};
  await project(onTask,env)('chosen-job','wanted');assert.equal(record.jobId,'chosen-job');assert.equal(record.attempt.id,'wanted');
  const taskRecordRef={current:null};
  const view=project(tasks,{React,taskRecord:record,taskRecordRef,state:{jobs:[{id:'chosen-job',kind:'unit-generate',mode:'scene',chapterId:'chapter',createdAt:'2026-10-02T00:00:00Z',status:'unknown',done:0,total:1}],chapters:[{id:'chapter',title:'自拟章'}]},names:{unknown:'结果待核对'},voices:[],chapterId:'chapter',time:()=>'',active:()=>false,locked:false,busy:false,Dialog:'Dialog',AudioLines:'AudioLines',Status:'Status',Empty:'Empty',setModal(){},setTaskRecord(){},startPlay(){},run:fn=>fn(),api:async()=>{},setChapter(){},setChecked(){},setSearch(){},setFilter(){},setNotice(){}});
  assert.match(text(view),/这次声音背景生成记录/);assert.ok(nodes(view).some(node=>node.props.className==='task-row selected-task'));
  assert.ok(!text(view).includes('PRIVATE_'));assert.equal(nodes(view).find(node=>node.type==='section').props.ref,taskRecordRef);
});

test('任务摘要仅按记录变化定位焦点，同一记录轮询不抢回键盘焦点',()=>{
  let prior,focused=0;
  const env={modal:'tasks',taskRecord:{attempt:{id:'one'}},taskRecordRef:{current:{focus(){focused++;}}},
    useEffect:(callback,dependencies)=>{if(!prior||dependencies.some((value,index)=>value!==prior[index]))callback();prior=dependencies;}};
  project(focus,env);project(focus,env);project(focus,env);assert.equal(focused,1);
  env.taskRecord={attempt:{id:'two'}};project(focus,env);assert.equal(focused,2);
});
