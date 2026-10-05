import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8').replace(/^import .*;\n/gm,''),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const client = await import('data:text/javascript;base64,'+Buffer.from(compile('../src/assistantClient.ts')).toString('base64'));
const compiled=compile('../src/AssistantPanel.tsx');
const nodes = node => !node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const find=(tree,label)=>nodes(tree).find(n=>n.props?.['aria-label']===label||n.type==='Select'&&n.props.label===label||n.type==='button'&&text(n)===label);
const tick=()=>new Promise(done=>setImmediate(done));
const config={revision:1,enabled:true,configured:true,hasKey:true,baseUrl:'https://example.invalid/v1',model:'test',credentialSource:'audio',vision:true};
const session=id=>({id,projectId:'p',chapterId:'c'+id,title:id,state:'active',revision:1});
const detail=id=>({session:session(id),messages:[],runs:[],steps:[],attachments:[],capabilities:[]});
let sequence=0;
async function setup({request,initial,records=new Map(),component="default",sessionRows=[session('A'),session('B')],savedConfig=config}={}){
  let index=0,queued=[],rendered;const values=[],effects=[],calls=[],saved=[],timers=new Map();let timerSequence=0;
  const api=async(path,body,method)=>{calls.push([path,body,method]);if(path==='/assistant/config'&&!body)return savedConfig;if(path==='/assistant/sessions'&&!body)return typeof sessionRows==='function'?sessionRows():sessionRows;if(request){const value=await request(path,body,method);if(value!==undefined)return value;}return detail(path.endsWith('/B')?'B':'A');};
  const state={settings:{workspaceIdentity:'w'},projects:[{id:'p',name:'测试'}],chapters:[{id:'cA',projectId:'p',title:'甲章'},{id:'cB',projectId:'p',title:'乙章'}],voices:[],roles:[]};
  const props={state,config,connected:true,onSaved:()=>{},projectId:'p',chapterId:'cA',selectedSegmentIds:['segment'],connected:true,pane:'settings',onClose:()=>{},onManual:()=>{},onNavigate:()=>{},onUIAction:async()=>{},withSavedScope:async(binding,work)=>{saved.push(binding);await work();},refresh:async()=>{},...initial};
  globalThis.window={setInterval:fn=>{const id=++timerSequence;timers.set(id,fn);return id;},clearInterval:id=>timers.delete(id)};
  globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});
  globalThis.FileReader=class {readAsDataURL(){this.result='data:image/png;base64,YWJj';this.onload();}};
  globalThis.assistantClientTest={...client,React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},useRef:value=>{const i=index++;return values[i]||=( {current:value});},useState:value=>{const i=index++;if(!(i in values))values[i]=typeof value==='function'?value():value;return[values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}];},useEffect:(fn,deps)=>{const i=index++;if(!effects[i]||deps.some((v,n)=>v!==effects[i].deps[n]))queued.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});},api,readDraft:key=>records.has(key)?{draft:records.get(key),revision:1}:null,writeDraft:(key,value)=>records.set(key,structuredClone(value)),clearDraft:key=>records.delete(key),draftWorkspace:()=> 'w',Dialog:'Dialog',Field:'Field',Select:'Select',ArrowDown:'Icon',ArrowUp:'Icon',ImagePlus:'Icon',MessageSquare:'Icon',Plus:'Icon',Settings2:'Icon',X:'Icon'};
  const module=await import('data:text/javascript;base64,'+Buffer.from('const {'+Object.keys(globalThis.assistantClientTest).join(',')+'}=globalThis.assistantClientTest;\n'+compiled+'\n//'+sequence++).toString('base64'));
  const render=()=>{index=0;rendered=module[component](props);const work=queued;queued=[];work.forEach(fn=>fn());return rendered;};
  render();await tick();render();await tick();render();
  return {render,props,calls,records,saved,poll:()=>[...timers.values()].at(-1)?.(),timerCount:()=>timers.size,unmount:()=>effects.forEach(e=>e?.cleanup?.()),change:value=>{find(render(),'给助手的消息').props.onChange({target:{value}});},find:label=>find(render(),label)};
}

test('截图输入边界与提案展示覆盖实际内容，包括未知字段和嵌套修改',()=>{
  assert.throws(()=>client.checkAssistantFiles([{type:'image/svg+xml',size:100}],[]),/PNG/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:6*1024*1024}],[]),/5 MB/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:1},{type:'image/png',size:1}],[{bytes:1}]),/两张/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:5*1024*1024}],[{bytes:4*1024*1024}]),/8 MB/);
  const rows=client.assistantPreviewRows({data:{text:'全部正文\n第二行',excluded:false},newField:'不得隐藏'},x=>x);
  assert.deepEqual(rows.map(r=>r.value),['全部正文\n第二行','否','不得隐藏']);
});

test('已开启图片输入时可直接发送纯图片；IME输入不会误发',async()=>{
  let posted;
  const records=new Map([['assistant:A',{...client.newAssistantDraft(),mode:'ask',attachments:[{id:'pic',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3}]}]]);
  const f=await setup({records,request:async(path,body)=>{if(path.endsWith('/messages')){posted=body;return {...detail('A'),messages:[{id:body.messageId,role:'user',content:'',attachmentIds:['pic']}]};}}});
  f.find('给助手的消息').props.onKeyDown({key:'Enter',shiftKey:false,nativeEvent:{isComposing:true},preventDefault(){throw Error('IME intercepted');}});assert.equal(posted,undefined);
  assert.equal(f.find('发送').props.disabled,false);f.find('发送').props.onClick();await tick();
  assert.deepEqual(posted.attachmentIds,['pic']);assert.ok(posted.materials.includes('image'));assert.equal(posted.text,'');assert.equal('dataBase64'in posted,false);assert.deepEqual(f.saved,[]);assert.equal(f.records.get('assistant:A').pending,undefined);f.unmount();
});

test('未知回执保留原消息ID，重开只核对不自动重发；显式重试不重复费用意图',async()=>{
  const posts=[];const f=await setup({request:async(path,body)=>{if(path.endsWith('/messages')){posts.push(body);throw Error('连接中断');}}});f.change('解释这个页面');f.find('发送').props.onClick();f.find('正在提交…').props.onClick();await tick();assert.equal(posts.length,1);const id=posts[0].messageId;assert.equal(f.records.get('assistant:A').pending.messageId,id);f.unmount();
  const g=await setup({records:f.records,request:async(path,body)=>{if(path.endsWith('/messages')){posts.push(body);return {...detail('A'),messages:[{id:body.messageId,role:'user',content:body.text,attachmentIds:[]}]};}}});assert.equal(posts.length,1);g.find('核对后重试原消息').props.onClick();await tick();assert.equal(posts.length,2);assert.equal(posts[1].messageId,id);assert.equal(g.records.get('assistant:A').pending,undefined);g.unmount();
});

test('迟到截图仅归属原会话；跨会话切换保留各自草稿',async()=>{
  let resolveUpload;const f=await setup({request:async(path)=>{if(path==='/assistant/attachments')return new Promise(done=>{resolveUpload=done;});}});
  f.change('甲草稿');const file={type:'image/png',size:3};const fileInput=nodes(f.render()).find(n=>n.type==='input'&&n.props.type==='file');fileInput.props.onChange({target:{files:[file],value:'x'}});await tick();
  f.find('助手会话').props.onChange('B');await tick();f.change('乙草稿');resolveUpload({id:'late',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3});await tick();
  assert.deepEqual(f.records.get('assistant:A').attachments.map(a=>a.id),['late']);assert.equal(f.records.get('assistant:B').text,'乙草稿');assert.deepEqual(f.records.get('assistant:B').attachments,[]);assert.equal(f.find('给助手的消息').props.value,'乙草稿');f.unmount();
});

test('委托任务先保存绑定章节，保存冲突零发送且输入仍可改正',async()=>{
  let posted=0;const records=new Map([['assistant:A',{...client.newAssistantDraft(),text:'帮我制作',mode:'task'}]]);
  const f=await setup({records,initial:{withSavedScope:async()=>{throw Error('请先处理保存冲突');}},request:async(path)=>{if(path.endsWith('/messages'))posted++;}});f.find('发送').props.onClick();await tick();assert.equal(posted,0);assert.equal(f.records.get('assistant:A').pending,undefined);assert.equal(f.find('给助手的消息').props.disabled,false);assert.match(text(f.render()),/保存冲突/);f.unmount();
});

test('任务卡批准使用冻结绑定与版本；关闭仅卸载轮询不停止后台任务',async()=>{
  const run={id:'r',state:'awaitingApproval',revision:5,objective:'编辑指定正文',mode:'task',planVersion:2,binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:1,analysis:0,audio:0}}};let sent;
  const f=await setup({initial:{chapterId:'cB'},request:async(path,body)=>{if(path.endsWith('/decision')){sent=body;return {...detail('A'),runs:[{...run,state:'executing'}]};}if(path==='/assistant/sessions/A')return {...detail('A'),runs:[run],steps:[{id:'s',runId:'r',ordinal:0,capabilityId:'segment.update',description:'修改正文',state:'proposed',input:{text:'需要保留的完整改动'}}]};},records:new Map([['assistant-current',{id:'A'}]])});
  assert.match(text(f.render()),/需要保留的完整改动/);f.find('批准并开始').props.onClick();await tick();assert.deepEqual(f.saved,[{projectId:'p',chapterId:'cA'}]);assert.equal(sent.revision,5);assert.equal(sent.decisionId,'r:5:yes');f.unmount();assert.equal(f.calls.filter(([path])=>path.endsWith('/control')).length,0);
});


test('用户可更换任意助手模型并自行设置图片能力，保存只写连接配置',async()=>{
  const saved=[];
  const f=await setup({component:'AssistantConnection',request:async(path,body,method)=>{if(path==='/assistant/config'&&method==='PUT'){saved.push(body);return {...config,...body,revision:body.revision+1};}}});
  assert.equal(f.find('验证识图能力'),undefined);assert.doesNotMatch(text(f.render()),/同意发送测试图片|尚未通过识图验证/);
  const model=nodes(f.render()).find(n=>n.type==='input'&&n.props.placeholder==='claude-sonnet-5-5');model.props.onChange({target:{value:'my-image-model'}});
  const imageOption=()=>nodes(nodes(f.render()).find(n=>n.type==='label'&&text(n)==='此模型支持图片输入')).find(n=>n.type==='input');
  imageOption().props.onChange({target:{checked:false}});f.find('保存连接').props.onClick();await tick();
  assert.equal(saved[0].model,'my-image-model');assert.equal(saved[0].vision,false);assert.equal(saved[0].revision,1);assert.equal('apiKey'in saved[0],false);
  imageOption().props.onChange({target:{checked:true}});f.find('保存连接').props.onClick();await tick();assert.equal(saved[1].vision,true);assert.equal(saved[1].revision,2);
  assert.deepEqual(f.calls.map(([path,,method])=>[path,method]),[['/assistant/config','PUT'],['/assistant/config','PUT']]);f.unmount();
});


test('结果不明的重发必须再次授权，核对只包含明确步骤与尝试ID',async()=>{
  const decisions=[],run={reconciliation:{steps:[{stepId:'step',description:'生成一段',canRetry:true,attempts:[{id:'attempt',status:'unknown'}]}]}};
  const f=await setup({component:'AssistantReconciliation',initial:{run,busy:false,reconcile:async body=>decisions.push(body)}});
  assert.equal(f.find('重新发送并继续').props.disabled,true);f.find('重新发送并继续').props.onClick();assert.deepEqual(decisions,[]);
  const consent=nodes(f.render()).find(n=>n.type==='label');nodes(consent).find(n=>n.type==='input').props.onChange({target:{checked:true}});f.find('重新发送并继续').props.onClick();await tick();assert.deepEqual(decisions,[{stepId:'step',acknowledgedAttemptIds:['attempt'],resolution:'retry'}]);
  f.find('保留已有结果').props.onClick();await tick();assert.equal(decisions[1].resolution,'keep-results');f.unmount();
});

test('调整任务总额度不得低于已用次数，集中音色仅提交明确角色选择',async()=>{
  const changed=[],run={budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:2,analysis:1,audio:5}},voicePolicy:'askMissing',materials:['text'],voiceQuestions:[{roleId:'r',roleName:'旁白',segmentIds:['s'],availableVoiceIds:['voice']}]};
  const f=await setup({component:'AssistantMandate',initial:{run,voices:[{id:'voice',name:'声音',state:'active'},{id:'retired',name:'已停用',state:'retired'},{id:'outside',name:'非候选',state:'active'}],busy:false,amend:async body=>changed.push(body)}});
  assert.deepEqual(nodes(f.render()).filter(n=>n.type==='Select').map(n=>n.props.label),['旁白使用音色','后续缺少音色时']);assert.equal(nodes(f.render()).some(n=>n.type==='select'),false);assert.deepEqual(f.find('旁白使用音色').props.options.map(o=>o.value),['','voice']);
  f.props.busy=true;assert.ok(nodes(f.render()).filter(n=>n.type==='input'||n.type==='Select').every(n=>n.props.disabled));f.props.busy=false;
  const numeric=nodes(f.render()).filter(n=>n.type==='input'&&n.props.type==='number');assert.equal(numeric[0].props.min,2);numeric[0].props.onChange({target:{value:'1'}});assert.equal(f.find('保存本次任务范围').props.disabled,true);
  numeric[0].props.onChange({target:{value:'20'}});f.find('旁白使用音色').props.onChange('voice');f.find('保存本次任务范围').props.onClick();await tick();assert.equal(changed[0].limits.assistant,20);assert.deepEqual(changed[0].roleVoiceChoices,{r:'voice'});assert.equal(changed[0].acceptCurrentConnection,undefined);assert.deepEqual(changed[0].workflowKinds,['dry']);assert.equal(changed[0].stepLimit,40);
  const workflow=nodes(f.render()).find(n=>n.type==='label'&&text(n)==='允许场景制作');nodes(workflow).find(n=>n.type==='input').props.onChange({target:{checked:true}});const steps=nodes(f.render()).find(n=>n.type==='label'&&text(n).startsWith('本任务步骤上限'));nodes(steps).find(n=>n.type==='input').props.onChange({target:{value:'80'}});f.find('保存本次任务范围').props.onClick();await tick();assert.deepEqual(changed[1].workflowKinds,['dry','scene']);assert.equal(changed[1].stepLimit,80);f.unmount();
});

test('正在任务保存范围只提交实际修改的额度项，未改自动额度不变为明确限制',async()=>{
  const posted=[],run={state:'awaitingUser',budget:{limits:{assistant:40,analysis:3,audio:138},used:{assistant:2,analysis:1,audio:5}},voicePolicy:'askMissing',materials:['text','reference']};
  const f=await setup({component:'AssistantMandate',initial:{run,voices:[],connected:true,busy:false,amend:async body=>posted.push(body)}});
  f.find('保存并继续处理').props.onClick();await tick();assert.equal('limits'in posted[0],false);
  nodes(f.render()).find(n=>n.type==='input'&&n.props.type==='number').props.onChange({target:{value:'20'}});f.find('保存并继续处理').props.onClick();await tick();assert.deepEqual(posted[1].limits,{assistant:20});assert.equal('audio'in posted[1].limits,false);assert.equal('analysis'in posted[1].limits,false);f.unmount();
});


test('归档非当前会话不切换当前、清草稿或串入另一会话附件',async()=>{
  const records=new Map([['assistant:A',{...client.newAssistantDraft(),text:'甲未发送',attachments:[{id:'pic-A',sessionId:'A'}]}],['assistant:B',{...client.newAssistantDraft(),text:'乙未发送',attachments:[{id:'pic-B',sessionId:'B'}]}]]);
  const f=await setup({records});const before=structuredClone([...records]);
  f.find('归档会话 B').props.onClick();await tick();
  assert.equal(f.find('助手会话').props.value,'A');assert.equal(f.find('给助手的消息').props.value,'甲未发送');assert.deepEqual([...records],before);
  assert.equal(f.calls.filter(([path,,method])=>path==='/assistant/sessions/B'&&method==='DELETE').length,1);assert.equal(f.calls.filter(([path,,method])=>path==='/assistant/sessions/B'&&method!=='DELETE').length,0);f.unmount();
});

test('删除对话先呈现具体会话范围与永久后果，确认仅清所选会话草稿和图片',async()=>{
  const records=new Map([['assistant:A',{...client.newAssistantDraft(),text:'甲草稿',attachments:[{id:'pic-A',sessionId:'A'}]}],['assistant:B',{...client.newAssistantDraft(),text:'乙草稿',attachments:[{id:'pic-B',sessionId:'B'}]}]]),a=structuredClone(records.get('assistant:A'));
  const f=await setup({records,request:async(path,body)=>path.endsWith('/content-delete')?{sessionId:body.sessionId,deleted:true}:undefined});
  f.find('删除对话内容 B').props.onClick();await tick();
  assert.match(text(f.render()),/删除“B”的对话内容/);assert.match(text(f.render()),/乙章，仅此会话/);assert.match(text(f.render()),/无法恢复/);assert.match(text(f.render()),/费用不会撤销/);assert.equal(f.calls.some(([path])=>path.endsWith('/content-delete')),false);
  f.find('永久删除此会话内容').props.onClick();await tick();
  const submitted=f.calls.find(([path])=>path.endsWith('/content-delete'));assert.deepEqual(submitted[1],{sessionId:'B',revision:1,confirmed:true});
  assert.equal(records.has('assistant:B'),false);assert.deepEqual(records.get('assistant:A'),a);assert.equal(f.find('助手会话').props.value,'A');assert.equal(f.find('给助手的消息').props.value,'甲草稿');f.unmount();
});

test('默认委托发送就是授权，按任务推导额度和功能，聊天只显示自然进度',async()=>{
  let submitted;
  const run={id:'r',state:'executing',revision:2,mode:'task',objective:'制作本章',summary:'正在准备声音',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:40,analysis:4,audio:170},used:{assistant:1,analysis:0,audio:0}}};
  const f=await setup({request:async(path,body)=>{if(path.endsWith('/messages')){submitted=body;return {...detail('A'),runs:[run],messages:[{id:body.messageId,role:'user',content:body.text,attachmentIds:[]}]};}}});
  assert.equal(nodes(nodes(f.render()).find(n=>n.type==='label'&&text(n)==='交给助手做')).find(n=>n.type==='input').props.checked,true);
  assert.equal(f.find('完成目标'),undefined);assert.equal(nodes(f.render()).some(n=>n.props?.className==='assistant-mandate'),false);
  f.change('帮我做好这一章');f.find('发送').props.onClick();await tick();
  assert.equal(submitted.mode,'task');assert.equal(submitted.approved,true);assert.equal(submitted.voicePolicy,'askMissing');assert.deepEqual(submitted.allowedVoiceIds,[]);
  for(const field of ['limits','materials','workflowKinds','stepLimit','completionTarget'])assert.equal(field in submitted,false,field+' must derive from task');
  assert.deepEqual(f.saved,[session('A')]);assert.match(text(f.render()),/正在准备声音/);assert.equal(nodes(f.render()).some(n=>n.props?.className==='assistant-task-card'),false);assert.equal(f.calls.some(([path])=>path.endsWith('/decision')),false);
  f.find('助手任务').props.onClick();const taskDialog=nodes(f.render()).find(n=>n.type==='Dialog'&&n.props.title==='助手任务');assert.ok(taskDialog);assert.ok(nodes(taskDialog).some(n=>n.props?.className==='assistant-task-card'));assert.ok(find(taskDialog,'暂停后续步骤'));taskDialog.props.onClose();assert.equal(nodes(f.render()).some(n=>n.props?.className==='assistant-task-card'),false);f.unmount();
});

test('只调整一个额度不会把其他默认数值变成限制；显式材料和工作流限制随草稿保留',async()=>{
  const f=await setup();f.find('本次任务设置').props.onClick();
  const numbers=nodes(f.render()).filter(n=>n.type==='input'&&n.props.type==='number');numbers[0].props.onChange({target:{value:'8'}});
  const checkbox=label=>nodes(nodes(f.render()).find(n=>n.type==='label'&&text(n)===label)).find(n=>n.type==='input');
  checkbox('允许生成时使用参考音频').props.onChange({target:{checked:false}});checkbox('允许场景制作').props.onChange({target:{checked:false}});
  const held=f.records.get('assistant:A');assert.deepEqual(client.assistantTaskOptions(held),{limits:{assistant:8},materials:['text'],workflowKinds:['dry','group']});f.unmount();
  let submitted;const g=await setup({records:f.records,request:async(path,body)=>{if(path.endsWith('/messages')){submitted=body;return detail('A');}}});g.change('准备本章');g.find('发送').props.onClick();await tick();
  assert.deepEqual(submitted.limits,{assistant:8});assert.deepEqual(submitted.materials,['text']);assert.deepEqual(submitted.workflowKinds,['dry','group']);assert.equal('stepLimit'in submitted,false);g.unmount();
  const legacy={text:'',attachments:[],mode:'task',limits:{assistant:12,analysis:3,audio:2},workflowKinds:['dry','scene'],stepLimit:70,completionTarget:'chapter-master',materials:['text'],voicePolicy:'askMissing',allowedVoiceIds:[],textMutationPolicy:'preserveExact'};
  assert.deepEqual(client.assistantTaskOptions(legacy),{limits:{audio:2},workflowKinds:['dry','scene'],stepLimit:70,completionTarget:'chapter-master'});
});

test('真正缺声时只出现集中选声，选定后自动继续而不再要求恢复按钮',async()=>{
  for(const after of ['paused','executing']){
    const run={id:'r',state:'awaitingUser',revision:3,mode:'task',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:1,analysis:0,audio:0}},voiceQuestions:[{roleId:'role',roleName:'旁白',segmentIds:['s'],availableVoiceIds:['voice']}]};
    let updated=run;const controls=[];
    const f=await setup({request:async(path,body)=>{if(path.endsWith('/control')){controls.push(body);updated={...run,state:body.action==='resume'?'executing':after,revision:body.action==='resume'?5:4,voiceQuestions:[]};return {...detail('A'),session:{...session('A'),revision:updated.revision},runs:[updated]};}if(path==='/assistant/sessions/A')return {...detail('A'),runs:[updated]};}});
    const choice=nodes(f.render()).find(n=>typeof n.type==='function'&&n.type.name==='AssistantMandate');assert.equal(choice.props.choicesOnly,true);assert.equal(nodes(f.render()).some(n=>n.props?.className==='assistant-task-card'),false);
    await choice.props.amend({roleVoiceChoices:{role:'voice'}});await tick();assert.equal(controls[0].action,'amend');assert.equal(controls[0].revision,3);assert.deepEqual(controls[0].roleVoiceChoices,{role:'voice'});assert.equal(controls[0].limits,undefined);
    assert.deepEqual(controls.map(b=>b.action),after==='paused'?['amend','resume']:['amend']);if(after==='paused')assert.equal(controls[1].revision,4);assert.equal(nodes(f.render()).some(n=>n.type==='Dialog'&&n.props.title==='需要你决定'),false);assert.deepEqual(f.saved,[run.binding]);f.unmount();
  }
  const posted=[];const h=await setup({component:'AssistantMandate',initial:{choicesOnly:true,connected:true,busy:false,run:{budget:{limits:{assistant:12,analysis:3,audio:100}},voiceQuestions:[{roleId:'role',roleName:'旁白',segmentIds:['s'],availableVoiceIds:['voice']}]},voices:[{id:'voice',name:'声音',state:'active'}],amend:async body=>posted.push(body)}});
  assert.equal(nodes(h.render()).some(n=>n.type==='input'&&n.props.type==='number'),false);assert.equal(h.find('选好声音，继续处理').props.disabled,true);h.find('旁白使用音色').props.onChange('voice');h.find('选好声音，继续处理').props.onClick();await tick();assert.deepEqual(posted,[{roleVoiceChoices:{role:'voice'}}]);h.unmount();
});

test('关闭必要决定窗口后相同版本轮询不会反复弹出，新决定才重新提示',async()=>{
  let revision=3;const run=()=>({id:'r',state:'awaitingUser',revision,mode:'task',questions:['请说明目标'],binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:1,analysis:0,audio:0}}});
  const f=await setup({request:async path=>path==='/assistant/sessions/A'?{...detail('A'),runs:[run()]}:undefined});
  const dialog=()=>nodes(f.render()).find(n=>n.type==='Dialog'&&n.props.title==='需要你决定');assert.ok(dialog());dialog().props.onClose();assert.equal(dialog(),undefined);f.poll();await tick();assert.equal(dialog(),undefined);
  revision=4;f.poll();await tick();f.render();assert.ok(dialog());assert.equal(f.calls.some(([,body])=>body),false);f.unmount();
});

test('选声后仍有额度或未知结果异常时不自动恢复，必要处理窗口保留',async()=>{
  for(const blocker of [{error:'本次明确额度已用尽'},{reconciliation:{assistantRequest:{id:'unknown',state:'unknown'},steps:[]}}]){
    const run={id:'r',state:'awaitingUser',revision:3,mode:'task',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:1},used:{assistant:1,analysis:0,audio:1}},voiceQuestions:[{roleId:'role',roleName:'旁白',segmentIds:['s'],availableVoiceIds:['voice']}]};
    const f=await setup({request:async(path,body)=>{if(path.endsWith('/control'))return {...detail('A'),session:{...session('A'),revision:4},runs:[{...run,state:'paused',revision:4,voiceQuestions:[],...blocker}]};if(path==='/assistant/sessions/A')return {...detail('A'),runs:[run]};}});
    await nodes(f.render()).find(n=>typeof n.type==='function'&&n.type.name==='AssistantMandate').props.amend({roleVoiceChoices:{role:'voice'}});await tick();f.render();
    assert.deepEqual(f.calls.filter(([path])=>path.endsWith('/control')).map(([,body])=>body.action),['amend']);assert.ok(nodes(f.render()).some(n=>n.type==='Dialog'&&n.props.title==='需要你决定'));f.unmount();
  }
});

test('补齐必要范围或明确重发后同一次操作继续；主动暂停和保留结果不自动续付',async()=>{
  for(const [state,action,resolution,resumes] of [['awaitingUser','amend',undefined,true],['paused','amend',undefined,false],['needsReconciliation','reconcile','retry',true],['needsReconciliation','reconcile','keep-results',false]]){
    const run={id:'r',state,revision:3,mode:'task',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:1},used:{assistant:1,analysis:0,audio:1}},...(action==='reconcile'?{reconciliation:{steps:[{stepId:'s',description:'未知声音结果',attempts:[{id:'attempt',status:'unknown'}],canRetry:true}]}}:{})};
    const f=await setup({request:async(path,body)=>{if(path.endsWith('/control'))return {...detail('A'),session:{...session('A'),revision:4},runs:[{...run,state:body.action==='resume'?'executing':'paused',revision:4,reconciliation:{steps:[]}}]};if(path==='/assistant/sessions/A')return {...detail('A'),runs:[run]};}});
    if(state==='paused')f.find('助手任务').props.onClick();
    const panel=nodes(f.render()).find(n=>typeof n.type==='function'&&n.type.name===(action==='amend'?'AssistantMandate':'AssistantReconciliation'));
    assert.ok(panel);await (action==='amend'?panel.props.amend({limits:{assistant:12,analysis:3,audio:2}}):panel.props.reconcile({stepId:'s',acknowledgedAttemptIds:['attempt'],resolution}));await tick();
    const posted=f.calls.filter(([path])=>path.endsWith('/control')).map(([,body])=>body);assert.deepEqual(posted.map(b=>b.action),resumes?[action,'resume']:[action]);assert.equal(posted[0].revision,3);if(resumes)assert.equal(posted[1].revision,4);assert.deepEqual(f.saved,[run.binding]);f.unmount();
  }
});

test('可选初始额度显示自动，输入明确限制后清空恢复自动推导，工作流说明对应当前功能',async()=>{
  const f=await setup();f.props.state.settings.features={groups:false,scenes:true};f.find('本次任务设置').props.onClick();
  const numbers=()=>nodes(f.render()).filter(n=>n.type==='input'&&n.props.type==='number');assert.equal(numbers().length,4);assert.ok(numbers().every(n=>n.props.value===''&&n.props.placeholder==='自动'));
  assert.match(text(f.render()),/工作流自动按当前启用功能安排/);const checkbox=label=>nodes(nodes(f.render()).find(n=>n.type==='label'&&text(n)===label)).find(n=>n.type==='input');assert.equal(checkbox('允许一起演绎').props.checked,false);assert.equal(checkbox('允许场景制作').props.checked,true);
  numbers()[2].props.onChange({target:{value:'138'}});numbers()[3].props.onChange({target:{value:'200'}});assert.deepEqual(client.assistantTaskOptions(f.records.get('assistant:A')),{limits:{audio:138},stepLimit:200});assert.equal(numbers()[2].props.value,138);
  numbers()[2].props.onChange({target:{value:''}});numbers()[3].props.onChange({target:{value:''}});assert.deepEqual(client.assistantTaskOptions(f.records.get('assistant:A')),{});assert.ok(numbers().every(n=>n.props.value===''));f.unmount();
});

test('初始旧列表过滤已删会话；删除最后会话后可直接输入，首次发送才创建且不会丢草稿',async()=>{
  let removed=false;const tombstone={...session('B'),state:'archived',contentDeletion:{revision:1,at:'old'}};const rows=()=>removed?[tombstone]:[session('A'),tombstone];
  const f=await setup({sessionRows:rows,request:async(path,body)=>{if(path.endsWith('/content-delete')){removed=true;return {sessionId:body.sessionId,deleted:true};}if(path==='/assistant/sessions'&&body)return detail('C');if(path.endsWith('/messages'))return {...detail('C'),messages:[{id:body.messageId,role:'user',content:body.text,attachmentIds:[]}]};}});
  assert.deepEqual(f.find('助手会话').props.options.map(s=>s.value),['A']);assert.equal(f.find('删除对话内容 B'),undefined);
  f.find('删除对话内容 A').props.onClick();await tick();f.find('永久删除此会话内容').props.onClick();await tick();
  assert.equal(f.find('助手会话').props.value,'');assert.deepEqual(f.find('助手会话').props.options,[]);assert.equal(f.records.has('assistant-current'),false);assert.equal(f.timerCount(),0);assert.equal(f.find('在当前章节开始'),undefined);assert.ok(f.find('给助手的消息'));
  f.change('继续做这一章');assert.equal(f.calls.filter(([path,body])=>path==='/assistant/sessions'&&body).length,0);f.find('发送').props.onClick();await tick();
  assert.equal(f.calls.filter(([path,body])=>path==='/assistant/sessions'&&body).length,1);const submitted=f.calls.find(([path])=>path.endsWith('/messages'));assert.equal(submitted[0],'/assistant/sessions/C/messages');assert.equal(submitted[1].text,'继续做这一章');assert.equal(f.records.has('assistant-new:p:cA'),false);assert.equal(f.find('助手会话').props.value,'C');f.unmount();
});

test('空聊天创建失败仍保留输入和绑定；仅添加截图按需创建一次会话',async()=>{
  const f=await setup({sessionRows:[],request:async(path,body)=>{if(path==='/assistant/sessions'&&body)throw Error('建立连接失败');}});f.change('不能丢失的新任务');f.find('发送').props.onClick();await tick();assert.equal(f.find('给助手的消息').props.value,'不能丢失的新任务');assert.equal(f.records.get('assistant-new:p:cA').text,'不能丢失的新任务');assert.equal(f.calls.some(([path])=>path.endsWith('/messages')),false);f.unmount();
  const rows=[];const g=await setup({sessionRows:rows,request:async(path,body)=>{if(path==='/assistant/sessions'&&body){rows.push(session('A'));return detail('A');}if(path==='/assistant/attachments')return {id:'new-pic',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3};}});g.change('看看这张图');nodes(g.render()).find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{type:'image/png',size:3}],value:'x'}});await tick();
  assert.equal(g.calls.filter(([path,body])=>path==='/assistant/sessions'&&body).length,1);assert.equal(g.find('给助手的消息').props.value,'看看这张图');assert.deepEqual(g.records.get('assistant:A').attachments.map(a=>a.id),['new-pic']);assert.equal(g.calls.some(([path])=>path.endsWith('/messages')),false);g.unmount();
});

test('删除回执后迟到旧列表仍过滤删除项，当前已删404清轮询且不打开旧账本',async()=>{
  let lists=0,resolveRows;const f=await setup({sessionRows:()=>++lists===1?[session('A'),session('B')]:new Promise(done=>{resolveRows=done;}),request:async(path,body)=>path.endsWith('/content-delete')?{sessionId:body.sessionId,deleted:true}:undefined});
  f.find('删除对话内容 A').props.onClick();await tick();f.find('永久删除此会话内容').props.onClick();await tick();assert.equal(f.find('助手会话').props.value,'');assert.equal(f.find('助手任务'),undefined);assert.equal(f.timerCount(),0);
  resolveRows([session('A'),session('B')]);await tick();assert.deepEqual(f.find('助手会话').props.options.map(s=>s.value),['B']);assert.equal(f.find('助手会话').props.value,'B');f.unmount();
  let gone=false;const g=await setup({records:new Map([['assistant:A',{...client.newAssistantDraft(),text:'应清除的旧草稿'}]]),request:async path=>{if(path==='/assistant/sessions/A'&&gone)throw Object.assign(Error('会话已删除'),{status:404});}});
  gone=true;g.poll();await tick();g.render();assert.equal(g.find('助手会话').props.options.some(s=>s.value==='A'),false);assert.equal(g.find('给助手的消息').props.value,'');assert.equal(g.records.has('assistant:A'),false);assert.equal(g.records.has('assistant-current'),false);assert.equal(g.timerCount(),0);g.unmount();
});

test('空聊天按章节保留输入，首次建会话期间切章不会串入新章草稿或切回旧章',async()=>{
  let finishCreate,submitted;const f=await setup({sessionRows:[],request:async(path,body)=>{if(path==='/assistant/sessions'&&body)return new Promise(done=>{finishCreate=done;});if(path.endsWith('/messages')){submitted=body;return {...detail('A'),messages:[{id:body.messageId,role:'user',content:body.text,attachmentIds:[]}]};}}});
  f.change('甲章授权任务');f.props.chapterId='cB';f.render();assert.equal(f.find('给助手的消息').props.value,'');f.change('乙章未发送草稿');f.props.chapterId='cA';f.render();assert.equal(f.find('给助手的消息').props.value,'甲章授权任务');
  f.find('发送').props.onClick();await tick();f.props.chapterId='cB';f.render();assert.equal(f.find('给助手的消息').props.value,'乙章未发送草稿');finishCreate(detail('A'));await tick();
  assert.equal(submitted.text,'甲章授权任务');assert.equal(f.find('助手会话').props.value,'');assert.equal(f.find('给助手的消息').props.value,'乙章未发送草稿');assert.equal(f.records.get('assistant-new:p:cB').text,'乙章未发送草稿');assert.equal(f.records.get('assistant:A').text,'甲章授权任务');assert.deepEqual(f.saved,[session('A')]);f.unmount();
});

test('取消删除不清任何材料，归档会话没有编辑或续跑入口',async()=>{
  const f=await setup();f.change('保留这段草稿');f.find('删除对话内容 B').props.onClick();await tick();f.find('保留对话').props.onClick();assert.equal(f.calls.some(([path])=>path.endsWith('/content-delete')),false);assert.equal(f.find('给助手的消息').props.value,'保留这段草稿');f.unmount();
  const archived=await setup({request:async path=>path==='/assistant/sessions/A'?{...detail('A'),session:{...session('A'),state:'archived',revision:2},messages:[{id:'old',role:'user',content:'归档全文',attachmentIds:[]}]}:undefined});
  assert.match(text(archived.render()),/归档全文/);assert.match(text(archived.render()),/可只读查看/);assert.equal(archived.find('给助手的消息'),undefined);archived.unmount();
});

test('删除后的迟到读取不能复活聊天、待发送草稿或截图',async()=>{
  let delay=false,resolveLate,removed=false;
  const kept=new Map([['assistant:A',{...client.newAssistantDraft(),text:'将清除草稿',attachments:[{id:'private-image',sessionId:'A'}]}]]);
  const modern=()=>({sessionId:'A',deleted:true});
  const f=await setup({records:kept,request:async(path)=>{
    if(path.endsWith('/content-delete')){removed=true;return modern();}
    if(path==='/assistant/sessions/A'){if(delay){delay=false;return new Promise(done=>{resolveLate=done;});}return removed?modern():detail('A');}
  }});
  delay=true;f.poll();await tick();f.find('删除对话内容 A').props.onClick();await tick();f.find('永久删除此会话内容').props.onClick();await tick();
  resolveLate({...detail('A'),messages:[{id:'stale',role:'user',content:'不应复活的私有聊天',attachmentIds:['private-image']}],attachments:[{id:'private-image',sessionId:'A'}]});await tick();
  assert.equal(kept.has('assistant:A'),false);assert.equal(f.find('助手会话').props.value,'B');assert.deepEqual(f.find('助手会话').props.options.map(s=>s.value),['B']);assert.equal(f.find('删除对话内容 A'),undefined);assert.equal(text(f.render()).includes('不应复活的私有聊天'),false);assert.equal(nodes(f.render()).some(n=>n.type==='img'&&n.props.src.includes('private-image')),false);assert.doesNotMatch(text(f.render()),/对话内容已永久删除/);f.unmount();
});

test('具体批准显示既有及新建台词与旧新音色，并显式呈现朗读范围变化',async()=>{
  const run={id:'r',state:'awaitingApproval',revision:1,mode:'task',textMutationPolicy:'preserveExact',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:2,analysis:0,audio:0},used:{assistant:1,analysis:0,audio:0}}};
  const f=await setup({request:async path=>path==='/assistant/sessions/A'?{...detail('A'),runs:[run],steps:[{id:'s',runId:'r',ordinal:0,state:'proposed',description:'改变配音设置',input:{excluded:true},preview:{effects:{voiceAssignments:[{roleId:'role',segmentId:'segment',segmentText:'第二句完整正文',before:'voice-old',after:'voice-new'},{roleId:'role',segmentText:'新建台词完整正文',before:null,after:'voice-new',source:'new-segment'},{roleId:'role',before:null,after:'voice-new',source:'role-default'}],readingRange:{before:{text:'第一句。第二句。',spans:[]},after:{text:'第一句。',spans:[]}}}}}]}:undefined});
  f.props.state.roles=[{id:'role',name:'旁白'}];f.props.state.voices=[{id:'voice-old',name:'原音色'},{id:'voice-new',name:'新音色'}];
  const rendered=text(f.render());assert.match(rendered,/旁白 · 台词 第二句完整正文/);assert.match(rendered,/原音色 → 新音色/);assert.match(rendered,/旁白 · 台词 新建台词完整正文/);assert.match(rendered,/旁白 · 角色默认音色/);assert.match(rendered,/下面提案将改变朗读范围，仅批准才实施/);assert.match(rendered,/原朗读文字第一句。第二句。/);assert.match(rendered,/拟朗读文字第一句。/);assert.equal(rendered.includes('保留原文。'),false);f.unmount();
});

test('需要补充或已暂停时，实际未确认步骤仍显示逐项核对入口',async()=>{
  for(const state of ['awaitingUser','paused']){
    const run={id:'r',state,revision:3,mode:'task',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:1,analysis:0,audio:0}},reconciliation:{steps:[{stepId:'s',description:'生成声音',canRetry:true,attempts:[{id:'a',status:'unknown'}]}]}};
    const f=await setup({request:async(path)=>path==='/assistant/sessions/A'?{...detail('A'),runs:[run]}:undefined});
    assert.ok(nodes(f.render()).some(n=>typeof n.type==='function'&&n.type.name==='AssistantReconciliation'),'missing reconciliation at '+state);f.unmount();
  }
});


test('问答仅外发当前保存状态，不包含编辑草稿正文；制作发送在保存屏障之后标记已保存',async()=>{
 let asked,staged;const privateDraft='未保存正文不应外发';
 const f=await setup({records:new Map([['assistant:A',{...client.newAssistantDraft(),mode:'ask'}]]),initial:{draftStatus:'local',state:{settings:{workspaceIdentity:'w'},projects:[{id:'p',name:'项目'}],chapters:[{id:'cA',title:'章',source:privateDraft}],voices:[],roles:[]}},request:async(path,body)=>{if(path.endsWith('/messages')){asked=body;return detail('A');}}});f.change('解释这个按钮');assert.match(text(f.render()),/当前编辑内容尚未保存/);f.find('发送').props.onClick();await tick();assert.equal(asked.view.draftStatus,'local');assert.ok(!JSON.stringify(asked).includes(privateDraft));assert.deepEqual(f.saved,[]);f.unmount();
 let saved=false;const g=await setup({initial:{draftStatus:'saving',withSavedScope:async(_binding,work)=>{saved=true;await work();}},records:new Map([['assistant:A',{...client.newAssistantDraft(),text:'准备本章',mode:'task'}]]),request:async(path,body)=>{if(path.endsWith('/messages')){assert.equal(saved,true);staged=body;return detail('A');}}});g.find('发送').props.onClick();await tick();assert.equal(staged.view.draftStatus,'saved');g.unmount();
});


test('正常发送中与暂停后仍在收尾的助手请求不误显示结果不明核对',async()=>{
 for(const [state,requestState,visible] of [['planning','sending',false],['paused','sending',false],['paused','unknown',true]]){
  const run={id:'r',state,revision:3,mode:'ask',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:3,analysis:0,audio:0},used:{assistant:1,analysis:0,audio:0}},reconciliation:{assistantRequest:{id:'request',state:requestState},steps:[]}};
  const f=await setup({request:async path=>path==='/assistant/sessions/A'?{...detail('A'),runs:[run]}:undefined});assert.equal(nodes(f.render()).some(n=>typeof n.type==='function'&&n.type.name==='AssistantReconciliation'),visible);f.unmount();
 }
});

test('助手会话和任务选择复用统一控件；选择只更新本会话草稿，不触发模型请求',async()=>{
  const f=await setup({records:new Map([['assistant:A',{...client.newAssistantDraft(),text:'继续保留',mode:'task'}]])});
  assert.deepEqual(nodes(f.render()).filter(n=>n.type==='Select').map(n=>n.props.label),['助手会话']);f.find('本次任务设置').props.onClick();assert.deepEqual(nodes(f.render()).filter(n=>n.type==='Select').map(n=>n.props.label),['助手会话','完成目标','音色选择']);
  assert.equal(nodes(f.render()).some(n=>n.type==='select'),false);
  f.find('完成目标').props.onChange('chapter-master');f.find('音色选择').props.onChange('chooseFromApprovedSet');
  const stored=f.records.get('assistant:A');assert.equal(stored.completionTarget,'chapter-master');assert.equal(stored.voicePolicy,'chooseFromApprovedSet');assert.equal(stored.text,'继续保留');
  assert.equal(f.calls.filter(([,body])=>!!body).length,0);
  f.props.connected=false;assert.equal(f.find('助手会话').props.disabled,true);assert.equal(f.find('完成目标').props.disabled,false);f.unmount();
});

test('连接保存未返回时表单禁止继续改写，返回后恢复编辑且仅提交连接',async()=>{
  let finishSave,posted;
  const f=await setup({component:'AssistantConnection',request:async(path,body,method)=>{
    if(path==='/assistant/config'&&method==='PUT'){posted=body;return new Promise(done=>{finishSave=done;});}
  }});
  assert.equal(nodes(f.render()).some(n=>n.type==='select'),false);
  f.find('连接凭据').props.onChange('separate');assert.ok(nodes(f.render()).some(n=>n.type==='input'&&n.props.type==='password'));
  assert.equal(f.calls.filter(([,body])=>!!body).length,0);
  f.find('保存连接').props.onClick();await tick();assert.equal(posted.credentialSource,'separate');
  const locked=nodes(f.render()).filter(n=>n.type==='input'||n.type==='Select');assert.ok(locked.length>=6);assert.ok(locked.every(n=>n.props.disabled===true));
  finishSave({...config,revision:2,credentialSource:'separate'});await tick();
  assert.equal(f.find('连接凭据').props.disabled,false);assert.equal(f.find('连接凭据').props.value,'separate');assert.equal(f.find('验证识图能力'),undefined);
  assert.equal(f.calls.filter(([path])=>path==='/assistant/verify').length,0);f.unmount();
});


test('连接设置入口独立于被抽屉隐藏的标题，空会话和归档会话均可打开且不创建任务',async()=>{
  for(const archived of [false,true]){
    const f=await setup({sessionRows:archived?[{...session('A'),state:'archived'}]:[],request:async path=>path==='/assistant/sessions/A'?{...detail('A'),session:{...session('A'),state:'archived'}}:undefined});
    const tree=f.render(),heading=nodes(tree).find(n=>n.props?.className==='assistant-heading'),row=nodes(tree).find(n=>n.props?.className==='assistant-session-row');
    assert.equal(find(heading,'助手连接设置'),undefined);assert.ok(find(row,'助手连接设置'));assert.equal(!!find(tree,'给助手的消息'),!archived);
    f.find('助手连接设置').props.onClick();const connection=nodes(f.render()).find(n=>typeof n.type==='function'&&n.type.name==='AssistantConnection');assert.ok(connection);connection.props.onClose();assert.equal(nodes(f.render()).some(n=>typeof n.type==='function'&&n.type.name==='AssistantConnection'),false);
    assert.equal(f.calls.filter(([,body])=>!!body).length,0);f.unmount();
  }
});


test('未开启图片输入时只拦截图并保留附件，保存启用后直接发送且不要求验证',async()=>{
  let posted;const records=new Map([['assistant:A',{...client.newAssistantDraft(),text:'看这张图',attachments:[{id:'pic',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3}]}]]);
  const f=await setup({records,savedConfig:{...config,vision:false},request:async(path,body)=>{if(path.endsWith('/messages')){posted=body;return {...detail('A'),messages:[{id:body.messageId,role:'user',content:body.text,attachmentIds:['pic']}]};}}});
  assert.equal(f.find('发送').props.disabled,true);assert.match(text(f.render()),/连接设置中启用图片输入/);assert.doesNotMatch(text(f.render()),/发送将把|可能产生服务费用/);
  f.find('发送').props.onClick();await tick();assert.equal(posted,undefined);assert.equal(records.get('assistant:A').attachments.length,1);
  f.find('助手连接设置').props.onClick();const connection=nodes(f.render()).find(n=>typeof n.type==='function'&&n.type.name==='AssistantConnection');connection.props.onSaved({...config,revision:2,model:'another-image-model',vision:true});connection.props.onClose();
  assert.equal(f.find('发送').props.disabled,false);assert.doesNotMatch(text(f.render()),/尚未.*验证|已验证/);f.find('发送').props.onClick();await tick();assert.deepEqual(posted.attachmentIds,['pic']);assert.equal(f.calls.filter(([path])=>path==='/assistant/verify').length,0);f.unmount();
  const g=await setup({savedConfig:{...config,vision:false}});g.change('只问文字问题');assert.equal(g.find('发送').props.disabled,false);g.find('发送').props.onClick();await tick();assert.equal(g.calls.filter(([path])=>path.endsWith('/messages')).length,1);g.unmount();
});


test('精简助手保留顶部连接与关闭，移除手动入口和常驻发送说明；主次发送按钮使用相同尺寸',async()=>{
  let closed=0;const f=await setup({initial:{onClose:()=>{closed++;}}});
  const tree=f.render();assert.equal(f.find('手动操作'),undefined);assert.equal(f.find('连接设置'),undefined);assert.equal(nodes(tree).some(n=>n.props?.className==='assistant-send-notice'),false);assert.equal(nodes(tree).some(n=>n.props?.className==='hint assistant-image-hint'),false);
  const actions=nodes(nodes(tree).find(n=>n.props?.className==='assistant-send-row')).filter(n=>n.type==='button');assert.equal(actions.length,2);assert.ok(actions.every(n=>n.props.className.split(' ').includes('small')));assert.ok(actions[1].props.className.split(' ').includes('primary'));
  assert.ok(f.find('助手连接设置'));f.find('关闭 AI 助手').props.onClick();assert.equal(closed,1);assert.equal(f.calls.filter(([,body])=>!!body).length,0);f.unmount();
});
