import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { recoverProjectFolders, stageProjectDeletion } from '../server/workspace.mjs';

function fixture(t, folders = true) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'dubbing-project-delete-'));
  const store = openStore(directory), domain = createDomain(store);
  t.after(() => { store.close(); fs.rmSync(directory, {recursive:true,force:true}); });
  if (folders) store.put('settings', {id:'project-folders',enabled:true});
  const project = domain.mutate('project.create', {name:'删除这个项目'});
  const other = domain.mutate('project.create', {name:'保留这个项目'});
  const chapter = domain.mutate('chapter.create', {projectId:project.id,title:'本章',source:'只删除本项目。',segment:true});
  const otherChapter = domain.mutate('chapter.create', {projectId:other.id,title:'另一章',source:'另一项目必须保持。',segment:true});
  const write = path => { fs.mkdirSync(dirname(join(directory,path)), {recursive:true}); fs.writeFileSync(join(directory,path), path); return path; };
  const owned = kind => project.folder ? `${project.folder}/${kind}` : kind;
  const audio = {id:uid(),chapterId:chapter.id,path:write(`${owned('audio')}/made.wav`),targetKind:'unit'};
  store.put('audios', audio, chapter.id);
  const master = {id:uid(),chapterId:chapter.id,path:write(`${owned('masters')}/made.wav`)};
  store.put('masters', master, chapter.id);
  const exported = {id:uid(),chapterId:chapter.id,path:write(`${owned('exports')}/made.mp3`)};
  store.put('exports', exported, chapter.id);
  const job = {id:uid(),chapterId:chapter.id,status:'unknown',request:{chapterId:chapter.id}};
  store.put('jobs', job, chapter.id);
  const attempt = {id:uid(),jobId:job.id,status:'unknown',path:write(`${owned('audio')}/uncertain.wav`),quota:{scope:'retained',state:'used'}};
  store.put('attempts', attempt, job.id); write(attempt.path + '.part');
  const unit = store.all('units', chapter.id)[0];
  const event = {id:uid(),unitId:unit.id,chapterId:chapter.id,state:'adopted'};
  store.put('events', event, unit.id);
  const suggestion = {id:uid(),chapterId:chapter.id,status:'partial',items:[]};
  store.put('suggestions', suggestion, chapter.id);
  const voice = {id:uid(),state:'active',path:write('voices/shared.wav')};
  store.put('voices', voice);
  const session = {id:uid(),state:'active',revision:1,description:'共用声音创建'};
  store.put('voiceSessions', session);
  const sharedJob = {id:uid(),chapterId:'',sessionId:session.id,kind:'voice-create',status:'success',request:{chapterId:chapter.id}};
  store.put('jobs', sharedJob);
  const candidate = {id:uid(),targetKind:'candidate',path:write('audio/candidate.wav'),input:{sessionId:session.id}};
  store.put('audios', candidate);
  const sharedAttempt = {id:candidate.id,jobId:sharedJob.id,targetKind:'candidate',status:'success',path:candidate.path};
  store.put('attempts', sharedAttempt, sharedJob.id);
  store.put('audios', {id:uid(),path:write(`${other.folder || 'audio'}/other.wav`)}, otherChapter.id);
  const grant = {id:'ux-grant:delete-grant',grantId:'delete-grant',projectId:project.id,audioUsed:2,audioReserved:0};
  store.put('settings', grant);
  store.put('settings', {id:`ux-policy:${project.id}`,projectId:project.id,mode:'smart'});
  store.put('settings', {id:`ux-change:${suggestion.id}`,projectId:project.id,chapterId:chapter.id});
  store.put('settings', {id:'ux-operation:delete-operation',kind:'save',request:{kind:'save',action:'segment.update',data:{chapterId:chapter.id}},jobIds:[],steps:{completed:true}});
  store.put('settings', {id:'ux-operation:role-operation',kind:'save',request:{kind:'save',action:'role.update',data:{id:store.all('roles',project.id)[0].id}},jobIds:[],steps:{completed:true}});
  store.put('settings', {id:'ux-operation:other-operation',request:{chapterId:otherChapter.id},jobIds:[],steps:{completed:true}});
  store.put('settings', {id:'audio-usage:retained',used:2,reserved:0,limit:10});
  const snapshot = () => Object.fromEntries(['projects','chapters','roles','segments','units','events','suggestions','jobs','attempts','audios','masters','exports','voices','voiceSessions','settings'].map(table => [table,store.all(table)]));
  const remove=(extra={})=>domain.mutate('project.delete',{id:project.id,...(store.maybe('projects',project.id)?{scope:domain.deletionPlan({id:project.id}).scope}:{}),...extra});
  return {directory,store,domain,project,other,chapter,otherChapter,job,attempt,sharedJob,sharedAttempt,candidate,voice,session,grant,write,snapshot,remove,audio,master,exported};
}

test('T14 删除确认后新建章节、编辑章节或增加产物均拒绝旧范围，不删除任何新资料',async t=>{
  for(const changed of ['chapter.create','chapter.update','export'])await t.test(changed,t=>{
    const f=fixture(t),scope=f.domain.deletionPlan({id:f.project.id}).scope;
    if(changed==='chapter.create')f.domain.mutate('chapter.create',{projectId:f.project.id,title:'确认后新章',source:'必须保留的新正文。',segment:true});
    if(changed==='chapter.update')f.domain.mutate('chapter.update',{chapterId:f.chapter.id,revision:f.store.get('chapters',f.chapter.id).revision,title:'确认后编辑'});
    if(changed==='export')f.store.put('exports',{id:uid(),path:f.write(`${f.project.folder}/exports/later.wav`)},f.chapter.id);
    const before=f.snapshot();assert.throws(()=>f.domain.mutate('project.delete',{id:f.project.id,scope}),{status:409});assert.deepEqual(f.snapshot(),before);
    assert.equal(fs.readFileSync(join(f.directory,f.audio.path),'utf8'),f.audio.path);
  });
});

test('T14 删除预览只读且缺范围拒绝，相同快照可删除；已删除命令仍幂等',t=>{
  const f=fixture(t),before=f.snapshot(),plan=f.domain.deletionPlan({id:f.project.id});
  assert.deepEqual(f.snapshot(),before);assert.equal(plan.counts.chapters,1);assert.equal(plan.counts.exports,1);assert.equal(plan.chapters[0].id,f.chapter.id);
  assert.throws(()=>f.domain.mutate('project.delete',{id:f.project.id}),{status:409});assert.deepEqual(f.snapshot(),before);
  assert.equal(f.domain.mutate('project.delete',{id:f.project.id,scope:JSON.parse(JSON.stringify(plan.scope))}).deleted,true);
  assert.equal(f.domain.mutate('project.delete',{id:f.project.id,scope:plan.scope}).alreadyDeleted,true);
});

for (const folders of [true,false]) test(`直接删除${folders?'目录项目':'旧平铺项目'}，只清本项目，保留其他项目和共用声音及账本`, t => {
  const f=fixture(t,folders), before=f.snapshot();
  assert.deepEqual(f.remove({entityRevision:1}),{id:f.project.id,deleted:true,cleanupPending:false});
  assert.equal(f.store.maybe('projects',f.project.id),null);
  for (const table of ['chapters','segments','units','events','suggestions','jobs','attempts','audios','masters','exports'])
    assert.equal(f.store.all(table).some(row=>row.chapterId===f.chapter.id||row.id===f.job.id||row.jobId===f.job.id),false,table);
  assert.deepEqual(f.store.all('roles',f.project.id),[]);
  assert.equal(f.store.all('settings').some(row=>row.projectId===f.project.id||row.request?.data?.chapterId===f.chapter.id),false);
  assert.equal(f.store.maybe('settings','ux-operation:role-operation'),null);
  for (const [table,id] of [['projects',f.other.id],['chapters',f.otherChapter.id],['voices',f.voice.id],['voiceSessions',f.session.id],['jobs',f.sharedJob.id],['attempts',f.sharedAttempt.id],['audios',f.candidate.id]])
    assert.deepEqual(f.store.get(table,id),before[table].find(row=>row.id===id),table);
  assert.deepEqual(f.store.get('settings','audio-usage:retained'),before.settings.find(row=>row.id==='audio-usage:retained'));
  assert.deepEqual(f.store.get('settings','ux-operation:other-operation'),before.settings.find(row=>row.id==='ux-operation:other-operation'));
  for (const row of [...before.voices,...before.audios.filter(row=>row.id!==f.audio.id)]) assert.equal(fs.readFileSync(join(f.directory,row.path),'utf8'),row.path);
  for (const path of [f.audio.path,f.master.path,f.exported.path,f.attempt.path,f.attempt.path+'.part']) assert.equal(fs.existsSync(join(f.directory,path)),false,path);
  if(folders)assert.equal(fs.existsSync(join(f.directory,f.project.folder)),false);
  assert.equal(fs.readdirSync(f.directory).some(name=>name.startsWith('.project-delete-')),false);
  assert.deepEqual(f.remove(),{id:f.project.id,deleted:true,alreadyDeleted:true,cleanupPending:false});
});

test('活动任务、分析及项目授权的共享候选阻止删除；其他项目任务不会阻止',t=>{
  const f=fixture(t), before=f.snapshot();
  const check=()=>{const current=f.snapshot();assert.throws(()=>f.remove(),{status:409});assert.deepEqual(f.snapshot(),current);assert.equal(fs.readFileSync(join(f.directory,f.audio.path),'utf8'),f.audio.path);};
  f.store.put('jobs',{...f.job,status:'running'},f.chapter.id);check();f.store.put('jobs',f.job,f.chapter.id);
  const suggestion=f.store.all('suggestions',f.chapter.id)[0];f.store.put('suggestions',{...suggestion,status:'running'},f.chapter.id);check();f.store.put('suggestions',suggestion,f.chapter.id);
  f.store.put('jobs',{...f.sharedJob,status:'running'});check();f.store.put('jobs',f.sharedJob);
  f.store.put('attempts',{...f.sharedAttempt,grantReservation:{grantId:f.grant.grantId,state:'reserved'}},f.sharedJob.id);check();f.store.put('attempts',f.sharedAttempt,f.sharedJob.id);
  f.store.put('attempts',{...f.attempt,quota:{scope:'retained',state:'reserved'}},f.job.id);check();f.store.put('attempts',f.attempt,f.job.id);
  assert.deepEqual(f.snapshot(),before);
  const otherJob={id:uid(),chapterId:f.otherChapter.id,status:'running'};f.store.put('jobs',otherJob,f.otherChapter.id);
  assert.equal(f.remove().deleted,true);assert.deepEqual(f.store.get('jobs',otherJob.id),otherJob);
});

test('数据库中途失败回滚全部记录和已移动文件，过期版本也不删除',t=>{
  const f=fixture(t), before=f.snapshot();
  assert.throws(()=>f.remove({entityRevision:0}),{status:409});
  f.store.db.exec("CREATE TRIGGER fail_project_delete BEFORE DELETE ON roles BEGIN SELECT RAISE(ABORT,'delete rollback fixture'); END");
  assert.throws(()=>f.remove(),/delete rollback fixture/);
  assert.deepEqual(f.snapshot(),before);
  for(const row of [f.audio,f.master,f.exported,f.attempt])assert.equal(fs.readFileSync(join(f.directory,row.path),'utf8'),row.path);
  assert.equal(fs.readdirSync(f.directory).some(name=>name.startsWith('.project-delete-')),false);
});

test('文件移动中途失败恢复此前已移动文件，不删除数据库或共用文件',t=>{
  const f=fixture(t),legacy=f.write('audio/legacy-owned.wav');f.store.put('audios',{id:uid(),path:legacy},f.chapter.id);
  const before=f.snapshot(),original=fs.renameSync;let moves=0;
  fs.renameSync=(from,to)=>{if(String(to).includes('.project-delete-')&&++moves===2)throw Object.assign(new Error('move fixture failure'),{code:'EACCES'});return original(from,to);};syncBuiltinESMExports();
  try{assert.throws(()=>f.remove(),/move fixture failure/);}finally{fs.renameSync=original;syncBuiltinESMExports();}
  assert.deepEqual(f.snapshot(),before);assert.equal(fs.readFileSync(join(f.directory,f.audio.path),'utf8'),f.audio.path);assert.equal(fs.readFileSync(join(f.directory,legacy),'utf8'),legacy);
  assert.equal(fs.readdirSync(f.directory).some(name=>name.startsWith('.project-delete-')),false);
});

test('项目归属标记、符号链接与越界素材拒绝删除，其他文件原样保留',t=>{
  const f=fixture(t),marker=join(f.directory,f.project.folder,'.project-id'),before=f.snapshot();
  fs.writeFileSync(marker,f.other.id);assert.throws(()=>f.remove(),{status:409});fs.writeFileSync(marker,f.project.id);
  const row={id:uid(),path:'audio/../private-not-a-project-file'};f.store.put('audios',row,f.chapter.id);f.write('private-not-a-project-file');
  assert.throws(()=>f.remove(),{status:409});f.store.remove('audios',row.id);
  const link=join(f.directory,f.project.folder,'audio','linked.wav');fs.symlinkSync(join(f.directory,f.voice.path),link);f.store.put('audios',{id:row.id,path:`${f.project.folder}/audio/linked.wav`},f.chapter.id);
  assert.throws(()=>f.remove(),{status:409});f.store.remove('audios',row.id);
  const shared={...f.voice,path:f.audio.path};f.store.put('voices',shared);assert.throws(()=>f.remove(),{status:409});f.store.put('voices',f.voice);
  const sharedLink=f.write('voices/shared-alias.wav');fs.unlinkSync(join(f.directory,sharedLink));fs.symlinkSync(join(f.directory,f.audio.path),join(f.directory,sharedLink));
  f.store.put('voices',{...f.voice,path:sharedLink});assert.throws(()=>f.remove(),{status:409});f.store.put('voices',f.voice);
  assert.deepEqual(f.snapshot(),before);assert.equal(fs.readFileSync(join(f.directory,f.voice.path),'utf8'),f.voice.path);assert.equal(fs.readFileSync(join(f.directory,'private-not-a-project-file'),'utf8'),'private-not-a-project-file');
});

test('删除中断按数据库commit状态恢复或完成，清理失败仍保留可恢复的暂存记录',t=>{
  const f=fixture(t),legacy=f.write('audio/legacy-owned.wav');
  stageProjectDeletion(f.store,f.project,[legacy]);assert.equal(fs.existsSync(join(f.directory,f.project.folder)),false);assert.equal(fs.existsSync(join(f.directory,legacy)),false);
  recoverProjectFolders(f.store);assert.equal(fs.readFileSync(join(f.directory,f.audio.path),'utf8'),f.audio.path);assert.equal(fs.readFileSync(join(f.directory,legacy),'utf8'),legacy);
  const original=fs.rmSync;
  fs.rmSync=(path,options)=>{if(String(path).includes('.project-delete-')&&/\/0$/.test(String(path)))throw Object.assign(new Error('cleanup fixture failure'),{code:'EACCES'});return original(path,options);};syncBuiltinESMExports();
  let result;try{
    result=f.remove();
    assert.deepEqual(f.remove(),{id:f.project.id,deleted:true,alreadyDeleted:true,cleanupPending:true});
  }finally{fs.rmSync=original;syncBuiltinESMExports();}
  assert.equal(result.deleted,true);assert.equal(result.cleanupPending,true);assert.equal(f.store.maybe('projects',f.project.id),null);assert.equal(fs.existsSync(join(f.directory,f.project.folder)),false);
  recoverProjectFolders(f.store);assert.equal(fs.readdirSync(f.directory).some(name=>name.startsWith('.project-delete-')),false);assert.equal(fs.readFileSync(join(f.directory,f.voice.path),'utf8'),f.voice.path);
});
