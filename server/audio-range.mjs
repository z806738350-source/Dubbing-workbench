import { mkdir, readFile, writeFile, stat, rename, rm, open, readdir, lstat, unlink, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fail, same, text, uid } from './store.mjs';
import { ffmpeg, inspect, runMediaProcess, validateStoredAudio } from './audio.mjs';
import { audioDigest } from './audio-delivery.mjs';
import { createLocalPool } from './scheduler.mjs';
import { reserveDiskSpace } from './disk-space.mjs';
import { pcmWave } from './tail-audio.mjs';

export const decodeProfile = 'pcm-s16le-48000-native-v1', sampleRate = 48000, edgePolicy = 'short-fade-v1';
export const LEGACY_RENDER_PROFILE='legacy-mono-v1',DEFAULT_RENDER_PROFILE='source-stereo-v1',BOUNDARY_POLICY='unit-gap-v1';
export const renderProfileOf=record=>record?.renderProfile || LEGACY_RENDER_PROFILE;
const preparing = new Map(), clips = new Map(), waves = new Map();
const pcmTasks=createLocalPool(1);
// ponytail: one bounded PCM scan/write slot; raise only after measuring long-chapter responsiveness.
export const audioRangeActivity=()=>({active:pcmTasks.active,queued:pcmTasks.queued,preparing:preparing.size,clips:clips.size,waves:waves.size,peak:pcmTasks.peak,limit:1,chunkBytes:65536});
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const touchCache = async paths => { const now=new Date();await Promise.all(paths.map(path=>utimes(path,now,now).catch(()=>{}))); };
export async function pruneAudioRangeCache(store,{maxBytes=1024**3,keep=[]}={}) {
  if(!Number.isSafeInteger(maxBytes)||maxBytes<0)fail('缓存容量应为非负整数字节');
  const cache=resolve(store.directory,'.audio-range-cache'),retained=new Set(keep.map(path=>resolve(path)));
  const result={removedBytes:0,removedFiles:0,remainingBytes:0,remainingFiles:0,maxBytes};
  let directory;try{directory=await lstat(cache);}catch(error){if(error.code==='ENOENT')return result;throw error;}
  if(!directory.isDirectory()||directory.isSymbolicLink())return {...result,skipped:'cache-is-not-directory'};
  const groups=new Map(),blocked=new Set();
  for(const entry of await readdir(cache,{withFileTypes:true})){
    const path=join(cache,entry.name);let info;try{info=await lstat(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    const generated=/^([a-f0-9]{64})\.(pcm|json|wav|peaks\.json)$/.exec(entry.name);
    const key=generated&&(['pcm','json'].includes(generated[2])?generated[1]:entry.name);
    if(!info.isFile()){if(key)blocked.add(key);continue;}
    result.remainingBytes+=info.size;result.remainingFiles++;
    if(!key)continue;
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({path,size:info.size,mtimeMs:info.mtimeMs});
  }
  // The server enters this only while requests and workers are idle; standalone callers must do the same.
  const busy=()=>pcmTasks.active||pcmTasks.queued;
  const protectedGroup=(key,files)=>blocked.has(key)||files.some(file=>retained.has(file.path)||preparing.has(file.path)||clips.has(file.path)||waves.has(file.path))||
    /^[a-f0-9]{64}$/.test(key)&&[join(cache,key+'.pcm'),join(cache,key+'.json')].some(path=>retained.has(path)||preparing.has(path));
  if(busy())return {...result,busy:true};
  const ordered=[...groups].sort(([,a],[,b])=>Math.max(...a.map(file=>file.mtimeMs))-Math.max(...b.map(file=>file.mtimeMs)));
  for(const [key,files] of ordered){
    if(result.remainingBytes<=maxBytes||busy())break;
    if(protectedGroup(key,files))continue;
    let unchanged=true;
    for(const file of files){
      try{const now=await lstat(file.path);if(!now.isFile()||now.size!==file.size||now.mtimeMs!==file.mtimeMs)unchanged=false;}
      catch(error){if(error.code==='ENOENT')unchanged=false;else throw error;}
    }
    if(!unchanged||busy()||protectedGroup(key,files))continue;
    for(const file of files){
      try{await unlink(file.path);result.removedBytes+=file.size;result.removedFiles++;result.remainingBytes-=file.size;result.remainingFiles--;}
      catch(error){if(error.code!=='ENOENT')throw error;}
    }
  }
  return result;
}
const rangeId = (unitId, mode, audioId) => `audio-range:${unitId}:${mode}:${audioId}`;
export const savedAudioRange = (store, unitId, mode, audioId) => audioId ? store.maybe('settings', rangeId(unitId, mode, audioId)) : null;
export const snapshotRange = savedAudioRange;
export const hasClip = range => !!range && (range.startFrame !== 0 || range.endFrame !== range.sourceFrames);
export const rangeContentKey = range => hasClip(range) ? hash([range.audioId,range.sourceHash,range.decodeProfile,range.channels,range.sourceFrames,range.startFrame,range.endFrame,range.edgePolicy,range.fadeInFrames,range.fadeOutFrames]) : null;

function target(store, unitId, mode, audioId) {
  text(unitId,'声音单元',100);
  if (!['dry','scene'].includes(mode)) fail('声音类型无效');
  const unit = store.get('units', unitId), chapter = store.get('chapters', unit.chapterId);
  store.get('projects', chapter.projectId);
  audioId ||= unit.variants[mode].current;
  if (!audioId) fail('本段尚无可编辑声音',404);
  text(audioId,'声音版本',100);
  const audio = store.get('audios', audioId), parent = store.db.prepare('SELECT parent FROM audios WHERE id=?').get(audioId)?.parent;
  const variant = unit.variants[mode];
  const legacy = unit.kind === 'single' && mode === 'dry' && !audio.input?.unitId &&
    (audio.targetKind === 'single' && audio.targetId === unit.id || store.maybe('attempts',audioId)?.segmentId === unit.id || [variant.current,variant.previous,variant.approved].includes(audioId));
  if ((audio.chapterId || parent) !== chapter.id || !(audio.input?.unitId === unit.id && (audio.input.mode || audio.mode || 'dry') === mode || legacy)) fail('这份声音不属于当前单元和类型',403);
  const members = unit.members.map(id=>store.maybe('segments',id));
  let reason = ['dissolved','retired'].includes(unit.state) || members.some(s=>!s || s.retired || s.excluded || s.chapterId !== chapter.id) ? '本段结构已变化，历史范围仅可查看' : variant.current !== audioId ? '当前声音版本已变化，旧范围仅可查看' : '';
  if (!reason && store.db.prepare(`SELECT json_extract(a.data,'$.unitId') AS unitId,json_extract(a.data,'$.input.unitId') AS inputUnitId,
    json_extract(a.data,'$.segmentId') AS segmentId,json_extract(a.data,'$.targetId') AS targetId,
    json_extract(a.data,'$.mode') AS mode,json_extract(a.data,'$.input.mode') AS inputMode
    FROM jobs j JOIN attempts a ON a.parent=j.id
    WHERE j.parent=? AND j.parent<>'' AND json_extract(j.data,'$.status') IN ('queued','running')
    AND json_extract(a.data,'$.status') IN ('queued','sending','processing','unknown')`).all(chapter.id)
    .some(a=>(a.unitId || a.inputUnitId || a.segmentId || a.targetId)===unit.id && (a.mode || a.inputMode || 'dry')===mode)) reason = '本段正在重新生成，请等当前声音保存后调整范围';
  return { unit, chapter, audio, editable:!reason, reason };
}

export async function prepareAudioSource(store, audioId, {signal}={}) {
  signal?.throwIfAborted();
  const audio = store.get('audios',audioId), file = resolve(store.directory,audio.path || '');
  if (!audio.path || !file.startsWith(resolve(store.directory) + '/')) fail('声音文件归属无效',403);
  if (!await validateStoredAudio(store,audio,{signal})) fail('源声音损坏或缺失，范围和历史仍已保留',409);
  signal?.throwIfAborted();
  const info = await stat(file), version = [audio.path,info.size,info.mtimeMs,info.ctimeMs].join(':');
  const cacheId = 'audio-range-source:' + audioId, old = store.maybe('settings',cacheId);
  let sourceHash = old?.version === version ? old.sourceHash : null;
  if (!sourceHash) {
    sourceHash = (await audioDigest(file,{signal})).sha256;
  }
  signal?.throwIfAborted();
  const cache = join(store.directory,'.audio-range-cache'), base = join(cache,hash([sourceHash,decodeProfile])), pcmPath = base + '.pcm', metadataPath = base + '.json';
  const key = pcmPath;
  if (preparing.has(key)) {const shared=await preparing.get(key);signal?.throwIfAborted();return {...shared,audioId};}
  const promise = (async()=>{
    await mkdir(cache,{recursive:true});
    let metadata;
    try { metadata=JSON.parse(await readFile(metadataPath,'utf8')); const cached=await stat(pcmPath); if (metadata.sourceHash !== sourceHash || metadata.decodeProfile !== decodeProfile || !Number.isSafeInteger(metadata.sourceFrames) || metadata.sourceFrames<1 || !Number.isSafeInteger(metadata.channels) || metadata.channels<1 || metadata.channels>32 || cached.size!==metadata.sourceFrames*metadata.channels*2) metadata=null; } catch { metadata=null; }
    signal?.throwIfAborted();
    if (!metadata) {
      const media = await inspect(file,{signal}), temp=pcmPath+'.'+uid()+'.part';
      if (!Number.isSafeInteger(media.channels) || media.channels<1 || media.channels>32) fail('源声音声道数不受支持');
      const lease=reserveDiskSpace(store.directory,Math.ceil(media.duration*sampleRate)*media.channels*2+65536,'源声音解码缓存');
      try {
        signal?.throwIfAborted();
        await runMediaProcess(ffmpeg,['-v','error','-xerror','-i',file,'-map','0:a:0','-ar',String(sampleRate),'-c:a','pcm_s16le','-f','s16le','-y',temp],{signal});
        signal?.throwIfAborted();
        const size=(await stat(temp)).size;
        if (!size || size%(media.channels*2)) fail('源声音解码帧不完整',409);
        metadata={sourceHash,decodeProfile,sampleRate,channels:media.channels,sourceFrames:size/(media.channels*2)};
        await rename(temp,pcmPath); await writeFile(metadataPath,JSON.stringify(metadata));
      } finally {try{await rm(temp,{force:true});}finally{lease.release();}}
    }
    signal?.throwIfAborted();
    const current=store.maybe('audios',audioId);
    if (!current || current.path!==audio.path) fail('声音版本在准备期间已变化',409);
    const now=await stat(file);
    if ([audio.path,now.size,now.mtimeMs,now.ctimeMs].join(':')!==version) fail('源声音文件在准备期间已变化',409);
    const chapterId=current.chapterId || store.db.prepare('SELECT parent FROM audios WHERE id=?').get(audioId).parent;
    if (old?.version!==version || old.sourceHash!==sourceHash) store.put('settings',{id:cacheId,audioId,chapterId,version,sourceHash},chapterId);
    await touchCache([pcmPath,metadataPath]);
    return {...metadata,audioId,pcmPath};
  })();
  preparing.set(key,promise);
  try {const result=await promise;signal?.throwIfAborted();return {...result,audioId};} finally { preparing.delete(key); }
}

function validFrames(startFrame,endFrame,sourceFrames) {
  if (![startFrame,endFrame].every(Number.isSafeInteger) || startFrame<0 || startFrame>=endFrame || endFrame>sourceFrames) fail('播放起止应为源音频内非空整数帧范围');
}
function recipe(source,startFrame,endFrame) {
  validFrames(startFrame,endFrame,source.sourceFrames);
  const fade=Math.min(144,Math.floor((endFrame-startFrame)/4));
  return {...source,startFrame,endFrame,edgePolicy,fadeInFrames:startFrame ? fade : 0,fadeOutFrames:endFrame<source.sourceFrames ? fade : 0};
}
function checkSource(range, source) {
  if (range && (range.sourceHash!==source.sourceHash || range.decodeProfile!==source.decodeProfile || range.sourceFrames!==source.sourceFrames || range.channels!==source.channels || range.edgePolicy!==edgePolicy)) fail('范围的源身份或解码版本已变化，旧范围已保留',409);
}
export async function resolveAudioRange(store,unitId,mode,audioId) {
  const t=target(store,unitId,mode,audioId), source=await prepareAudioSource(store,t.audio.id), saved=savedAudioRange(store,unitId,mode,t.audio.id);
  checkSource(saved,source);
  const {pcmPath,...metadata}=source;
  const range=saved || {id:rangeId(unitId,mode,t.audio.id),projectId:t.chapter.projectId,chapterId:t.chapter.id,unitId,mode,...recipe(metadata,0,source.sourceFrames),revision:0,lastOperationId:null,updatedAt:null};
  return {range,editable:t.editable,reason:t.reason,previewUrl:previewUrl(range)};
}
export function previewUrl(range) { const query=new URLSearchParams({unitId:range.unitId,mode:range.mode,audioId:range.audioId,startFrame:String(range.startFrame),endFrame:String(range.endFrame),sourceHash:range.sourceHash,decodeProfile:range.decodeProfile}); return '/api/audio-ranges/preview?'+query; }

export function renderIdentity(store,chapterId,rows,renderProfile) {
  const chapter=store.get('chapters',chapterId);
  renderProfile ||= chapter.renderProfile || DEFAULT_RENDER_PROFILE;
  if(![LEGACY_RENDER_PROFILE,DEFAULT_RENDER_PROFILE].includes(renderProfile))fail('渲染声道版本不受支持');
  rows ||= store.all('units',chapterId).filter(u=>u.state==='active').map(u=>({s:{unitId:u.id,mode:u.mode},a:store.maybe('audios',u.variants[u.mode].current)}));
  const items=rows.map(r=>{const unitId=r.s?.unitId || r.s?.id || r.unitId || r.id,mode=r.s?.mode || r.mode || 'dry',audioId=r.a?.id || r.audioId,range=Object.hasOwn(r,'range')?r.range:savedAudioRange(store,unitId,mode,audioId);return {unitId,mode,audioId,range};});
  const hasRanges=items.some(item=>hasClip(item.range));
  const content=[chapter.arrangement,Math.round(chapter.gap*sampleRate),items.map(item=>[item.unitId,item.mode,item.audioId,rangeContentKey(item.range)])];
  const renderSignature=renderProfile===LEGACY_RENDER_PROFILE?(hasRanges?hash(content):null):hash([renderProfile,BOUNDARY_POLICY,...content]);
  return {renderRevision:chapter.renderRevision || 0,renderProfile,boundaryPolicy:BOUNDARY_POLICY,renderSignature,renderContentKey:renderSignature,hasRanges,items};
}
export function renderMatches(record,identity) { return renderProfileOf(record)===renderProfileOf(identity)&&(record.renderSignature || null)===(identity.renderSignature || null); }

export function getRangeOperation(store,operationId) {
  text(operationId,'操作标识',100);
  const receipt=store.maybe('settings','audio-range-operation:'+operationId);
  return receipt ? {...receipt.result,status:'completed'} : {operationId,status:'missing'};
}
export async function updateAudioRange(store,p,{kind='human',intentId}={}) {
  if (!p || Object.keys(p).some(key=>!['operationId','unitId','mode','audioId','expectedRevision','startFrame','endFrame','decodeProfile','sourceHash'].includes(key))) fail('范围保存参数无效');
  text(p.operationId,'操作标识',100);
  text(p.audioId,'声音版本',100);
  if (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision<0) fail('范围版本无效');
  const receiptId='audio-range-operation:'+p.operationId, previous=store.maybe('settings',receiptId);
  if (previous) { if (!same(previous.request,p)) fail('同一范围操作标识不能改变参数',409);return previous.result; }
  const t=target(store,p.unitId,p.mode,p.audioId);
  if (!t.editable) fail(t.reason,409);
  const source=await prepareAudioSource(store,t.audio.id);
  if (p.sourceHash!==undefined && p.sourceHash!==source.sourceHash || p.decodeProfile!==undefined && p.decodeProfile!==source.decodeProfile) fail('范围源身份与当前声音不一致',409);
  const {pcmPath,...metadata}=source, next=recipe(metadata,p.startFrame,p.endFrame);
  return store.transaction(()=>{
    const existingReceipt=store.maybe('settings',receiptId);
    if(existingReceipt){if(!same(existingReceipt.request,p))fail('同一范围操作标识不能改变参数',409);return existingReceipt.result;}
    const currentTarget=target(store,p.unitId,p.mode,p.audioId);if(!currentTarget.editable)fail(currentTarget.reason,409);
    const before=savedAudioRange(store,p.unitId,p.mode,t.audio.id);checkSource(before,source);
    const implicit={id:rangeId(p.unitId,p.mode,t.audio.id),projectId:t.chapter.projectId,chapterId:t.chapter.id,unitId:p.unitId,mode:p.mode,...recipe(metadata,0,source.sourceFrames),revision:0,lastOperationId:null,updatedAt:null};
    const current=before || implicit;
    if (current.revision!==p.expectedRevision) fail('另一页面已更新本段范围，请保留双方值后选择',409,{conflict:true,range:current});
    const changed=current.startFrame!==next.startFrame || current.endFrame!==next.endFrame;
    const range=changed?{...current,...next,revision:current.revision+1,lastOperationId:p.operationId,updatedAt:new Date().toISOString(),updatedBy:{kind,...(intentId?{intentId}:{})}}:current;
    if(changed)delete range.undoNextOperationId;
    const chapter=store.get('chapters',t.chapter.id);
    if(changed){store.put('settings',range,chapter.id);chapter.renderRevision=(chapter.renderRevision || 0)+1;store.put('chapters',chapter,chapter.projectId);}
    const result={range,operationId:p.operationId,changed,renderRevision:chapter.renderRevision || 0};
    store.put('settings',{id:receiptId,projectId:chapter.projectId,chapterId:chapter.id,request:structuredClone(p),before:current,result},chapter.id);
    return result;
  });
}
export async function undoAudioRange(store,p) {
  if (!p || Object.keys(p).some(key=>!['operationId','unitId','mode','audioId','expectedRevision','undoOperationId'].includes(key))) fail('范围撤销参数无效');
  text(p.operationId,'操作标识',100);
  text(p.audioId,'声音版本',100);
  const completed=store.maybe('settings','audio-range-operation:'+p.operationId);
  if(completed){if(!same(completed.undoRequest,p))fail('同一撤销操作标识不能改变参数',409);return completed.result;}
  const current=savedAudioRange(store,p.unitId,p.mode,p.audioId);
  if (!current) fail('此声音暂无可撤销范围',409);
  const nextUndo=Object.hasOwn(current,'undoNextOperationId')?current.undoNextOperationId:current.lastOperationId;
  if(!nextUndo)fail('已回到最早的范围，没有更早手势可撤销',409);
  if(p.undoOperationId && p.undoOperationId!==nextUndo)fail('范围已被后续操作修改，未撤销后来内容',409,{conflict:true,range:current});
  const previous=store.get('settings','audio-range-operation:'+nextUndo);
  if (!previous.result.changed || previous.result.range.id!==current.id || !Object.hasOwn(current,'undoNextOperationId') && previous.result.range.revision!==current.revision) fail('范围已被后续操作修改，未撤销后来内容',409,{conflict:true,range:current});
  const b=previous.before;
  const result=await updateAudioRange(store,{operationId:p.operationId,unitId:p.unitId,mode:p.mode,audioId:p.audioId,expectedRevision:p.expectedRevision,startFrame:b.startFrame,endFrame:b.endFrame,sourceHash:b.sourceHash,decodeProfile:b.decodeProfile});
  return store.transaction(()=>{const latest=savedAudioRange(store,p.unitId,p.mode,p.audioId);if(latest?.lastOperationId===p.operationId){result.range={...result.range,undoNextOperationId:b.lastOperationId || null};store.put('settings',result.range,result.range.chapterId);}const receipt=store.get('settings','audio-range-operation:'+p.operationId);store.put('settings',{...receipt,result,undoRequest:structuredClone(p)},receipt.chapterId);return result;});
}

function wavHeader(frames,channels) {
  const size=frames*channels*2;
  if(size>0xffffffff-36)fail('播放区间超过 WAV 可用大小');
  const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(size+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(channels,22);b.writeUInt32LE(sampleRate,24);b.writeUInt32LE(sampleRate*channels*2,28);b.writeUInt16LE(channels*2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b;
}
function clipRequest(store,unitId,mode,audioId,source,saved,startFrame,endFrame) {
  checkSource(saved,source);startFrame??=saved?.startFrame??0;endFrame??=saved?.endFrame??source.sourceFrames;
  const range={...saved,unitId,mode,audioId,...recipe(source,startFrame,endFrame)},frames=endFrame-startFrame;
  return {range,frames,expectedSize:44+frames*source.channels*2,path:join(store.directory,'.audio-range-cache',hash([source.sourceHash,decodeProfile,range.startFrame,range.endFrame,range.edgePolicy,range.fadeInFrames,range.fadeOutFrames])+'.wav')};
}
async function cachedClip(request,signal) {
  try {
    const {path,range,frames,expectedSize}=request;
    if((await stat(path)).size!==expectedSize)return null;
    const valid=await pcmWave(path,w=>w.sampleRate===sampleRate&&w.channels===range.channels&&w.frames===frames);
    if(!valid)return null;
    await touchCache([path]);signal?.throwIfAborted();
    return {path,range,frames,channels:range.channels,sampleRate};
  }catch(error){if(signal?.aborted)throw error;return null;}
}
export async function renderRangeResource(store,unitId,mode,audioId,startFrame,endFrame,rangeSnapshot,{signal}={}) {
  signal?.throwIfAborted();
  const t=target(store,unitId,mode,audioId);
  const saved=rangeSnapshot===undefined?savedAudioRange(store,unitId,mode,t.audio.id):rangeSnapshot;
  const old=store.maybe('settings','audio-range-source:'+t.audio.id),file=resolve(store.directory,t.audio.path||'');
  if(saved&&old?.sourceHash===saved.sourceHash&&file.startsWith(resolve(store.directory)+'/')) {
    let native,version;
    try {
      const info=await stat(file);version=[t.audio.path,info.size,info.mtimeMs,info.ctimeMs].join(':');
      if(old.version===version&&await validateStoredAudio(store,t.audio,{signal}))native=await pcmWave(file,w=>w.sampleRate===sampleRate?{audioId:t.audio.id,sourceHash:old.sourceHash,decodeProfile,sampleRate,channels:w.channels,sourceFrames:w.frames}:null);
    }catch(error){if(signal?.aborted)throw error;}
    if(native){
      const cached=await cachedClip(clipRequest(store,unitId,mode,t.audio.id,native,saved,startFrame,endFrame),signal);
      if(cached){try{const now=await stat(file);signal?.throwIfAborted();if(store.maybe('audios',t.audio.id)?.path===t.audio.path&&[t.audio.path,now.size,now.mtimeMs,now.ctimeMs].join(':')===version)return cached;}catch(error){if(signal?.aborted)throw error;}}
    }
  }
  const source=await prepareAudioSource(store,t.audio.id,{signal});
  const request=clipRequest(store,unitId,mode,t.audio.id,source,saved,startFrame,endFrame),{range,path,frames,expectedSize}=request;
  const cached=await cachedClip(request,signal);if(cached)return cached;
  startFrame=range.startFrame;endFrame=range.endFrame;
  if(clips.has(path)){const shared=await clips.get(path);signal?.throwIfAborted();return shared;}
  const promise=pcmTasks.run(async()=>{
    signal?.throwIfAborted();
    const lease=reserveDiskSpace(store.directory,expectedSize,'区间试听缓存'),temp=path+'.'+uid()+'.part';let input,output;
    try {
      input=await open(source.pcmPath,'r');
      output=await open(temp,'wx');await output.writeFile(wavHeader(frames,source.channels));
      const frameSize=source.channels*2, buffer=Buffer.alloc(Math.floor(65536/frameSize)*frameSize);let offset=0;
      while(offset<frames){signal?.throwIfAborted();const count=Math.min(buffer.length,(frames-offset)*frameSize),{bytesRead}=await input.read(buffer,0,count,(startFrame+offset)*frameSize);signal?.throwIfAborted();if(bytesRead!==count)fail('源声音帧缓存不完整',409);
        for(let frame=0;frame<count/frameSize;frame++){const pos=offset+frame;let gain=1;if(pos<range.fadeInFrames)gain=range.fadeInFrames<=1?0:pos/(range.fadeInFrames-1);if(frames-1-pos<range.fadeOutFrames)gain=Math.min(gain,range.fadeOutFrames<=1?0:(frames-1-pos)/(range.fadeOutFrames-1));if(gain!==1)for(let ch=0;ch<source.channels;ch++){const i=frame*frameSize+ch*2;buffer.writeInt16LE(Math.round(buffer.readInt16LE(i)*gain),i);}}
        await output.writeFile(buffer.subarray(0,count));offset+=count/frameSize;
      }
      signal?.throwIfAborted();await output.close();output=null;signal?.throwIfAborted();await rename(temp,path);
      return {path,range,frames,channels:source.channels,sampleRate};
    }finally{try{await input?.close();await output?.close();await rm(temp,{force:true});}finally{lease.release();}}
  });clips.set(path,promise);try{const result=await promise;signal?.throwIfAborted();return result;}finally{clips.delete(path);}
}
export async function rangeResource(store,options) {const {signal,...range}=options;return renderRangeResource(store,range.unitId,range.mode,range.audioId,range.startFrame,range.endFrame,range.sourceHash ? range : undefined,{signal});}

export async function audioWaveform(store,audioId,{level=1024,startFrame=0,endFrame}={}) {
  const source=await prepareAudioSource(store,audioId);endFrame ??=source.sourceFrames;
  if(!Number.isSafeInteger(level)||level<1||level>8192)fail('波形分辨率应为1～8192桶');validFrames(startFrame,endFrame,source.sourceFrames);
  const bucketFrames=Math.max(1,Math.ceil((endFrame-startFrame)/level)), count=Math.ceil((endFrame-startFrame)/bucketFrames);
  const path=join(store.directory,'.audio-range-cache',hash([source.sourceHash,decodeProfile,'minmax-v1',level,startFrame,endFrame])+'.peaks.json');
  try{const cached=JSON.parse(await readFile(path,'utf8'));if(cached.sourceHash===source.sourceHash&&cached.decodeProfile===decodeProfile&&cached.sourceFrames===source.sourceFrames&&cached.channels===source.channels&&cached.startFrame===startFrame&&cached.endFrame===endFrame&&cached.bucketFrames===bucketFrames&&cached.buckets?.length===count&&cached.buckets.every(b=>b.min?.length===source.channels&&b.max?.length===source.channels&&b.min.every((v,ch)=>Number.isFinite(v)&&Number.isFinite(b.max[ch])&&v>=-1&&b.max[ch]<1&&v<=b.max[ch]))){await touchCache([path]);return {...cached,audioId};}}catch{}
  if(waves.has(path))return {...await waves.get(path),audioId};
  const promise=pcmTasks.run(async()=>{
    const buckets=Array.from({length:count},()=>({min:Array(source.channels).fill(1),max:Array(source.channels).fill(-1)}));
    const input=await open(source.pcmPath,'r'),frameSize=source.channels*2,buffer=Buffer.alloc(Math.floor(65536/frameSize)*frameSize);let offset=startFrame;
    try{while(offset<endFrame){const bytes=Math.min(buffer.length,(endFrame-offset)*frameSize),{bytesRead}=await input.read(buffer,0,bytes,offset*frameSize);if(bytesRead!==bytes)fail('波形源帧缓存不完整',409);for(let i=0;i<bytes/frameSize;i++){const bucket=buckets[Math.floor((offset+i-startFrame)/bucketFrames)];for(let ch=0;ch<source.channels;ch++){const v=buffer.readInt16LE(i*frameSize+ch*2)/32768;bucket.min[ch]=Math.min(bucket.min[ch],v);bucket.max[ch]=Math.max(bucket.max[ch],v);}}offset+=bytes/frameSize;}}finally{await input.close();}
    const {pcmPath,...metadata}=source,result={...metadata,startFrame,endFrame,bucketFrames,buckets};await writeFile(path,JSON.stringify(result));return result;
  });waves.set(path,promise);try{return await promise;}finally{waves.delete(path);}
}

export function presentationReview(store,unitId,mode,audioId,basis,originalState) {
  const range=savedAudioRange(store,unitId,mode,audioId),key=rangeContentKey(range);
  if(!key)return originalState;
  const review=store.maybe('settings','audio-range-review:'+unitId+':'+mode+':'+audioId+':'+key);
  return review && same(review.basis,basis) ? review.state : 'pending';
}
export function savePresentationReview(store,unitId,mode,audioId,basis,state) {
  const range=savedAudioRange(store,unitId,mode,audioId),key=rangeContentKey(range);
  if(!key)return false;
  store.put('settings',{id:'audio-range-review:'+unitId+':'+mode+':'+audioId+':'+key,projectId:range.projectId,chapterId:range.chapterId,unitId,mode,audioId,rangeContentKey:key,basis,state,at:new Date().toISOString()},range.chapterId);return true;
}
export function assertPresentationReview(store,unitId,mode,audioId,expectedKey) {
  if((expectedKey || null)!==rangeContentKey(savedAudioRange(store,unitId,mode,audioId)))fail('试听范围已在另一页面改变，请检查当前保留区间',409);
}
