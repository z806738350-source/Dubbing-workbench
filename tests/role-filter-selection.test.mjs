import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8');
const file=ts.createSourceFile('App.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function find(predicate){let found;function visit(node){if(!found&&predicate(node))found=node;if(!found)ts.forEachChild(node,visit);}visit(file);assert.ok(found,'实际角色筛选界面应存在');return found;}
const declaration=name=>find(node=>ts.isVariableDeclaration(node)&&node.name.getText(file)===name).initializer;
const attr=(node,name)=>node.attributes.properties.find(item=>ts.isJsxAttribute(item)&&item.name.getText(file)===name);
function project(node,env){const code=ts.transpileModule('const projected=('+node.getText(file)+');',{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;return new Function(...Object.keys(env),code+';return projected;')(...Object.values(env));}
const roleSelect=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='Select'&&attr(node,'label')?.initializer?.text==='筛选角色');
const selectAll=find(node=>ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='input'&&attr(node,'aria-label')?.initializer?.text==='选择可见片段');
const bar=find(node=>ts.isJsxElement(node)&&attr(node.openingElement,'className')?.initializer?.text==='selection-bar');
const React={createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'Fragment'};
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const button=(tree,label)=>nodes(tree).find(node=>node.type==='button'&&text(node)===label);

function fixture(){
  const roles=[{id:'role-a',name:'李青'},{id:'role-b',name:'李青'},{id:'narrator',name:'旁白',narrator:true},{id:'excluded-role',name:'说明角色'},{id:'pending',name:'角色ID可等于旧状态值'},{id:'other-chapter-role',name:'其他章角色'}];
  const segments=[
    {id:'one',roleId:'role-a',text:'开门。',validity:'matched',review:'passed',roleConfirmed:true},
    {id:'two',roleId:'role-a',text:'别怕。',validity:'missing',review:'pending',roleConfirmed:false},
    {id:'three',roleId:'role-b',text:'门外是谁？',validity:'matched',review:'rework'},
    {id:'narration',roleId:'narrator',text:'雨还在下。',validity:'missing',review:'pending'},
    {id:'excluded',roleId:'role-a',text:'只作标记。',excluded:true},
    {id:'excluded-only',roleId:'excluded-role',text:'不参加朗读。',excluded:true},
    {id:'old-status-id',roleId:'pending',text:'这仍是角色筛选。',validity:'missing',review:'passed'},
  ];
  const calls={filters:[],checked:[],rebind:[],voices:[]},env={React,Select:'Select',roles,segments,chapter:{id:'chapter',segments},filter:'all',search:'',checked:[],locked:false,busy:false,connectionReady:true,state:{settings:{features:{groups:true}}},rebindOpen:false,voiceTarget:null,
    configurationDecided:s=>!!s.roleConfirmed,effectiveStatus:s=>s,chapterMemberState:(_chapter,s)=>({...s,requestIssues:[]}),
    setFilter:value=>{calls.filters.push(value);env.filter=value;},setChecked:value=>{env.checked=typeof value==='function'?value(env.checked):value;calls.checked.push([...env.checked]);},setRebindOpen:value=>{calls.rebind.push(value);env.rebindOpen=value;},setVoiceTarget:value=>{calls.voices.push(value);env.voiceTarget=value;},
    openUnit(){assert.fail('音色入口不应创建对戏组');},generate(){assert.fail('音色入口不应生成声音');},mutate(){assert.fail('音色入口不应改变角色或确认归属');},run(){assert.fail('打开音色面板不需要任务提交');},onDeleteSegments(){assert.fail('音色入口不应删除台词');},Users:'Users',AudioLines:'AudioLines',MicVocal:'MicVocal',CheckCheck:'CheckCheck',Volume2:'Volume2',Headphones:'Headphones',Trash2:'Trash2',X:'X'};
  const updateVisible=()=>{env.chapterRoleIds=project(declaration('chapterRoleIds'),env);env.chapterRoles=project(declaration('chapterRoles'),env);env.visible=project(declaration('visible'),env);env.selectableVisible=project(declaration('selectableVisible'),env);};
  return {env,calls,visible:()=>{updateVisible();return env.visible;},select:()=>{updateVisible();return project(roleSelect,env);},all:()=>{updateVisible();return project(selectAll,env);},bar:()=>{updateVisible();return project(bar,env);}};
}

test('角色下拉只列本章出现的角色，按ID去重、保留同名角色与旁白',()=>{
  const f=fixture(),select=f.select();assert.equal(select.props.label,'筛选角色');assert.equal(select.props.value,'all');
  assert.deepEqual(select.props.options[0],{value:'all',label:'全部角色'});
  const options=select.props.options.slice(1);assert.equal(options.length,5);assert.deepEqual(new Set(options.map(option=>option.value)),new Set(['role-a','role-b','narrator','excluded-role','pending']));assert.equal(options.filter(option=>option.value==='role-a').length,1);assert.equal(options.filter(option=>option.label==='李青').length,2);assert.ok(options.some(option=>option.value==='narrator'&&option.label==='旁白'));assert.ok(!options.some(option=>option.value==='other-chapter-role'));
});

test('角色ID与正文或角色名搜索共同决定可见段落，旧状态词不再成为筛选分支',()=>{
  const f=fixture();f.env.filter='role-a';assert.deepEqual(f.visible().map(segment=>segment.id),['one','two','excluded']);
  f.env.search='门';assert.deepEqual(f.visible().map(segment=>segment.id),['one']);f.env.filter='role-b';assert.deepEqual(f.visible().map(segment=>segment.id),['three']);
  f.env.filter='all';f.env.search='李青';assert.deepEqual(f.visible().map(segment=>segment.id),['one','two','three','excluded']);
  f.env.search='旁白';assert.deepEqual(f.visible().map(segment=>segment.id),['narration']);f.env.filter='role-a';assert.deepEqual(f.visible(),[]);
  f.env.search='';f.env.filter='pending';assert.deepEqual(f.visible().map(segment=>segment.id),['old-status-id']);
});

test('全选仅选可见且参与朗读的段落，排除行不会让已全选状态变成假未选；取消清空',()=>{
  const f=fixture();f.env.filter='role-a';f.env.checked=['one','two'];assert.equal(f.all().props.checked,true);assert.equal(f.all().props.disabled,false);
  f.all().props.onChange({target:{checked:true}});assert.deepEqual(f.env.checked,['one','two']);assert.ok(!f.env.checked.includes('excluded'));
  f.all().props.onChange({target:{checked:false}});assert.deepEqual(f.env.checked,[]);assert.equal(f.all().props.checked,false);
  f.env.filter='all';f.env.search='门';f.all().props.onChange({target:{checked:true}});assert.deepEqual(f.env.checked,['one','three']);
});

test('仅有排除行或搜索无结果时全选不可用，不受其他隐藏勾选干扰',()=>{
  const f=fixture();f.env.checked=['one','two'];f.env.filter='excluded-role';assert.deepEqual(f.visible().map(segment=>segment.id),['excluded-only']);assert.equal(f.all().props.checked,false);assert.equal(f.all().props.disabled,true);
  f.env.filter='all';f.env.search='没有这句';assert.equal(f.all().props.checked,false);assert.equal(f.all().props.disabled,true);
});

test('同角色选择零副作用，切换角色清勾选并关闭旧角色与音色范围面板',()=>{
  const f=fixture();f.env.filter='role-a';f.env.checked=['one','two'];f.env.rebindOpen=true;f.env.voiceTarget={segmentIds:['one','two']};
  f.select().props.onChange('role-a');assert.deepEqual(f.calls,{filters:[],checked:[],rebind:[],voices:[]});assert.deepEqual(f.env.checked,['one','two']);assert.equal(f.env.rebindOpen,true);
  f.select().props.onChange('role-b');assert.deepEqual(f.calls,{filters:['role-b'],checked:[[]],rebind:[false],voices:[null]});assert.deepEqual(f.env.checked,[]);assert.equal(f.env.rebindOpen,false);assert.equal(f.env.voiceTarget,null);assert.deepEqual(f.visible().map(segment=>segment.id),['three']);
});

test('批量音色入口只携带所选段落ID快照，不改变角色归属也不发送生成请求',()=>{
  const f=fixture();f.env.checked=['one','three'];const checked=f.env.checked,tree=f.bar(),bind=button(tree,'改绑音色');assert.ok(bind);assert.equal(bind.props.disabled,false);assert.equal(button(tree,'确认归属'),undefined);
  assert.equal(nodes(button(tree,'生成所选')).find(node=>node.type==='AudioLines')?.type,'AudioLines');assert.equal(nodes(bind).find(node=>node.type==='MicVocal')?.type,'MicVocal');assert.equal(nodes(bind).some(node=>node.type==='AudioLines'),false,'音色与生成动作使用不同图标');
  bind.props.onClick();assert.deepEqual(f.calls.voices,[{segmentIds:['one','three']}]);assert.notEqual(f.calls.voices[0].segmentIds,checked);checked.push('added-later');assert.deepEqual(f.calls.voices[0].segmentIds,['one','three']);assert.deepEqual(f.calls.filters,[]);assert.deepEqual(f.calls.rebind,[]);
  for(const guards of [{locked:true},{busy:true},{connectionReady:false}]){const guarded=fixture();guarded.env.checked=['one'];Object.assign(guarded.env,guards);assert.equal(button(guarded.bar(),'改绑音色').props.disabled,true);}
});
