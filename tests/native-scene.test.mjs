import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, compileNativeScene, listTemplates, listUnitTemplates, templateCatalog, resolveCompiler, scenePresenceConflicts } from '../server/templates.mjs';

const single = () => ({
  template: 'scene-v3-native',
  slots: [{speaker:'A',roleId:'narrator',reference:1}],
  members: [{id:'s1',roleId:'narrator',type:'narration',text:'洞中响起一声水滴。她缓缓睁开眼睛。',performance:'沉稳叙述'}],
  guidance:'水滴自然回响，仙侠器乐随着叙述转为宁静。',
  events: [
    {kind:'environment',memberId:'s1',position:'during',description:'空旷山洞，间歇水滴有自然空间回响'},
    {kind:'music',memberId:'s1',position:'during',description:'仙侠器乐旋律随后转为宁静'},
  ],
});

test('native 场景为明确试验白名单，不改变默认或旧模板策略', () => {
  assert.equal(templateCatalog.current,'dry-v1');
  assert.deepEqual(listTemplates().map(t=>t.id),['dry-v1']);
  const template=listUnitTemplates().find(t=>t.id==='scene-v3-native');
  assert.equal(template.mode,'scene');assert.equal(template.scope,'unit');assert.match(template.name,/试验/);
  const s=single();
  assert.match(compile({...s,template:'scene-v1'}),/对白清楚，声音事件次要/);
  assert.match(compile({...s,template:'scene-v2'}),/对白时适度降低背景声音，但不能消失/);
  assert.match(compile({...s,template:'scene-v2'}),/不延长停顿/);
  assert.match(compile({...s,template:'dialogue-dry-v1'}),/无音乐、环境声、额外音效和明显空间混响/);
  assert.match(compile({template:'dry-v1',text:'只朗读这句。'}),/生成一条中文有声书干声/);
  assert.throws(()=>compile({...s,template:'scene-v3-unapproved'}),/实现不可用/);
});

test('单旁白先组织完整采用声景，再给参考和唯一正文，不自造降低及停顿政策', () => {
  const s=single(),before=structuredClone(s),prompt=compile(s);
  assert.equal(prompt,compileNativeScene(s));assert.deepEqual(s,before);
  assert.match(prompt,/^创作一段完整的中文有声小说声音场景/);
  assert.ok(prompt.indexOf(s.events[0].description)<prompt.indexOf(s.members[0].text));
  assert.ok(prompt.indexOf(s.guidance)<prompt.indexOf(s.members[0].text));
  assert.ok(prompt.indexOf('其余描述作为声音创作要求，不读出')<prompt.indexOf(s.members[0].text));
  assert.match(prompt,/环境声：第1条正文期间，空旷山洞/);
  assert.match(prompt,/音乐：第1条正文期间，仙侠器乐旋律随后转为宁静/);
  for(const text of [s.guidance,s.members[0].text,...s.events.map(e=>e.description)])assert.equal(prompt.split(text).length,2,text);
  assert.match(prompt,/声音身份参考 @音频1/);
  assert.match(prompt,/环境和音乐可与旁白同期呈现/);
  assert.doesNotMatch(prompt,/轮流说话|不重叠|降低背景|事件次要|不延长停顿|指定范围内持续清楚可辨/);
  assert.doesNotMatch(prompt,/成年男性|\[逐条正文|\[只朗读/);
  s.slots[0].reference=2;assert.match(compile(s),/声音身份参考 @音频2/);
  s.events[0].memberId='missing';assert.throws(()=>compile(s),/声音事件锚点已失效/);
  s.events=[];s.members[0].roleId='missing';assert.throws(()=>compile(s),/成员缺少说话者槽位/);
});

test('多人稳定槽位、共享参考、连续及一次性范围保留完整映射', () => {
  const s=single();
  s.slots=[{speaker:'A',roleId:'r1',reference:2},{speaker:'B',roleId:'r2',reference:1},{speaker:'C',roleId:'r3',reference:2}];
  s.members=[{id:'a',roleId:'r3',text:'丙先开口。',performance:'迟疑'},{id:'b',roleId:'r1',text:'甲回答。',performance:'坚定'},{id:'c',roleId:'r2',text:'乙轻声。'}];
  s.guidance='对白之间依次接话；雨声与音乐同场发展。';
  s.events=[{kind:'environment',startMemberId:'a',startPosition:'before',endMemberId:'c',endPosition:'after',description:'持续雨声'},
    {kind:'music',startMemberId:'a',startPosition:'during',endMemberId:'b',endPosition:'during',description:'音乐渐入随后平静'},
    {kind:'effect',memberId:'b',position:'after',description:'两下敲门声'}];
  const prompt=compile(s);
  assert.match(prompt,/说话者 A 的声音身份参考 @音频2/);assert.match(prompt,/说话者 B 的声音身份参考 @音频1/);assert.match(prompt,/说话者 C 的声音身份参考 @音频2/);
  assert.match(prompt,/1\. 说话者 C；表演：迟疑；正文：丙先开口。/);
  assert.match(prompt,/2\. 说话者 A；表演：坚定；正文：甲回答。/);
  assert.match(prompt,/3\. 说话者 B；表演：自然清楚地朗读；正文：乙轻声。/);
  assert.match(prompt,/环境声：第1条正文之前至第3条正文之后，持续雨声/);
  assert.match(prompt,/音乐：第1条正文期间至第2条正文期间，音乐渐入随后平静/);
  assert.match(prompt,/一次性音效：第2条正文之后，两下敲门声/);
  assert.doesNotMatch(prompt,/roleId|startMemberId|endMemberId/);
  s.events[0].endMemberId='missing';assert.throws(()=>compile(s),/声音事件锚点已失效/);
  s.events=[];s.members[0].roleId='missing';assert.throws(()=>compile(s),/成员缺少说话者槽位/);
});

test('人工轻背景与紧凑节奏按原文保留，不按关键词删除表演或正文', () => {
  const s=single();
  s.guidance='背景很轻，不延长停顿，无前奏；人声干净，降低背景是我的选择。';
  s.members[0].performance='清晰干声式咬字，但保留山洞声景。';
  s.members[0].text='她说：“不要音乐，不延长停顿，也不要降低背景。”';
  const prompt=compile(s);
  for(const text of [s.guidance,s.members[0].performance,s.members[0].text])assert.equal(prompt.split(text).length,2,text);
  assert.doesNotMatch(prompt,/对白时适度降低|声音事件次要/);
  s.events=[];s.guidance='场景只有悠远琴声与洞穴回响，旁白正常叙述。';
  const guidanceOnly=compile(s);assert.ok(guidanceOnly.includes(s.guidance));assert.match(guidanceOnly,/不增加已采用事件或整体场景指导之外的声音或角色/);
});

test('中文和 emoji 正文及长声景不截断、不增加第二份朗读正文', () => {
  const s=single();
  s.members[0].text='她看见灯光✨与小猫🐈，说道：“你好👩🏽‍🚀。”';
  s.guidance='按自然节奏组织山洞声景。';
  const description='水滴💧在远处回响。'.repeat(320)+'最后音乐自然转为宁静。';
  s.events[0].description=description;
  const prompt=compileNativeScene(s);
  assert.ok(prompt.endsWith(`\n“${s.members[0].text}”`));
  assert.equal(prompt.split(s.members[0].text).length,2);
  assert.ok(prompt.includes(description));assert.ok(Array.from(prompt).length>3000);
  assert.ok(prompt.length>Array.from(prompt).length);
  assert.doesNotMatch(prompt,/�/);
  assert.throws(()=>compile(s),/1500/);
});

test('B15/B16 presence仅替换一个块，未选存在感原样，新模板不改正文或事件',()=>{
  const s=single(),before=structuredClone(s),old=compile(s),block='已采用声音按各自范围及发展要求组织；环境和音乐可与旁白同期呈现。';
  assert.equal(compile({...s,template:'scene-v4-presence-1'}),old);
  assert.equal(compile({...s,template:'scene-v4-presence-1',backgroundPresence:'unspecified'}),old);
  for(const presence of ['clear','natural','subtle']){
    const prompt=compile({...s,template:'scene-v4-presence-1',backgroundPresence:presence}),prefix=old.slice(0,old.indexOf(block)),suffix=old.slice(old.indexOf(block)+block.length);
    assert.ok(prompt.startsWith(prefix));assert.ok(prompt.endsWith(suffix));assert.equal(prompt.split(s.members[0].text).length,2);
    assert.match(prompt,presence==='clear'?/明确存在感/:presence==='natural'?/自然共同呈现/:/轻柔背景/);assert.match(prompt,/音量|淡出/);
    assert.doesNotMatch(prompt,/music_volume|降低背景声音|毫秒/);
  }
  assert.deepEqual(s,before);assert.equal(resolveCompiler(s,old),'native3-paragraph-k');assert.equal(resolveCompiler(s,old+'未知变化'),null);
});

test('B17/B18重复引文转折有真实出现序号，情绪和音量分开，明确冲突聚合一次',()=>{
  const s=single();s.template='scene-v4-presence-1';s.members[0].text='她终于放松。她终于放松。';
  s.events[1].transition={memberId:'s1',quote:'终于放松',occurrence:2,development:'旋律情绪和织体转为宁静'};
  const prompt=compile(s);assert.match(prompt,/第1条正文第2次出现“终于放松”/);assert.match(prompt,/音量变化：未指定，不由情绪变化推断淡出/);assert.equal(prompt.split(s.members[0].text).length,2);assert.doesNotMatch(prompt,/毫秒|\d+秒/);
  s.events[1].transition.occurrence=3;assert.throws(()=>compile(s),/出现序号已失效/);s.events[1].transition.occurrence=2;
  s.events[1].transition.volumeChange='保持清楚可闻';assert.match(compile(s),/音量变化：保持清楚可闻/);
  s.guidance='不要音乐；不要环境声';assert.throws(()=>compile(s),error=>error.code==='scene-intent-conflict' && error.conflicts.length===2);
  s.guidance='人声干净；背景很轻';assert.doesNotThrow(()=>compile(s));
});

test('明确几乎不可闻与极微弱设置冲突按存在感和来源返回，不改写用户要求',()=>{
  for(const description of ['音乐几乎不可闻','环境声几乎听不到','水滴听不清','把背景压低到听不到','极微弱的音乐','仅保留微弱底噪']){
    const input={backgroundPresence:'clear',guidance:description,events:[{kind:'music',state:'adopted',description}]},before=structuredClone(input),conflicts=scenePresenceConflicts(input);
    assert.equal(conflicts.length,2,description);assert.match(conflicts[0],/清楚.*整体场景指导/);assert.match(conflicts[1],/已采用音乐/);assert.deepEqual(input,before);
  }
  for(const description of ['音乐几乎不可闻','环境声几乎听不到','背景听不见','极微弱的音乐'])assert.equal(scenePresenceConflicts({backgroundPresence:'natural',events:[{kind:'music',state:'adopted',description}]}).length,1,description);
  for(const description of ['音乐响亮压过人声','环境声盖过对白','音效喧宾夺主'])assert.equal(scenePresenceConflicts({backgroundPresence:'subtle',guidance:description}).length,1,description);
});

test('宁静轻柔和明确否定弱化或压过人声不误报，未知存在感不猜',()=>{
  for(const backgroundPresence of ['clear','natural'])for(const guidance of ['宁静且旋律清楚可辨','轻柔背景，不抢讲话','音乐清楚但不喧宾夺主','不压低背景','不要把背景压低到几乎不可闻','背景并非极微弱','避免音乐几乎听不到','不要微弱底噪']){
    assert.deepEqual(scenePresenceConflicts({backgroundPresence,guidance}),[],guidance);
  }
  for(const guidance of ['清楚但不喧宾夺主','音乐不盖过人声','不要让音乐压过对白','避免环境声淹没台词'])assert.deepEqual(scenePresenceConflicts({backgroundPresence:'subtle',guidance}),[],guidance);
  assert.equal(scenePresenceConflicts({backgroundPresence:'clear',guidance:'不要把背景压低到几乎不可闻，但保留微弱底噪'}).length,1,'后半句明确冲突不被前半句否定掩盖');
  for(const backgroundPresence of ['unspecified',undefined,'unknown'])assert.deepEqual(scenePresenceConflicts({backgroundPresence,guidance:'极微弱，几乎不可闻的音乐'}),[]);
});

test('存在感只检查整体指导和已采用声音，不扫描身体叙述、表演及草稿移除事件',()=>{
  const input={...single(),backgroundPresence:'clear',guidance:'旋律宁静且清楚可辨',events:[{kind:'music',state:'draft',description:'极微弱音乐'},{kind:'environment',state:'removed',description:'几乎不可闻的环境声'}]};
  input.members[0].text='她的呼吸极微弱，远处的话听不清。';input.members[0].performance='声音极微弱的身体状态仍按正文叙述';
  assert.deepEqual(scenePresenceConflicts(input),[]);
  input.events.push({kind:'music',description:'极微弱，几乎不可闻的音乐'});
  assert.equal(scenePresenceConflicts(input).length,1,'已选择事件快照没有state仍需检查');
});

test('转折音量拒绝整段或对白期间不可闻，明确局部尾声淡出仍允许',()=>{
  for(const backgroundPresence of ['clear','natural']){
    const input={backgroundPresence,events:[{kind:'music',state:'adopted',description:'宁静且旋律清楚可辨',transition:{volumeChange:''}}]};
    for(const volumeChange of ['对白期间保持几乎不可闻','全程极微弱，末尾淡出','末尾淡出，但整段叙述几乎听不到','全段保持几乎不可闻直到尾声淡出']){
      input.events[0].transition.volumeChange=volumeChange;const conflicts=scenePresenceConflicts(input);assert.equal(conflicts.length,1,volumeChange);assert.match(conflicts[0],/转折音量/);
    }
    for(const volumeChange of ['尾声逐渐淡出到几乎不可闻','对白期间旋律清楚可辨，末尾淡出到几乎不可闻','仅在最后一句结束后渐弱至几乎听不到','尾声逐渐淡出，直到几乎不可闻','不要把音乐压低到几乎不可闻']){
      input.events[0].transition.volumeChange=volumeChange;assert.deepEqual(scenePresenceConflicts(input),[],volumeChange);
    }
    input.events[0].transition.volumeChange='全程几乎不可闻';input.events[0].state='removed';assert.deepEqual(scenePresenceConflicts(input),[]);
  }
});

test('存在感守卫独立于历史编译，已保存v4及旧模板仍逐字复现和识别',()=>{
  const s={...single(),template:'scene-v4-presence-1',backgroundPresence:'clear',guidance:'音乐几乎不可闻，仅保留微弱底噪'},before=structuredClone(s),prompt=compile(s);
  assert.ok(prompt.includes(s.guidance));assert.match(prompt,/明确存在感/);assert.equal(scenePresenceConflicts(s).length,1);
  assert.equal(compile(s),prompt);assert.equal(resolveCompiler(s,prompt),'scene-v4-presence-1');assert.deepEqual(s,before);
  for(const template of ['scene-v1','scene-v2','scene-v3-native']){
    const old={...s,template},saved=compile(old);assert.ok(saved.includes(s.guidance));assert.equal(compile(old),saved);assert.ok(resolveCompiler(old,saved));
  }
  s.events[1].transition={memberId:'s1',quote:'缓缓睁开眼睛',occurrence:1,development:'宁静旋律继续',volumeChange:'对白期间压到几乎不可闻'};
  const savedTransition=compile(s);assert.match(savedTransition,/音量变化：对白期间压到几乎不可闻/);assert.equal(resolveCompiler(s,savedTransition),'scene-v4-presence-1');assert.equal(scenePresenceConflicts(s).length,2);assert.equal(compile(s),savedTransition);
});
