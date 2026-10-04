import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startServer} from '../server/index.mjs';

 test('H01真实HTTP免费预检与正式reuse共用当前资格，旧问题保留、非法子项全事务拒绝、重复跳过',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-history-preflight-'));
  const app=await startServer({port:0,directory,config:{key:'',model:'seed-audio-1.0',baseUrl:'https://example.invalid/v1',audioUrl:'https://example.invalid/audio'}}),base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();rmSync(directory,{recursive:true,force:true});});
  const native=globalThis.fetch;let providerCalls=0;t.mock.method(globalThis,'fetch',(url,init)=>{if(String(url).startsWith(base+'/'))return native(url,init);providerCalls++;throw Error('本测试禁止供应商请求');});
  const request=async(path,p)=>{const res=await fetch(base+'/api'+path,p===undefined?undefined:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(p)});return {status:res.status,data:await res.json()};};
  const {store,domain}=app,project=domain.mutate('project.create',{name:'历史免费复用HTTP夹具'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'自拟章',source:'门外响起两下敲门声。',segment:true}),segment=domain.list(chapter.id)[0],unit=domain.enhancement.getUnit(segment.id);
  domain.mutate('unit.update',{chapterId:chapter.id,revision:chapter.revision,unitId:unit.id,entityRevision:unit.revision,mode:'scene',backgroundPresence:'subtle'});
  const legal={id:'quiet-music',unitId:unit.id,kind:'music',description:'极微弱，几乎不可闻的音乐',memberId:segment.id,position:'during',evidence:'原文明示',sourceQuote:chapter.source,reason:'原文明示声音',issues:['旧clear存在感冲突']};
  const draft={id:'history-fixture',kind:'scene',chapterId:chapter.id,unitId:unit.id,draftVersion:1,status:'partial',sceneBackgroundPresence:'clear',items:[legal,{...legal,id:'forged-quote',description:'缓慢风声',sourceQuote:'不属于本章的伪造引文',issues:['旧引文问题']}]};store.put('suggestions',draft,chapter.id);
  const target=()=>({id:draft.id,draftVersion:1,chapterId:chapter.id,unitId:unit.id,revision:store.get('chapters',chapter.id).revision,unitRevision:store.get('units',unit.id).revision,contextRevision:store.get('projects',project.id).contextRevision});
  const preview=()=>request('/analysis/reuse-preview?'+new URLSearchParams(Object.entries(target()).map(([key,value])=>[key,String(value)])));
  const before={chapter:store.get('chapters',chapter.id),unit:store.get('units',unit.id),suggestions:store.all('suggestions'),events:store.all('events'),jobs:store.all('jobs'),attempts:store.all('attempts')};
  const checked=await preview();assert.equal(checked.status,200);assert.deepEqual(checked.data.items[0].historicalIssues,legal.issues);assert.deepEqual(checked.data.items[0].currentIssues,[]);assert.equal(checked.data.items[0].canReuse,true);assert.equal(checked.data.items[1].canReuse,false);assert.match(checked.data.items[1].currentIssues.join('；'),/逐字引文/);
  assert.deepEqual({chapter:store.get('chapters',chapter.id),unit:store.get('units',unit.id),suggestions:store.all('suggestions'),events:store.all('events'),jobs:store.all('jobs'),attempts:store.all('attempts')},before,'GET免费预检完全只读');
  const invalid=await request('/analysis/reuse',{...target(),selected:['quiet-music','forged-quote'],canReuse:true});assert.ok([400,409].includes(invalid.status));assert.deepEqual(store.all('events'),[]);assert.deepEqual(store.get('chapters',chapter.id),before.chapter);assert.deepEqual(store.get('units',unit.id),before.unit);
  const added=await request('/analysis/reuse',{...target(),selected:['quiet-music']});assert.equal(added.status,200);assert.equal(added.data.addedCount,1);assert.deepEqual(store.get('suggestions',draft.id),draft);
  const already=await preview();assert.equal(already.data.items[0].alreadyIncluded,true);assert.equal(already.data.items[0].canReuse,false);const repeated=await request('/analysis/reuse',{...target(),selected:['quiet-music']});assert.equal(repeated.data.addedCount,0);assert.deepEqual(repeated.data.skippedItemIds,['quiet-music']);assert.equal(store.all('events').length,1);assert.deepEqual(store.get('suggestions',draft.id),draft);assert.equal(providerCalls,0);assert.equal(store.all('jobs').length,0);assert.equal(store.all('attempts').length,0);
});
