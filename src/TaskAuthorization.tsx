import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { Field } from "./components";

export type TaskGrant = {
  id: string; grantId: string; projectId: string; chapterId?: string; steps: string[];
  materials: string[]; voiceIds: string[]; models: { text: string; audio: string };
  textLimit: number; audioLimit: number; textUsed: number; audioUsed: number;
  textReserved: number; audioReserved: number; expiresAt: string | null; revoked: boolean;
};

export type TaskIntent = {projectId:string;chapterId?:string;step:"audio"|"text";steps:string[];requests:number;minimumRequests?:number;voiceIds?:string[];model?:string};
export async function ensureTaskGrant(intent:TaskIntent):Promise<string> {
  const voices=[...(intent.voiceIds||[])].sort(),now=Date.now(),workspace=sessionStorage.getItem("workbench-workspace")||"";
  const key="workbench-grant/"+encodeURIComponent(workspace)+"/"+intent.projectId+"/"+(intent.chapterId||"project")+"/"+intent.steps.join(",");
  const {grants}=await api<{grants:TaskGrant[]}>("/projects/"+intent.projectId+"/experience");
  if((sessionStorage.getItem("workbench-workspace")||"")!==workspace)throw new Error("工作区已变化，本次请求未发送。请在目标工作区重新发起。");
  const scoped=(grants||[]).filter(grant=>!grant.revoked&&(!grant.chapterId||grant.chapterId===intent.chapterId)&&(!grant.expiresAt||Date.parse(grant.expiresAt)>now)&&intent.steps.every(step=>grant.steps.includes(step))&&(!intent.model||grant.models[intent.step]===intent.model));
  const available=(grant:TaskGrant)=>intent.step==="text"?grant.textLimit-grant.textUsed-grant.textReserved:grant.audioLimit-grant.audioUsed-grant.audioReserved;
  const current=scoped.find(grant=>grant.materials.includes("text")&&(!voices.length||grant.materials.includes("reference"))&&voices.every(id=>grant.voiceIds.includes(id))&&available(grant)>=(intent.minimumRequests??intent.requests));
  if(current){
    const pending=localStorage.getItem(key);
    if(pending&&JSON.parse(pending).payload?.grantId===(current.grantId||current.id))localStorage.removeItem(key);
    return current.grantId||current.id;
  }
  if(scoped.length)throw Object.assign(new Error("本次范围或剩余额度不足，请决定是否允许这次具体请求；原有上限保持。"),{code:"task-grant-needed",requests:intent.requests,available:Math.max(...scoped.map(available))});
  const signature=JSON.stringify({...intent,voiceIds:voices}),raw=localStorage.getItem(key),prior=raw?JSON.parse(raw) as {intent:string;payload:Record<string,unknown>}:null;
  if(prior&&prior.intent!==signature)throw new Error("上一次授权回执尚未确认，请先恢复原操作，不能扩大范围。");
  const payload=prior?.payload||{grantId:crypto.randomUUID(),projectId:intent.projectId,...(intent.chapterId?{chapterId:intent.chapterId}:{}),steps:intent.steps,materials:voices.length?["text","reference"]:["text"],voiceIds:voices,textLimit:intent.step==="text"?intent.requests:0,audioLimit:intent.step==="audio"?intent.requests:0,...(intent.step==="text"&&intent.model?{textModel:intent.model}:{}),expiresAt:new Date(now+24*60*60*1000).toISOString()};
  localStorage.setItem(key,JSON.stringify({intent:signature,payload}));
  const grant=await api<TaskGrant>("/experience/grant",payload);
  localStorage.removeItem(key);
  if((sessionStorage.getItem("workbench-workspace")||"")!==workspace)throw new Error("工作区已变化，原授权保留在原工作区，本次制作未发送。");
  return grant.grantId||grant.id;
}

export default function TaskAuthorization({ projectId, chapterId, label, step = "audio", steps, requests = 1, voiceIds = [], model, onReady, onAuthorized, disabled = false }: {
  projectId: string; chapterId?: string; label: string; step?: "audio" | "text";
  steps?: string[]; requests?: number; voiceIds?: string[]; model?: string; onReady: (grantId: string | null) => void; onAuthorized?:(grantId:string)=>Promise<void>; disabled?: boolean;
}) {
  const allowedSteps = steps || (step === "text" ? ["extract", "director", "scene"] : ["generate", "unit-generate", "voice-create"]);
  const [grants, setGrants] = useState<TaskGrant[]>([]);
  const [limit, setLimit] = useState(String(Math.max(requests, step === "text" ? 5 : 10)));
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const ready = useRef(onReady); ready.current = onReady;
  const stepKey = allowedSteps.join(","), voiceKey = [...voiceIds].sort().join(",");
  const current = grants.find(grant => grant.projectId === projectId && !grant.revoked && (!grant.chapterId || grant.chapterId === chapterId) &&
    (!grant.expiresAt || Date.parse(grant.expiresAt) > Date.now()) && allowedSteps.every(value => grant.steps.includes(value)) &&
    grant.materials.includes("text") && (!voiceIds.length || grant.materials.includes("reference")) && voiceIds.every(id => grant.voiceIds.includes(id)) && (!model || grant.models[step] === model) && (step === "text" ? grant.textLimit - grant.textUsed - grant.textReserved : grant.audioLimit - grant.audioUsed - grant.audioReserved) >= requests);
  useEffect(() => {
    let active = true;
    const reload = () => void api<{ grants: TaskGrant[] }>("/projects/" + projectId + "/experience").then(data => { if (active) setGrants(data.grants || []); }).catch(error => { if (active) setError(error.message); });
    reload();
    window.addEventListener("workbench-operation", reload); window.addEventListener("focus", reload);
    return () => { active = false; window.removeEventListener("workbench-operation", reload); window.removeEventListener("focus", reload); };
  }, [projectId, chapterId, stepKey, voiceKey, model]);
  useEffect(() => { ready.current(current?.grantId || current?.id || null); }, [current?.id, current?.grantId]);
  const authorize = async () => {
    setError("");
    const count = Number(limit);
    if (!Number.isSafeInteger(count) || count < requests || count > 1000) { setError("请输入足够本次使用的请求次数，最多 1000 次。"); return; }
    setPending(true);
    const key = "workbench-grant/" + projectId + "/" + (chapterId || "project") + "/" + stepKey;
    try {
      const prior = localStorage.getItem(key);
      const intent = JSON.stringify({ count, voiceIds: [...voiceIds].sort(), model });
      const record = prior ? JSON.parse(prior) as { intent: string; payload: Record<string, unknown> } : null;
      if (record && record.intent !== intent) throw new Error("上一次授权回执尚未确认，请按原额度重试，避免重复扩大授权。");
      const payload = record?.intent === intent ? record.payload : {
        grantId: crypto.randomUUID(), projectId, ...(chapterId ? { chapterId } : {}), steps: allowedSteps,
        materials: voiceIds.length ? ["text", "reference"] : ["text"], voiceIds,
        textLimit: step === "text" ? count : 0, audioLimit: step === "audio" ? count : 0,
        ...(step === "text" && model ? { textModel: model } : {}),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      };
      localStorage.setItem(key, JSON.stringify({ intent, payload }));
      const grant = await api<TaskGrant>("/experience/grant", payload);
      localStorage.removeItem(key);
      setGrants(value => [grant, ...value.filter(item => item.id !== grant.id)]);
      onReady(grant.grantId || grant.id);
      await onAuthorized?.(grant.grantId || grant.id);
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status && status >= 400 && status < 500 && status !== 409) localStorage.removeItem(key);
      setError((error as Error).message);
    }
    finally { setPending(false); }
  };
  return <section className="task-authorization" aria-label="本次调用授权">
    {current ? <>
      <p className="hint">{label} · 已允许{step === "text" ? "文本分析" : "声音制作"}，还可请求 {step === "text" ? current.textLimit - current.textUsed - current.textReserved : current.audioLimit - current.audioUsed - current.audioReserved} 次。{current.expiresAt && "有效至 " + new Date(current.expiresAt).toLocaleString("zh-CN") + "。"}</p>
      <button className="text-button" disabled={disabled || pending} onClick={() => void (async () => {
        setPending(true); setError("");
        try { await api("/experience/revoke", { grantId: current.grantId || current.id }); setGrants(value => value.map(grant => grant.id === current.id ? { ...grant, revoked: true } : grant)); onReady(null); }
        catch (error) { setError((error as Error).message); }
        finally { setPending(false); }
      })()}>停止后续授权</button>
    </> : <>
      <p>{label}：将向{model || "已配置的" + (step === "text" ? "文本模型" : "声音模型")}发送本次文字{voiceIds.length ? "和所选参考录音" : ""}，用于{step === "text" ? "分析与建议" : "生成声音"}。</p>
      <Field label={step === "text" ? "允许文本请求次数" : "允许音频请求次数"}><input type="number" min={requests} max={1000} value={limit} disabled={disabled || pending} onChange={event => setLimit(event.target.value)} /></Field>
      <p className="hint">仅{chapterId ? "当前章节" : "当前项目"}，24小时有效。金额以供应商账单为准；{onAuthorized?"提交后直接继续本次操作。":"授权不会自动开始生成。"}</p>
      <button className="button secondary" disabled={disabled || pending} onClick={() => void authorize()}>{pending ? "正在处理…" : onAuthorized?"允许上述范围并继续":"允许上述范围"}</button>
    </>}
    {error && <p className="error-inline" role="alert">{error}</p>}
  </section>;
}
