export async function api<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const payload=body && typeof body==='object' ? body as Record<string,unknown> : {},target=payload.data && typeof payload.data==='object' ? payload.data as Record<string,unknown> : payload;
  const scope:Record<string,unknown>={kind:'request',path:'/api'+path};
  for(const field of ['chapterId','projectId','unitId','mode'])if(target[field]!==undefined)scope[field]=target[field];
  if(payload.operationId)scope.operationId=payload.operationId;
  const objectKind=typeof payload.action==='string'?payload.action.split('.')[0]:'';
  if(target.id&&['chapter','project','unit','segment','voice','event','job'].includes(objectKind))scope[objectKind+'Id']=target.id;
  let response:Response;
  try { response = await fetch(
    "/api" + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  ); } catch (cause) { throw Object.assign(new Error('连接中断，本次回执尚未确认。请查看现有记录并核对原操作，再决定下一步。'),{cause,code:'connection-lost',scope,retryClass:'check-existing-operation'}); }
  let data:Record<string,unknown>;
  try { data=await response.json();if(!data||typeof data!=='object')throw new Error('回执格式无效'); } catch(cause) { throw Object.assign(new Error('本次回执未能读取。请查看现有记录并核对原操作，再决定下一步。'),{cause,status:response.ok?undefined:response.status,code:'response-unreadable',scope,retryClass:'check-existing-operation'}); }
  if (!response.ok) {
    const recovery:Record<number,[string,string]>={400:['invalid-request','edit-request'],401:['permission-denied','review-permission'],403:['permission-denied','review-permission'],404:['object-unavailable','review-target'],409:['state-conflict','refresh-and-review'],413:['request-too-large','edit-request'],416:['invalid-range','review-target'],503:['service-unavailable','wait-for-service']};
    const [code,retryClass]=recovery[response.status]||['operation-result-unconfirmed','check-existing-operation'],retry=String(data.retryClass||retryClass);
    const message=String(data.error||'请求未完成，请保留当前编辑')+(retry==='check-existing-operation'?'。请查看现有记录并核对原操作，再决定下一步。':'');
    throw Object.assign(new Error(message),{status:response.status,code:data.code||code,scope:{...scope,...(data.scope&&typeof data.scope==='object'?data.scope:{})},retryClass:retry,...(data.notApplied===true?{outcome:data.outcome,notApplied:true,fieldErrors:data.fieldErrors}:{})});
  }
  if(data?.error || data?.outcome==='unknown')data.scope={...scope,...(data.scope&&typeof data.scope==='object'?data.scope:{})};
  if (body !== undefined) {
    // Cross-tab notification carries no content or credentials; polling remains the fallback.
    try { localStorage.setItem("workbench-change", crypto.randomUUID()); } catch { /* Polling still works when browser storage is unavailable. */ }
  }
  return data as T;
}
export const action = <T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
) => api<T>("/action", { action, ...data });
