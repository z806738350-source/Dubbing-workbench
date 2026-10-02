import { api } from "./api";
import type { Job } from "./types";

export type TaskOperation<T = Record<string, unknown>> = {
  operationId: string;
  kind: string;
  outcome: "completed" | "prepared" | "needsInput" | "processing" | "unknown";
  steps: Record<string, unknown>;
  jobIds: string[];
  createdObjectIds: string[];
  result: T;
  error?: string;
  errorStatus?: number;
};

// The current draft owner survives reloads and stays distinct in copied tabs.
const storageKey = (key: string) => "workbench-operation/" + (sessionStorage.getItem("draft-owner") || "page") + "/" + key;

export async function submitOperation<T>(key: string, payload: Record<string, unknown>, jobs: Job[] = []): Promise<TaskOperation<T>> {
  const recordKey = storageKey(key);
  const raw = localStorage.getItem(recordKey);
  let record: { operationId: string; payload: Record<string, unknown>; receipt?: TaskOperation<T> } | null = raw ? JSON.parse(raw) : null;
  const changed = !!record && JSON.stringify(record.payload) !== JSON.stringify(payload);
  let refreshed = false;
  if (record && (!record.receipt || changed || record.payload.kind === "prepareChapter")) {
    try {
      record.receipt = await api<TaskOperation<T>>("/operations/" + record.operationId);
      localStorage.setItem(recordKey, JSON.stringify(record));
      refreshed = true;
    } catch (error) {
      if (changed && !record.receipt) throw new Error("上一次操作回执尚未确认，请先恢复该次操作，再修改范围或授权。");
    }
  }
  const analysis = (record?.receipt?.result as { analysis?: { status: string; batches?: { status: string }[] } } | undefined)?.analysis;
  const unknown = record?.receipt?.outcome === "unknown" || analysis?.status === "unknown" || !!analysis?.batches?.some(batch => batch.status === "unknown");
  const finished = (!!record?.receipt?.jobIds?.length && record.receipt.jobIds.every(id => jobs.some(job => job.id === id && !["queued", "running", "unknown"].includes(job.status)))) || (refreshed && !!analysis && !unknown && analysis.status !== "running");
  if (unknown && payload.retryUnknown !== true) throw new Error("上一次结果不明，可能已计费；请先明确决定是否再次发送请求。");
  if (changed && record?.receipt?.outcome === "processing" && !finished) throw new Error("上一次操作仍在处理中，请先查看结果，再发起新的制作。");
  if (changed && record?.payload.kind === "groupAndGenerate" && record.receipt?.createdObjectIds.length && !finished) return record.receipt;
  if (!record || changed || finished || (unknown && payload.retryUnknown === true)) {
    record = { operationId: crypto.randomUUID(), payload };
    localStorage.setItem(recordKey, JSON.stringify(record));
  }
  try {
    const receipt = await api<TaskOperation<T>>("/operations", { ...record.payload, operationId: record.operationId });
    record.receipt = receipt;
    localStorage.setItem(recordKey, JSON.stringify(record));
    window.dispatchEvent(new Event("workbench-operation"));
    return receipt;
  } catch (error) {
    // A lost response may follow a committed write. Query that operation before offering a retry.
    if (!(error as { status?: number }).status) {
      try {
        const receipt = await api<TaskOperation<T>>("/operations/" + record.operationId);
        record.receipt = receipt;
        localStorage.setItem(recordKey, JSON.stringify(record));
        window.dispatchEvent(new Event("workbench-operation"));
        return receipt;
      } catch { /* Keep the same operation ID for the user's retry. */ }
    }
    throw error;
  }
}
