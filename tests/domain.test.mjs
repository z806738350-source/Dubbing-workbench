import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, same, uid } from "../server/store.mjs";
import {
  createDomain,
  coverage,
  basisOf,
  inputOf,
  segmentStatus,
  compile,
} from "../server/domain.mjs";
import { createWorker } from "../server/worker.mjs";

function setup(t, source = "第一句。😀第二句。") {
  const dir = mkdtempSync(join(tmpdir(), "dubbing-test-"));
  const store = openStore(dir),
    d = createDomain(store);
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const p = d.mutate("project.create", { name: "测试" });
  const c = d.mutate("chapter.create", {
    projectId: p.id,
    title: "第一章",
    source,
    segment: true,
  });
  const role = store.all("roles", p.id)[0];
  function voice() {
    const v = {
      id: uid(),
      name: "参考",
      path: uid() + ".wav",
      state: "active",
    };
    writeFileSync(join(dir, v.path), "test");
    store.put("voices", v);
    return v;
  }
  const v = voice();
  const update = (action, data = {}) =>
    d.mutate(action, {
      chapterId: c.id,
      revision: store.get("chapters", c.id).revision,
      ...(action === "role.update" ? {entityRevision: store.get("roles", data.id).revision ?? 1} : {}),
      ...data,
    });
  return { store, d, p, c, role, v, voice, update };
}
test("章节改名保留音频编排，但旧编辑保存仍冲突", t => {
  const {store,d,c,update} = setup(t);
  const before = store.get("chapters", c.id);
  update("chapter.update", {title: "新章名"});
  const after = store.get("chapters", c.id);
  assert.equal(after.arrangement, before.arrangement);
  assert.equal(after.revision, before.revision + 1);
  assert.throws(() => d.mutate("chapter.update", {chapterId:c.id,revision:before.revision,title:"过时改名"}), /其他页面/);
});
test("章节重排更新交换双方修订，拒绝旧页面重复移动且保留已有音频", t => {
  const {store,d,p,c,v} = setup(t);
  const middle = d.mutate("chapter.create", {projectId:p.id,title:"第二章",source:"中间章。",segment:true});
  const last = d.mutate("chapter.create", {projectId:p.id,title:"第三章",source:"末章。",segment:true});
  const s = d.list(last.id)[0];
  s.voiceId = v.id;
  const a = {id:uid(),path:v.path,input:inputOf(s)};
  store.put("audios",a,last.id);
  s.current = a.id;
  s.review = {audioId:a.id,basis:basisOf(s),state:"passed"};
  store.put("segments",s,last.id);
  const before = d.chapter(last.id), context = store.get("projects",p.id).contextRevision;
  const move = {chapterId:last.id,revision:last.revision,direction:-1};
  d.mutate("chapter.move",move);
  const after = d.chapter(last.id), chapters = store.all("chapters",p.id);
  assert.equal(after.revision,last.revision+1);
  assert.equal(store.get("chapters",middle.id).revision,middle.revision+1);
  assert.equal(store.get("chapters",c.id).revision,c.revision);
  assert.equal(after.order,1);
  assert.equal(after.arrangement,before.arrangement);
  assert.equal(store.get("chapters",middle.id).arrangement,middle.arrangement);
  assert.deepEqual(after.segments,before.segments);
  assert.equal(store.get("projects",p.id).contextRevision,context+1);
  assert.throws(() => d.mutate("chapter.move",move), {status:409});
  assert.throws(() => d.mutate("chapter.move",{chapterId:middle.id,revision:middle.revision,direction:-1}), {status:409});
  assert.deepEqual(store.all("chapters",p.id),chapters);
  assert.equal(store.get("projects",p.id).contextRevision,context+1);
  assert.equal(store.all("jobs").length,0);
});
test("音频配置只接收三个数值字段，保存与入队均拒绝未知属性", t => {
  const {store,d,c,v,update} = setup(t);
  const original = d.list(c.id)[0], chapter = store.get("chapters",c.id);
  for (const config of [null,[],"invalid",{...original.config,format:"mp3"},{...original.config,sample_rate:8000},{...original.config,channels:2}]) {
    assert.throws(() => update("segment.update",{id:original.id,config}), {status:400});
    assert.deepEqual(store.get("segments",original.id),original);
    assert.deepEqual(store.get("chapters",c.id),chapter);
  }
  const valid = update("segment.update",{id:original.id,voiceId:v.id,roleConfirmed:true,config:{pitch_rate:-12,loudness_rate:100,speech_rate:-50}});
  assert.deepEqual(valid.config,{pitch_rate:-12,loudness_rate:100,speech_rate:-50});
  valid.config.sample_rate = 8000;
  store.put("segments",valid,c.id);
  const worker = createWorker(store,d,{key:"test",model:"seed-audio-1.0"});
  assert.throws(() => worker.enqueue({chapterId:c.id,revision:store.get("chapters",c.id).revision,ids:[valid.id],commandId:uid()}), {status:400});
  assert.equal(store.all("jobs").length,0);
  assert.equal(store.all("attempts").length,0);
});
test("同音色不同来源合并保留覆盖保护；数值冲突取消不修改", t => {
  const {d,c,role,v,update} = setup(t);
  update("role.update", {id:role.id,voiceId:v.id});
  const [a,b] = d.list(c.id);
  update("segment.update", {id:b.id,voiceId:v.id});
  update("segment.update", {id:b.id,config:{...b.config,pitch_rate:2}});
  assert.throws(() => update("segment.merge",{id:a.id}), /配置不同/);
  assert.equal(d.list(c.id).length,2);
  const merged = update("segment.merge",{id:a.id,choice:"first"});
  assert.equal(merged.voiceId,v.id);
  assert.equal(merged.voiceSource,"override");
  assert.equal(merged.config.pitch_rate,0);
});
test("Unicode 原文区间覆盖完整，漏句/重复可检测", (t) => {
  const { d, c } = setup(t);
  const rows = d.list(c.id);
  assert.equal(coverage(c, rows).valid, true);
  assert.equal(coverage(c, rows.slice(1)).valid, false);
  assert.equal(
    coverage(c, [...rows, { ...rows[0], id: uid() }]).overlaps > 0,
    true,
  );
});
test("旧音频检查不能落到新音频，拒绝后当前检查记录不变",t=>{
  const {store,d,c,v,update}=setup(t);const segment=d.list(c.id)[0];
  segment.voiceId=v.id;const first={id:uid(),path:v.path,input:inputOf(segment)};
  store.put("audios",first,c.id);segment.current=first.id;store.put("segments",segment,c.id);
  const basis=basisOf(segment);const second={...first,id:uid()};store.put("audios",second,c.id);
  segment.current=second.id;store.put("segments",segment,c.id);
  assert.throws(()=>update("segment.review",{id:segment.id,audioId:first.id,basis,state:"passed"}),/试听版本已变化/);
  assert.equal(store.get("segments",segment.id).review,null);
  assert.equal(store.get("segments",segment.id).current,second.id);
});
test("首次绑定补齐当前章，覆盖音色受保护，跨章不静默修改", (t) => {
  const { store, d, p, c, role, v, voice, update } = setup(t);
  const other = d.mutate("chapter.create", {
    projectId: p.id,
    title: "二",
    source: "第三句。",
    segment: true,
  });
  const override = voice(),
    first = d.list(c.id)[0];
  update("segment.update", { id: first.id, voiceId: override.id });
  update("role.update", { id: role.id, voiceId: v.id });
  const rows = d.list(c.id);
  assert.equal(rows[0].voiceId, override.id);
  assert.equal(rows[1].voiceId, v.id);
  assert.equal(d.list(other.id)[0].voiceId, null);
});
test("拆分继承实际配置，默认值变动不影响；共享来源不误报重复", (t) => {
  const { d, c, role, v, voice, update } = setup(t);
  update("role.update", { id: role.id, voiceId: v.id });
  const second = voice();
  update("role.update", { id: role.id, voiceId: second.id });
  const old = d.list(c.id)[0];
  update("segment.split", { id: old.id, offset: 2, performance: ["", ""] });
  const rows = d.list(c.id);
  assert.equal(rows[0].voiceId, v.id);
  assert.equal(rows[1].voiceId, v.id);
  assert.equal(coverage(c, rows).valid, true);
  assert.equal(rows[0].current, null);
});
test("不同实际音色合并必须明确选择，取消没有半成品", (t) => {
  const { d, c, v, update } = setup(t);
  const rows = d.list(c.id);
  update("segment.update", { id: rows[0].id, voiceId: v.id });
  assert.throws(() => update("segment.merge", { id: rows[0].id }), /配置不同/);
  assert.equal(d.list(c.id).length, 2);
  update("segment.merge", { id: rows[0].id, choice: "first" });
  assert.equal(d.list(c.id)[0].voiceSource, "override");
  assert.equal(coverage(c, d.list(c.id)).valid, true);
});
test("改角色同音色仍匹配音频，但检查依据失效", (t) => {
  const { store, d, p, c, role, v, update } = setup(t);
  update("role.update", { id: role.id, voiceId: v.id });
  let s = d.list(c.id)[0];
  update("segment.update", { id: s.id, roleConfirmed: true });
  s = d.list(c.id)[0];
  const id = uid();
  store.put("audios", { id, path: v.path, input: inputOf(s) }, c.id);
  s.current = id;
  s.review = { audioId: id, basis: basisOf(s), state: "passed" };
  store.put("segments", s, c.id);
  const b = d.mutate("role.create", { projectId: p.id, name: "B" });
  d.mutate("role.update", { id: b.id, voiceId: v.id, entityRevision: b.revision ?? 1 });
  update("segment.update", { id: s.id, roleId: b.id });
  const now = d.list(c.id)[0];
  assert.equal(segmentStatus(store, now).validity, "matched");
  assert.equal(segmentStatus(store, now).review, "pending");
  assert.equal(compile(s), compile(now));
});
test("过期修订和运行中锁拒绝写入", (t) => {
  const { store, d, c, update } = setup(t);
  const s = d.list(c.id)[0];
  update("segment.update", { id: s.id, text: "更改" });
  assert.throws(
    () =>
      d.mutate("segment.update", {
        chapterId: c.id,
        revision: 1,
        id: s.id,
        text: "旧页面",
      }),
    /其他页面/,
  );
  store.put(
    "jobs",
    { id: uid(), commandId: uid(), chapterId: c.id, status: "running" },
    c.id,
  );
  assert.throws(
    () => update("segment.update", { id: s.id, text: "锁中修改" }),
    /处理任务/,
  );
});
test("同一个生成命令只入队一次，状态登记不使后续任务过期", (t) => {
  const { store, d, c, role, v, update } = setup(t);
  update("role.update", { id: role.id, voiceId: v.id });
  for (const s of d.list(c.id))
    update("segment.update", { id: s.id, roleConfirmed: true });
  const w = createWorker(store, d, { key: "test", model: "seed-audio-1.0" });
  const command = {
    chapterId: c.id,
    revision: store.get("chapters", c.id).revision,
    ids: d.list(c.id).map((s) => s.id),
    commandId: uid(),
  };
  const a = w.enqueue(command),
    b = w.enqueue(command);
  assert.equal(a.id, b.id);
  assert.equal(store.all("attempts", a.id).length, 2);
  assert.equal(store.get("chapters", c.id).revision, command.revision);
});
test("完整输入超限阻断，不截断正文，不派发请求", (t) => {
  const { store, d, c, role, v, update } = setup(t);
  update("role.update", { id: role.id, voiceId: v.id });
  const s = d.list(c.id)[0];
  update("segment.update", {
    id: s.id,
    roleConfirmed: true,
    text: "文".repeat(3000),
  });
  const w = createWorker(store, d, { key: "test" });
  assert.throws(
    () =>
      w.enqueue({
        chapterId: c.id,
        revision: store.get("chapters", c.id).revision,
        ids: [s.id],
        commandId: uid(),
      }),
    /3000/,
  );
  assert.equal(store.all("jobs").length, 0);
  assert.equal(d.list(c.id)[0].text.length, 3000);
});
test("拆分子条与邻条合并后，原文来源仍各覆盖一次", (t) => {
  const { d, c, update } = setup(t);
  const first = d.list(c.id)[0];
  update("segment.split", { id: first.id, offset: 2 });
  const child = d.list(c.id)[1];
  update("segment.merge", { id: child.id });
  assert.equal(coverage(c, d.list(c.id)).valid, true);
});
test("批量确认原子提交，未知片段不留下半批修改", (t) => {
  const { d, c, store, update } = setup(t);
  const rows = d.list(c.id);
  assert.throws(() =>
    update("segment.confirm", { ids: [rows[0].id, "missing"] }),
  );
  assert.equal(d.list(c.id)[0].roleConfirmed, false);
  const before = store.get("chapters", c.id).revision;
  update("segment.confirm", { ids: rows.map((s) => s.id) });
  assert.ok(d.list(c.id).every((s) => s.roleConfirmed && s.identityConfirmed));
  assert.equal(store.get("chapters", c.id).revision, before + 1);
});
test("模型设置按名称持久保存且不触碰章节修订", (t) => {
  const { store, d, c } = setup(t);
  const before = store.get("chapters", c.id);
  d.mutate("settings.update", { entityRevision: 1, textModel: " gemini-3.8-flash " });
  assert.equal(store.get("settings", "models").textModel, "gemini-3.8-flash");
  assert.deepEqual(store.get("chapters", c.id), before);
  assert.throws(() => d.mutate("settings.update", { entityRevision: 2, textModel: "  " }));
  assert.throws(() =>
    d.mutate("settings.update", { entityRevision: 2, textModel: "model\nsecret" }),
  );
});

test("角色上下文不携带后续章节才确认的身份、别名和事实", async (t) => {
  const { knownRoles } = await import("../server/domain.mjs");
  const { store, d, c, p } = setup(t);
  const later = d.mutate("chapter.create", {
    projectId: c.projectId,
    title: "以后",
    source: "后文。",
  });
  store.put(
    "roles",
    {
      id: "early",
      projectId: c.projectId,
      name: "甲",
      introducedIn: c.id,
      aliases: ["早期别名", "后期别名"],
      aliasSources: [
        { name: "早期别名", chapterId: c.id, kind:"用户补充",sourceVersion:1 },
        { name: "后期别名", chapterId: later.id, kind:"用户补充",sourceVersion:1 },
      ],
      facts: [
        { text: "早期事实", chapterId: c.id },
        { text: "后期事实", chapterId: later.id },
      ],
    },
    c.projectId,
  );
  store.put(
    "roles",
    { id: "late", projectId: c.projectId, name: "乙", introducedIn: later.id },
    c.projectId,
  );
  const context = knownRoles(store, c);
  assert.equal(
    context.some((r) => r.id === "late"),
    false,
  );
  assert.deepEqual(context.find((r) => r.id === "early").aliases, ["早期别名"]);
  assert.deepEqual(
    context.find((r) => r.id === "early").facts.map((f) => f.text),
    ["早期事实"],
  );
});

test("批量改绑保留覆盖音色并重核对，越界回滚；有引用角色不能归档", (t) => {
  const { store, d, p, c, role, v, voice, update } = setup(t);
  const other = voice();
  update("role.update", { id: role.id, voiceId: v.id });
  const target = d.mutate("role.create", {
    projectId: p.id,
    name: "目标",
    chapterId: c.id,
  });
  update("role.update", { id: target.id, voiceId: other.id });
  let rows = d.list(c.id);
  update("segment.update", { id: rows[1].id, voiceId: v.id });
  assert.throws(
    () => update("role.update", { id: role.id, archived: true }),
    /引用|旁白/,
  );
  assert.throws(() =>
    update("segment.rebind", {
      ids: [rows[0].id, "missing"],
      roleId: target.id,
    }),
  );
  assert.equal(d.list(c.id)[0].roleId, role.id);
  update("segment.rebind", { ids: rows.map((s) => s.id), roleId: target.id });
  rows = d.list(c.id);
  assert.equal(rows[0].voiceId, other.id);
  assert.equal(rows[1].voiceId, v.id);
  assert.equal(rows[1].identityConfirmed, false);
  assert.throws(
    () => update("role.update", { id: target.id, archived: true }),
    /引用/,
  );
  update("segment.rebind", { ids: rows.map((s) => s.id), roleId: role.id });
  update("role.update", { id: target.id, archived: true });
  assert.equal(store.get("roles", target.id).archived, true);
  assert.throws(
    () => update("segment.rebind", { ids: [rows[0].id], roleId: target.id }),
    /归档/,
  );
});

test("角色显示名变化更新文本分析上下文，但不改变章节音频编排", (t) => {
  const { store, c, p, role, update } = setup(t);
  const before = store.get("chapters", c.id),
    revision = store.get("projects", p.id).contextRevision;
  update("role.update", { id: role.id, name: "叙述者" });
  assert.equal(store.get("projects", p.id).contextRevision, revision + 1);
  assert.deepEqual(store.get("chapters", c.id), before);
  update("role.update", { id: role.id, name: "叙述者" });
  assert.equal(store.get("projects", p.id).contextRevision, revision + 1);
});

test('默认间隔仅用于新章，当前章改间隔更新编辑修订；清空正文明确排除', t=>{
  const {d,store,c,p,update}=setup(t);
  d.mutate('settings.update',{entityRevision:1,defaultGap:0.8});
  const second=d.mutate('chapter.create',{projectId:p.id,title:'新章',source:'新。',sourceFilename:'原稿.txt',importedSource:'新。\r\n'});
  assert.equal(second.gap,0.8);assert.equal(store.get('chapters',c.id).gap,0.5);assert.equal(second.importedSource,'新。\r\n');assert.equal(second.sourceFilename,'原稿.txt');
  const before=store.get('chapters',c.id).revision;update('chapter.update',{gap:0});assert.equal(store.get('chapters',c.id).revision,before+1);
  const first=d.list(c.id)[0];update('segment.update',{id:first.id,text:''});const cleared=store.get('segments',first.id);assert.equal(cleared.excluded,true);assert.equal(cleared.editHistory.at(-1).text,first.text);assert.equal(d.chapter(c.id).coverage.valid,true);
});
test('旧源版本不通过覆盖；拆分与合并保留当前来源和实际模型',t=>{
  const {d,store,c,update}=setup(t);const first=d.list(c.id)[0];
  first.source.version=999;store.put('segments',first,c.id);assert.equal(d.chapter(c.id).coverage.valid,false);
  first.source.version=1;first.model='original-audio';store.put('segments',first,c.id);
  const children=update('segment.split',{id:first.id,offset:2,performance:['','']});assert.ok(children.every(s=>s.model==='original-audio'&&s.source.version===1&&s.source.parentRevision));
  const second=children[1];second.model='another-audio';store.put('segments',second,c.id);assert.throws(()=>update('segment.merge',{id:children[0].id,performance:''}),/配置不同/);
  const merged=update('segment.merge',{id:children[0].id,choice:'first',performance:''});assert.equal(merged.model,'original-audio');assert.equal(merged.source.version,1);assert.equal(d.chapter(c.id).coverage.valid,true);
});
test('历史音频缺少 model 字段仍匹配；更换实际模型后旧音频待更新',t=>{
  const {store,d,c,update}=setup(t);const s=d.list(c.id)[0], input=inputOf(s), basis=basisOf(s);delete input.model;delete basis.model;
  const audio={id:uid(),input,model:'seed-audio-1.0',path:'legacy.wav'};writeFileSync(join(store.directory,audio.path),'legacy');store.put('audios',audio,c.id);
  s.current=audio.id;s.review={audioId:audio.id,basis,state:'passed'};store.put('segments',s,c.id);
  assert.equal(segmentStatus(store,s).validity,'matched');assert.equal(segmentStatus(store,s).review,'passed');
  s.model='other';store.put('segments',s,c.id);assert.equal(segmentStatus(store,s).validity,'stale');assert.equal(segmentStatus(store,s).review,'pending');
});

test('等效编译提示复用音频和恢复设置，审核依据变化仍需检查', t => {
  const {store,d,c,role,v,update}=setup(t);
  update('role.update',{id:role.id,voiceId:v.id});
  const s=d.list(c.id)[0], prompt=compile(s);
  const audio={id:uid(),path:v.path,input:inputOf(s),prompt};
  store.put('audios',audio,c.id);
  s.current=s.previous=audio.id;
  s.review={audioId:audio.id,basis:basisOf(s),state:'passed'};
  store.put('segments',s,c.id);
  update('segment.update',{id:s.id,performance:'自然、清楚地朗读，不增加喘息、笑声或额外台词。'});
  let current=d.list(c.id)[0];
  assert.equal(compile(current),prompt);
  assert.equal(segmentStatus(store,current).validity,'matched');
  assert.equal(segmentStatus(store,current).review,'pending');
  update('segment.restore',{id:s.id,audioId:audio.id});
  current=d.list(c.id)[0];
  assert.equal(current.performance,'自然、清楚地朗读，不增加喘息、笑声或额外台词。');
  assert.equal(current.current,audio.id);
  for (const patch of [{text:s.text+'新字'},{performance:'更轻一些'},{model:'another-model'},{voiceId:uid()},{config:{...s.config,pitch_rate:1}}])
    assert.equal(segmentStatus(store,{...current,...patch}).validity,'stale');
  store.put('audios',{...audio,prompt:prompt+'额外指令'},c.id);
  assert.equal(segmentStatus(store,current).validity,'stale');
  store.put('audios',{...audio,prompt:undefined},c.id);
  assert.equal(segmentStatus(store,current).validity,'matched');
  assert.equal(store.all('jobs').length,0);
});

test('对象键顺序不改变音频和检查状态，数组顺序仍有意义', t => {
  const {store,d,c,role,v,update}=setup(t);
  update('role.update',{id:role.id,voiceId:v.id});
  const s=d.list(c.id)[0],audio={id:uid(),path:v.path,input:inputOf(s),prompt:compile(s)};
  store.put('audios',audio,c.id);
  s.current=audio.id;s.review={audioId:audio.id,basis:basisOf(s),state:'passed'};
  store.put('segments',s,c.id);
  update('segment.update',{id:s.id,config:{pitch_rate:0,loudness_rate:0,speech_rate:0}});
  const current=d.list(c.id)[0];
  assert.equal(segmentStatus(store,current).validity,'matched');
  assert.equal(segmentStatus(store,current).review,'passed');
  assert.ok(same({a:1,b:2},{b:2,a:1}));
  assert.ok(!same(['reference-one','reference-two'],['reference-two','reference-one']));
});

test("更换原文后旧事实出处不进入分析，重新核对保存后恢复", async (t) => {
  const { knownRoles } = await import("../server/domain.mjs");
  const { store, c, role, update } = setup(t);
  update("role.update", { id: role.id, note: "正在说话", quote: "第一句。", gender: "未知" });
  assert.equal(knownRoles(store, c)[0].facts.length, 1);
  store.put("chapters", { ...store.get("chapters", c.id), source: "新的一句。", sourceVersion: 2 }, c.projectId);
  assert.equal(knownRoles(store, c)[0].facts.length, 0);
  assert.throws(() => update("role.update", { id: role.id, note: "正在说话", quote: "第一句。" }), /原文依据/);
  update("role.update", { id: role.id, note: "正在说话", quote: "新的一句。" });
  assert.equal(knownRoles(store, c)[0].facts[0].sourceVersion, 2);
  update("role.update", { id: role.id, note: "用户补充", quote: "" });
  store.put("chapters", { ...store.get("chapters", c.id), sourceVersion: 3 }, c.projectId);
  assert.equal(knownRoles(store, c)[0].facts[0].kind, "用户补充");
});

test("拆合必须明确重新分配已有表演要求，取消不留下结构修改", (t) => {
  const { d, c, update } = setup(t);
  const original = d.list(c.id)[0];
  update("segment.update", { id: original.id, performance: "后半句哽咽" });
  assert.throws(() => update("segment.split", { id: original.id, offset: 2 }), /明确分配/);
  assert.equal(d.list(c.id).length, 2);
  const children = update("segment.split", { id: original.id, offset: 2, performance: ["克制", "哽咽"] });
  assert.deepEqual(children.map(s => s.performance), ["克制", "哽咽"]);
  assert.throws(() => update("segment.merge", { id: children[0].id }), /确认合并/);
  assert.equal(d.list(c.id).length, 3);
  const merged = update("segment.merge", { id: children[0].id, performance: "先克制，后半句哽咽" });
  assert.equal(merged.performance, "先克制，后半句哽咽");
  assert.equal(merged.current, null);
  assert.equal(merged.review, null);
  assert.equal(d.list(c.id).length, 2);
});

test("角色、项目与音色拒绝旧表单；冲突不留下部分修改，旧数据以版本 1 兼容", t => {
  const {store,d,p,c,role,v} = setup(t);
  const base = {id:role.id,chapterId:c.id,revision:c.revision,entityRevision:1};
  const saved = d.mutate("role.update", {...base,note:"窗口 A 已保存",quote:""});
  assert.equal(saved.revision,2);
  assert.equal(store.get("chapters",c.id).revision,c.revision);
  assert.throws(() => d.mutate("role.update", {...base,name:"窗口 B 旧名",note:"窗口 B 旧内容",quote:""}), {status:409});
  assert.deepEqual(store.get("roles",role.id),saved);
  assert.throws(() => d.mutate("role.update", {id:role.id,name:"未带版本"}), {status:409});
  const contextBefore = store.get("projects",p.id).contextRevision;
  assert.throws(() => d.mutate("role.update", {...base,entityRevision:2,name:"不应留下半次改名",note:"内容",quote:"不是原文"}), /原文依据/);
  assert.deepEqual(store.get("roles",role.id),saved);
  assert.equal(store.get("projects",p.id).contextRevision,contextBefore);
  assert.equal(d.mutate("role.update",{...base,entityRevision:2,name:"主动核对后保存"}).revision,3);

  const project = d.mutate("project.rename",{id:p.id,name:"新项目名",entityRevision:1});
  assert.equal(project.revision,2);
  assert.throws(()=>d.mutate("project.rename",{id:p.id,name:"旧窗口",entityRevision:1}),{status:409});
  assert.deepEqual(store.get("projects",p.id),project);

  const voice = d.mutate("voice.update",{id:v.id,name:"新音色名",entityRevision:1});
  assert.throws(()=>d.mutate("voice.update",{id:v.id,state:"stopped",entityRevision:1}),{status:409});
  assert.throws(()=>d.mutate("voice.delete",{id:v.id,confirm:true,entityRevision:1}),{status:409});
  assert.deepEqual(store.get("voices",v.id),voice);
  store.put("jobs",{id:uid(),chapterId:c.id,status:"running"},c.id);
  assert.throws(()=>d.mutate("role.update",{...base,entityRevision:3,voiceId:v.id,apply:true}),/正在处理/);
  assert.throws(()=>d.mutate("chapter.update",{chapterId:c.id,revision:c.revision,title:"不应改名"}),/正在处理/);
  assert.throws(()=>d.mutate("chapter.delete",{chapterId:c.id,revision:c.revision}),/正在处理/);
  const other = d.mutate("chapter.create",{projectId:p.id,title:"其他章",source:"另章。",segment:true});
  const otherRow=d.list(other.id)[0];
  d.mutate("segment.update",{chapterId:other.id,revision:other.revision,id:otherRow.id,text:"其他章仍可编辑。"});
  assert.equal(d.list(other.id)[0].text,"其他章仍可编辑。");
  // 停用参考在章节只读期间仍允许，但保存的版本必须匹配。
  assert.equal(d.mutate("voice.update",{id:v.id,state:"stopped",entityRevision:2}).state,"stopped");
  assert.throws(()=>d.mutate("role.update",{...base,entityRevision:3,voiceId:v.id,apply:true}),/停用|可用|正在处理/);
  const settings=d.mutate("settings.update",{entityRevision:1,textModel:"gemini-3.8-flash",defaultGap:0.8});
  assert.throws(()=>d.mutate("settings.update",{entityRevision:1,textModel:"DeepSeek-V4-Pro",defaultGap:0}),{status:409});
  assert.deepEqual(store.get("settings","models"),settings);
});

test("别名逐项校验出处与类别，重复候选不跨角色合并，无效保存原子回滚", async t=>{
  const {store,d,p,c,role,update}=setup(t,"大家叫沈砚老沈。她猜测老沈就是沈砚。");
  const alias=(name,kind,sourceQuote="",reason="")=>({name,kind,sourceQuote,reason,chapterId:c.id,sourceVersion:1});
  const sources=[alias("老沈","原文明示","大家叫沈砚老沈。"),alias("沈先生","上下文推断","她猜测老沈就是沈砚。","根据语境推断，已由用户核对"),alias("项目代号","用户补充")];
  const before=store.get("chapters",c.id),ctx=store.get("projects",p.id).contextRevision;
  update("role.update",{id:role.id,aliasSources:sources,voiceId:""});
  assert.deepEqual(d.chapter(c.id).knownRoles[0].aliasSources,sources);
  assert.equal(store.get("projects",p.id).contextRevision,ctx+1);
  assert.deepEqual(store.get("chapters",c.id),before);
  const saved=store.get("roles",role.id);
  for(const invalid of [
    [alias("老沈","原文明示","不在原文")],
    [alias("老沈","上下文推断","大家叫沈砚老沈。")],
    [alias("老沈","创作建议")],
    [{...sources[0],sourceVersion:2}],
    [{...sources[0],chapterId:"other-project"}],
    [sources[0],sources[0]],
  ]){
    assert.throws(()=>update("role.update",{id:role.id,name:"不应留下半次改名",aliasSources:invalid}));
    assert.deepEqual(store.get("roles",role.id),saved);
  }
  assert.throws(()=>update("role.update",{id:role.id,aliases:["没有出处"]}),/逐项/);
  const other=d.mutate("role.create",{projectId:p.id,chapterId:c.id,name:"另一个人"});
  update("role.update",{id:other.id,aliasSources:[sources[0]]});
  assert.equal(d.chapter(c.id).knownRoles.filter(r=>r.aliases.includes("老沈")).length,2);
});

test("历史别名保留待核对，迁移只失效文本上下文且重复启动不再改写",t=>{
  const {store,d,p,c,role}=setup(t);
  const legacy={...role,aliases:["旧称"],aliasSources:[{name:"旧称",chapterId:c.id}]};
  store.put("roles",legacy,p.id);
  const chapter=store.get("chapters",c.id),segments=d.list(c.id),ctx=store.get("projects",p.id).contextRevision;
  const migrated=createDomain(store),after=store.get("roles",role.id);
  assert.equal(after.aliasSources[0].needsReview,true);
  assert.equal(after.aliasSources[0].kind,undefined);
  assert.equal(after.aliasSources[0].sourceQuote,undefined);
  assert.equal(after.revision,2);
  assert.deepEqual(migrated.chapter(c.id).knownRoles[0].aliases,[]);
  assert.deepEqual(after.aliases,["旧称"]);
  assert.deepEqual(store.get("chapters",c.id),chapter);
  assert.deepEqual(migrated.list(c.id),segments);
  assert.equal(store.get("projects",p.id).contextRevision,ctx+1);
  createDomain(store);
  assert.deepEqual(store.get("roles",role.id),after);
  assert.equal(store.get("projects",p.id).contextRevision,ctx+1);
  migrated.mutate("role.update",{id:role.id,entityRevision:2,chapterId:c.id,revision:c.revision,aliasSources:[{name:"旧称",chapterId:c.id,kind:"用户补充",sourceQuote:"",reason:"",sourceVersion:1}]});
  assert.deepEqual(migrated.chapter(c.id).knownRoles[0].aliases,["旧称"]);
});

test("别名随叙事顺序截取，来源章以外不能改写或移除，重排不重做音频",t=>{
  const {store,d,p,c,role,update}=setup(t);
  const later=d.mutate("chapter.create",{projectId:p.id,title:"第二章",source:"后文。"});
  const first={name:"早期称呼",chapterId:c.id,kind:"用户补充",sourceQuote:"",reason:"",sourceVersion:1};
  const second={...first,name:"后期称呼",chapterId:later.id};
  update("role.update",{id:role.id,aliasSources:[first]});
  update("role.update",{id:role.id,chapterId:later.id,revision:later.revision,aliasSources:[first,second]});
  assert.deepEqual(d.chapter(c.id).knownRoles[0].aliases,[first.name]);
  assert.deepEqual(d.chapter(later.id).knownRoles[0].aliases,[first.name,second.name]);
  assert.throws(()=>update("role.update",{id:role.id,aliasSources:[first]}),/来源章节/);
  const arrangement=store.get("chapters",c.id).arrangement,rows=d.list(c.id),ctx=store.get("projects",p.id).contextRevision;
  d.mutate("chapter.move",{chapterId:later.id,revision:later.revision,direction:-1});
  assert.deepEqual(d.chapter(later.id).knownRoles[0].aliases,[second.name]);
  assert.deepEqual(d.chapter(c.id).knownRoles[0].aliases,[first.name,second.name]);
  assert.equal(store.get("chapters",c.id).arrangement,arrangement);
  assert.deepEqual(d.list(c.id),rows);
  assert.equal(store.get("projects",p.id).contextRevision,ctx+1);
});

test("同声角色纠正复用编排但更新播放与审核依据，确认和显示改名不重建声音", t=>{
  const {store,d,p,c,role,v,voice,update}=setup(t);update('role.update',{id:role.id,voiceId:v.id});
  const rows=d.list(c.id);for(const s of rows){const a={id:uid(),path:v.path,input:inputOf(s)};store.put('audios',a,c.id);s.current=a.id;s.review={audioId:a.id,basis:basisOf(s),state:'passed'};store.put('segments',s,c.id)}
  const target=d.mutate('role.create',{projectId:p.id,name:'B'});update('role.update',{id:target.id,voiceId:v.id});
  let before=d.chapter(c.id);const s=d.list(c.id)[0];
  update('segment.update',{id:s.id,roleId:target.id});let after=d.chapter(c.id);
  assert.equal(after.arrangement,before.arrangement);assert.equal(after.revision,before.revision+1);assert.notDeepEqual(after.playbackItems,before.playbackItems);assert.equal(after.segments[0].validity,'matched');assert.equal(after.segments[0].review,'pending');assert.equal(after.segments[1].review,'passed');
  assert.throws(()=>update('segment.review',{id:s.id,audioId:s.current,basis:basisOf(s),state:'passed'}),/试听版本已变化/);
  before=after;update('role.update',{id:target.id,name:'Renamed'});update('chapter.update',{title:'Renamed chapter'});after=d.chapter(c.id);assert.deepEqual(after.playbackItems,before.playbackItems);assert.equal(after.arrangement,before.arrangement);
  update('segment.rebind',{ids:rows.map(s=>s.id),roleId:role.id});assert.equal(d.chapter(c.id).arrangement,before.arrangement);
  before=d.chapter(c.id);update('segment.confirm',{ids:rows.map(s=>s.id)});after=d.chapter(c.id);assert.equal(after.arrangement,before.arrangement);assert.notDeepEqual(after.playbackItems,before.playbackItems);
  before=after;update('role.update',{id:role.id,voiceId:v.id,apply:true});assert.equal(d.chapter(c.id).arrangement,before.arrangement);
  const other=voice();update('role.update',{id:target.id,voiceId:other.id});update('segment.rebind',{ids:rows.map(s=>s.id),roleId:target.id});assert.equal(d.chapter(c.id).arrangement,before.arrangement);assert.equal(d.chapter(c.id).segments[0].validity,'stale');
});

test("音色人工检查独立于生成成功，观察保存使相关导演建议过期但不改音频",t=>{
  const {store,d,c,p,role,v,update}=setup(t);update('role.update',{id:role.id,voiceId:v.id});const chapter=store.get('chapters',c.id),segments=d.list(c.id),ctx=store.get('projects',p.id).contextRevision;
  const observations={tone:'偏低',accent:'普通话',performance:'明显紧张',volume:'偏轻'};
  let voice=d.mutate('voice.update',{id:v.id,entityRevision:1,observations,inspection:{target:'reference',audioId:null,checked:false}});
  assert.equal(d.snapshot().voices.find(x=>x.id===v.id).inspectionCurrent,false);assert.equal(store.get('projects',p.id).contextRevision,ctx+1);
  voice=d.mutate('voice.update',{id:v.id,entityRevision:voice.revision,inspection:{target:'reference',audioId:null,checked:true}});
  assert.equal(d.snapshot().voices.find(x=>x.id===v.id).inspectionCurrent,true);assert.equal(d.snapshot().voices.find(x=>x.id===v.id).tested,false);assert.ok(Date.parse(voice.inspection.at));
  const a={id:uid(),path:v.path,input:{voiceId:v.id}};store.put('audios',a);voice.sampleAudioId=a.id;store.put('voices',voice);
  assert.equal(d.snapshot().voices.find(x=>x.id===v.id).inspectionCurrent,true); // 明确是参考检查，不冒充新样音检查。
  voice=d.mutate('voice.update',{id:v.id,entityRevision:voice.revision,inspection:{target:'sample',audioId:a.id,checked:true}});
  const newer={id:uid(),path:v.path,input:{voiceId:v.id}};store.put('audios',newer);store.put('voices',{...voice,sampleAudioId:newer.id});
  assert.equal(d.snapshot().voices.find(x=>x.id===v.id).inspectionCurrent,false);
  assert.throws(()=>d.mutate('voice.update',{id:v.id,entityRevision:voice.revision,observations:{...observations,tone:'不应保存'},inspection:{target:'sample',audioId:a.id,checked:true}}),/样音已变化/);
  assert.deepEqual(store.get('voices',v.id).observations,observations);assert.equal(store.get('projects',p.id).contextRevision,ctx+1);
  assert.throws(()=>d.mutate('voice.update',{id:v.id,entityRevision:1,observations}),/资料已在其他页面/);
  assert.throws(()=>d.mutate('voice.update',{id:v.id,entityRevision:voice.revision,observations:{tone:'x'.repeat(1001)}}),/最多 1000/);
  assert.throws(()=>d.mutate('voice.update',{id:v.id,entityRevision:voice.revision,inspection:{target:'sample',audioId:newer.id,checked:'yes'}}),/检查记录无效/);
  assert.deepEqual(store.get('chapters',c.id),chapter);assert.deepEqual(d.list(c.id),segments);assert.equal(store.all('jobs').length,0);
});

test("模板版本只在明确切换后改变，新建使用当前默认，拆分继承父模板和数值",async t=>{
  const {templateCatalog}=await import('../server/templates.mjs');const original=templateCatalog.current;
  t.after(()=>{templateCatalog.current=original;delete templateCatalog.versions['fixture-v2']});
  const {store,d,c,v,role,update}=setup(t);update('role.update',{id:role.id,voiceId:v.id});let s=d.list(c.id)[0];const originalPrompt=compile(s);
  const audio={id:uid(),path:v.path,input:inputOf(s)};store.put('audios',audio,c.id);s.current=audio.id;s.review={audioId:audio.id,basis:basisOf(s),state:'passed'};store.put('segments',s,c.id);
  const first=templateCatalog.versions['dry-v1'];templateCatalog.versions['fixture-v2']={...first,name:'TEST ONLY v2',description:'Controlled test fixture',defaults:{...first.defaults,speech_rate:5},compile:s=>first.compile(s)+'\n[TEST ONLY v2]'};templateCatalog.current='fixture-v2';
  assert.equal(compile(s),originalPrompt);
  const created=update('segment.create',{text:'新建片段。'});assert.equal(created.template,'fixture-v2');assert.equal(created.config.speech_rate,5);
  update('segment.update',{id:s.id,text:s.text+'改字'});assert.equal(d.list(c.id)[0].template,'dry-v1');assert.equal(d.list(c.id)[0].config.speech_rate,0);
  update('segment.update',{id:s.id,text:s.text});
  const before=store.get('chapters',c.id),rows=d.list(c.id),preview=d.previewTemplate({id:s.id,chapterId:c.id,revision:before.revision,template:'fixture-v2'});
  assert.equal(preview.before,originalPrompt);assert.match(preview.after,/TEST ONLY v2/);assert.deepEqual(d.list(c.id),rows);
  assert.throws(()=>update('segment.template',{id:s.id,template:'fixture-v2'}),/明确应用/);assert.throws(()=>update('segment.update',{id:s.id,template:'fixture-v2'}),/明确的模板切换/);
  assert.throws(()=>update('segment.template',{id:s.id,template:'toString',confirm:true}),/实现不可用/);assert.throws(()=>update('segment.template',{id:s.id,confirm:true}),/实现不可用/);
  assert.deepEqual(store.get('chapters',c.id),before);
  s=update('segment.template',{id:s.id,template:'fixture-v2',confirm:true});assert.equal(s.config.speech_rate,0);assert.equal(s.current,audio.id);assert.equal(segmentStatus(store,s).validity,'stale');assert.equal(segmentStatus(store,s).review,'pending');assert.equal(store.get('chapters',c.id).arrangement,before.arrangement);assert.equal(store.get('chapters',c.id).revision,before.revision+1);
  assert.throws(()=>d.mutate('segment.template',{chapterId:c.id,revision:before.revision,id:s.id,template:'dry-v1',confirm:true}),/其他页面更新/);
  templateCatalog.current='dry-v1';const children=update('segment.split',{id:s.id,offset:1});assert.ok(children.every(s=>s.template==='fixture-v2'&&s.config.speech_rate===0&&s.current===null));assert.equal(store.all('jobs').length,0);
});

test("模板不同合并须明确选择，缺失实现仍可查看且不会静默回退",async t=>{
  const {templateCatalog}=await import('../server/templates.mjs');const first=templateCatalog.versions['dry-v1'];templateCatalog.versions['fixture-v2']={...first,name:'TEST ONLY',compile:s=>first.compile(s)+'\n[TEST ONLY]'};t.after(()=>delete templateCatalog.versions['fixture-v2']);
  const {store,d,c,update}=setup(t);let rows=d.list(c.id);update('segment.template',{id:rows[1].id,template:'fixture-v2',confirm:true});const before=d.list(c.id);
  assert.throws(()=>update('segment.merge',{id:rows[0].id}),/音色或配置不同/);assert.deepEqual(d.list(c.id),before);
  const merged=update('segment.merge',{id:rows[0].id,choice:'second'});assert.equal(merged.template,'fixture-v2');assert.equal(merged.text,rows.map(s=>s.text).join(''));
  delete templateCatalog.versions['fixture-v2'];const chapter=d.chapter(c.id);assert.equal(chapter.segments[0].template,'fixture-v2');assert.match(chapter.segments[0].promptIssues.join(' '),/实现不可用/);assert.equal(chapter.segments[0].prompt,'');
  assert.throws(()=>update('segment.update',{id:merged.id,text:'不能静默换版本'}),/实现不可用/);assert.equal(store.get('segments',merged.id).text,merged.text);
  const preview=d.previewTemplate({id:merged.id,chapterId:c.id,revision:chapter.revision,template:'dry-v1'});assert.match(preview.unavailable,/实现不可用/);assert.match(preview.after,/只朗读正文一次/);
  update('segment.template',{id:merged.id,template:'dry-v1',confirm:true});assert.equal(d.chapter(c.id).segments[0].promptIssues.length,0);
});

test("改写新增字符后多次拆合保留父项沿革与原始坐标，共享来源不误报重复", t=>{
  const {store,d,c,update}=setup(t);
  const [first,second]=d.list(c.id), source=store.get('chapters',c.id).source;
  const changedFirst='新增🪶字，改写第一句。',changedSecond='第二句改成新的内容。';
  update('segment.update',{id:first.id,text:changedFirst});
  update('segment.update',{id:second.id,text:changedSecond});
  const splitRevision=store.get('chapters',c.id).revision;
  const children=update('segment.split',{id:first.id,offset:3});
  assert.deepEqual(children.map(s=>s.text),['新增🪶','字，改写第一句。']);
  for(const child of children){
    assert.equal(child.source.kind,'edited');
    assert.deepEqual(child.source.parentIds,[first.id]);
    assert.equal(child.source.parentRevision,splitRevision);
    assert.equal(child.source.splitOffset,3);
    assert.deepEqual(child.source.spans,first.source.spans.map(span=>({...span,origin:first.id})));
  }
  const mergeRevision=store.get('chapters',c.id).revision;
  const merged=update('segment.merge',{id:children[1].id});
  assert.deepEqual(merged.source.parentIds,[children[1].id,second.id]);
  assert.equal(merged.source.parentRevision,mergeRevision);
  assert.equal(merged.text,children[1].text+changedSecond);
  const nested=update('segment.split',{id:merged.id,offset:2});
  assert.deepEqual(nested[0].source.parentIds,[merged.id]);
  const remerged=update('segment.merge',{id:nested[0].id});
  const final=update('segment.merge',{id:children[0].id});
  assert.equal(final.text,changedFirst+changedSecond);
  assert.deepEqual(final.source.parentIds,[children[0].id,remerged.id]);
  assert.equal(final.source.spans.length,2);
  assert.deepEqual(coverage(store.get('chapters',c.id),d.list(c.id)),{valid:true,gaps:0,overlaps:0});
  assert.deepEqual(final.source.spans.map(({start,end})=>({start,end})),[...first.source.spans,...second.source.spans]);
  const visited=new Set();
  function walk(id){
    if(visited.has(id))return;
    visited.add(id);const row=store.get('segments',id);
    if(id!==final.id)assert.equal(row.retired,true);
    for(const parent of row.source.parentIds||[])walk(parent);
  }
  walk(final.id);
  for(const row of [first,second,...children,merged,...nested,remerged])assert.ok(visited.has(row.id));
  assert.equal(store.get('segments',first.id).text,changedFirst);
  assert.equal(store.get('segments',first.id).editHistory[0].text,first.text);
  assert.equal(store.get('segments',second.id).text,changedSecond);
  assert.equal(store.get('segments',second.id).editHistory[0].text,second.text);
  assert.equal(store.get('chapters',c.id).source,source);
  assert.equal(final.current,null);assert.equal(final.approved,null);
});
test('章节目录状态由当前内容和任务推导，不把旧失败或全部排除算作完成',t=>{
  const {store,d,p,c,role,v,update}=setup(t);
  const state=()=>d.snapshot().chapters.find(row=>row.id===c.id).productionStatus;
  const empty=d.mutate('chapter.create',{projectId:p.id,title:'未整理',source:'尚未分段。'});
  assert.equal(d.snapshot().chapters.find(row=>row.id===empty.id).productionStatus,'待整理');
  assert.equal(state(),'待确认');update('role.update',{id:role.id,voiceId:v.id});
  update('segment.confirm',{ids:d.list(c.id).map(s=>s.id)});assert.equal(state(),'待生成');
  for(const s of d.list(c.id)){const a={id:uid(),path:v.path,input:inputOf(s)};store.put('audios',a,c.id);s.current=a.id;store.put('segments',s,c.id)}
  assert.equal(state(),'待检查');
  for(const s of d.list(c.id))update('segment.review',{id:s.id,audioId:s.current,basis:basisOf(s),state:'passed'});
  assert.equal(state(),'已检查');let first=d.list(c.id)[0];first.latest='failed';store.put('segments',first,c.id);assert.equal(state(),'已检查');
  update('segment.review',{id:first.id,audioId:first.current,basis:basisOf(first),state:'rework'});assert.equal(state(),'需返工');
  update('segment.update',{id:first.id,text:'修改后正文。'});assert.equal(state(),'待更新');
  first=store.get('segments',first.id);first.latest='unknown';store.put('segments',first,c.id);assert.equal(state(),'结果待核对');
  const job={id:uid(),commandId:uid(),chapterId:c.id,status:'queued'};store.put('jobs',job,c.id);assert.equal(state(),'排队中');job.status='running';store.put('jobs',job,c.id);assert.equal(state(),'制作中');job.status='stopped';store.put('jobs',job,c.id);assert.equal(state(),'结果待核对');
  for(const s of d.list(c.id))update('segment.update',{id:s.id,excluded:true});assert.equal(state(),'全已排除');
  update('segment.update',{id:first.id,excluded:false});first=store.get('segments',first.id);first.source.spans=[];store.put('segments',first,c.id);assert.equal(state(),'待校对');
  assert.equal(store.get('chapters',c.id).productionStatus,undefined,'状态只用于展示，不持久化成第二份事实');
});
