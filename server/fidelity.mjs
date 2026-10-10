import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { same, fail } from './store.mjs';
import { compile } from './templates.mjs';
import { savedAudioRange, renderProfileOf, presentationReview } from './audio-range.mjs';

const words = value => Array.from(value || '').filter(c => !/[\p{P}\p{Z}\s]/u.test(c)).join('');
const available = (store, path, expectedBytes) => {
  if (!path) return false;
  const file=resolve(store.directory,path);
  if(!file.startsWith(resolve(store.directory)+'/'))return false;
  try {const s=statSync(file);return s.isFile()&&s.size>0&&(expectedBytes===undefined || s.size===expectedBytes);}catch{return false;}
};

// Pure projection: historical gaps and user edits are evidence, never permission to repair.
export function inspectFidelity(store, chapter, segments, coverage, options = {}) {
  const limit=options.limit ?? 20, offset=options.cursor == null ? 0 : Number(options.cursor);
  if (!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0||options.cursor!=null&&!/^\d+$/.test(String(options.cursor))) fail('保真记录分页范围无效');
  if(options.arrangement!==undefined&&(!Number.isSafeInteger(options.arrangement)||options.arrangement<0))fail('保真编排版本无效');
  const historical=options.arrangement!==undefined;
  const source=Array.from(chapter.source || ''), live=segments.filter(s=>!s.retired).sort((a,b)=>a.order-b.order), active=live.filter(s=>!s.excluded&&!s.deletion);
  const textFidelity={status:'retained',exact:0,punctuationEdits:0,wordEdits:0,unknown:0,unexplained:0}, items=[];
  for(const s of live) {
    const spans=s.source?.spans, current=(s.source?.version || 1)===(chapter.sourceVersion || 1);
    const known=current&&Array.isArray(spans)&&spans.length&&spans.every(p=>Number.isSafeInteger(p.start)&&Number.isSafeInteger(p.end)&&p.start>=0&&p.start<p.end&&p.end<=source.length);
    const original=known?spans.map(p=>source.slice(p.start,p.end).join('')).join(''):null;
    const kind=original===null?'unknown':original===s.text?'exact':words(original)===words(s.text)?'punctuation':'words';
    const recordedEdit=!!s.editHistory?.length || s.protectedFields?.includes('text')===true;
    if(kind==='unknown')textFidelity.unknown++;
    else if(kind==='exact')textFidelity.exact++;
    else {textFidelity[kind==='punctuation'?'punctuationEdits':'wordEdits']++;if(!recordedEdit)textFidelity.unexplained++;}
    items.push({kind:'text',segmentId:s.id,number:s.order+1,status:kind,recordedEdit,actor:'unknown',sourceVersion:s.source?.version || null,spans:known?spans.map(({start,end})=>({start,end})):[],participation:s.deletion?'deleted':s.excluded?'excluded':'active'});
  }
  textFidelity.status=textFidelity.unexplained?'mismatch':textFidelity.unknown?'unknown':textFidelity.punctuationEdits||textFidelity.wordEdits?'edited':'retained';
  const effectiveCoverage=coverage(chapter,active), sourceCoverage=coverage(chapter,live);
  const participation={active:active.length,excluded:live.filter(s=>s.excluded&&!s.deletion).length,deleted:live.filter(s=>s.deletion).length,retired:segments.filter(s=>s.retired).length,gaps:effectiveCoverage.gaps,overlaps:effectiveCoverage.overlaps};
  const memberMap=new Map(active.map(s=>[s.id,s])),audios=new Map(store.all('audios',chapter.id).map(a=>[a.id,a])), attempts=new Map(store.all('attempts').map(a=>[a.id,a]));
  let duplicateOwners=0;
  let master=null, rows=[];
  if(historical) {
    items.length=0;
    master=store.all('masters',chapter.id).filter(m=>m.arrangement===options.arrangement).sort((a,b)=>(b.createdAt || '').localeCompare(a.createdAt || ''))[0];
    if(!master)fail('未找到该历史编排的母版',404);
    rows=(master.mapping || []).map(m=>({id:m.unitId || m.segmentId || m.id,mode:m.mode || 'dry',members:m.memberIds || [m.segmentId || m.id],audioId:m.audioId,mapping:m}));
  } else {
    const units=store.all('units',chapter.id),used=new Set(),single=new Map(units.filter(u=>!['retired','dissolved'].includes(u.state)).map(u=>[u.id,u])),owners=new Map();
    for(const u of units.filter(u=>u.kind==='group'&&u.state==='active'))for(const id of u.members){if(owners.has(id))duplicateOwners++;owners.set(id,u);}
    for(const s of active) {
      const unit=owners.get(s.id) || single.get(s.id);
      const id=unit?.id || s.id;
      if(used.has(id))continue;used.add(id);
      const mode=unit?.mode || 'dry';
      rows.push({id,mode,members:unit?.members || [s.id],audioId:unit?.variants?.[mode]?.current || (!unit?s.current:null),review:unit?.variants?.[mode]?.review || s.review});
    }
  }
  const spokenPayload={status:'matched',matched:0,missing:0,mismatches:0,unknown:0}, audioProvenance={originalAvailable:0,originalNotSaved:0,originalUnknown:0,referenceFrozen:0,referenceUnknown:0}, listening={reviewed:0,pending:0,quality:'not-assessed'};
  const allMembers=[];
  for(const row of rows) {
    allMembers.push(...row.members);
    const audio=audios.get(row.audioId), problems=[];
    if(!audio){spokenPayload.missing++;listening.pending++;items.push({kind:'audio',unitId:row.id,audioId:row.audioId || null,status:'missing'});continue;}
    const input=audio.input || {}, frozen=input.members || (typeof input.text==='string'?[{id:row.members[0],text:input.text,roleId:audio.roleId || audio.slot?.roleId || audio.basis?.roleId,voiceId:input.voiceId}]:[]);
    if(!same(frozen.map(m=>m.id),row.members))problems.push('members-order');
    if(!historical) for(const member of frozen) {
      const s=memberMap.get(member.id);
      if(!s||!same([member.text,member.roleId,member.voiceId],[s.text,s.roleId,s.voiceId]))problems.push('member-'+member.id);
    }
    let promptStatus='unknown';
    if(typeof audio.prompt==='string')try {promptStatus=compile(input)===audio.prompt?'matched':'mismatch';}catch{promptStatus='unknown';}
    if(promptStatus==='mismatch')problems.push('frozen-prompt');
    if(problems.length)spokenPayload.mismatches++;else if(!frozen.length||promptStatus==='unknown')spokenPayload.unknown++;else spokenPayload.matched++;
    let ancestor=audio, seen=new Set();
    while(ancestor&&!attempts.has(ancestor.sourceAttemptId || ancestor.id)&&ancestor.tailRepair?.sourceAudioId&&!seen.has(ancestor.id)){seen.add(ancestor.id);ancestor=audios.get(ancestor.tailRepair.sourceAudioId);}
    const attempt=ancestor&&attempts.get(ancestor.sourceAttemptId || ancestor.id), delivery=audio.delivery || attempt?.delivery;
    const originalAvailability=delivery?.rawPath?Number.isSafeInteger(delivery.receivedBytes)&&available(store,delivery.rawPath,delivery.receivedBytes)?'available':available(store,delivery.rawPath)?'unknown':'not-saved':audio.originalAvailability==='not-saved'?'not-saved':'unknown';
    audioProvenance[originalAvailability==='available'?'originalAvailable':originalAvailability==='not-saved'?'originalNotSaved':'originalUnknown']++;
    const refs=input.referenceVoiceIds || (input.voiceId?[input.voiceId]:[]), assets=attempt?.referenceAssets ?? ancestor?.referenceAssets ?? audio.referenceAssets;
    const referenceFrozen=refs.length>0&&Array.isArray(assets)&&same(refs,assets.map(a=>a.voiceId))&&assets.every(a=>/^[a-f0-9]{64}$/.test(a.contentHash || '')&&Number.isSafeInteger(a.bytes)&&a.bytes>0);
    audioProvenance[referenceFrozen?'referenceFrozen':'referenceUnknown']++;
    const storedReview=row.review?.audioId===audio.id?row.review.state:historical&&audio.review?.audioId===audio.id?audio.review.state:'pending';
    const review=historical?'pending':presentationReview(store,row.id,row.mode,audio.id,audio.basis,storedReview);
    listening[review==='passed'?'reviewed':'pending']++;
    const range=historical?{startFrame:row.mapping.clipStartFrame ?? 0,endFrame:row.mapping.clipEndFrame ?? row.mapping.endFrame-row.mapping.startFrame,sourceFrames:null,decodeProfile:row.mapping.decodeProfile ?? null}:savedAudioRange(store,row.id,row.mode,audio.id);
    items.push({kind:'audio',unitId:row.id,memberIds:row.members,audioId:audio.id,mode:row.mode,status:problems.length?'mismatch':promptStatus==='unknown'?'unknown':'matched',problems,promptStatus,originalAvailability,referenceFrozen,referenceVoiceIds:refs,referenceAssets:assets?.map(({voiceId,contentHash,bytes})=>({voiceId,contentHash,bytes})),model:input.model || audio.model || null,template:input.template || null,processing:audio.processing?.version || audio.tailRepair?.version || null,range:range?{startFrame:range.startFrame,endFrame:range.endFrame,sourceFrames:range.sourceFrames,decodeProfile:range.decodeProfile}:null});
  }
  if(!historical&&(!same(allMembers,active.map(s=>s.id))||duplicateOwners))spokenPayload.mismatches++;
  spokenPayload.status=spokenPayload.mismatches?'mismatch':spokenPayload.missing||spokenPayload.unknown?'unknown':'matched';
  if(!rows.length)spokenPayload.status='unknown';
  const current={sourceCoverage,textFidelity,participation};
  return {chapterId:chapter.id,projectId:chapter.projectId,scope:{kind:historical?'historical':'current',arrangement:historical?master.arrangement:chapter.arrangement,sourceVersion:historical?master.sourceVersion ?? null:chapter.sourceVersion || 1,revision:historical?master.sourceRevision ?? null:chapter.revision},...(historical?{current,sourceCoverage:{valid:false,gaps:null,overlaps:null,status:'unknown'},textFidelity:{status:'unknown'},participation:{active:allMembers.length},masterId:master.id,renderProfile:renderProfileOf(master),boundaryPolicy:master.boundaryPolicy || 'unit-gap-v1'}:current),spokenPayload,audioProvenance,listening,items:items.slice(offset,offset+limit),total:items.length,nextCursor:offset+limit<items.length?String(offset+limit):null};
}
