import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
const source=readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),component=source.slice(source.indexOf('function ExportDialog('),source.indexOf('function RebindDialog('));
const code=ts.transpileModule(component,{compilerOptions:{target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.React}}).outputText;
const nodes=node=>!node||typeof node!=='object'?[]:[node,...(node.props?.children||[]).flat(Infinity).flatMap(nodes)];
const defer=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)}};
function setup(call=async()=>({jobIds:['export-job']})){
  let index=0,close=0,refresh=0;const hooks=[],effects=[],sent=[];
  const env={React:{createElement:(type,props,...children)=>({type,props:{...props,children}})},Dialog:'Dialog',Form:'Form',Field:'Field',Select:'Select',Headphones:'Headphones',Download:'Download',
    useState:value=>{const i=index++;if(!(i in hooks))hooks[i]=value;return [hooks[i],next=>hooks[i]=typeof next==='function'?next(hooks[i]):next];},useRef:value=>hooks[index++]||={current:value},useEffect:next=>effects.push(next),
    withSavedDrafts:async(_scope,_deps,next)=>next(),submitOperation:async(...args)=>{sent.push(args);return call(...args);},basis:()=>({}),action:async()=>{}};
  const ExportDialog=new Function(...Object.keys(env),code+';return ExportDialog;')(...Object.values(env));
  const props={chapter:{id:'chapter',title:'示例章',gap:0,revision:2,arrangement:3,segments:[],playbackItems:[],exports:[],reviewItems:[]},ready:2,total:2,passed:2,connectionReady:true,jobs:[{id:'export-job',status:'success'}],onClose:()=>close++,onRefresh:async()=>refresh++};
  const render=()=>{index=0;return ExportDialog(props);};render();const cleanup=effects[0]();
  const submit=()=>nodes(render()).find(node=>node.type==='Form'&&node.props.label==='确认检查并导出').props.onSubmit();
  return {props,render,submit,sent,cleanup,close:()=>close,refresh:()=>refresh};
}
test('导出提交后留在结果面板，传真实任务状态并给就地成品下载',async()=>{const f=setup();await f.submit();assert.equal(f.close(),0);assert.equal(f.sent.length,1);assert.equal(f.sent[0][1].arrangement,3);assert.equal(f.sent[0][2],f.props.jobs);f.props.chapter.exports=[{id:'export-one',format:'wav',arrangement:3,createdAt:'2026-10-03T08:00:00Z',fileExists:true,current:true}];const tree=f.render(),link=nodes(tree).find(node=>node.type==='a');assert.equal(link.props.href,'/api/media/exports/export-one');assert.match(link.props.download,/编排3/);assert.match(JSON.stringify(tree),/成品已就绪/);});
test('导出已提交后关面板或切章，晚回执只更新资料，不关闭后来新页面',async()=>{const receipt=defer(),f=setup(()=>receipt.promise),pending=f.submit();f.cleanup();receipt.resolve({jobIds:['export-job']});await pending;assert.equal(f.close(),0);assert.equal(f.refresh(),1);assert.equal(f.sent.length,1);});
test('缺失的导出文件无伪下载地址，历史版本仍显示实际编排',()=>{const f=setup();f.props.chapter.exports=[{id:'missing',format:'mp3',arrangement:1,createdAt:'2026-10-03T08:00:00Z',fileExists:false,current:false}];const link=nodes(f.render()).find(node=>node.type==='a');assert.equal(link.props.href,undefined);assert.equal(link.props['aria-disabled'],true);assert.match(link.props.download,/编排1/);});
