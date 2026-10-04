import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const compile = path => ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8').replace(/^import .*;\n/gm,''),{compilerOptions:{jsx:ts.JsxEmit.React,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
const client = await import('data:text/javascript;base64,'+Buffer.from(compile('../src/assistantClient.ts')).toString('base64'));
const compiled=compile('../src/AssistantPanel.tsx');
const nodes = node => !node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const text=node=>node==null||typeof node==='boolean'?'':typeof node!=='object'?String(node):(node.props?.children||[]).flat(Infinity).map(text).join('');
const find=(tree,label)=>nodes(tree).find(n=>n.props?.['aria-label']===label||n.type==='button'&&text(n)===label);
const tick=()=>new Promise(done=>setImmediate(done));
const config={revision:1,enabled:true,configured:true,hasKey:true,baseUrl:'https://example.invalid/v1',model:'test',credentialSource:'audio',vision:true,visionVerified:true};
const session=id=>({id,projectId:'p',chapterId:'c'+id,title:id,state:'active'});
const detail=id=>({session:session(id),messages:[],runs:[],steps:[],attachments:[],capabilities:[]});
let sequence=0;
async function setup({request,initial,records=new Map(),component="default"}={}){
  let index=0,queued=[],rendered;const values=[],effects=[],calls=[],saved=[],unmounts=[];
  const api=async(path,body,method)=>{calls.push([path,body,method]);if(path==='/assistant/config'&&!body)return config;if(path==='/assistant/sessions'&&!body)return [session('A'),session('B')];if(request){const value=await request(path,body,method);if(value!==undefined)return value;}return detail(path.endsWith('/B')?'B':'A');};
  const state={settings:{workspaceIdentity:'w'},projects:[{id:'p',name:'测试'}],chapters:[{id:'cA',projectId:'p',title:'甲章'},{id:'cB',projectId:'p',title:'乙章'}],voices:[],roles:[]};
  const props={state,config,connected:true,onSaved:()=>{},projectId:'p',chapterId:'cA',selectedSegmentIds:['segment'],connected:true,pane:'settings',onClose:()=>{},onManual:()=>{},onNavigate:()=>{},onUIAction:async()=>{},withSavedScope:async(binding,work)=>{saved.push(binding);await work();},refresh:async()=>{},...initial};
  globalThis.window={setInterval:()=>1,clearInterval:()=>{}};
  globalThis.createImageBitmap=async()=>({width:2,height:2,close(){}});
  globalThis.FileReader=class {readAsDataURL(){this.result='data:image/png;base64,YWJj';this.onload();}};
  globalThis.assistantClientTest={...client,React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},useRef:value=>{const i=index++;return values[i]||=( {current:value});},useState:value=>{const i=index++;if(!(i in values))values[i]=typeof value==='function'?value():value;return[values[i],v=>{values[i]=typeof v==='function'?v(values[i]):v;}];},useEffect:(fn,deps)=>{const i=index++;if(!effects[i]||deps.some((v,n)=>v!==effects[i].deps[n]))queued.push(()=>{effects[i]?.cleanup?.();effects[i]={deps,cleanup:fn()};});},api,readDraft:key=>records.has(key)?{draft:records.get(key),revision:1}:null,writeDraft:(key,value)=>records.set(key,structuredClone(value)),draftWorkspace:()=> 'w',Dialog:'Dialog',Field:'Field',ArrowDown:'Icon',ArrowUp:'Icon',ImagePlus:'Icon',MessageSquare:'Icon',Plus:'Icon',Settings2:'Icon',X:'Icon'};
  const module=await import('data:text/javascript;base64,'+Buffer.from('const {'+Object.keys(globalThis.assistantClientTest).join(',')+'}=globalThis.assistantClientTest;\n'+compiled+'\n//'+sequence++).toString('base64'));
  const render=()=>{index=0;rendered=module[component](props);const work=queued;queued=[];work.forEach(fn=>fn());return rendered;};
  render();await tick();render();await tick();render();
  return {render,props,calls,records,saved,unmount:()=>effects.forEach(e=>e?.cleanup?.()),change:value=>{find(render(),'给助手的消息').props.onChange({target:{value}});},find:label=>find(render(),label)};
}

test('截图输入边界与提案展示覆盖实际内容，包括未知字段和嵌套修改',()=>{
  assert.throws(()=>client.checkAssistantFiles([{type:'image/svg+xml',size:100}],[]),/PNG/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:6*1024*1024}],[]),/5 MB/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:1},{type:'image/png',size:1}],[{bytes:1}]),/两张/);
  assert.throws(()=>client.checkAssistantFiles([{type:'image/png',size:5*1024*1024}],[{bytes:4*1024*1024}]),/8 MB/);
  const rows=client.assistantPreviewRows({data:{text:'全部正文\n第二行',excluded:false},newField:'不得隐藏'},x=>x);
  assert.deepEqual(rows.map(r=>r.value),['全部正文\n第二行','否','不得隐藏']);
});

test('纯图片可发送真实附件ID；IME输入不会误发，预览不是模型验证',async()=>{
  let posted;
  const records=new Map([['assistant:A',{...client.newAssistantDraft(),attachments:[{id:'pic',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3}]}]]);
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
  f.find('助手会话').props.onChange({target:{value:'B'}});await tick();f.change('乙草稿');resolveUpload({id:'late',sessionId:'A',mime:'image/png',width:2,height:2,bytes:3});await tick();
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


test('助手连接保存与付费识图分开，只有明确同意才发送一次验证',async()=>{
  let verification=0,saved;
  const f=await setup({component:'AssistantConnection',initial:{config:{...config,visionVerified:false}},request:async(path,body,method)=>{if(path==='/assistant/verify'){verification++;return {...config,visionVerified:true};}if(path==='/assistant/config'&&method==='PUT'){saved=body;return {...config,revision:2,visionVerified:false};}}});
  assert.equal(f.find('验证识图能力').props.disabled,true);f.find('验证识图能力').props.onClick();await tick();assert.equal(verification,0);
  const secret=nodes(f.render()).find(n=>n.type==='input'&&n.props.placeholder==='claude-sonnet-5-5');secret.props.onChange({target:{value:'another-model'}});assert.equal(f.find('验证识图能力').props.disabled,true);
  f.find('保存连接').props.onClick();await tick();assert.equal(saved.model,'another-model');assert.equal(saved.revision,1);assert.equal(verification,0);assert.equal('apiKey'in saved,false);
  const agree=nodes(f.render()).find(n=>n.type==='label'&&text(n).includes('同意发送测试图片'));nodes(agree).find(n=>n.type==='input').props.onChange({target:{checked:true}});
  assert.equal(f.find('验证识图能力').props.disabled,false);f.find('验证识图能力').props.onClick();f.find('验证识图能力').props.onClick();await tick();assert.equal(verification,1);assert.match(text(f.render()),/已通过真实识图验证/);f.unmount();
});


test('结果不明的重发必须再次授权，核对只包含明确步骤与尝试ID',async()=>{
  const decisions=[],run={reconciliation:{steps:[{stepId:'step',description:'生成一段',canRetry:true,attempts:[{id:'attempt',status:'unknown'}]}]}};
  const f=await setup({component:'AssistantReconciliation',initial:{run,busy:false,reconcile:async body=>decisions.push(body)}});
  assert.equal(f.find('批准重新发送').props.disabled,true);f.find('批准重新发送').props.onClick();assert.deepEqual(decisions,[]);
  const consent=nodes(f.render()).find(n=>n.type==='label');nodes(consent).find(n=>n.type==='input').props.onChange({target:{checked:true}});f.find('批准重新发送').props.onClick();await tick();assert.deepEqual(decisions,[{stepId:'step',acknowledgedAttemptIds:['attempt'],resolution:'retry'}]);
  f.find('保留已有结果').props.onClick();await tick();assert.equal(decisions[1].resolution,'keep-results');f.unmount();
});

test('调整任务总额度不得低于已用次数，集中音色仅提交明确角色选择',async()=>{
  const changed=[],run={budget:{limits:{assistant:12,analysis:3,audio:100},used:{assistant:2,analysis:1,audio:5}},voicePolicy:'askMissing',materials:['text'],voiceQuestions:[{roleId:'r',roleName:'旁白',segmentIds:['s'],availableVoiceIds:['voice']}]};
  const f=await setup({component:'AssistantMandate',initial:{run,voices:[{id:'voice',name:'声音',state:'active'}],busy:false,amend:async body=>changed.push(body)}});
  const numeric=nodes(f.render()).filter(n=>n.type==='input'&&n.props.type==='number');assert.equal(numeric[0].props.min,2);numeric[0].props.onChange({target:{value:'1'}});assert.equal(f.find('保存本次任务范围').props.disabled,true);
  numeric[0].props.onChange({target:{value:'20'}});f.find('旁白使用音色').props.onChange({target:{value:'voice'}});f.find('保存本次任务范围').props.onClick();await tick();assert.equal(changed[0].limits.assistant,20);assert.deepEqual(changed[0].roleVoiceChoices,{r:'voice'});assert.equal(changed[0].acceptCurrentConnection,undefined);assert.deepEqual(changed[0].workflowKinds,['dry']);assert.equal(changed[0].stepLimit,40);
  const workflow=nodes(f.render()).find(n=>n.type==='label'&&text(n)==='允许场景制作');nodes(workflow).find(n=>n.type==='input').props.onChange({target:{checked:true}});const steps=nodes(f.render()).find(n=>n.type==='label'&&text(n).startsWith('本任务步骤上限'));nodes(steps).find(n=>n.type==='input').props.onChange({target:{value:'80'}});f.find('保存本次任务范围').props.onClick();await tick();assert.deepEqual(changed[1].workflowKinds,['dry','scene']);assert.equal(changed[1].stepLimit,80);f.unmount();
});


test('归档非当前会话不切换当前、清草稿或串入另一会话附件',async()=>{
  const records=new Map([['assistant:A',{...client.newAssistantDraft(),text:'甲未发送',attachments:[{id:'pic-A',sessionId:'A'}]}],['assistant:B',{...client.newAssistantDraft(),text:'乙未发送',attachments:[{id:'pic-B',sessionId:'B'}]}]]);
  const f=await setup({records});const before=structuredClone([...records]);
  f.find('归档会话 B').props.onClick();await tick();
  assert.equal(f.find('助手会话').props.value,'A');assert.equal(f.find('给助手的消息').props.value,'甲未发送');assert.deepEqual([...records],before);
  assert.equal(f.calls.filter(([path,,method])=>path==='/assistant/sessions/B'&&method==='DELETE').length,1);assert.equal(f.calls.filter(([path,,method])=>path==='/assistant/sessions/B'&&method!=='DELETE').length,0);f.unmount();
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
 const f=await setup({initial:{draftStatus:'local',state:{settings:{workspaceIdentity:'w'},projects:[{id:'p',name:'项目'}],chapters:[{id:'cA',title:'章',source:privateDraft}],voices:[],roles:[]}},request:async(path,body)=>{if(path.endsWith('/messages')){asked=body;return detail('A');}}});f.change('解释这个按钮');assert.match(text(f.render()),/当前编辑内容尚未保存/);f.find('发送').props.onClick();await tick();assert.equal(asked.view.draftStatus,'local');assert.ok(!JSON.stringify(asked).includes(privateDraft));assert.deepEqual(f.saved,[]);f.unmount();
 let saved=false;const g=await setup({initial:{draftStatus:'saving',withSavedScope:async(_binding,work)=>{saved=true;await work();}},records:new Map([['assistant:A',{...client.newAssistantDraft(),text:'准备本章',mode:'task'}]]),request:async(path,body)=>{if(path.endsWith('/messages')){assert.equal(saved,true);staged=body;return detail('A');}}});g.find('发送').props.onClick();await tick();assert.equal(staged.view.draftStatus,'saved');g.unmount();
});


test('正常发送中与暂停后仍在收尾的助手请求不误显示结果不明核对',async()=>{
 for(const [state,requestState,visible] of [['planning','sending',false],['paused','sending',false],['paused','unknown',true]]){
  const run={id:'r',state,revision:3,mode:'ask',binding:{projectId:'p',chapterId:'cA'},budget:{limits:{assistant:3,analysis:0,audio:0},used:{assistant:1,analysis:0,audio:0}},reconciliation:{assistantRequest:{id:'request',state:requestState},steps:[]}};
  const f=await setup({request:async path=>path==='/assistant/sessions/A'?{...detail('A'),runs:[run]}:undefined});assert.equal(nodes(f.render()).some(n=>typeof n.type==='function'&&n.type.name==='AssistantReconciliation'),visible);f.unmount();
 }
});
