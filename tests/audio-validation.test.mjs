import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync,chmodSync,statSync,utimesSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {execFileSync,spawn} from 'node:child_process';
import {openStore} from '../server/store.mjs';
import {createDomain} from '../server/domain.mjs';
import {ffmpeg,ffprobe} from '../server/audio.mjs';
import {projectFile} from '../server/workspace.mjs';

function wav() {
  const b=Buffer.alloc(44+9600);b.write('RIFF');b.writeUInt32LE(b.length-8,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);
  b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(b.length-44,40);
  for(let i=0;i<4800;i++)b.writeInt16LE(Math.round(Math.sin(i/17)*1000),44+i*2);return b;
}
const childCode=`
  import {openStore} from './server/store.mjs';
  import {validateStoredAudio} from './server/audio.mjs';
  const options=JSON.parse(process.argv[2]),results=[];let store=openStore(process.argv[1]);
  try{for(let round=0;round<(options.reopen?2:1);round++){
    if(round){store.close();store=openStore(process.argv[1]);}
    for(const id of options.ids||['one']){const audio=store.get('audios',id),valid=await validateStoredAudio(store,audio);
      results.push({valid,audio:store.get('audios',id),check:store.maybe('settings','audio-file-check:'+id)});}
  }}finally{store.close();}
  process.stdout.write(JSON.stringify(results));
`;
function fixture(t) {
  const directory=mkdtempSync(join(tmpdir(),'audio-validation-')),calls=join(directory,'calls'),gate=join(directory,'gate'),running=new Set();
  const wrapper=`#!/usr/bin/env node
    import {appendFileSync,writeFileSync,existsSync} from 'node:fs';import {spawnSync} from 'node:child_process';
    const probe=process.argv[1].includes('probe-wrapper'),kind=probe?'probe':'decode';appendFileSync(process.env.DUBBING_VALIDATION_CALLS,kind+'\\n');
    if(!probe&&process.env.DUBBING_VALIDATION_GATE){const gate=process.env.DUBBING_VALIDATION_GATE;writeFileSync(gate+'.started',String(process.pid));while(!existsSync(gate+'.release'))await new Promise(resolve=>setTimeout(resolve,5));}
    const result=spawnSync(probe?process.env.DUBBING_VALIDATION_PROBE:process.env.DUBBING_VALIDATION_DECODE,process.argv.slice(2),{stdio:'inherit'});
    if(result.error)throw result.error;process.exit(result.status??1);
  `;
  const probe=join(directory,'probe-wrapper.mjs'),decode=join(directory,'decode-wrapper.mjs');
  for(const path of [probe,decode]){writeFileSync(path,wrapper);chmodSync(path,0o755);}
  const env={...process.env,FFPROBE_PATH:probe,FFMPEG_PATH:decode,DUBBING_VALIDATION_CALLS:calls,DUBBING_VALIDATION_PROBE:ffprobe,DUBBING_VALIDATION_DECODE:ffmpeg};
  const args=options=>['--input-type=module','-e',childCode,directory,JSON.stringify(options)];
  const alter=work=>{const store=openStore(directory);try{return work(store);}finally{store.close();}};
  const add=(id='one',path=id+'.wav')=>{writeFileSync(join(directory,path),wav());utimesSync(join(directory,path),1700000000,1700000000);alter(store=>store.put('audios',{id,path},'chapter'));};add();
  t.after(()=>{for(const child of running)child.kill('SIGKILL');rmSync(directory,{recursive:true,force:true});});
  return {directory,gate,alter,add,check:id=>alter(store=>store.maybe('settings','audio-file-check:'+(id||'one'))),audio:id=>alter(store=>store.get('audios',id||'one')),
    counts:()=>{const rows=existsSync(calls)?readFileSync(calls,'utf8').trim().split('\n'):[];return {probe:rows.filter(s=>s==='probe').length,decode:rows.filter(s=>s==='decode').length};},
    validate:(options={})=>JSON.parse(execFileSync(process.execPath,args(options),{cwd:new URL('..',import.meta.url),env,encoding:'utf8',stdio:['ignore','pipe','pipe']})),
    held:()=>{const child=spawn(process.execPath,args({}),{cwd:new URL('..',import.meta.url),env:{...env,DUBBING_VALIDATION_GATE:gate},stdio:['ignore','pipe','pipe']});running.add(child);let output='',error='';child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>error+=part);
      const done=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',(code,signal)=>{running.delete(child);if(code!==0)return reject(Object.assign(Error(error||'validation interrupted'),{code,signal}));try{resolve(JSON.parse(output));}catch(failure){reject(failure);}});});return {child,done};},
  };
}
async function arrived(file) {const end=Date.now()+5000;while(!existsSync(file)){if(Date.now()>end)assert.fail('媒体校验未到达确定屏障');await new Promise(resolve=>setTimeout(resolve,5));}}

test('unchanged audio reuses persisted validation across closed stores and separate processes without changing its record',t=>{
  const f=fixture(t),before=f.audio(),results=f.validate({reopen:true});assert.ok(results.every(row=>row.valid));assert.deepEqual(f.counts(),{probe:1,decode:1});
  assert.deepEqual(results[0].audio,before);assert.deepEqual(results[1].audio,before);assert.equal(f.check().audioId,'one');assert.equal(f.check().valid,true);
  assert.equal(f.validate()[0].valid,true);assert.deepEqual(f.counts(),{probe:1,decode:1});assert.deepEqual(f.audio(),before);
});

test('new audio and changed bytes with restored size and mtime are decoded while unchanged siblings reuse checks',t=>{
  const f=fixture(t);f.validate();const file=join(f.directory,'one.wav'),before=statSync(file),changed=wav();changed.writeInt16LE(2000,44);writeFileSync(file,changed);utimesSync(file,1700000000,1700000000);
  const after=statSync(file);assert.equal(after.size,before.size);assert.equal(after.mtimeMs,before.mtimeMs);assert.notEqual(after.ctimeMs,before.ctimeMs);
  assert.equal(f.validate()[0].valid,true);assert.deepEqual(f.counts(),{probe:2,decode:2});
  f.add('new');assert.ok(f.validate({ids:['one','new']}).every(row=>row.valid));assert.deepEqual(f.counts(),{probe:3,decode:3});
});

test('broken, restored, missing and moved audio cannot reuse an incompatible check',t=>{
  const f=fixture(t),file=join(f.directory,'one.wav'),original=wav();f.validate();writeFileSync(file,'broken');
  assert.equal(f.validate()[0].valid,false);assert.equal(f.audio().invalid,true);assert.equal(f.check().valid,false);const broken=f.counts();
  assert.equal(f.validate()[0].valid,false);assert.deepEqual(f.counts(),broken,'已确定坏且未变的文件无需重复解码');
  writeFileSync(file,original);assert.equal(f.validate()[0].valid,true);assert.equal(f.audio().invalid,undefined);assert.deepEqual(f.counts(),{probe:broken.probe+1,decode:broken.decode+1});
  rmSync(file);const absent=f.counts();assert.equal(f.validate()[0].valid,false);assert.equal(f.audio().invalid,true);assert.deepEqual(f.counts(),absent);
  const other='different.wav';writeFileSync(join(f.directory,other),original);f.alter(store=>store.put('audios',{...store.get('audios','one'),path:other},'chapter'));
  assert.equal(f.validate()[0].valid,true);assert.equal(f.check().path,other);assert.equal(f.audio().invalid,undefined);assert.deepEqual(f.counts(),{probe:absent.probe+1,decode:absent.decode+1});
});

test('a decoded file changed in flight leaves no trusted validation stamp until a fresh completed check',async t=>{
  const f=fixture(t),held=f.held();
  try{
    await arrived(f.gate+'.started');const changed=wav();changed.writeInt16LE(2000,44);writeFileSync(join(f.directory,'one.wav'),changed);utimesSync(join(f.directory,'one.wav'),1700000000,1700000000);
    writeFileSync(f.gate+'.release','');const results=await held.done;assert.equal(results[0].valid,false);assert.equal(f.check(),null);
    assert.equal(f.validate()[0].valid,true);assert.equal(f.check().valid,true);assert.deepEqual(f.counts(),{probe:2,decode:2});
  }finally{writeFileSync(f.gate+'.release','');if(held.child.exitCode===null&&!held.child.signalCode)held.child.kill('SIGKILL');await held.done.catch(()=>{});}
});

test('an interrupted validation never persists success and the next process performs a complete check',async t=>{
  const f=fixture(t),held=f.held();let wrapperPid;
  try{
    await arrived(f.gate+'.started');wrapperPid=Number(readFileSync(f.gate+'.started','utf8'));assert.equal(f.check(),null);
    held.child.kill('SIGKILL');process.kill(wrapperPid,'SIGKILL');await assert.rejects(held.done,error=>error.signal==='SIGKILL');wrapperPid=undefined;
    assert.equal(f.check(),null);assert.equal(f.validate()[0].valid,true);assert.equal(f.check().valid,true);assert.deepEqual(f.counts(),{probe:2,decode:2});
  }finally{if(wrapperPid)try{process.kill(wrapperPid,'SIGKILL');}catch{}if(held.child.exitCode===null&&!held.child.signalCode)held.child.kill('SIGKILL');await held.done.catch(()=>{});}
});

test('cache rows follow project deletion without touching another project or immutable audio metadata',t=>{
  const f=fixture(t),store=openStore(f.directory);try{
    const domain=createDomain(store),create=name=>{const p=domain.mutate('project.create',{name}),c=domain.mutate('chapter.create',{projectId:p.id,title:name,source:'自拟原文。',segment:true});return {p,c};},first=create('删除项目'),other=create('保留项目');
    for(const [id,target] of [['one',first],['other',other]]){const path=projectFile(store,target.c.id,'audio',id+'.wav');mkdirSync(dirname(join(f.directory,path)),{recursive:true});writeFileSync(join(f.directory,path),wav());store.put('audios',{id,path,chapterId:target.c.id},target.c.id);}
    const audioBefore=store.all('audios');assert.ok(f.validate({ids:['one','other']}).every(row=>row.valid));assert.deepEqual(store.all('audios'),audioBefore);
    const kept=store.get('settings','audio-file-check:other'),plan=domain.deletionPlan({id:first.p.id});domain.mutate('project.delete',{id:first.p.id,scope:plan.scope});
    assert.equal(store.maybe('settings','audio-file-check:one'),null);assert.deepEqual(store.get('settings','audio-file-check:other'),kept);assert.ok(store.get('audios','other'));
  }finally{store.close();}
});
