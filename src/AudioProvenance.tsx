import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { AudioHistoryRecord, AudioProvenanceMetadata } from "./types";

export function AudioProvenance({ record, original, connected, locked, playingId, preview, useOriginal }: {
  record: AudioProvenanceMetadata;
  original?: AudioHistoryRecord;
  connected: boolean;
  locked: boolean;
  playingId?: string;
  preview: (id: string) => void;
  useOriginal: (audio: AudioHistoryRecord) => void;
}) {
  if (!record.originalAudioId) return <p className="hint audio-provenance-note">{record.provenance === "provider-original" ? "供应商原件 · 未做尾部清理" : "历史原件未保存"}</p>;
  const retained = record.originalAvailability === "retained", label = retained ? "原件" : "清理前版本", available = !!original && original.available !== false;
  return <details className="audio-provenance">
    <summary>已清理尾部 · {label}{available ? "保留" : "不可用"}</summary>
    {!retained && <p className="hint">历史供应商原件未保存；这里保留本次清理前的声音。</p>}
    <div className="button-row">
      <button type="button" className="button secondary small" disabled={!connected || !available} onClick={() => { if (connected && available) preview(original!.id); }}>{playingId === original?.id ? "暂停" : "试听"}{label}</button>
      <button type="button" className="button secondary small" disabled={!connected || !available || locked || !!original?.selected} onClick={() => { if (connected && available && !locked && !original!.selected) useOriginal(original!); }}>{original?.selected ? `正在使用${label}` : original?.matched ? `使用${label}` : `核对并使用${label}`}</button>
    </div>
    <p className={available ? "hint" : "warning"}>{available ? "试听不改变当前选版。切换免费，使用后需重新听评。" : "这份声音已缺失或不可用，请找回文件或恢复备份。"}</p>
  </details>;
}

export function LocalAudioRecovery({ attemptId, jobId, chapterId, connected, refresh }: {
  attemptId: string;
  jobId: string;
  chapterId: string;
  connected: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [done, setDone] = useState(false);
  const active = useRef(true), sending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const recover = async () => {
    if (!connected || sending.current || done) return;
    sending.current = true; setPending(true); setError("");
    try {
      await api("/attempts/" + encodeURIComponent(attemptId) + "/recover", { jobId, chapterId });
      if (!active.current) return;
      setDone(true);
      await refresh();
    } catch (failure) { if (active.current) setError((failure as Error).message); }
    finally { sending.current = false; if (active.current) setPending(false); }
  };
  return <section className="local-audio-recovery" aria-label="恢复已接收音频">
    <p role="status">{done ? "已免费恢复，当前选版保持。可在声音历史中试听和选用。" : "原件已接收，待本地恢复"}</p>
    {!done && <button type="button" className="button secondary small" disabled={!connected || pending} aria-busy={pending} onClick={() => void recover()}>{pending ? "正在本地恢复…" : "免费恢复"}</button>}
    {error && <p className="error-inline" role="alert">{error}</p>}
  </section>;
}
