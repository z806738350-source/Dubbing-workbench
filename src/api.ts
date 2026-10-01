export async function api<T = unknown>(
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(
    "/api" + path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || "请求失败，请重试"), {status: response.status});
  if (body !== undefined) {
    // Cross-tab notification carries no content or credentials; polling remains the fallback.
    try { localStorage.setItem("workbench-change", crypto.randomUUID()); } catch { /* Polling still works when browser storage is unavailable. */ }
  }
  return data;
}
export const action = <T = unknown>(
  action: string,
  data: Record<string, unknown> = {},
) => api<T>("/action", { action, ...data });
