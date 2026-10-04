import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import './ConcurrencySettings.css';

export interface SchedulerStatus {
  revision: number;
  desiredAudioConcurrency: number;
  effectiveAudioConcurrency: number;
  routeConcurrencyCap: number;
  networkActive: number;
  localActive: number;
  localQueued: number;
  attemptsActive: number;
  accepting: boolean;
  storageBlocked?: boolean;
  routeBlocked?: boolean;
  queuedAttempts?: number;
  phaseCounts?: Record<string, number>;
}

export function ConcurrencyStatus({ status }: { status?: SchedulerStatus }) {
  if (!status) return null;
  const phases = status.phaseCounts || {}, preparing = phases.preparing || 0;
  const upstream = (phases.sending || 0) + (phases.receiving || 0), local = (phases.rawSealed || 0) + (phases.processing || 0);
  return <p className="hint concurrency-status" role="status" aria-label="全局制作状态">
    {status.storageBlocked ? '本地整理需要处理，已停止后续发送' : status.routeBlocked ? '音频接口已暂停，请核对连接或额度' : !status.accepting ? '后续发送已停止，正在收尾' : status.attemptsActive || status.queuedAttempts ? '全局制作中' : '全局制作空闲'}
    {(status.attemptsActive > 0 || !!status.queuedAttempts) && <> · {status.queuedAttempts || 0} 段等待 · {preparing} 段准备 · {upstream} 段生成或接收 · {local} 段整理</>}
  </p>;
}

export function ConcurrencySettings({ status, connected, refresh }: {
  status?: SchedulerStatus;
  connected: boolean;
  refresh: () => Promise<unknown>;
}) {
  const [saved, setSaved] = useState<SchedulerStatus | null>(null), [pending, setPending] = useState(false), [error, setError] = useState('');
  const live = useRef(true), sending = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const current = saved && (!status || saved.revision > status.revision) ? saved : status;
  if (!current) return null;
  const change = async (count: number) => {
    if (!connected || sending.current || count === current.desiredAudioConcurrency) return;
    sending.current = true; setPending(true); setError('');
    try {
      const result = await api<SchedulerStatus>('/scheduler', { revision: current.revision, desiredAudioConcurrency: count }, 'PUT');
      if (!live.current) return;
      setSaved(result);
      try { await refresh(); } catch { if (live.current) setError('设置已保存，状态暂未刷新。'); }
    } catch (failure) {
      if (!live.current) return;
      setError((failure as Error).message);
      try { await refresh(); } catch { /* The request error remains visible; polling can recover. */ }
    } finally { sending.current = false; if (live.current) setPending(false); }
  };
  return <details className="concurrency-settings">
    <summary>同时制作：{current.effectiveAudioConcurrency} 段 <span className="hint">调整</span></summary>
    <div className="concurrency-content">
      <div className="concurrency-options" role="group" aria-label="期望同时制作段数">
        {[1, 2, 3, 4].map(count => <button key={count} type="button" className="button secondary small"
          aria-pressed={current.desiredAudioConcurrency === count} disabled={!connected || pending}
          onClick={() => void change(count)}>{count} 段</button>)}
      </div>
      <p className="hint">{current.routeConcurrencyCap === 1 ? '当前按 1 段运行；配置并验证账号并发上限后可提速。' : `当前账号上限 ${current.routeConcurrencyCap} 段。`}
        {current.desiredAudioConcurrency !== current.effectiveAudioConcurrency && ` 已选择 ${current.desiredAudioConcurrency} 段，实际同时 ${current.effectiveAudioConcurrency} 段。`}</p>
      <p className="hint">所有章节和试音共用。降低段数会让已发送的音频继续完成；调整不增加生成份数。</p>
      <ConcurrencyStatus status={current} />
      {pending && <p className="hint" role="status">正在调整…</p>}
      {!connected && <p className="warning" role="status">连接恢复后可调整。</p>}
      {error && <p className="error-inline" role="alert">{error}</p>}
    </div>
  </details>;
}
