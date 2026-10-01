import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {openStore,uid} from '../../server/store.mjs';
import {createDomain,inputOf,segmentStatus,knownRoles} from '../../server/domain.mjs';
import {validateStoredAudio} from '../../server/audio.mjs';
const dir=mkdtempSync(join(tmpdir(),'conformance-probes-'));const s=openStore(dir),d=createDomain(s),results=[];
try{
 const p=d.mutate('project.create',{name:'隔离缺陷复现'}),c=d.mutate('chapter.create',{projectId:p.id,title:'第一章',source:'原文。第二句。',segment:true}),r=s.all('roles',p.id)[0];
 const originalRev=s.get('chapters',c.id).revision;
 d.mutate('role.update',{id:r.id,entityRevision:r.revision??1,chapterId:c.id,revision:originalRev,note:'窗口 A 已保存',quote:''});
 let rejected=false;try{d.mutate('role.update',{id:r.id,entityRevision:r.revision??1,chapterId:c.id,revision:originalRev,note:'窗口 B 旧内容',quote:''});}catch{rejected=true}
 results.push({issue:'F01',expected:'旧窗口提交应冲突且保留 A',actual:s.get('roles',r.id).facts[0].text,conforms:rejected});
 d.mutate('role.update',{id:r.id,entityRevision:s.get('roles',r.id).revision??1,chapterId:c.id,revision:originalRev,aliasSources:[{name:'旧称',chapterId:c.id,kind:'原文明示',sourceQuote:'原文。',sourceVersion:s.get('chapters',c.id).sourceVersion}]});
 results.push({issue:'F02',expected:'别名具备来源分类/出处/正文版本',actual:s.get('roles',r.id).aliasSources,conforms:!!s.get('roles',r.id).aliasSources[0].sourceVersion});
 const v={id:uid(),state:'active',path:'reference.wav'};s.put('voices',v);writeFileSync(join(dir,v.path),'not audio');
 d.mutate('role.update',{id:r.id,entityRevision:s.get('roles',r.id).revision??1,chapterId:c.id,revision:s.get('chapters',c.id).revision,voiceId:v.id});
 let seg=d.list(c.id)[0];const audio={id:uid(),path:v.path,input:inputOf(seg)};s.put('audios',audio,c.id);seg.current=audio.id;s.put('segments',seg,c.id);
 await validateStoredAudio(s,audio);
 results.push({issue:'F04',expected:'内容损坏不应显示音频匹配',actual:segmentStatus(s,seg).validity,conforms:segmentStatus(s,seg).validity==='broken'});
 const wav=Buffer.alloc(44+960);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(48000,24);wav.writeUInt32LE(96000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(960,40);writeFileSync(join(dir,v.path),wav);await validateStoredAudio(s,s.get('audios',audio.id));
 const b=d.mutate('role.create',{projectId:p.id,name:'B'});d.mutate('role.update',{id:b.id,entityRevision:b.revision??1,voiceId:v.id});const before=s.get('chapters',c.id).arrangement;
 d.mutate('segment.update',{id:seg.id,chapterId:c.id,revision:s.get('chapters',c.id).revision,roleId:b.id});
 results.push({issue:'F05',expected:'相同音频输入的归属纠正无需使母版编排变更',actual:{before,after:s.get('chapters',c.id).arrangement,audio:segmentStatus(s,d.list(c.id)[0]).validity},conforms:before===s.get('chapters',c.id).arrangement});
 console.log(JSON.stringify({date:'2026-09-25',type:'audit probes; false means known nonconformance, not passed regression tests',results},null,2));
}finally{s.close();rmSync(dir,{recursive:true,force:true})}
