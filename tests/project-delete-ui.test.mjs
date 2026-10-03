import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const compile=source=>ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const event=key=>({key,prevented:false,stopped:false,preventDefault(){this.prevented=true;},stopPropagation(){this.stopped=true;}});
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(!result&&predicate(node))result=node;if(!result)ts.forEachChild(node,visit);}visit(file);assert.ok(result,'真实 App 回调仍应存在');return result;}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const project=(node,env)=>new Function(...Object.keys(env),compile('const projected=('+node.getText(file)+');')+'\nreturn projected;')(...Object.values(env));
const select=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='Select'&&node.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='label'&&ts.isStringLiteral(attr.initializer)&&attr.initializer.text==='当前项目'));

function selectFixture(onDelete){
  const hooks=[],effects=[];let index=0,effectIndex=0,pendingEffects=[],tree;
  const calls={chosen:[],deleted:[],focus:[]};
  const env={React,Check:'Check',ChevronDown:'ChevronDown',Trash2:'Trash2',crypto,
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    useRef:initial=>hooks[index++]||=( {current:initial} ),
    useEffect:(callback,deps)=>{const key=effectIndex++;if(!effects[key]||deps.some((value,i)=>value!==effects[key].deps[i]))pendingEffects.push(()=>{effects[key]?.cleanup?.();effects[key]={deps,cleanup:callback()};});},
    window:{innerWidth:320,innerHeight:640,addEventListener(){},removeEventListener(){}},
    document:{addEventListener(){},removeEventListener(){}},
  };
  const componentSource=readFileSync(new URL('../src/components.tsx',import.meta.url),'utf8');
  const component=componentSource.slice(componentSource.indexOf('export function Select('),componentSource.indexOf('export function Field('));
  const Select=new Function(...Object.keys(env),compile(component).replace('export function Select','function Select')+'\nreturn Select;')(...Object.values(env));
  const props={value:'one',options:[{value:'one',label:'当前项目'},{value:'two',label:'很长的项目名称'.repeat(12)}],label:'当前项目',onChange:value=>calls.chosen.push(value),...(onDelete?{onDelete:value=>calls.deleted.push(value)}:{})};
  const render=()=>{
    index=0;effectIndex=0;pendingEffects=[];tree=Select(props);
    const trigger=nodes(tree).find(node=>node.props.className==='select-trigger');
    trigger.props.ref.current={focus:()=>calls.focus.push('trigger'),getBoundingClientRect:()=>({top:50,bottom:86,left:8,width:200})};
    tree.props.ref.current={contains:target=>target==='inside',querySelector:selector=>{const match=selector.match(/data-choice-index="(\d+)"/);return match?{focus:()=>calls.focus.push(Number(match[1]))}:null;}};
    for(const effect of pendingEffects)effect();return tree;
  };
  const trigger=()=>nodes(tree).find(node=>node.props.className==='select-trigger');
  const open=()=>{trigger().props.onClick();return render();};
  const menu=()=>nodes(tree).find(node=>node.props.className==='select-menu');
  const choose=i=>nodes(tree).filter(node=>node.props.className?.includes('select-option')&&node.type==='button')[i];
  const remove=i=>nodes(tree).filter(node=>node.props.className==='select-delete')[i];
  render();return {props,calls,render,open,trigger,menu,choose,remove};
}

test('项目下拉选择和SVG删除是并列按钮，删除不选择项目、不弹确认',()=>{
  const f=selectFixture(true);f.open();
  assert.equal(f.trigger().props.role,undefined);assert.equal(f.trigger().props['aria-haspopup'],'dialog');
  assert.equal(f.menu().props.role,'dialog');assert.ok(!nodes(f.menu()).some(node=>node.props.role==='option'));
  const remove=f.remove(1),click=event();assert.equal(remove.props['aria-label'],'删除'+f.props.options[1].label);
  assert.ok(nodes(remove).some(node=>node.type==='Trash2'&&node.props['aria-hidden']==='true'));
  assert.equal(f.choose(1).props.title,f.props.options[1].label);
  remove.props.onClick(click);assert.deepEqual(f.calls.deleted,['two']);assert.deepEqual(f.calls.chosen,[]);assert.equal(click.stopped,true);
  assert.equal(f.render().props.children.some?.(child=>child?.props?.className==='select-menu'),false);
  assert.equal(f.calls.focus.at(-1),'trigger');
  f.open();f.choose(1).props.onClick();assert.deepEqual(f.calls.chosen,['two']);assert.deepEqual(f.calls.deleted,['two']);
});

test('项目列表方向键定位选择按钮，Tab可到删除，Escape返回触发器',()=>{
  const f=selectFixture(true);f.open();assert.equal(f.calls.focus.at(-1),0);
  const down=event('ArrowDown');f.menu().props.onKeyDown(down);assert.equal(down.prevented,true);assert.equal(f.calls.focus.at(-1),1);f.render();
  f.remove(1).props.onFocus();f.render();const up=event('ArrowUp');f.menu().props.onKeyDown(up);assert.equal(f.calls.focus.at(-1),0);
  for(const key of ['Tab','Enter',' ']){const native=event(key);f.menu().props.onKeyDown(native);assert.equal(native.prevented,false,'保留原生按钮和Tab行为');}
  const escape=event('Escape');f.menu().props.onKeyDown(escape);assert.equal(escape.stopped,true);assert.equal(f.calls.focus.at(-1),'trigger');assert.equal(f.render().props.children[1],false);
  f.open();f.render().props.onBlur({currentTarget:{contains:target=>target==='inside'},relatedTarget:'outside'});assert.equal(f.render().props.children[1],false);
});

test('普通Select继续使用combobox/listbox与原Enter选择；项目忙碌时行按钮不可用',()=>{
  const normal=selectFixture(false);normal.open();assert.equal(normal.trigger().props.role,'combobox');assert.equal(normal.menu().props.role,'listbox');
  assert.ok(nodes(normal.menu()).filter(node=>node.type==='button').every(node=>node.props.role==='option'));
  normal.trigger().props.onKeyDown(event('End'));normal.render();normal.trigger().props.onKeyDown(event('Enter'));assert.deepEqual(normal.calls.chosen,['two']);
  const project=selectFixture(true);project.open();project.props.disabled=true;project.render();assert.equal(project.choose(0).props.disabled,true);assert.equal(project.remove(0).props.disabled,true);
});

function appFixture(){
  const calls={actions:[],updates:[],refresh:0,paused:0,errors:[]};
  const state={settings:{workspaceDirectory:'/fixture'},projects:[{id:'one',name:'第一项目'},{id:'two',name:'第二项目'}],chapters:[{id:'old',projectId:'one'},{id:'next',projectId:'two'}]};
  const env={React,Select:'Select',state,projectId:'one',busy:false,connectionReady:true,
    stateRef:{current:state},projectRef:{current:'one'},chapterRef:{current:'old'},refreshPending:{current:null},bookmarks:{current:{old:'line-old',next:'line-next'}},
    playIntent:{current:0},pendingPlay:{current:'old'},pendingPlaySnapshot:{current:{arrangement:1}},recoveryTarget:{current:{chapterId:'old'}},
    bindDraftWorkspace(){},draftWorkspace:()=>'',playbackIdentity:items=>JSON.stringify(items),generationIntent:{current:0},generationPlan:{id:'old-plan'},audio:{current:{pause(){calls.paused++;}}},
    action:async(name,payload)=>calls.actions.push({name,payload}),refresh:async()=>{calls.refresh++;},
  };
  for(const name of ['ProjectId','ChapterId','Chapter','Selected','Checked','Filter','Search','OldPreview','CurrentMembers','CurrentSegment','Modal','TaskRecord','UnitInitialEvent','DraftIds','GrantId','VoiceTarget','UnitPanelId','UnitInitialMode','Player','NavOpen','InspectorOpen','Busy','DeleteTarget'])env['set'+name]=value=>{calls.updates.push({name,value});env[name[0].toLowerCase()+name.slice(1)]=value;};
  env.setGenerationPlan=value=>{env.generationPlan=value;calls.updates.push({name:'GenerationPlan',value});};
  env.setState=value=>{env.state=typeof value==='function'?value(env.state):value;calls.updates.push({name:'State',value:env.state});};
  env.setError=value=>calls.errors.push(value);
  env.closeGeneration=project(declaration('closeGeneration'),env);
  env.pickChapter=project(declaration('pickChapter'),env);
  env.pickProject=project(declaration('pickProject'),env);
  env.deleteProject=project(declaration('deleteProject'),env);
  env.run=project(declaration('run'),env);
  return {env,calls,view:()=>project(select,env)};
}

test('下拉删除入口打开一份具体范围预览，不先发送删除',()=>{const f=appFixture();f.view().props.onDelete('two');assert.equal(f.env.deleteTarget.id,'two');assert.deepEqual(f.calls.actions,[]);assert.equal(f.env.projectRef.current,'one');});

test('删除当前项目直接发action，切剩余项目并清旧章、播放和面板，不清其他项目断点',async()=>{
  const f=appFixture();await f.env.deleteProject('one',{project:1});
  assert.deepEqual(f.calls.actions,[{name:'project.delete',payload:{id:'one',scope:{project:1}}}]);
  assert.equal(f.env.projectRef.current,'two');assert.equal(f.env.chapterRef.current,'next');assert.equal(f.env.chapter,null);
  assert.equal(f.env.player,null);assert.equal(f.env.generationPlan,null);assert.equal(f.env.modal,null);assert.equal(f.env.voiceTarget,null);assert.equal(f.env.unitPanelId,null);
  assert.deepEqual(f.env.checked,[]);assert.equal(f.env.search,'');assert.equal(f.env.oldPreview,null);assert.equal(f.env.recoveryTarget.current,null);
  assert.deepEqual(f.env.bookmarks.current,{next:'line-next'});assert.deepEqual(f.env.state.projects.map(p=>p.id),['two']);assert.ok(f.calls.paused>0);
});

test('删除最后项目回空状态；删除非当前项目不改当前编辑或播放',async()=>{
  const last=appFixture();last.env.state.projects.splice(1);last.env.state.chapters.splice(1);await last.env.deleteProject('one',{project:1});
  assert.equal(last.env.projectRef.current,'');assert.equal(last.env.chapterRef.current,'');assert.equal(last.env.chapter,null);assert.deepEqual(last.env.state.projects,[]);
  const other=appFixture();await other.env.deleteProject('two',{project:1});assert.equal(other.env.projectRef.current,'one');assert.equal(other.env.chapterRef.current,'old');
  assert.deepEqual(other.calls.updates.map(update=>update.name),['State']);assert.equal(other.calls.paused,0);assert.equal(other.env.generationPlan.id,'old-plan');
});

test('最终删除409保留项目与编辑，通过现有run显示错误，不自动重发',async()=>{
  const f=appFixture();f.env.action=async()=>{throw Object.assign(new Error('项目仍在处理，请稍后删除'),{status:409});};
  f.env.deleteProject=project(declaration('deleteProject'),f.env);f.env.run=project(declaration('run'),f.env);
  await f.env.run(()=>f.env.deleteProject('one',{project:1}));
  assert.equal(f.env.projectRef.current,'one');assert.equal(f.env.chapterRef.current,'old');assert.equal(f.env.generationPlan.id,'old-plan');
  assert.ok(f.calls.errors.includes('项目仍在处理，请稍后删除'));assert.equal(f.calls.paused,0);assert.equal(f.calls.refresh,0);
});

test('成功删除等待已有刷新结束，迟到旧章读不能在切剩余项目后复活',async()=>{
  const f=appFixture();let release;
  f.env.refreshPending.current=new Promise(resolve=>release=resolve);
  const pending=f.env.deleteProject('one',{project:1});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.env.projectRef.current,'one');assert.equal(f.calls.updates.length,0);
  // Simulate the already-started pre-delete refresh finishing with its old snapshot.
  f.env.stateRef.current={...f.env.stateRef.current};release();await pending;
  assert.equal(f.env.projectRef.current,'two');assert.equal(f.env.chapterRef.current,'next');assert.equal(f.env.chapter,null);
  assert.ok(f.env.state.projects.every(p=>p.id!=='one'));
});

test('真实刷新回调读取旧章期间清空项目，迟到章节不回填空页面',async()=>{
  const f=appFixture();let release;
  f.env.useCallback=callback=>callback;f.env.pendingPlay.current=null;f.env.playerRef={current:null};f.env.active=()=>false;
  f.env.setLoading=()=>{};f.env.setConnectionReady=()=>{};f.env.connectionMessage='连接失败';
  f.env.api=async path=>path==='/state'?{...f.env.state,jobs:[]}:new Promise(resolve=>release=resolve);
  const refresh=project(declaration('refresh'),f.env),pending=refresh();await new Promise(resolve=>setImmediate(resolve));
  f.env.pickProject('',{projects:[],chapters:[]});release({id:'old',projectId:'one',segments:[],masters:[],playbackItems:[]});await pending;
  assert.equal(f.env.chapterRef.current,'');assert.equal(f.env.chapter,null);assert.ok(!f.calls.updates.some(update=>update.name==='Chapter'&&update.value?.id==='old'));
});

test('真实播放核对旧章期间切走，不迟到播放已删除项目的声音',async()=>{
  const f=appFixture();let release;const reads=[];
  f.env.chapter={id:'old',arrangement:1,playbackItems:[]};f.env.chapterId='old';f.env.playerRef={current:null};
  f.env.api=async path=>{reads.push(path);return new Promise(resolve=>release=resolve);};
  const play=project(declaration('startPlay'),f.env),pending=play('audios','old-audio','旧声音');
  f.env.pickProject('two');release({id:'old',arrangement:1,playbackItems:[]});await pending;
  assert.deepEqual(reads,['/chapters/old']);assert.equal(f.env.player,null);assert.equal(f.env.chapterRef.current,'next');
  assert.ok(!f.calls.updates.some(update=>update.name==='Player'&&update.value?.id==='old-audio'));
});
