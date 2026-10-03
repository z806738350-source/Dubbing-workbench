import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openStore} from '../server/store.mjs';

test('历史索引候选经既有归属过滤与章级扫描等价，保留legacy、共享refs和原顺序',t=>{
  const directory=mkdtempSync(join(tmpdir(),'dubbing-history-query-')),store=openStore(directory);
  t.after(()=>{store.close();rmSync(directory,{recursive:true,force:true});});
  const rows=[
    {id:'modern-dry',input:{unitId:'single',mode:'dry'}},
    {id:'modern-scene',input:{unitId:'single',mode:'scene'}},
    {id:'mode-from-audio',input:{unitId:'single'},mode:'scene'},
    {id:'mode-default-dry',input:{unitId:'single'}},
    {id:'null-mode',input:{unitId:'single',mode:null},mode:'scene'},
    {id:'empty-mode',input:{unitId:'single',mode:''},mode:'scene'},
    {id:'other-single',input:{unitId:'other',mode:'dry'}},
    {id:'legacy-target',targetKind:'single',targetId:'single'},
    {id:'legacy-attempt',input:{text:'旧句'}},
    {id:'shared-ref',input:{unitId:'other',mode:'scene'}},
    {id:'shared-ref-legacy',targetKind:'single',targetId:'other'},
    {id:'deduplicate',input:{unitId:'single',mode:'dry'},targetKind:'single',targetId:'single'},
    {id:'modern-wrong-mode-with-legacy',input:{unitId:'single',mode:'scene'},targetKind:'single',targetId:'single'},
    {id:'group-dry',input:{unitId:'group',mode:'dry'}},
    {id:'group-scene',input:{unitId:'group',mode:'scene'}},
    {id:'wrong-chapter',input:{unitId:'single',mode:'dry'},chapter:'elsewhere'},
    {id:'legacy-wrong-chapter',targetKind:'single',targetId:'single',chapter:'elsewhere'},
    {id:'foreign-attempt',input:{text:'别句'}},
  ];
  rows.forEach(({chapter,...row})=>store.put('audios',row,chapter || 'chapter'));
  for(const id of ['legacy-attempt','deduplicate','modern-wrong-mode-with-legacy','wrong-chapter'])store.put('attempts',{id,segmentId:'single'},'job');
  store.put('attempts',{id:'foreign-attempt',segmentId:'other'},'other-job');
  const refs=['shared-ref','shared-ref-legacy','deduplicate','wrong-chapter',null];
  for(const [kind,id] of [['single','single'],['single','other'],['group','group']])for(const mode of ['dry','scene']){
    const unit={id,kind,chapterId:'chapter'};
    const belongs=a=>{
      if(a.input?.unitId===unit.id)return (a.input.mode || a.mode || 'dry')===mode;
      if(unit.kind!=='single' || mode!=='dry')return false;
      return a.targetKind==='single' && a.targetId===unit.id || refs.includes(a.id) || store.maybe('attempts',a.id)?.segmentId===unit.id;
    };
    const baseline=store.all('audios',unit.chapterId).filter(belongs).map(a=>a.id),indexed=store.unitHistory(unit,mode,refs).filter(belongs).map(a=>a.id);
    assert.deepEqual(indexed,baseline,`${kind}/${id}/${mode}`);assert.equal(new Set(indexed).size,indexed.length);
  }
});
