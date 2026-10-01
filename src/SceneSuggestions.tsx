import { useEffect, useState } from "react";
import { api } from "./api";
import { Field, Form, Select } from "./components";
import type { ChapterDetail, GenerationUnit } from "./types";
type Suggestion = {id:string;kind:string;unitId:string;unitRevision:number;revision:number;contextRevision:number;draftVersion:number;status:string;error?:string;issues?:string[];createdAt?:string;model:string;items:{
  id:string;description:string;kind:string;memberId:string;position:string;endMemberId?:string;endPosition?:string;evidence:string;reason?:string;sourceQuote?:string;issues?:string[];
}[]};
export default function SceneSuggestions({unit,chapter,contextRevision,model,enabled,refresh}:{unit:GenerationUnit;chapter:ChapterDetail;contextRevision:number;model:string;enabled:boolean;refresh:()=>Promise<void>}) {
  const records=(chapter.suggestions as Suggestion[]).filter(s=>s.kind === "scene" && s.unitId === unit.id);
  const [selected,setSelected]=useState<string[]>([]);
  const [view,setView]=useState("");
  const [accepted,setAccepted]=useState(false);
  const record=records.find(r=>r.id === view) || records.at(-1);
  useEffect(()=>setSelected([]),[record?.id,record?.draftVersion]);
  const current=record?.status === "ready" && record.revision === chapter.revision && record.contextRevision === contextRevision && record.unitRevision === unit.revision;
  return <section className="section-rule">
    <h3>AI 场景建议</h3><p className="hint">只分析这个单元的声音事件，不重写台词或自动生成。勾选审阅后一次应用；仅采用的事件进入场景请求。</p>
    <Form label="分析场景建议" busy={!enabled || records.some(r=>r.status === "running")} onSubmit={async()=>{
      if(!accepted)throw new Error("请确认本次文本分析费用");
      await api("/analysis",{kind:"scene",sceneEnabled:true,chapterId:chapter.id,revision:chapter.revision,unitId:unit.id,unitRevision:unit.revision,model});setAccepted(false);await refresh();
    }}><p className="hint">文本模型：{model}</p><label className="check-label"><input type="checkbox" checked={accepted} onChange={e=>setAccepted(e.target.checked)}/>我已开启本单元场景建议，确认文本分析费用</label></Form>
    {!!records.length && <Select label="场景建议记录" value={record!.id} options={records.map(r=>({value:r.id,label:(r.createdAt ? new Date(r.createdAt).toLocaleString() : "历史建议") + " · " + r.model}))} onChange={id=>{setView(id);setSelected([]);}}/>}
    {record && <><p className={current ? "hint" : "warning"}>{record.status === "running" ? "正在分析，关闭面板不取消。" : current ? "待审阅" : record.status === "applied" ? "已应用，生成仍需另行发起。" : "建议已过期或需处理，请核对后重新分析。"}</p>
      {record.error && <p className="error-inline">{record.error}</p>}{record.issues?.map((issue,i)=><p className="warning" key={i}>{issue}</p>)}
      {record.items.map(item=><section className="voice-card" key={item.id}>
        <label className="check-label"><input type="checkbox" aria-label={"采用声音事件 " + item.description} checked={selected.includes(item.id)} disabled={!current || !!item.issues?.length} onChange={e=>setSelected(v=>e.target.checked ? [...v,item.id] : v.filter(id=>id !== item.id))}/>{item.description}</label>
        <p className="hint">第 {(chapter.segments.find(s=>s.id === item.memberId)?.order ?? -1)+1} 条 · {({before:"之前",during:"期间",after:"之后"} as Record<string,string>)[item.position]}{item.endMemberId ? "，持续到第 " + ((chapter.segments.find(s=>s.id === item.endMemberId)?.order ?? -1)+1) + " 条" : ""} · {item.evidence}</p>
        {item.reason && <p>{item.reason}</p>}{item.sourceQuote && <p className="original-excerpt">{item.sourceQuote}</p>}{item.issues?.map((issue,i)=><p className="warning" key={i}>{issue}</p>)}
      </section>)}
      {current && <Form label="应用本轮选择的场景事件" busy={!selected.length || !enabled} onSubmit={async()=>{
        await api("/analysis/apply",{id:record.id,draftVersion:record.draftVersion,revision:chapter.revision,unitRevision:unit.revision,selected});setSelected([]);await refresh();
      }}><Field label="采用范围"><p>已选择 {selected.length} 个事件；不自动请求声音。</p></Field></Form>}
    </>}
  </section>;
}
