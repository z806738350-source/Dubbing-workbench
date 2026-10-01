import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { openStore, uid } from '../server/store.mjs';
import { createDomain } from '../server/domain.mjs';
import { saveCandidateVoice, drainReferenceDeletes } from '../server/audio.mjs';
import { compile } from '../server/templates.mjs';

function wav(seconds=.1) {
  const frames=Math.round(seconds*48000), bytes=frames*2, b=Buffer.alloc(44+bytes);
  b.write('RIFF');b.writeUInt32LE(36+bytes,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(bytes,40);
  return b;
}
function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'dubbing-candidate-')),store=openStore(dir),d=createDomain(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});
  const session=d.mutate('voice-session.create',{description:'温和清楚的成年声音'});
  function candidate(bytes=wav(),meta={}) {
    const input={targetKind:'candidate',sessionId:session.id,description:session.description,text:session.text,config:session.config,model:session.model,template:session.template,referenceVoiceIds:[]};
    const job={id:uid(),commandId:uid(),kind:'voice-create',chapterId:'',sessionId:session.id,status:'success'},a={id:uid(),jobId:job.id,targetKind:'candidate',targetId:session.id,input,prompt:compile(input),status:'success'};
    const audio={id:a.id,path:`audio/${a.id}.wav`,input,prompt:a.prompt,model:input.model,targetKind:'candidate',duration:.1,sampleRate:48000,channels:1,format:'wav',...meta};
    mkdirSync(join(dir,'audio'),{recursive:true});writeFileSync(join(dir,audio.path),bytes);store.put('jobs',job);store.put('attempts',a,job.id);store.put('audios',audio);return audio;
  }
  return {dir,store,d,session,candidate};
}

test('VO04/VO05 重复及并发保存同一候选返回同档案原文件，禁止自动角色绑定',async t=>{
  const {dir,store,candidate}=setup(t),a=candidate(),before=store.all('roles');
  const [first,second]=await Promise.all([saveCandidateVoice(store,{audioId:a.id,name:'选择的声音'}),saveCandidateVoice(store,{audioId:a.id,name:'重复请求的另一名称'})]);
  assert.equal(first.id,a.id);assert.equal(second.id,first.id);assert.equal(second.name,first.name);assert.equal(store.all('voices').length,1);
  assert.deepEqual(readFileSync(join(dir,first.path)),readFileSync(join(dir,a.path)));assert.notEqual(first.path,a.path);assert.deepEqual(store.all('roles'),before);
  assert.equal(first.sourceAudioId,a.id);assert.equal(first.source.description,a.input.description);assert.equal(first.source.prompt,a.prompt);assert.equal(first.tested,false);
  assert.deepEqual(readdirSync(join(dir,'voices')),[`${a.id}.wav`]);assert.deepEqual(await saveCandidateVoice(store,{audioId:a.id,name:''}),first);
});

test('VO06 真正完整解码与规格检查，超限或损坏不建立可绑定档案，原候选保留',async t=>{
  const {dir,store,candidate}=setup(t);
  for(const [bytes,meta,reason] of [[Buffer.from('broken'),{},/./],[wav(31),{duration:31},/30 秒/],[Buffer.alloc(10*1024*1024+1),{},/10 MB/]]){
    const a=candidate(bytes,meta);await assert.rejects(saveCandidateVoice(store,{audioId:a.id,name:'不合格'}),reason);assert.equal(store.maybe('voices',a.id),null);assert.deepEqual(readFileSync(join(dir,a.path)),bytes);
  }
  assert.equal(store.all('voices').length,0);
});

test('VO07 参考登记失败不丢候选或假成功；同一固定资产安全重试',async t=>{
  const {dir,store,candidate}=setup(t),a=candidate(),bytes=readFileSync(join(dir,a.path));
  store.db.exec("CREATE TRIGGER injected_voice_failure BEFORE INSERT ON voices BEGIN SELECT RAISE(ABORT,'injected registration failure'); END");
  await assert.rejects(saveCandidateVoice(store,{audioId:a.id,name:'安全重试'}),/injected registration/);assert.equal(store.maybe('voices',a.id),null);assert.deepEqual(readFileSync(join(dir,a.path)),bytes);
  store.db.exec('DROP TRIGGER injected_voice_failure');const saved=await saveCandidateVoice(store,{audioId:a.id,name:'安全重试'});
  assert.equal(saved.id,a.id);assert.equal(store.all('voices').length,1);assert.deepEqual(readFileSync(join(dir,saved.path)),bytes);
});

test('VO07 文件目标异常明确失败，原候选保留，修复后同候选可保存',async t=>{
  const {dir,store,candidate}=setup(t),a=candidate();writeFileSync(join(dir,'voices'),'blocked directory');
  await assert.rejects(saveCandidateVoice(store,{audioId:a.id,name:'修复后保存'}));assert.equal(store.maybe('voices',a.id),null);assert.ok(existsSync(join(dir,a.path)));
  rmSync(join(dir,'voices'));const saved=await saveCandidateVoice(store,{audioId:a.id,name:'修复后保存'});assert.equal(saved.sourceAudioId,a.id);
});

test('VO08 放弃单候选与删除正式参考互不误删，重复保存不复活已删除档案',async t=>{
  const {dir,store,d,session,candidate}=setup(t),a=candidate(),other=candidate(),saved=await saveCandidateVoice(store,{audioId:a.id,name:'保留候选'});
  d.mutate('voice-candidate.discard',{id:other.id,sessionId:session.id,entityRevision:session.revision});assert.equal(store.get('attempts',other.id).discarded,true);
  await assert.rejects(saveCandidateVoice(store,{audioId:other.id,name:'已放弃'}),/放弃/);assert.ok(existsSync(join(dir,other.path)));
  d.mutate('voice.delete',{id:saved.id,entityRevision:saved.revision,confirm:true});drainReferenceDeletes(store);
  assert.equal(store.get('voices',saved.id).state,'deleted');assert.equal(existsSync(join(dir,saved.path)),false);assert.ok(existsSync(join(dir,a.path)));
  const repeated=await saveCandidateVoice(store,{audioId:a.id,name:'不要复活'});assert.equal(repeated.id,saved.id);assert.equal(repeated.state,'deleted');assert.equal(store.all('voices').length,1);
});

test('VO03 候选超过100个任务仍可查，规格状态不把超大/invalid资源写为合格',t=>{
  const {store,d,session,candidate}=setup(t),first=candidate();for(let i=0;i<101;i++)candidate();
  const tooLarge=candidate(Buffer.alloc(10*1024*1024+1)),invalid=candidate(wav(),{invalid:true});
  const snapshot=d.snapshot(),s=snapshot.voiceSessions.find(v=>v.id===session.id);assert.equal(s.candidates.length,104);assert.ok(s.candidates.find(v=>v.audioId===first.id));
  assert.equal(s.candidates.find(v=>v.id===tooLarge.id).referenceEligible,false);assert.equal(s.candidates.find(v=>v.id===invalid.id).referenceEligible,false);assert.equal(store.all('jobs').filter(j=>j.chapterId).length,0);
});

test('MR05/MR06 候选、参考副本、历史变体和unknown正式/part均备份恢复且不被清理',async t=>{
  const {dir,store,d,candidate}=setup(t),a=candidate(),saved=await saveCandidateVoice(store,{audioId:a.id,name:'备份声音'});
  const p=d.mutate('project.create',{name:'备份项目'}),c=d.mutate('chapter.create',{projectId:p.id,title:'备份章',source:'备份句。',segment:true}),s=d.list(c.id)[0];
  s.voiceId=saved.id;store.put('segments',s,c.id);d.enhancement.syncLegacySegment(s);
  const u=store.get('units',s.id);u.variants.dry.current=a.id;u.variants.scene.previous=a.id;store.put('units',u,c.id);
  const unknown={id:uid(),targetKind:'candidate',targetId:a.input.sessionId,status:'unknown',path:`audio/${uid()}.wav`};store.put('attempts',unknown);writeFileSync(join(dir,unknown.path),wav());writeFileSync(join(dir,'audio',`${uid()}.wav.part`),wav());
  const root=mkdtempSync(join(tmpdir(),'dubbing-candidate-backup-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const backup=join(root,'backup'),restored=join(root,'restored');
  const run=(...args)=>{const r=spawnSync(process.execPath,[resolve('scripts/backup.mjs'),...args],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout};
  const before=['voiceSessions','units','events','audios','voices','attempts'].map(table=>store.all(table));run('create',dir,backup);assert.match(run('cleanup',dir,'--apply'),/0 个无引用文件/);run('restore',backup,restored);
  const copy=openStore(restored);assert.deepEqual(['voiceSessions','units','events','audios','voices','attempts'].map(table=>copy.all(table)),before);copy.close();
  for(const path of [a.path,saved.path,unknown.path])assert.deepEqual(readFileSync(join(restored,path)),readFileSync(join(dir,path)));
});
