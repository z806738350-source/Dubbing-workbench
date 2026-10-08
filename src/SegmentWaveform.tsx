import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { api } from "./api";
import { clearDraft, discardDraft, draftWorkspace, listDrafts, readDraft, recoverDraft, writeDraft, type DraftRecord } from "./drafts";
import { registerDraftSave } from "./autosave";
import { createAudioRangeSave, normalizeRange, type RangeBounds, type RangeSaveSnapshot } from "./audioRangeSave";
import type { AudioRangeRecord } from "./types";
import "./SegmentWaveform.css";

export type RangePreview = { url: string; unitId: string; mode: "dry" | "scene"; audioId: string; startFrame: number; endFrame: number; sampleRate: number; fullSource: boolean; sourceFrame?: number; seekOnly?: boolean };
export type SegmentWaveformProps = {
  unitId: string; mode: "dry" | "scene"; audioId: string | null;
  chapterId: string; projectId: string; workspaceId?: string; sourceTime?: number;
  sourceLabel?: string;
  lockedReason?: string;
  onRangeChange?: (range: AudioRangeRecord, pending: boolean) => void;
  onPreview?: (preview: RangePreview) => void;
  onEditStart?: () => void;
  onEditCancel?: (range: AudioRangeRecord) => void;
  onBrowse?: () => void;
  onSaved?: (range: AudioRangeRecord) => void;
};
type RangeResponse = { range: AudioRangeRecord; editable: boolean; reason?: string; previewUrl?: string };
type Waveform = { audioId: string; sourceHash: string; decodeProfile: string; sampleRate: number; sourceFrames: number; channels: number; startFrame: number; endFrame: number; bucketFrames: number; buckets: { min: number[]; max: number[] }[] };
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const same = (a: RangeBounds, b: RangeBounds) => a.startFrame === b.startFrame && a.endFrame === b.endFrame;
const format = (frame: number, sampleRate: number) => {
  const milliseconds = Math.round(frame / sampleRate * 1000), minutes = Math.floor(milliseconds / 60000);
  return String(minutes).padStart(2, "0") + ":" + ((milliseconds % 60000) / 1000).toFixed(3).padStart(6, "0");
};
export const rangePreviewUrl = (range: AudioRangeRecord, fullSource = false) => "/api/audio-ranges/preview?" + new URLSearchParams({ unitId: range.unitId, mode: range.mode, audioId: range.audioId, startFrame: String(fullSource ? 0 : range.startFrame), endFrame: String(fullSource ? range.sourceFrames : range.endFrame) });

export default function SegmentWaveform(props: SegmentWaveformProps) {
  const root = useRef<HTMLDivElement>(null), [visibleIdentity, setVisibleIdentity] = useState("");
  const [result, setResult] = useState<RangeResponse | null>(null), [error, setError] = useState("");
  const workspaceId = props.workspaceId ?? draftWorkspace(), identity = [workspaceId, props.unitId, props.mode, props.audioId].join("|");
  const visible = visibleIdentity === identity;
  useEffect(() => {
    if (!root.current || !props.audioId) return;
    if (typeof IntersectionObserver === "undefined") { setVisibleIdentity(identity); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) setVisibleIdentity(identity); });
    observer.observe(root.current); return () => observer.disconnect();
  }, [identity]);
  useEffect(() => {
    setResult(null); setError("");
    if (!visible || !props.audioId) return;
    let current = true;
    const load = async () => {
      try {
        const response = await api<RangeResponse>("/units/" + encodeURIComponent(props.unitId) + "/audio-range?" + new URLSearchParams({ mode: props.mode, audioId: props.audioId! }));
        if (!current) return;
        if (response.range.chapterId !== props.chapterId || response.range.projectId !== props.projectId || response.range.audioId !== props.audioId) throw new Error("声音归属已变化，请重新打开该段。");
        setResult(response); setError("");
      } catch (failure) { if (current) setError((failure as Error).message); }
    };
    void load();
    const changed = (event: StorageEvent) => { if (event.key === "workbench-change") void load(); };
    const reconnect = () => void load();
    window.addEventListener("storage", changed); window.addEventListener("online", reconnect);
    return () => { current = false; window.removeEventListener("storage", changed); window.removeEventListener("online", reconnect); };
  }, [identity, visible, props.chapterId, props.projectId, props.lockedReason]);
  return <div ref={root} className="segment-waveform" data-unit-id={props.unitId} data-audio-id={props.audioId || undefined}>
    {!props.audioId ? <p className="waveform-message">生成声音后可调整起止。</p> : error ? <p className="waveform-message warning" role="status">无法准备波形：{error} <button type="button" onClick={() => { setVisibleIdentity(""); setTimeout(() => setVisibleIdentity(identity), 0); }}>重试</button></p> : result ?
      <WaveformEditor key={identity + "|" + result.range.sourceHash} {...props} workspaceId={workspaceId} result={result} /> : <p className="waveform-message">{visible ? "正在准备真实波形…" : "滚动到此段后显示波形"}</p>}
  </div>;
}

function WaveformEditor(props: SegmentWaveformProps & { workspaceId: string; result: RangeResponse }) {
  const callbacks = useRef(props); callbacks.current = props;
  const active = useRef(true);
  const historyAnchor = useRef(props.result.range.lastOperationId);
  const [snapshot, setSnapshot] = useState<RangeSaveSnapshot | null>(null), [frozen, setFrozen] = useState(false);
  const [controller] = useState(() => createAudioRangeSave({
    range: props.result.range, workspaceId: props.workspaceId, deferSubscribe: true,
    onChange: next => { if (active.current) { setSnapshot(next); callbacks.current.onRangeChange?.(next.range, next.dirty); } },
    onSaved: range => { historyAnchor.current = range.lastOperationId; if (active.current) callbacks.current.onSaved?.(range); },
  }));
  const state = snapshot || controller.snapshot(), range = state.range;
  const [gesture, setGesture] = useState<RangeBounds | null>(null);
  const current = useRef(range); current.current = { ...range, ...(gesture || {}) };
  const shown = current.current, minimum = Math.min(range.sourceFrames, 960), editable = props.result.editable && !props.lockedReason && !frozen;
  const historyKey = "workbench-audio-range-history/" + encodeURIComponent(props.workspaceId) + "/" + (sessionStorage.getItem("draft-owner") || "page") + "/" + props.unitId + "/" + props.mode + "/" + props.audioId;
  const [history, setHistory] = useState<RangeBounds[]>(() => {
    try {
      const record = JSON.parse(localStorage.getItem(historyKey) || "null");
      if (record?.sourceHash === range.sourceHash && record?.decodeProfile === range.decodeProfile && record?.lastOperationId === range.lastOperationId && Array.isArray(record.ranges)) return record.ranges.filter((bounds: RangeBounds) => Number.isSafeInteger(bounds.startFrame) && Number.isSafeInteger(bounds.endFrame) && bounds.startFrame >= 0 && bounds.startFrame < bounds.endFrame && bounds.endFrame <= range.sourceFrames).slice(-20);
    } catch { /* A broken undo cache never changes the saved audio range. */ }
    return [];
  }), historyRef = useRef(history); historyRef.current = history;
  const [zoom, setZoom] = useState(1), [view, setView] = useState(0), [waveform, setWaveform] = useState<Waveform | null>(null), [waveError, setWaveError] = useState(""), [waveRetry, setWaveRetry] = useState(0);
  const canvas = useRef<HTMLCanvasElement>(null), overview = useRef<HTMLCanvasElement>(null), track = useRef<HTMLDivElement>(null);
  const whole = useRef<Waveform | null>(null), [size, setSize] = useState(0);
  const drag = useRef<{ pointer: number; side: "start" | "end"; before: RangeBounds; element: HTMLDivElement } | null>(null);
  const [startText, setStartText] = useState((range.startFrame / range.sampleRate).toFixed(3)), [endText, setEndText] = useState((range.endFrame / range.sampleRate).toFixed(3));
  const [inputSide, setInputSide] = useState<"start" | "end" | null>(null), [inputError, setInputError] = useState("");
  const inputDraftKey = "audio-range-time-v1/" + props.unitId + "/" + props.mode + "/" + props.audioId;
  const inputDraft = useRef<{ start?: string; end?: string }>({});
  const [otherDrafts, setOtherDrafts] = useState<DraftRecord<RangeBounds>[]>([]), [draftError, setDraftError] = useState("");
  const span = range.sourceFrames / zoom, viewStart = clamp(view, 0, Math.max(0, range.sourceFrames - span)), viewEnd = viewStart + span;
  useEffect(() => {
    active.current = true;
    controller.connect();
    const unregister = registerDraftSave(controller.key, { scope: "chapter:" + props.chapterId, dependencies: [controller.key, "unit:" + props.unitId + "/" + props.mode], state: () => controller.snapshot().status, dirty: controller.dirty, flush: controller.flush, freeze: value => { if (active.current) setFrozen(value); } });
    if (props.result.editable && !props.lockedReason) controller.start();
    const resume = () => { if (controller.dirty() && controller.snapshot().status !== "conflict") void controller.flush().catch(() => {}); };
    const leaving = () => { if (drag.current) cancelGesture(); resume(); };
    window.addEventListener("online", resume); window.addEventListener("pagehide", leaving);
    return () => { active.current = false; window.removeEventListener("online", resume); window.removeEventListener("pagehide", leaving); unregister(); controller.release(); };
  }, [controller]);
  useEffect(() => controller.refresh(props.result.range), [props.result.range.revision, props.result.range.startFrame, props.result.range.endFrame, controller]);
  useEffect(() => {
    if (!state.dirty && range.lastOperationId !== historyAnchor.current) { historyAnchor.current = range.lastOperationId; setHistory([]); return; }
    try { localStorage.setItem(historyKey, JSON.stringify({ sourceHash: range.sourceHash, decodeProfile: range.decodeProfile, lastOperationId: historyAnchor.current, ranges: history })); }
    catch { /* The saved range remains available even if undo history cannot be cached. */ }
  }, [history, historyKey, range.lastOperationId, state.dirty]);
  useEffect(() => {
    let current = true;
    const scan = () => void listDrafts<RangeBounds>(controller.key).then(records => { if (current) setOtherDrafts(records.filter(record => record.compatible && record.status !== "current")); }).catch(failure => { if (current) setDraftError(failure.message); });
    const changed = (event: StorageEvent) => { if (event.key?.startsWith("draft-")) scan(); };
    scan(); window.addEventListener("storage", changed); window.addEventListener("workbench-draft-restored", scan);
    return () => { current = false; window.removeEventListener("storage", changed); window.removeEventListener("workbench-draft-restored", scan); };
  }, [controller]);
  useEffect(() => {
    if (inputSide !== "start" && inputDraft.current.start === undefined) setStartText((shown.startFrame / range.sampleRate).toFixed(3));
    if (inputSide !== "end" && inputDraft.current.end === undefined) setEndText((shown.endFrame / range.sampleRate).toFixed(3));
  }, [shown.startFrame, shown.endFrame, inputSide, range.sampleRate]);
  useEffect(() => {
    try {
      const old = readDraft<{ start?: string; end?: string }>(inputDraftKey, props.workspaceId);
      if (old && [old.draft.start, old.draft.end].every(value => value === undefined || typeof value === "string")) {
        inputDraft.current = old.draft;
        if (old.draft.start !== undefined) setStartText(old.draft.start);
        if (old.draft.end !== undefined) setEndText(old.draft.end);
        setInputError("时间尚未填完，当前播放范围保留。");
      }
    } catch { setInputError("时间暂存无法读取，当前播放范围保留。"); }
  }, [inputDraftKey, props.workspaceId]);
  useEffect(() => {
    if (!track.current) return;
    const observer = new ResizeObserver(() => setSize(track.current?.clientWidth || 0));
    observer.observe(track.current); setSize(track.current.clientWidth); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const abort = new AbortController(); let current = true;
    const timer = setTimeout(() => {
      const params = new URLSearchParams({ level: zoom === 1 ? "1024" : "4096", startFrame: String(Math.floor(viewStart)), endFrame: String(Math.min(range.sourceFrames, Math.ceil(viewEnd))) });
      void fetch("/api/audios/" + encodeURIComponent(range.audioId) + "/waveform?" + params, { signal: abort.signal }).then(async response => {
        const result = await response.json(); if (!response.ok) throw new Error(result.error || "波形准备失败"); return result as Waveform;
      }).then(result => {
        if (!current) return;
        if (result.audioId !== range.audioId || result.sourceHash !== range.sourceHash || result.decodeProfile !== range.decodeProfile || !Array.isArray(result.buckets)) throw new Error("波形来源已变化");
        if (zoom === 1) whole.current = result;
        setWaveform(result); setWaveError("");
      }).catch(failure => { if (current && failure.name !== "AbortError") setWaveError(failure.message); });
    }, zoom === 1 ? 0 : 90);
    return () => { current = false; abort.abort(); clearTimeout(timer); };
  }, [range.audioId, range.sourceHash, range.decodeProfile, zoom, viewStart, viewEnd, waveRetry]);
  useEffect(() => {
    const paint = (element: HTMLCanvasElement | null, data: Waveform | null, low: number, high: number, mini = false) => {
      if (!element || !data) return;
      const rect = element.getBoundingClientRect(), w = rect.width, h = rect.height, dpr = window.devicePixelRatio || 1;
      element.width = Math.round(w * dpr); element.height = Math.round(h * dpr);
      const context = element.getContext("2d"); if (!context) return;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      const x = (frame: number) => (frame - low) / (high - low) * w;
      context.fillStyle = "#f5f7f5"; context.fillRect(0, 0, w, h);
      context.fillStyle = "#e1f2e5";
      context.fillRect(clamp(x(shown.startFrame), 0, w), 0, Math.max(0, clamp(x(shown.endFrame), 0, w) - clamp(x(shown.startFrame), 0, w)), h);
      context.strokeStyle = "#dce6de"; context.beginPath(); context.moveTo(0, h / 2); context.lineTo(w, h / 2); context.stroke();
      for (let i = 0; i < data.buckets.length; i++) {
        const bucket = data.buckets[i], frame = data.startFrame + i * data.bucketFrames, px = x(frame);
        if (px < -2 || px > w + 2) continue;
        const minimum = Math.min(0, ...bucket.min), maximum = Math.max(0, ...bucket.max);
        context.strokeStyle = frame >= shown.startFrame && frame < shown.endFrame ? "#3e8054" : "#bac9be";
        context.beginPath(); context.moveTo(px, h / 2 - clamp(maximum, -1, 1) * h * .45); context.lineTo(px, h / 2 - clamp(minimum, -1, 1) * h * .45); context.stroke();
      }
      if (mini) { context.strokeStyle = "#49845a"; context.lineWidth = 1.5; context.strokeRect(x(viewStart), 1, x(viewEnd) - x(viewStart), h - 2); }
      else if (props.sourceTime !== undefined) { const px = x(props.sourceTime * range.sampleRate); if (px >= 0 && px <= w) { context.strokeStyle = "#252d28"; context.lineWidth = 1.5; context.beginPath(); context.moveTo(px, 0); context.lineTo(px, h); context.stroke(); } }
    };
    paint(canvas.current, waveform, viewStart, viewEnd); paint(overview.current, whole.current, 0, range.sourceFrames, true);
  }, [waveform, shown.startFrame, shown.endFrame, size, viewStart, viewEnd, props.sourceTime]);

  const commit = (bounds: RangeBounds, remember = true) => {
    const before = { startFrame: range.startFrame, endFrame: range.endFrame };
    if (same(before, bounds)) { callbacks.current.onRangeChange?.(range, state.dirty); callbacks.current.onEditCancel?.(range); return; }
    if (!inputSide && Object.keys(inputDraft.current).length) { inputDraft.current = {}; try { clearDraft(inputDraftKey, undefined, false, props.workspaceId); } catch { /* Current range remains visible. */ } setInputError(""); }
    if (remember) setHistory(values => [...values, before].slice(-20));
    controller.edit(bounds); setGesture(null);
  };
  const preview = (fullSource = false, sourceFrame?: number, seekOnly = false) => {
    callbacks.current.onPreview?.({ url: rangePreviewUrl(shown, fullSource), unitId: range.unitId, mode: range.mode, audioId: range.audioId, startFrame: fullSource ? 0 : shown.startFrame, endFrame: fullSource ? range.sourceFrames : shown.endFrame, sampleRate: range.sampleRate, fullSource, sourceFrame, seekOnly });
  };
  const cancelGesture = () => {
    const previous = drag.current; if (!previous) return;
    drag.current = null; setGesture(null);
    callbacks.current.onRangeChange?.({ ...range, ...previous.before }, state.dirty);
    callbacks.current.onEditCancel?.({ ...range, ...previous.before });
    if (previous.element.hasPointerCapture(previous.pointer)) previous.element.releasePointerCapture(previous.pointer);
  };
  const pointerStart = (event: PointerEvent<HTMLDivElement>, side: "start" | "end") => {
    if (!editable || !waveform) return;
    event.preventDefault(); event.stopPropagation(); callbacks.current.onEditStart?.(); event.currentTarget.focus();
    drag.current = { pointer: event.pointerId, side, before: { startFrame: shown.startFrame, endFrame: shown.endFrame }, element: event.currentTarget };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const currentDrag = drag.current; if (!currentDrag || event.pointerId !== currentDrag.pointer || !track.current) return;
    const rect = track.current.getBoundingClientRect(), frame = Math.round(clamp(viewStart + (event.clientX - rect.left) / rect.width * span, 0, range.sourceFrames));
    const bounds = currentDrag.side === "start" ? { startFrame: clamp(frame, 0, shown.endFrame - minimum), endFrame: shown.endFrame } : { startFrame: shown.startFrame, endFrame: clamp(frame, shown.startFrame + minimum, range.sourceFrames) };
    setGesture(bounds);
  };
  const pointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || drag.current.pointer !== event.pointerId) return;
    drag.current = null; const bounds = { startFrame: shown.startFrame, endFrame: shown.endFrame };
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setGesture(null);
    commit(bounds);
  };
  const keyboard = (event: KeyboardEvent<HTMLDivElement>, side: "start" | "end") => {
    if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); return; }
    if (!editable || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation(); callbacks.current.onEditStart?.();
    const low = side === "start" ? 0 : shown.startFrame + minimum, high = side === "start" ? shown.endFrame - minimum : range.sourceFrames;
    const prior = side === "start" ? shown.startFrame : shown.endFrame, delta = Math.round(range.sampleRate * (event.shiftKey ? .1 : .01));
    const frame = event.key === "Home" ? low : event.key === "End" ? high : clamp(prior + (event.key === "ArrowLeft" ? -delta : delta), low, high);
    commit(side === "start" ? { startFrame: frame, endFrame: shown.endFrame } : { startFrame: shown.startFrame, endFrame: frame });
  };
  const changeInput = (side: "start" | "end", text: string) => {
    if (side === "start") setStartText(text); else setEndText(text);
    const keepDraft = () => { inputDraft.current[side] = text; try { writeDraft(inputDraftKey, inputDraft.current, range.revision, props.workspaceId); } catch { setInputError("时间输入仍在当前页，浏览器未能保存暂存。"); } };
    if (!text.trim() || !/^\d+(?:\.\d+)?$/.test(text)) { setInputError("时间尚未填完，当前播放范围保留。"); keepDraft(); return; }
    const frame = Math.round(Number(text) * range.sampleRate);
    const bounds = side === "start" ? { startFrame: frame, endFrame: shown.endFrame } : { startFrame: shown.startFrame, endFrame: frame };
    if (!Number.isSafeInteger(frame) || bounds.startFrame < 0 || bounds.endFrame > range.sourceFrames || bounds.endFrame - bounds.startFrame < minimum) { setInputError("起止时间超出范围或间隔过短，当前播放范围保留。"); keepDraft(); return; }
    delete inputDraft.current[side];
    try { if (Object.keys(inputDraft.current).length) writeDraft(inputDraftKey, inputDraft.current, range.revision, props.workspaceId); else clearDraft(inputDraftKey, undefined, false, props.workspaceId); } catch { /* Keep the numeric value visible even if browser storage is unavailable. */ }
    setInputError(Object.keys(inputDraft.current).length ? "时间尚未填完，当前播放范围保留。" : ""); callbacks.current.onEditStart?.(); commit(bounds);
  };
  const undo = () => {
    const previous = historyRef.current.at(-1); if (!previous || !editable) return;
    callbacks.current.onEditStart?.(); setHistory(values => values.slice(0, -1)); commit(previous, false);
  };
  const zoomTo = (next: number) => {
    callbacks.current.onBrowse?.();
    const center = document.activeElement?.getAttribute("data-wave-handle") === "start" ? shown.startFrame : document.activeElement?.getAttribute("data-wave-handle") === "end" ? shown.endFrame : (viewStart + viewEnd) / 2;
    setZoom(next); setView(clamp(center - range.sourceFrames / next / 2, 0, range.sourceFrames - range.sourceFrames / next));
  };
  const localStatus = gesture ? "调整中" : state.status === "saved" ? "已保存" : state.status === "saving" ? "正在自动保存…" : state.status === "conflict" ? "范围冲突" : state.status === "unreliable" ? "本机暂存不可用" : "已保留在本机，待同步";
  const handle = (side: "start" | "end") => {
    const frame = side === "start" ? shown.startFrame : shown.endFrame, low = side === "start" ? 0 : shown.startFrame + minimum, high = side === "start" ? shown.endFrame - minimum : range.sourceFrames;
    return <div className={"waveform-handle " + side} data-wave-handle={side} role="slider" tabIndex={editable && waveform ? 0 : -1} aria-label={side === "start" ? "本段播放开始" : "本段播放结束"} aria-disabled={!editable || !waveform} aria-valuemin={low / range.sampleRate} aria-valuemax={high / range.sampleRate} aria-valuenow={frame / range.sampleRate} aria-valuetext={format(frame, range.sampleRate)} style={{ left: clamp((frame - viewStart) / span * 100, 0, 100) + "%", visibility: frame < viewStart || frame > viewEnd ? "hidden" : "visible" }} onPointerDown={event => pointerStart(event, side)} onPointerMove={pointerMove} onPointerUp={pointerEnd} onPointerCancel={cancelGesture} onLostPointerCapture={() => { if (drag.current) cancelGesture(); }} onKeyDown={event => keyboard(event, side)} />;
  };
  return <div className="waveform-editor" onKeyDown={event => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || (event.target instanceof HTMLElement && event.target.isContentEditable)) return;
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); undo(); }
    if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancelGesture(); }
  }}>
    <div className="waveform-readouts">
      <label>开始 <input type="text" inputMode="decimal" aria-label="开始秒数" value={startText} disabled={!editable} onFocus={() => setInputSide("start")} onBlur={() => setInputSide(null)} onChange={event => changeInput("start", event.target.value)} /> 秒</label>
      <label>结束 <input type="text" inputMode="decimal" aria-label="结束秒数" value={endText} disabled={!editable} onFocus={() => setInputSide("end")} onBlur={() => setInputSide(null)} onChange={event => changeInput("end", event.target.value)} /> 秒</label>
      <span>保留 {((shown.endFrame - shown.startFrame) / range.sampleRate).toFixed(3)} 秒</span>
      <span className={"waveform-save-state " + state.status} role="status">{localStatus}</span>
    </div>
    <div ref={track} className="waveform-track" onClick={event => {
      if ((event.target as HTMLElement).closest(".waveform-handle") || !waveform || !track.current) return;
      callbacks.current.onEditStart?.(); const rect = track.current.getBoundingClientRect(), sourceFrame = Math.round(clamp(viewStart + (event.clientX - rect.left) / rect.width * span, shown.startFrame, shown.endFrame));
      preview(false, sourceFrame, true);
    }}><canvas ref={canvas} aria-label="当前声音的真实振幅波形" />{waveform && <>{handle("start")}{handle("end")}</>}{!waveform && <span className="waveform-loading">{waveError || "正在读取真实峰值…"}</span>}</div>
    <div className="waveform-timebar"><span>{format(viewStart, range.sampleRate)}</span><span>{format(viewEnd, range.sampleRate)}</span></div>
    {zoom > 1 && <><canvas className="waveform-overview" ref={overview} aria-label="完整声音波形与当前视窗" onClick={event => { callbacks.current.onBrowse?.(); const rect = event.currentTarget.getBoundingClientRect(); setView(clamp((event.clientX - rect.left) / rect.width * range.sourceFrames - span / 2, 0, range.sourceFrames - span)); }} /><input className="waveform-pan" type="range" min={0} max={Math.ceil(range.sourceFrames - span)} step={1} value={Math.round(viewStart)} aria-label="放大后移动波形视窗" onChange={event => { callbacks.current.onBrowse?.(); setView(Number(event.target.value)); }} /></>}
    <div className="waveform-tools">
      <button type="button" onClick={() => preview()} disabled={!props.onPreview || !waveform}>试听保留部分</button>
      <button type="button" onClick={() => preview(true)} disabled={!props.onPreview || !waveform}>试听完整源音</button>
      <button type="button" onClick={undo} disabled={!editable || !history.length}>撤销</button>
      <button type="button" onClick={() => { callbacks.current.onEditStart?.(); commit(normalizeRange({ startFrame: 0, endFrame: range.sourceFrames }, range.sourceFrames)); }} disabled={!editable || (shown.startFrame === 0 && shown.endFrame === range.sourceFrames)}>恢复完整范围</button>
      <div className="waveform-zoom"><span>波形</span>{[1, 2, 4, 8].map(value => <button key={value} type="button" className={zoom === value ? "selected" : ""} aria-pressed={zoom === value} onClick={() => zoomTo(value)}>{value}×</button>)}</div>
    </div>
    {props.sourceLabel && <p className="waveform-message">{props.sourceLabel}</p>}
    {(!props.result.editable || props.lockedReason) && <p className="waveform-message" role="status">{props.lockedReason || props.result.reason || "当前声音正在更新，完成后可调整。"}</p>}
    {(inputError || waveError || state.error || draftError) && <p className="waveform-message warning" role="status">{inputError || waveError || state.error || draftError}{waveError && <button type="button" onClick={() => setWaveRetry(value => value + 1)}>重新读取波形</button>}</p>}
    {state.conflict && <div className="waveform-conflict" role="status"><p>另一页范围：{format(state.conflict.startFrame, range.sampleRate)} — {format(state.conflict.endFrame, range.sampleRate)}；本页范围：{format(range.startFrame, range.sampleRate)} — {format(range.endFrame, range.sampleRate)}</p><button type="button" onClick={() => { setHistory(values => [...values, { startFrame: state.conflict!.startFrame, endFrame: state.conflict!.endFrame }].slice(-20)); controller.choose("mine"); }}>使用我的范围</button><button type="button" onClick={() => { setHistory([]); controller.choose("server"); }}>采用另一页范围</button></div>}
    {otherDrafts.map(record => <div className="waveform-conflict" key={record.key}><p>{record.status === "active" ? "另一页正在调整本段范围，请在那一页完成同步。" : "发现本段范围的遗留暂存。"}{record.data?.draft && Number.isFinite(record.data.draft.startFrame) && Number.isFinite(record.data.draft.endFrame) ? " " + format(record.data.draft.startFrame, range.sampleRate) + " — " + format(record.data.draft.endFrame, range.sampleRate) : ""}</p>{record.status === "orphan" && <><button type="button" disabled={state.dirty} onClick={() => void recoverDraft(controller.key, record).then(() => { controller.restoreDraft(); setOtherDrafts(values => values.filter(value => value.key !== record.key)); setDraftError(""); }).catch(failure => setDraftError(failure.message))}>恢复这份范围</button><button type="button" onClick={() => void discardDraft(controller.key, record).then(() => { setOtherDrafts(values => values.filter(value => value.key !== record.key)); setDraftError(""); }).catch(failure => setDraftError(failure.message))}>丢弃这份暂存</button></>}</div>)}
  </div>;
}
