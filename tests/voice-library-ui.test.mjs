import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let result;function visit(node){if(!result&&predicate(node))result=node;if(!result)ts.forEachChild(node,visit);}visit(file);assert.ok(result,'所测界面节点仍应存在');return result;}
const project=(node,env)=>new Function(...Object.keys(env),ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText+'\nreturn projected;')(...Object.values(env));
const inVoiceLibrary=project(find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='inVoiceLibrary').initializer,{});
const library=find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='VoiceLibrary');
const voicesBinding=find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)==='voices').initializer;
const sidebar=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='button'&&node.children.some(child=>ts.isJsxText(child)&&child.getText(file).includes('音色库')));
const tasks=find(node=>ts.isJsxElement(node)&&node.openingElement.tagName.getText(file)==='Dialog'&&node.openingElement.attributes.properties.some(attr=>ts.isJsxAttribute(attr)&&attr.name.getText(file)==='title'&&ts.isStringLiteral(attr.initializer)&&attr.initializer.text==='任务记录'));
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const fixture=()=>[
  {id:'active',name:'日常可用声音',state:'active',duration:5,revision:2},
  {id:'archived',name:'归档声音',state:'archived',duration:6,revision:3},
  {id:'stopped',name:'停用声音',state:'stopped',duration:7,revision:4},
  {id:'deleted',name:'旧音频的已删声音',state:'deleted',duration:8,revision:5},
  {id:'pending',name:'等待删除的声音',state:'stopped',deletePending:true,duration:9,revision:6},
];

function setup(voices){
  let index=0;const hooks=[],calls={actions:[],refresh:0};
  const env={React,crypto,inVoiceLibrary,Dialog:'Dialog',Form:'Form',Field:'Field',Select:'Select',Status:'Status',Empty:'Empty',VoiceCreation:'VoiceCreation',VoiceInspection:'VoiceInspection',DeleteVoiceDialog:'DeleteVoiceDialog',TaskAuthorization:'TaskAuthorization',
    AudioLines:'AudioLines',Upload:'Upload',Search:'Search',Plus:'Plus',Pause:'Pause',Play:'Play',Library:'Library',names:{success:'已生成'},
    useRef:initial=>hooks[index++]||=( {current:initial} ),
    useState:initial=>{const key=index++;if(!(key in hooks))hooks[key]=typeof initial==='function'?initial():initial;return [hooks[key],value=>{hooks[key]=typeof value==='function'?value(hooks[key]):value;}];},
    action:async(...args)=>calls.actions.push(args),api:async()=>{},
  };
  const VoiceLibrary=project(library,env);
  const props={voices,model:'fixture-model',projectId:'fixture-project',sessions:[],jobs:[],creationEnabled:true,configured:true,audioTools:true,routeBlocked:false,
    onRefresh:async()=>{calls.refresh++;},onClose(){},play(){},playSample(){}};
  return {env,calls,props,render:()=>{index=0;return VoiceLibrary(props);}};
}

test('日常音色库隐藏已删除和删除中的声音，归档与停用仍显示并可恢复',async()=>{
  const voices=fixture(),before=structuredClone(voices),f=setup(voices),tree=f.render();
  const cards=nodes(tree).filter(node=>node.props.className==='voice-card');
  assert.deepEqual(cards.map(card=>nodes(card).find(node=>node.type==='h3')?.props.children[0]),['日常可用声音','归档声音','停用声音']);
  assert.match(text(nodes(tree).find(node=>node.props.role==='status')),/正在删除 1 份参考素材；等待进行中的任务或试听结束/);
  const failed=setup(voices.map(voice=>voice.deletePending?{...voice,deleteError:'文件暂时无法删除'}:voice)).render();
  assert.match(text(nodes(failed).find(node=>node.props.role==='status'&&node.props.className==='error-inline')),/暂时无法清理的文件会在空闲时重试/);
  for(const id of ['archived','stopped']){
    const card=cards.find(card=>card.props.key===id),selector=nodes(card).find(node=>node.type==='Select');
    assert.equal(!!selector.props.disabled,false);assert.ok(selector.props.options.some(option=>option.value==='active'));
    selector.props.onOpen();await selector.props.onChange('active');
    assert.deepEqual(f.calls.actions.at(-1),['voice.update',{id,state:'active',entityRevision:voices.find(voice=>voice.id===id).revision}]);
  }
  assert.equal(f.calls.refresh,2);assert.deepEqual(voices,before,'列表投影不改底层声音记录');
});

test('侧栏音色库计数与日常可见列表一致，全部隐藏时显示空态',()=>{
  const voices=fixture(),state={voices},f=setup(voices),allVoices=project(voicesBinding,{state});
  const countTree=project(sidebar,{...f.env,voices:allVoices,state,setModal(){}});
  const count=nodes(countTree).find(node=>node.type==='span');
  assert.equal(count.props.children[0],nodes(f.render()).filter(node=>node.props.className==='voice-card').length);
  assert.equal(count.props.children[0],3);
  const empty=setup(voices.filter(voice=>voice.state==='deleted'||voice.deletePending)).render();
  assert.equal(nodes(empty).filter(node=>node.props.className==='voice-card').length,0);
  assert.ok(nodes(empty).some(node=>node.type==='Empty'&&node.props.heading==='让每个角色有自己的声音'));
});

test('底层完整声音集合保留，历史音频任务仍识别已删与删除中声音的旧名称',()=>{
  const voices=fixture(),state={voices,chapters:[],jobs:voices.filter(voice=>voice.state==='deleted'||voice.deletePending).map(voice=>({id:'job-'+voice.id,kind:'voice-test',voiceId:voice.id,status:'success',done:1,total:1,createdAt:'2026-10-02T00:00:00Z'}))};
  const allVoices=project(voicesBinding,{state});assert.deepEqual(allVoices.map(voice=>voice.id),voices.map(voice=>voice.id));
  const f=setup(voices),tree=project(tasks,{...f.env,state,voices:allVoices,taskRecord:null,chapterId:'fixture-chapter',time:()=>'',active:()=>false,locked:false,busy:false,setModal(){},setTaskRecord(){},startPlay(){},run:callback=>callback()});
  assert.match(text(tree),/旧音频的已删声音/);assert.match(text(tree),/等待删除的声音/);
});

test('执行删除完成回调刷新后卡片去除，全删后空态与侧栏计数同步',async()=>{
  const f=setup(fixture().slice(0,1));
  f.props.onRefresh=async()=>{f.calls.refresh++;f.props.voices=f.props.voices.map(voice=>({...voice,state:'deleted'}));};
  const card=nodes(f.render()).find(node=>node.props.className==='voice-card');
  nodes(card).find(node=>node.type==='button'&&text(node)==='删除参考素材').props.onClick();
  const dialog=nodes(f.render()).find(node=>node.type==='DeleteVoiceDialog');assert.equal(dialog.props.voice.id,'active');
  await dialog.props.onDeleted();const refreshed=f.render();
  assert.equal(f.calls.refresh,1);assert.ok(!nodes(refreshed).some(node=>node.props.className==='voice-card'||node.type==='DeleteVoiceDialog'));
  assert.ok(nodes(refreshed).some(node=>node.type==='Empty'));
  const state={voices:f.props.voices},allVoices=project(voicesBinding,{state});
  const sidebarTree=project(sidebar,{...f.env,state,voices:allVoices,setModal(){}});
  assert.equal(nodes(sidebarTree).find(node=>node.type==='span').props.children[0],0);
  assert.equal(allVoices[0].name,'日常可用声音','历史底层记录仍保留名称');
});
