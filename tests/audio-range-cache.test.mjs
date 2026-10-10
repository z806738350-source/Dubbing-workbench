import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,readdirSync,statSync,utimesSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {openStore,uid} from '../server/store.mjs';
import {createDomain,inputOf,basisOf} from '../server/domain.mjs';
import {prepareAudioSource,audioWaveform,renderRangeResource,updateAudioRange,getRangeOperation,savedAudioRange,pruneAudioRangeCache,audioRangeActivity} from '../server/audio-range.mjs';

const key=n=>n.toString(16).padStart(64,'0'),old=new Date('2020-01-01');
function directory(t){const dir=mkdtempSync(join(tmpdir(),'dubbing-range-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function cached(cache,name,size,date=old){const path=join(cache,name);writeFileSync(path,Buffer.alloc(size));utimesSync(path,date,date);return path;}
function wav(){const frames=4800,bytes=Buffer.alloc(44+frames*4);bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVEfmt ',8);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(2,22);bytes.writeUInt32LE(48000,24);bytes.writeUInt32LE(192000,28);bytes.writeUInt16LE(4,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(frames*4,40);for(let i=0;i<frames;i++){bytes.writeInt16LE(Math.round(9000*Math.sin(i*.1)),44+i*4);bytes.writeInt16LE(Math.round(6000*Math.sin(i*.03)),46+i*4);}return bytes;}
function fixture(t){
  const dir=directory(t),store=openStore(dir),domain=createDomain(store);t.after(()=>store.close());
  const project=domain.mutate('project.create',{name:'缓存测试'}),chapter=domain.mutate('chapter.create',{projectId:project.id,title:'合成声音',source:'这是一句合成测试。',segment:true});
  const segment=domain.list(chapter.id)[0],audio={id:uid(),chapterId:chapter.id,path:'audio/synthetic.wav',input:inputOf(segment),basis:basisOf(segment)};
  mkdirSync(join(dir,'audio'));writeFileSync(join(dir,audio.path),wav());store.put('audios',audio,chapter.id);segment.current=audio.id;segment.latest='success';store.put('segments',segment,chapter.id);domain.enhancement.syncLegacySegment(segment);
  return {dir,store,audio,segment};
}

test('缓存按mtime LRU成对回收，keep保护整对；part、未知、目录和symlink保持',async t=>{
  const dir=directory(t),cache=join(dir,'.audio-range-cache');mkdirSync(cache);
  const pcm=cached(cache,key(1)+'.pcm',30),metadata=cached(cache,key(1)+'.json',10);
  const recent=cached(cache,key(2)+'.wav',20,new Date('2021-01-01'));
  const retained=cached(cache,key(3)+'.pcm',20),retainedMetadata=cached(cache,key(3)+'.json',10);
  const peaks=cached(cache,key(4)+'.peaks.json',15,new Date('2022-01-01'));
  const part=cached(cache,key(5)+'.pcm.pending.part',7),unknown=cached(cache,'notes.json',8);
  const nested=join(cache,'nested');mkdirSync(nested);writeFileSync(join(nested,key(6)+'.wav'),Buffer.alloc(13));
  const outside=join(dir,'outside.wav');writeFileSync(outside,Buffer.from('original'));
  const link=join(cache,key(7)+'.pcm');symlinkSync(outside,link);const linkedMetadata=cached(cache,key(7)+'.json',5);
  const result=await pruneAudioRangeCache({directory:dir},{maxBytes:75,keep:[retainedMetadata]});
  assert.deepEqual(result,{removedBytes:60,removedFiles:3,remainingBytes:65,remainingFiles:6,maxBytes:75});
  assert.equal(existsSync(pcm),false);assert.equal(existsSync(metadata),false);assert.equal(existsSync(recent),false);
  for(const path of [retained,retainedMetadata,peaks,part,unknown,nested,link,linkedMetadata,outside])assert.ok(existsSync(path),path);
  assert.equal(readFileSync(outside,'utf8'),'original');
  const again=await pruneAudioRangeCache({directory:dir},{maxBytes:0,keep:[retained]});
  assert.equal(again.removedBytes,15);assert.equal(again.remainingBytes,50);assert.ok(existsSync(retainedMetadata));
});

test('容量校验和symlink缓存目录不越界回收；缺缓存目录是零变更',async t=>{
  const dir=directory(t);assert.deepEqual(await pruneAudioRangeCache({directory:dir}),{removedBytes:0,removedFiles:0,remainingBytes:0,remainingFiles:0,maxBytes:1024**3});
  for(const maxBytes of [-1,NaN,1.5,Infinity])await assert.rejects(pruneAudioRangeCache({directory:dir},{maxBytes}),/缓存容量/);
  const outside=join(dir,'outside');mkdirSync(outside);const file=cached(outside,key(1)+'.wav',30);symlinkSync(outside,join(dir,'.audio-range-cache'));
  const result=await pruneAudioRangeCache({directory:dir},{maxBytes:0});assert.equal(result.skipped,'cache-is-not-directory');assert.ok(existsSync(file));
});

test('真实PCM/clip/peaks命中更新LRU；回收后免费逐字节重建且原件、范围、撤销回执不变',async t=>{
  const f=fixture(t),sourceFile=join(f.dir,f.audio.path),original=readFileSync(sourceFile),cache=join(f.dir,'.audio-range-cache');
  const saved=await updateAudioRange(f.store,{operationId:uid(),unitId:f.segment.id,mode:'dry',audioId:f.audio.id,expectedRevision:0,startFrame:120,endFrame:4600});
  const source=await prepareAudioSource(f.store,f.audio.id),clip=await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id),wave=await audioWaveform(f.store,f.audio.id,{level:1024});
  const pcm=readFileSync(source.pcmPath),wavBytes=readFileSync(clip.path),before=f.store.all('settings');
  const generated=readdirSync(cache).map(name=>join(cache,name));assert.equal(generated.length,4);
  for(const path of generated)utimesSync(path,old,old);
  const activityBefore=audioRangeActivity();assert.equal(activityBefore.active,0);assert.equal(activityBefore.queued,0);assert.equal(activityBefore.preparing,0);assert.equal(activityBefore.clips,0);assert.equal(activityBefore.waves,0);
  await prepareAudioSource(f.store,f.audio.id);await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id);await audioWaveform(f.store,f.audio.id,{level:1024});
  for(const path of generated)assert.ok(statSync(path).mtimeMs>old.getTime(),basename(path));
  const total=generated.reduce((sum,path)=>sum+statSync(path).size,0),unused=cached(cache,key(999)+'.wav',100);
  const lru=await pruneAudioRangeCache(f.store,{maxBytes:total});assert.equal(lru.removedBytes,100);assert.equal(existsSync(unused),false);for(const path of generated)assert.ok(existsSync(path));
  const removed=await pruneAudioRangeCache(f.store,{maxBytes:0});assert.equal(removed.removedFiles,4);assert.equal(removed.remainingBytes,0);
  const restored=await prepareAudioSource(f.store,f.audio.id),restoredClip=await renderRangeResource(f.store,f.segment.id,'dry',f.audio.id),restoredWave=await audioWaveform(f.store,f.audio.id,{level:1024});
  assert.deepEqual(readFileSync(restored.pcmPath),pcm);assert.deepEqual(readFileSync(restoredClip.path),wavBytes);assert.deepEqual(restoredWave,wave);
  assert.deepEqual(readFileSync(sourceFile),original);assert.deepEqual(f.store.all('settings'),before);assert.deepEqual(savedAudioRange(f.store,f.segment.id,'dry',f.audio.id),saved.range);assert.equal(getRangeOperation(f.store,saved.operationId).status,'completed');assert.equal(f.store.all('attempts').length,0);
});
