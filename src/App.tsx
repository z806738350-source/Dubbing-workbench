import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  BookOpen,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  FolderOpen,
  Headphones,
  Import,
  Library,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  SkipBack,
  SkipForward,
  SlidersHorizontal,
  Sparkles,
  Square,
  Upload,
  Users,
  Volume2,
  X,
  Scissors,
  Link2,
  RotateCcw,
  PanelRightClose,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { api, action } from "./api";
import { importLimits, importProblems } from "../server/import-validation.mjs";
import { bindDraftWorkspace, draftWorkspace, readDraft, writeDraft, clearDraft, hasDraft, listDrafts, recoverDraft, discardDraft, finishDraftSave } from "./drafts";
import type { DraftRecord } from "./drafts";
import AnalysisDialog from "./AnalysisDialog";
import SegmentSplitDialog from "./SegmentSplitDialog";
import { ObjectDraftTools, useObjectDraft } from "./ObjectDraft";
import { saveAction, speechDraftProblem, withSavedDrafts, draftScopeRevision } from "./autosave";
import { useDraftSaveStatus } from "./ObjectDraft";
import { chapterIssues, chapterMemberState, configurationDecided, playbackIdentity, IssueCenter, ProjectOverview, VoicePicker, RecoveryCenter, QuickHelp, GeneratePlan, type RecoveryTarget } from "./WorkspaceExperience";
import TaskAuthorization from "./TaskAuthorization";
import { submitOperation } from "./taskOperations";
import VoiceCreation from "./VoiceCreation";
import UnitPanel, { CreateGroup, unitHasDraft } from "./UnitPanel";
import { Dialog, Empty, ErrorBanner, ErrorContext, Field, Form, Select, Status } from "./components";
import type {
  State,
  Job,
  ChapterDetail,
  Segment,
  Role,
  AliasSource,
  Voice,
  Master,
  Project,
  AudioRecord,
  VoiceSession,
  GenerationUnit,
  GenerationPlan,
} from "./types";

const inVoiceLibrary = (voice: Voice) => voice.state !== "deleted" && !voice.deletePending;
const names: Record<string, string> = {
  none: "未生成",
  queued: "排队中",
  running: "生成中",
  success: "已生成",
  failed: "生成失败",
  unknown: "结果不明",
  stopped: "已停止",
  missing: "待生成",
  broken: "文件不可用",
  stale: "待更新",
  matched: "音频匹配",
  pending: "待检查",
  passed: "已通过",
  rework: "需返工",
};
const basis = (s: Segment) => ({
  model: s.model || "seed-audio-1.0",
  text: s.text,
  voiceId: s.voiceId,
  performance: s.performance,
  config: s.config,
  template: s.template,
  roleId: s.roleId,
  type: s.type,
  source: s.source,
  identityConfirmed: s.identityConfirmed,
  roleConfirmed: s.roleConfirmed,
});
const time = (n: number) =>
  `${Math.floor(n / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(n % 60)
    .toString()
    .padStart(2, "0")}`;
const active = (s: string) => ["queued", "running"].includes(s);
const connectionMessage = "无法连接本地工作区，已暂停试听。连接恢复后将先核对版本。";
type UnitPlayback = {id:string;mode:"dry"|"scene";audioId:string;basis:Record<string,unknown>;state:string};
type Modal =
  | "overview"
  | "issues"
  | "recovery"
  | "help"
  | "project"
  | "project-rename"
  | "chapter"
  | "manual"
  | "voices"
  | "roles"
  | "settings"
  | "tasks"
  | "export"
  | "source"
  | "rename"
  | null;

export default function App() {
  const [deleteTarget,setDeleteTarget]=useState<Project|null>(null);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [unitPanelId, setUnitPanelId] = useState<string|null>(null);
  const [currentMembers, setCurrentMembers] = useState<string[]>([]);
  const [draftIds,setDraftIds] = useState<string[]>([]);
  const [draftSignal,setDraftSignal] = useState(0);
  const recoveryTarget = useRef<RecoveryTarget|null>(null);
  const [voiceTarget,setVoiceTarget] = useState<{roleId?:string;segmentId?:string;tab?:"create";sessionId?:string}|null>(null);
  const [voiceLibraryCreate,setVoiceLibraryCreate] = useState(false);
  const [voiceLibrarySession,setVoiceLibrarySession] = useState<string>();
  const [unitInitialEvent,setUnitInitialEvent] = useState<string>();
  const [unitInitialMode,setUnitInitialMode] = useState<"dry"|"scene">();
  const [density,setDensity] = useState(localStorage.getItem("reading-density")||"comfortable");
  const [readingSize,setReadingSize] = useState(Number(localStorage.getItem("reading-size"))||17);
  const [grantId,setGrantId] = useState<string|null>(null);
  const [generationPlan,setGenerationPlan] = useState<{plan:GenerationPlan;ids:string[];regenerate:boolean;retryUnknown:boolean;resumeRoute:boolean}|null>(null);
  const generationIntent=useRef(0);
  const closeGeneration=()=>{generationIntent.current++;setGenerationPlan(null);};
  const [taskRecord,setTaskRecord] = useState<{jobId:string;attempt:{id:string;status:string;mode?:string;error?:string}}|null>(null);
  const taskRecordRef=useRef<HTMLElement>(null),unitPanelRef=useRef(unitPanelId);
  unitPanelRef.current=unitPanelId;
  const onDraftChange = useCallback((id:string,dirty:boolean)=>setDraftIds(prev=>dirty ? (prev.includes(id) ? prev : [...prev,id]) : prev.filter(x=>x!==id)),[]);

  const bookmarks = useRef<Record<string, string>>({});
  const playIntent = useRef(0);
  const pendingPlay = useRef<string | null>(null);
  const pendingPlaySnapshot = useRef<{intent:number;arrangement:number;items:ChapterDetail["playbackItems"]}|null>(null);
  const [oldPreview, setOldPreview] = useState<Segment | null>(null);
  useEffect(() => {
    const close = () => {
      if (window.innerWidth >= 1216) setInspectorOpen(false);
    };
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, []);
  const [state, setState] = useState<State | null>(null),
    [chapter, setChapter] = useState<ChapterDetail | null>(null),
    [chapterId, setChapterId] = useState(localStorage.getItem("chapter") || ""),
    [projectId, setProjectId] = useState(""),
    [selected, setSelected] = useState(""),
    [checked, setChecked] = useState<string[]>([]),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [modal, setModal] = useState<Modal>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [navOpen, setNavOpen] = useState(false),
    [inspectorOpen, setInspectorOpen] = useState(false),
    [panelMode, setPanelMode] = useState("settings"),
    [follow, setFollow] = useState(true),
    [connectionReady, setConnectionReady] = useState(false),
    [loading, setLoading] = useState(true);
  const [player, setPlayer] = useState<{
      kind: string;
      id: string;
      title: string;
      chapterId?: string;
      arrangement?: number;
      playbackItems?: ChapterDetail["playbackItems"];
      master?: Master;
      resumeAt?: number;
      intent?: number;
      unitSession?: UnitPlayback;
    } | null>(null),
    [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(0),
    [currentSegment, setCurrentSegment] = useState(""),
    [transitioning, setTransitioning] = useState(false);
  const projectRef = useRef(projectId);
  projectRef.current = projectId;
  const audio = useRef<HTMLAudioElement>(null),
    listRef = useRef<HTMLDivElement>(null),
    chapterRef = useRef(chapterId),
    stateRef = useRef(state),
    playerRef = useRef(player);
  if(chapterRef.current!==chapterId)generationIntent.current++;
  chapterRef.current = chapterId;
  stateRef.current = state;
  playerRef.current = player;
  useEffect(()=>{if(modal==="tasks"&&taskRecord)taskRecordRef.current?.focus();},[modal,taskRecord?.attempt.id]);
  const refreshPending = useRef<Promise<void>|null>(null);
  const refresh = useCallback(() => {
    if(refreshPending.current)return refreshPending.current;
    const request=(async()=>{
    try {
    const s = await api<State>("/state");
    const identity=s.settings.workspaceIdentity||s.settings.workspaceDirectory,changedWorkspace=!!draftWorkspace()&&draftWorkspace()!==identity;
    bindDraftWorkspace(identity);
    if(changedWorkspace){playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;generationIntent.current++;setGenerationPlan(null);setGrantId(null);setDeleteTarget(null);setUnitPanelId(null);setVoiceTarget(null);setOldPreview(null);setModal(null);setChapter(null);setDraftSignal(value=>value+1);bookmarks.current={};audio.current?.pause();setPlayer(null);}
    setState(s);
    let id = chapterRef.current;
    if (!s.chapters.some((c) => c.id === id))
      id =
        s.chapters.find(
          (c) => !projectRef.current || c.projectId === projectRef.current,
        )?.id || "";
    if (id !== chapterRef.current) { chapterRef.current=id; setChapterId(id); }
    if (id) {
      const c = await api<ChapterDetail>("/chapters/" + id);
      if (chapterRef.current !== id) return;
      setChapter(c);
      setProjectId(c.projectId);
      setSelected((prev) =>
        c.segments.some((x) => x.id === prev) ? prev : c.segments[0]?.id || "",
      );
      if (pendingPlay.current === id) {
        const master = c.masters.find((m) => m.arrangement === c.arrangement);
        if (master) {
          pendingPlay.current = null;
          const intent=pendingPlaySnapshot.current;pendingPlaySnapshot.current=null;
          if(intent&&intent.intent===playIntent.current&&intent.arrangement===c.arrangement&&playbackIdentity(intent.items)===playbackIdentity(c.playbackItems)&&document.visibilityState==='visible'&&!s.jobs.some(j=>j.chapterId===id&&active(j.status))){
            const bookmark=bookmarks.current[id],point=master.mapping.find(x=>x.segmentId===bookmark||x.unitId===bookmark||x.memberIds?.includes(bookmark));
            if(bookmark&&!point){delete bookmarks.current[id];setNotice('断点已变化，试听已准备好，请重新选择播放位置。');}
            else setPlayer({kind:'masters',id:master.id,title:c.title,chapterId:id,arrangement:c.arrangement,playbackItems:c.playbackItems,master,intent:intent.intent,resumeAt:(point?.startFrame||0)/master.sampleRate});
          }else if(intent?.intent===playIntent.current)setNotice('整章试听已准备好；版本已变化，请点击播放继续。');
        } else if (
          !s.jobs.some(
            (j) =>
              j.chapterId === id && ["queued", "running"].includes(j.status),
          )
        )
          pendingPlay.current = null;
      } else if (pendingPlay.current && pendingPlay.current !== id)
        pendingPlay.current = null;
      const p = playerRef.current;
      const selectedUnit = p?.unitSession && c.units?.find(u=>u.id === p.unitSession!.id);
      const unitChanged = p?.unitSession && (!selectedUnit || selectedUnit.state !== p.unitSession.state || selectedUnit.variants[p.unitSession.mode].current !== p.unitSession.audioId || JSON.stringify(selectedUnit.variants[p.unitSession.mode].status.basis) !== JSON.stringify(p.unitSession.basis));
      if (p?.chapterId === id && (p.arrangement !== c.arrangement || playbackIdentity(p.playbackItems) !== playbackIdentity(c.playbackItems) || unitChanged || s.jobs.some(j => j.chapterId === id && active(j.status)))) {
        playIntent.current++;
        audio.current?.pause();
        setPlayer(null);
        setCurrentSegment("");
        setNotice("本章版本或任务状态已变化，已停止旧播放。请核对后继续。");
      }
    } else {
      setChapter(null);
      setProjectId((prev) =>
        s.projects.some((p) => p.id === prev) ? prev : s.projects[0]?.id || "",
      );
    }
    setLoading(false);
    setConnectionReady(true);
    setError(previous => previous === connectionMessage ? "" : previous);
    } catch (failure) {
      audio.current?.pause();
      setConnectionReady(false);
      const message=(failure as {storageFailure?:boolean}).storageFailure?(failure as Error).message:connectionMessage;
      setError(message);
      throw new Error(message);
    }
    })();
    refreshPending.current=request.finally(()=>{refreshPending.current=null;});
    return refreshPending.current;
  }, []);
  useEffect(() => {
    void refresh().catch((e) => {
      setError(e.message);
      setLoading(false);
    });
    const timer = setInterval(() => void refresh().catch(() => {}), 2500);
    const onFocus = () => { playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;audio.current?.pause(); setConnectionReady(false); void refresh().catch((e) => setError(e.message)); };
    const onStorage = (e: StorageEvent) => { if (e.key?.startsWith("draft-")) setDraftSignal(n=>n+1); if (e.key === "workbench-change") void refresh().catch(e => setError(e.message)); };
    const onOffline = () => { playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;audio.current?.pause(); setConnectionReady(false); setError(connectionMessage); };
    window.addEventListener("focus", onFocus);
    window.addEventListener("online", onFocus);
    window.addEventListener("offline", onOffline);
    window.addEventListener("storage", onStorage);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("online", onFocus);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("storage", onStorage);
    };
  }, [refresh,onDraftChange]);
  useEffect(() => {
    localStorage.setItem("chapter", chapterId);
    playIntent.current++;
    setNotice("");
    audio.current?.pause();
    setPlayer(null);
    setChecked([]);
    setFilter("all");
    setSearch("");
    void refresh().catch((e) => setError(e.message));
  }, [chapterId, refresh]);
  useEffect(() => {
    const list = listRef.current, row = document.getElementById("segment-" + currentSegment);
    if (follow && currentSegment && row && list?.contains(row)) {
      const offset = row.getBoundingClientRect().top - list.getBoundingClientRect().top;
      list.scrollTo({ top: list.scrollTop + offset - Math.max(0, (list.clientHeight - row.offsetHeight) / 2), behavior: "instant" });
    }
  }, [currentSegment, follow, filter, search]);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (name: string, data: Record<string, unknown> = {}) => {
    if(name === "segment.review") {
      const unit=chapter?.units?.find(u=>u.state === "active" && (u.kind === "group" || u.mode === "scene") && u.members.includes(String(data.id)));
      if(unit){setUnitPanelId(unit.id);throw new Error("请在声音版本面板核对实际单元音频后提交检查。");}
    }
    if (name === "segment.review" && !connectionReady) throw new Error(connectionMessage);
    const result = await action(name, {
      chapterId: chapter?.id,
      revision: chapter?.revision,
      ...data,
    });
    // A failed follow-up read must not hide an acknowledged write.
    await refresh().catch(() => {});
    return result;
  };
  const project = state?.projects.find((p) => p.id === projectId),
    roles = state?.roles.filter((r) => r.projectId === projectId) || [],
    voices = state?.voices || [],
    segments = chapter?.segments || [],
    selectedSegment = segments.find((s) => s.id === selected),
    job = state?.jobs.find(
      (j) => j.chapterId === chapterId && active(j.status),
    ),
    locked = !!job;
  const selectedUnit = chapter?.units?.find(u=>u.kind === "group" && u.state === "active" && u.members.includes(selected)) || chapter?.units?.find(u=>u.kind === "single" && u.members.includes(selected));
  const openMember = (id:string) => { setUnitPanelId(null); setSelected(id); if(window.innerWidth < 1216)setInspectorOpen(true); };
  const saveStatus = useDraftSaveStatus("chapter:"+chapterId);
  const issues = chapter ? chapterIssues(chapter,roles,voices) : [];
  const criticalIssues = issues.filter(i=>i.kind !== "audio" && i.kind !== "request" && i.kind !== "advice");
  const openVoice = (roleId?:string,segmentId?:string) => {setModal(null);setInspectorOpen(false);setVoiceTarget({roleId,segmentId});};
  const openUnit = (id:string,mode?:"dry"|"scene",eventId?:string)=>{setInspectorOpen(false);setModal(null);setUnitInitialMode(mode);setUnitInitialEvent(eventId);setUnitPanelId(id);};
  const locate = (id:string)=>{setModal(null);setSelected(id);setFilter("all");setSearch("");setPanelMode("settings");if(window.innerWidth<1216)setInspectorOpen(true);setTimeout(()=>document.getElementById("segment-"+id)?.scrollIntoView({block:"center"}),0);};
  const effectiveStatus = (s:Segment) => chapter ? chapterMemberState(chapter,s) : s;
  const visible = segments.filter((s) => {
    if (
      search &&
      !`${s.text}${roles.find((r) => r.id === s.roleId)?.name}`.includes(search)
    )
      return false;
    if (filter === "confirm") return !s.excluded && !configurationDecided(s);
    if (filter === "generate") return !s.excluded && effectiveStatus(s).validity !== "matched";
    if (filter === "failed") return !s.excluded && (chapter ? chapterMemberState(chapter,s).requestIssues.length > 0 : ["failed", "unknown"].includes(s.latest));
    if (filter === "pending")
      return effectiveStatus(s).validity === "matched" && effectiveStatus(s).review === "pending";
    if (filter === "rework") return effectiveStatus(s).review === "rework";
    return true;
  });
  const currentHidden = !!currentSegment && !visible.some(s=>s.id === currentSegment || currentMembers.includes(s.id));
  const ready = chapter?.playbackItems ? chapter.playbackItems.filter(item=>item.validity === "matched").flatMap(item=>item.members || [item.id]).length : segments.filter(
      (s) => !s.excluded && s.validity === "matched",
    ).length,
    total = segments.filter((s) => !s.excluded).length,
    passed = chapter?.playbackItems ? chapter.playbackItems.filter(item=>item.validity==='matched'&&item.review === "passed").flatMap(item=>item.members || [item.id]).length : segments.filter(
      (s) => !s.excluded && s.review === "passed",
    ).length;
  const pickChapter = (id: string) => {
    setDeleteTarget(null);
    playIntent.current++;
    chapterRef.current=id;
    pendingPlay.current=null;pendingPlaySnapshot.current=null;
    closeGeneration();setGrantId(null);setVoiceTarget(null);setUnitPanelId(null);setUnitInitialMode(undefined);
    audio.current?.pause();
    setPlayer(null);
    setChapterId(id);
    setNavOpen(false);
    setInspectorOpen(false);
  };
  const pickProject = (id: string, source = stateRef.current) => {
    projectRef.current=id;setProjectId(id);
    pickChapter(source?.chapters.find(c=>c.projectId===id)?.id || "");
    setChapter(null);setSelected("");setChecked([]);setFilter("all");setSearch("");
    setOldPreview(null);setCurrentMembers([]);setCurrentSegment("");
    setModal(null);setTaskRecord(null);setUnitInitialEvent(undefined);
    recoveryTarget.current=null;setDraftIds([]);
  };
  const deleteProject = async (id: string, scope:Record<string,unknown>) => {
    const result = await action<{cleanupPending?:boolean}>("project.delete", {id,scope});
    if(result?.cleanupPending)setNotice("项目已删除；部分文件暂存待清理，下次启动会继续清理。");
    if(projectRef.current===id)audio.current?.pause();
    // Finish a pre-delete read before selecting the remaining project.
    await refreshPending.current?.catch(()=>{});
    const current=stateRef.current;
    const remaining=current?.projects.filter(p=>p.id!==id) || [];
    if(projectRef.current===id){
      for(const c of current?.chapters.filter(c=>c.projectId===id) || [])delete bookmarks.current[c.id];
      pickProject(remaining[0]?.id || "",current);
    }
    setState(previous=>previous ? {...previous,projects:previous.projects.filter(p=>p.id!==id),chapters:previous.chapters.filter(c=>c.projectId!==id)} : previous);
  };
  useEffect(()=>{
    const target=recoveryTarget.current;if(!target)return;
    if(target.chapterId&&chapter?.id!==target.chapterId)return;
    recoveryTarget.current=null;
    if(target.kind==='import'){setModal('chapter');return;}
    if(target.kind==='segment'&&target.segmentId){locate(target.segmentId);return;}
    if((target.kind==='unit'||target.kind==='event')&&target.unitId){openUnit(target.unitId,target.mode,target.kind==='event'?target.eventId||'new':undefined);return;}
    if(target.kind==='new-group'){setChecked(target.ids||[]);openUnit('create');return;}
    if(target.kind==='voice-context'){
      if(target.contextKey)localStorage.setItem(target.contextKey,'new');
      if(target.roleId||target.segmentId){setInspectorOpen(false);setModal(null);setVoiceTarget({roleId:target.roleId,segmentId:target.segmentId,tab:"create"});return;}
    }
    if(target.kind==='voice-session'){setVoiceLibrarySession(target.voiceSessionId);setVoiceLibraryCreate(true);setModal('voices');return;}
    setVoiceLibrarySession(undefined);setVoiceLibraryCreate(true);setModal('voices');
  },[chapter?.id,draftSignal]);
  const generate = async (ids:string[], _whole=false, options:Record<string,unknown>={}, context=chapter, intent?:number) => {
    const expected=intent??++generationIntent.current;
    const current=()=>generationIntent.current===expected&&chapterRef.current===context?.id;
    if(intent===undefined)setGenerationPlan(null);
    if(!context||!ids.length)throw new Error("没有需要生成的台词。可以先试听现有声音。");
    const units=(context.units||[]).filter(u=>u.state==='active'&&u.members.some(id=>ids.includes(id)));
    const members=[...new Set([...ids,...units.flatMap(u=>u.members)])];
    const dependencies=members.map(id=>"segment:"+id).concat(units.flatMap(u=>["unit:"+u.id,"unit:"+u.id+"/"+u.mode,...(u.mode==='scene'?["events:"+u.id]:[])]));
    try{await withSavedDrafts("chapter:"+context.id,dependencies,async()=>{
      if(!current())return;
      if(members.some(id=>hasDraft(id))||units.some(u=>unitHasDraft(u,context.events||[],u.mode)))throw new Error('相关台词或声音背景有其他页面/遗留编辑，请先在本机暂存中处理。');
      const revision=draftScopeRevision("chapter:"+context.id,context.revision);
      const plan=await api<GenerationPlan>("/operations/plan",{kind:"generateSelection",chapterId:context.id,revision,ids,regenerate:options.regenerate===true,actionKind:options.actionKind||(options.regenerate===true?'forceRegenerate':'updateSelected')});
      if(!current())return;
      if(!plan.audioRequests){setGenerationPlan(null);setNotice("所选范围已有匹配声音，已复用；无需发送新的配音请求。");return;}
      setGrantId(null);
      setGenerationPlan({plan,ids,regenerate:options.regenerate===true,retryUnknown:false,resumeRoute:false});
      setInspectorOpen(false);
    });}catch(error){if(current())throw error;}
  };
  const planIntent=generationIntent.current;
  const generationUnknown = !!generationPlan?.plan.outstandingAttemptIds?.length || generationPlan?.plan.units.some(planned=>!!chapter?.units?.find(u=>u.id===planned.unitId)?.variants[planned.mode].outstandingAttemptIds?.length || chapter?.units?.find(u=>u.id===planned.unitId)?.variants[planned.mode].latest === "unknown") || false;
  const submitGeneration = async () => {
    if(!generationPlan||!chapter||!grantId)return;
    const request=generationPlan;
    const intent=generationIntent.current;
    const dependencies=request.plan.memberIds.map(id=>"segment:"+id).concat(request.plan.units.flatMap(u=>["unit:"+u.unitId,"unit:"+u.unitId+"/"+u.mode,...(u.mode==="scene"?["events:"+u.unitId]:[])]));
    await withSavedDrafts("chapter:"+chapter.id,dependencies,async()=>{
      if(generationIntent.current!==intent)return;
      if(chapterRef.current!==request.plan.chapterId)throw new Error("章节已切换，本次未发送。");
      if(request.plan.memberIds.some(id=>hasDraft(id))||request.plan.units.some(p=>{const u=chapter.units?.find(u=>u.id===p.unitId);return u&&unitHasDraft(u,chapter.events||[],p.mode);}))throw new Error("相关其他页面的草稿仍需处理，本次未发送。");
      if(draftScopeRevision("chapter:"+chapter.id,request.plan.revision)!==request.plan.revision)throw Object.assign(new Error("生成范围在核对后已变化，请重新核对生成范围。"),{status:409});
      playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;audio.current?.pause();setPlayer(null);
      const receipt=await submitOperation("generate:"+chapter.id,{kind:"generateSelection",chapterId:chapter.id,revision:request.plan.revision,arrangement:request.plan.arrangement,ids:request.ids,regenerate:request.regenerate,actionKind:request.plan.actionKind,grantId,...(request.retryUnknown?{retryUnknown:true,acknowledgedAttemptIds:request.plan.outstandingAttemptIds}:{}),...(request.resumeRoute?{resumeRoute:true}:{})},state?.jobs||[]);
      if(generationIntent.current!==intent||chapterRef.current!==request.plan.chapterId){await refresh();return;}
      if(receipt.error)throw Object.assign(new Error(receipt.error),{status:receipt.errorStatus});
      if(chapterRef.current!==request.plan.chapterId)return;
      setGenerationPlan(null);await refresh();
    });
  };
  const startPlay = async (
    kind: string,
    id: string,
    title: string,
    master?: Master,
    standalone = false,
    unitSession?: UnitPlayback,
    preparedIntent?: number,
  ) => {
    const intent=preparedIntent??++playIntent.current;
    const current=()=>intent===playIntent.current;
    pendingPlay.current=null;pendingPlaySnapshot.current=null;
    if(!master&&playerRef.current?.kind===kind&&playerRef.current?.id===id&&audio.current&&!audio.current.paused){audio.current.pause();setPlaying(false);return;}
    if (!connectionReady) { setError(connectionMessage); return; }
    if (kind !== "voices" && !standalone && chapter) {
      try {
        const fresh = await api<ChapterDetail>("/chapters/" + chapter.id);
        if(!current()||chapterRef.current!==chapter.id)return;
        const now = await api<State>("/state");
        if(!current()||chapterRef.current!==chapter.id)return;
        const existing = playerRef.current;
        const expected = existing?.chapterId === chapter.id && existing.kind === kind && existing.id === id ? existing.playbackItems : chapter.playbackItems;
        const target = unitSession && fresh.units?.find(u=>u.id === unitSession.id);
        const unitChanged = unitSession && (!target || target.state !== unitSession.state || target.variants[unitSession.mode].current !== unitSession.audioId || JSON.stringify(target.variants[unitSession.mode].status.basis) !== JSON.stringify(unitSession.basis));
        if (fresh.arrangement !== chapter.arrangement || playbackIdentity(fresh.playbackItems) !== playbackIdentity(expected) || unitChanged || now.jobs.some(j => j.chapterId === chapter.id && active(j.status))) {
          await refresh();
          if(!current())return;
          setError("章节版本或任务状态已变化，请核对后重新选择试听。");
          return;
        }
      } catch { if(current()&&chapterRef.current===chapter.id)setError("无法核对播放版本，请恢复连接后重试。"); return; }
    }
    if (
      !master &&
      playerRef.current?.kind === kind &&
      playerRef.current?.id === id &&
      audio.current
    ) {
      if (audio.current.paused)
        setPlayer({...playerRef.current,intent,resumeAt:audio.current.currentTime});
      else audio.current.pause();
      return;
    }
    const bookmark = bookmarks.current[chapterId];
    if (master && bookmark && !master.mapping.some(x => x.segmentId === bookmark || x.unitId === bookmark || x.memberIds?.includes(bookmark))) {
      delete bookmarks.current[chapterId];
      setNotice("原断点片段已拆分、合并或移除。请重新选择片段；再次点击试听将从开头播放。");
      return;
    }
    audio.current?.pause();
    setPosition(0);
    setDuration(0);
    setTransitioning(false);
    setPlayer({
      kind,
      id,
      title,
      intent,
      unitSession,
      chapterId: kind === "voices" || standalone ? undefined : chapterId,
      arrangement: chapter?.arrangement,
      playbackItems: chapter?.playbackItems,
      master,
      resumeAt: master
        ? (master.mapping.find(
            (x) => x.segmentId === bookmarks.current[chapterId] || x.unitId === bookmarks.current[chapterId] || x.memberIds?.includes(bookmarks.current[chapterId]),
          )?.startFrame || 0) / master.sampleRate
        : 0,
    });
  };
  useEffect(() => {
    if (!player) {
      setCurrentMembers([]);
      audio.current?.pause();
      setPlaying(false);
      setPosition(0);
      setDuration(0);
      setCurrentSegment("");
      setTransitioning(false);
      return;
    }
    const el = audio.current!;
    if (player.master) { setFollow(true); setCurrentSegment(""); setCurrentMembers([]); }
    el.src = player.kind === "demo" ? "/demo.mp3" : `/api/media/${player.kind}/${player.id}`;
    el.load();
    const intent=player.intent;
    void el.play().then(()=>{if(intent!==playIntent.current&&playerRef.current===player)el.pause();}).catch(() => {if(intent===playIntent.current){setPlaying(false);setError("浏览器未能开始播放，请再次点击播放。");}});
  }, [player]);
  const playChapter = () => {
    const intent=++playIntent.current,current=()=>intent===playIntent.current&&chapterRef.current===chapter?.id;
    pendingPlay.current=null;pendingPlaySnapshot.current=null;
    return run(async()=>{
    if(!chapter)return;
    try{
    await withSavedDrafts('chapter:'+chapter.id,undefined,async()=>{
      if(!current())return;
      const fresh=await api<ChapterDetail>('/chapters/'+chapter.id);
      if(!current())return;
      if(fresh.playbackItems.some(item=>item.validity!=='matched'))throw new Error('有效修改已保存。请先生成待更新的声音，再整章试听。');
      const master=fresh.masters.find(m=>m.arrangement===fresh.arrangement);
      if(master){await startPlay('masters',master.id,fresh.title,master,false,undefined,intent);return;}
      await api('/jobs',{kind:'master',chapterId:chapter.id,revision:fresh.revision,commandId:crypto.randomUUID()});
      if(!current())return;
      pendingPlay.current=chapter.id;pendingPlaySnapshot.current={intent,arrangement:fresh.arrangement,items:fresh.playbackItems};
      setNotice('正在本机准备整章试听，完成后继续播放；不调用配音模型。');
    });
    }catch(failure){if(current())throw failure;}
  });};
  useEffect(()=>{const visibility=()=>{if(document.visibilityState!=='visible'){playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;audio.current?.pause();}};document.addEventListener('visibilitychange',visibility);return()=>document.removeEventListener('visibilitychange',visibility);},[]);
  const playDemo = () => {setModal(null);void startPlay("demo","welcome","免费演示 · 本机语音",undefined,true);};
  const closeOldPreview = () => {
    playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;
    audio.current?.pause();
    setPlayer(null);
    setCurrentSegment("");
    setOldPreview(null);
  };
  const chapterOptions =
    state?.chapters
      .filter((c) => c.projectId === projectId)
      .sort((a, b) => a.order - b.order) || [];
  const nav = (
    <>
      <div className="brand">
        <span className="brand-mark">
          <AudioLines size={21} />
        </span>
        <div>
          <strong>配音工作台</strong>
          <span>DUBBING WORKBENCH</span>
        </div>
        <button
          className="icon mobile-close"
          aria-label="关闭目录"
          onClick={() => setNavOpen(false)}
        >
          <X size={18} />
        </button>
      </div>
      <div className="project-switch">
        <Select
          label="当前项目"
          value={projectId}
          options={
            state?.projects.map((p) => ({ value: p.id, label: p.name })) || []
          }
          onChange={pickProject}
          onDelete={id => {const target=state?.projects.find(project=>project.id===id);if(target)setDeleteTarget(target);}}
          disabled={busy || !connectionReady}
        />
        <button
          className="icon"
          aria-label="新建项目"
          onClick={() => setModal("project")}
        >
          <Plus size={16} />
        </button>
      </div>
      {project && <button className="text-button project-rename" onClick={() => setModal("project-rename")}>重命名项目</button>}
      <button className="nav-item" onClick={() => {setNavOpen(false);setModal("overview");}}><FolderOpen size={17}/>项目总览</button>
      <button className="nav-item current" onClick={() => setNavOpen(false)}>
        <BookOpen size={17} />
        章节工作台
      </button>
      <button className="nav-item" onClick={() => setModal("voices")}>
        <Library size={17} />
        音色库<span>{voices.filter(inVoiceLibrary).length}</span>
      </button>
      <button
        className="nav-item"
        disabled={!project}
        onClick={() => setModal("roles")}
      >
        <Users size={17} />
        角色档案<span>{roles.length}</span>
      </button>
      <div className="nav-section">
        <span>章节</span>
        <button
          className="icon"
          aria-label="导入新章节"
          disabled={!project}
          onClick={() => setModal("chapter")}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="chapter-list">
        {chapterOptions.map((c, i) => (
          <button
            key={c.id}
            className={`chapter-item ${c.id === chapterId ? "selected" : ""}`}
            onClick={() => pickChapter(c.id)}
          >
            <FileText size={15} />
            <span className="chapter-nav-label"><span>{c.title}</span><small>{c.productionStatus}</small></span>
            <span className="chapter-index">
              {String(i + 1).padStart(2, "0")}
            </span>
          </button>
        ))}
        {project && !chapterOptions.length && (
          <p className="nav-empty">导入文字，开始第一章</p>
        )}
      </div>
      <div className="nav-bottom">
        <button className="nav-item" onClick={()=>{setNavOpen(false);setModal("recovery");}}><RotateCcw size={16}/>本机暂存</button>
        <button className="nav-item" onClick={()=>{setNavOpen(false);setModal("help");}}><BookOpen size={16}/>使用帮助</button>
        <button className="nav-item" onClick={() => setModal("tasks")}>
          <RefreshCw size={16} />
          任务记录
          {state?.jobs.some((j) => active(j.status)) && (
            <span className="live-dot" />
          )}
        </button>
        <button className="nav-item" onClick={() => setModal("settings")}>
          <Settings2 size={16} />
          设置与连接
        </button>
        <div className="local-info">
          <span className="status-dot" />
          本地工作区<span>体验升级版</span>
        </div>
      </div>
    </>
  );
  const inspector = chapter && <>
    <div className="tabs panel-tabs" aria-label="工作面板">
      <button aria-pressed={panelMode === "settings"} className={panelMode === "settings" ? "active" : ""} onClick={()=>setPanelMode("settings")}>台词编辑</button>
      <button aria-pressed={panelMode === "analysis"} className={panelMode === "analysis" ? "active" : ""} onClick={()=>setPanelMode("analysis")}>AI 整理</button>
    </div>
    <div className="panel-content" hidden={panelMode !== "settings"}>
      {selectedSegment ? (
                    <Editor
                      key={(state?.settings.workspaceIdentity||state?.settings.workspaceDirectory)+":"+selectedSegment.id+":"+draftSignal}
                      segment={selectedSegment}
                      onDraftChange={onDraftChange}
                      templates={state?.templates || []}
                      chapter={chapter}
                      roles={roles}
                      voices={voices}
                      locked={locked}
                      connectionReady={connectionReady}
                      save={mutate}
                      run={run}
                      generate={(ids) => generate(ids)}
                      onRoles={() => setModal("roles")}
                      onVoice={openVoice}
                      unit={selectedUnit}
                      onUnit={()=>selectedUnit && openUnit(selectedUnit.id)}
                      defaultModel={state?.settings.textModel || "gemini-3.8-flash"}
                      contextRevision={project?.contextRevision || 0}
                      stateJobs={state?.jobs || []}
                      onSplitApplied={async(id,isCurrent)=>{await refresh();if(isCurrent()&&chapterRef.current===chapter.id)locate(id);}}
                    />
      ) : <div className="inspector-scroll">
        <div className="inspector-section">
          <h3>当前章节</h3>
          <p>{chapter.title}</p>
          <p className="hint">{chapter.source.length} 字原文 · {segments.length} 条片段</p>
        </div>
        <div className="inspector-section">
          <h3>制作方式</h3><p>逐句纯人声</p>
          <p className="hint">选择片段后，在这里调整角色、声音与表演。</p>
        </div>
      </div>}
    </div>
    <div className="panel-content" hidden={panelMode !== "analysis"}>
      <AnalysisDialog key={chapter.id} contextRevision={project?.contextRevision || 0}
        defaultModel={state?.settings.textModel || "gemini-3.8-flash"}
        chapter={chapter} roles={roles} selected={checked} refresh={refresh} onLocate={locate} onIssues={()=>setModal("issues")} stateJobs={state?.jobs||[]}/>
    </div>
  </>;
  return (
    <ErrorContext.Provider value={{ message: error, dismiss: () => setError("") }}>
      <div className={"app-shell density-"+density} style={{"--reading-size":readingSize+"px"} as React.CSSProperties}>
        <aside className="sidebar">{nav}</aside>
        <main className="workspace">
          <header className="topbar">
            <div className="breadcrumb">
              <button
                className="icon menu-toggle"
                aria-label="打开目录"
                onClick={() => setNavOpen(true)}
              >
                <Menu size={19} />
              </button>
              <FolderOpen size={15} />
              <span>{project?.name || "我的工作区"}</span>
              <ChevronRight size={13} />
              <strong>{chapter?.title || "开始制作"}</strong>
            </div>
            <div className="topbar-actions">
              <span className="local-save">
                <Check size={13} />
                {saveStatus === "saved" ? "已保存" : saveStatus === "saving" ? "保存中…" : saveStatus === "conflict" ? "保存冲突" : saveStatus === "local" ? "本机暂存" : "本地工作区"}
              </span>
              <button
                className="button small"
                onClick={() => setModal("tasks")}
              >
                <AudioLines size={14} />
                <span className="desktop-label">任务</span>
              </button>
              <button className="icon" aria-label="使用帮助" onClick={()=>setModal("help")}><BookOpen size={17}/></button>
              <button
                className="button small"
                disabled={!chapter || locked}
                onClick={() => setModal("export")}
              >
                <Download size={14} />
                导出
              </button>
            </div>
          </header>
          {notice && <div className="notice-banner" role="status"><Check size={16}/><span>{notice}</span><button className="icon" aria-label="关闭提示" onClick={() => setNotice("")}><X size={16}/></button></div>}
          <ErrorBanner />
          {loading ? (
            <div className="loading-layout" aria-label="正在读取工作区" aria-busy="true">
              <div className="loading-heading" aria-hidden="true"><div className="skeleton"/><div className="skeleton"/></div>
              <div className="loading-body" aria-hidden="true">
                <div className="loading-rows">{[0, 1, 2, 3].map(i => <div className="loading-row" key={i}><div className="skeleton"/><div className="skeleton"/></div>)}</div>
                <div className="inspector loading-inspector"><div className="skeleton"/><div className="skeleton"/><div className="skeleton"/></div>
              </div>
            </div>
          ) : !chapter ? (
            <Empty
              className="welcome-empty"
              icon={<BookOpen size={32} />}
              heading={project ? "让文字开始有声" : "从一个故事开始"}
              action={
                <>
                  <button className="button" onClick={playDemo}><Play size={16}/>免费试听演示</button>
                  <button
                    className="button primary"
                    onClick={() => setModal(project ? "chapter" : "project")}
                  >
                    <Plus size={16} />
                    {project ? "导入第一章" : "新建项目"}
                  </button>
                  {!project && (
                    <span className="subtle">项目和音频保存在本机</span>
                  )}
                </>
              }
            >
              按章整理文本，为角色选择声音，逐条试听与打磨。
            </Empty>
          ) : (
            <>
              <section className="chapter-heading">
                <div><button className="title-button" title={chapter.title} onClick={()=>setModal("rename")} disabled={locked}><h1>{chapter.title}</h1><MoreHorizontal size={18}/></button><p>{total} 句台词 · {chapter.playbackItems.length} 个声音单元 · {ready} 句声音就绪 · {passed} 句听评通过 <progress max={total||1} value={ready} aria-label="声音准备进度"/></p></div>
                <div className="chapter-actions">
                  <button className="button" onClick={()=>setModal("issues")}>{issues.length?`查看问题 · ${issues.length} 项`:"查看问题"}</button>
                  {!locked&&<button className="button primary" disabled={busy||!connectionReady} onClick={()=>{
                    if(saveStatus==='conflict'||saveStatus==='unreliable'){setModal('recovery');return;}
                    if(!segments.length||criticalIssues.length){if(!segments.length){setPanelMode('analysis');if(window.innerWidth<1216)setInspectorOpen(true);}else setModal('issues');return;}
                    if(ready<total){void run(()=>generate(segments.filter(s=>!s.excluded&&effectiveStatus(s).validity!=='matched').map(s=>s.id),true));return;}
                    if(chapter.playbackItems.some(item=>item.review==='rework')){void run(()=>generate(chapter.playbackItems.filter(item=>item.review==='rework').flatMap(item=>item.members||[item.id]),false,{actionKind:'redoRejected'}));return;}
                    if(passed<total){void playChapter();return;}
                    setModal('export');
                  }}>{saveStatus==='conflict'?'处理保存冲突':!segments.length?'AI准备剧本':criticalIssues.length?`需要你处理 · ${criticalIssues.length} 项`:ready<total?'生成待办':chapter.playbackItems.some(item=>item.review==='rework')?'重做否决项':passed<total?'整章试听':'导出成品'}</button>}
                </div>
              <nav className="production-steps" aria-label="章节制作步骤">
                <button onClick={()=>setModal('chapter')}><span>1</span>导入文字</button>
                <button className={panelMode==='analysis'?'active':''} onClick={()=>{setPanelMode('analysis');if(window.innerWidth<1216)setInspectorOpen(true);}}><span>2</span>AI准备</button>
                <button className={panelMode==='settings'?'active':''} onClick={()=>{setPanelMode('settings');setInspectorOpen(false);}}><span>3</span>试听与修改</button>
                <button onClick={()=>setModal('export')}><span>4</span>导出成品</button>
              </nav>
              {locked && (
                <div className="task-banner" role="status">
                  <AudioLines size={17} />
                  <div>
                    <strong>
                      {["generate","unit-generate"].includes(job.kind)
                        ? "正在生成配音"
                        : job.kind === "master"
                          ? chapter.coverage.valid ? "正在准备整章试听" : "正在准备当前剧本试听"
                          : "正在导出成品"}
                    </strong>
                    <span>
                      已成功 {job.done} / {job.total} · 失败 {job.failed || 0} · 已耗时 {time(job.elapsedSeconds || 0)}
                      {job.currentSegmentId && ` · 当前第 ${(segments.find(s => s.id === job.currentSegmentId)?.order ?? 0) + 1} 条`}
                      · 本章暂时只读，可前往其他章节
                    </span>
                  </div>
                  {job.kind === "master" && pendingPlay.current && <button className="text-button" onClick={()=>{playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;setNotice("已取消准备完成后自动播放，试听文件仍会保留。");}}>取消自动播放</button>}
                  <button
                    className="button small"
                    disabled={job.stop || !["generate","unit-generate"].includes(job.kind)}
                    onClick={() =>
                      run(() => mutate("job.stop", { id: job.id }))
                    }
                  >
                    {job.stop ? "正在停止后续" : "停止后续"}
                  </button>
                </div>
              )}
              </section>
              <div className="editor-layout">
                <section className="script-panel">
                  <div className="script-tools">
                    <div className="tabs" aria-label="片段筛选">
                      {[
                        ["all", "全部"],
                        ["confirm", "待确认"],
                        ["generate", "待生成"],
                        ["failed", "失败"],
                        ["pending", "待检查"],
                        ["rework", "需返工"],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          className={filter === id ? "active" : ""}
                          aria-pressed={filter === id}
                          onClick={() => setFilter(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <div className="search-field">
                      <Search size={14} />
                      <input
                        aria-label="搜索台词或角色"
                        placeholder="搜索台词"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    </div>
                  </div>
                  <div className="creation-tools" role="group" aria-label="创作与显示">
                    <button className="button small" disabled={locked||state?.settings.features?.groups===false} onClick={()=>{if(checked.length<2){setNotice("勾选两条或更多连续对白，再点一起演绎。");return;}openUnit("create");}}><Users size={15}/>一起演绎</button>
                    <button className="button small" disabled={locked||!selectedUnit||state?.settings.features?.scenes===false} onClick={()=>selectedUnit&&openUnit(selectedUnit.id,"scene")}><AudioLines size={15}/>声音背景</button>
                    <button className="button secondary small" onClick={()=>openUnit("list")}>历史与版本</button>
                    <details className="workspace-more"><summary>更多</summary><div><button onClick={()=>setModal("source")}>查看原文</button><button onClick={()=>setModal("manual")}>添加台词</button><button onClick={()=>setModal("roles")}>角色资料</button><button onClick={()=>{const value=density==="compact"?"comfortable":"compact";setDensity(value);localStorage.setItem("reading-density",value);}}>切换{density==="compact"?"舒适":"紧凑"}密度</button><label>正文字号<input aria-label="正文字号" type="range" min="17" max="34" value={readingSize} onChange={e=>{setReadingSize(Number(e.target.value));localStorage.setItem("reading-size",e.target.value);}}/></label></div></details>
                  </div>
                  {checked.length > 0 && (
                    <div className="selection-bar" role="group" aria-label="所选片段操作">
                      <span>已选 {checked.length} 条</span>
                      <button className="text-button" disabled={locked || checked.length < 2 || state?.settings.features?.groups === false} onClick={()=>openUnit("create")}>一起演绎</button>
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => setRebindOpen(true)}
                      >
                        <Users size={14} aria-hidden="true" />改绑角色
                      </button>
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() => run(() => generate(checked))}
                      >
                        <AudioLines size={14} aria-hidden="true" />生成所选
                      </button>
                      <button
                        className="text-button"
                        disabled={locked}
                        onClick={() =>
                          run(() => mutate("segment.confirm", { ids: checked }))
                        }
                      >
                        <CheckCheck size={14} aria-hidden="true" />确认归属
                      </button>
                      <button
                        className="icon"
                        aria-label="清空选择"
                        onClick={() => setChecked([])}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  )}

                  {!!chapter.arrangementIssues?.length && <p className="error-inline" role="alert">当前编排需修复：{chapter.arrangementIssues.join("；")}。请打开对戏组与声音版本处理后，再准备整章试听或导出。</p>}
                  <div className="script-column-head">
                    <input
                      aria-label="选择可见片段"
                      type="checkbox"
                      checked={
                        visible.length > 0 &&
                        visible.every((s) => checked.includes(s.id))
                      }
                      onChange={(e) =>
                        setChecked(
                          e.target.checked
                            ? visible
                                .filter((s) => !s.excluded)
                                .map((s) => s.id)
                            : [],
                        )
                      }
                    />
                    <span>角色 / 朗读正文</span>
                    <span>音频状态</span>
                  </div>
                  <div
                    className="script-list"
                    data-unit-members={currentMembers.join(",")}
                    ref={listRef}
                    onWheel={() => setFollow(false)}
                    onTouchMove={() => setFollow(false)}
                    onPointerDown={(e) => { if (e.target === e.currentTarget) setFollow(false); }}
                    onKeyDown={(e) => { if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) setFollow(false); }}
                  >
                    {visible.map((s) => {
                      const role = roles.find((r) => r.id === s.roleId),
                        voice = voices.find((v) => v.id === s.voiceId);
                      const grouped = chapter.units?.find(u=>u.kind === "group" && u.state === "active" && u.members.includes(s.id));
                      const rowUnit = grouped || chapter.units?.find(u=>u.kind === "single" && u.state === "active" && u.id === s.id);
                      const rowAudio = rowUnit?.variants[rowUnit.mode].current || s.current;
                      const rowStatus = effectiveStatus(s);
                      const groupOrders = grouped?.members.map(id=>(segments.find(item=>item.id===id)?.order??0)+1)||[];
                      const groupRange = groupOrders.length>1?`${groupOrders[0]}—${groupOrders.at(-1)}`:String(groupOrders[0]||"");
                      return (
                        <article
                          id={"segment-" + s.id}
                          data-group-playing={currentMembers.includes(s.id)}
                          key={s.id}
                          data-group-id={grouped?.id || ""}
                          className={`script-row ${selected === s.id ? "selected" : ""} ${currentSegment === s.id ? "playing" : ""} ${s.excluded ? "excluded" : ""}`}
                        >
                          {grouped && visible.find(item=>grouped.members.includes(item.id))?.id === s.id && <div className="group-strip">
                            <div><strong>第 {groupRange} 句一起演绎</strong><span>{grouped.mode === "scene"?"有声音背景":"纯人声"} · 重做会影响这 {grouped.members.length} 句</span></div>
                            <div className="group-actions">
                              <button className="text-button" disabled={!connectionReady||!rowAudio||rowStatus.validity==="broken"||locked} onClick={()=>{setCurrentMembers(grouped.members);setCurrentSegment(grouped.members[0]);void startPlay("audios",rowAudio!,`第 ${groupRange} 句一起演绎`,undefined,false,{id:grouped.id,mode:grouped.mode,audioId:rowAudio!,basis:grouped.variants[grouped.mode].status.basis,state:grouped.state});}}><Play size={14}/>试听整段{rowStatus.validity==="stale"?"旧声音":""}</button>
                              <button className="text-button" onClick={()=>openUnit(grouped.id)}>调整这段</button>
                              <button className="text-button" disabled={locked||busy} onClick={()=>void run(()=>generate(grouped.members,false,{regenerate:true}))}>重做这 {grouped.members.length} 句</button>
                            </div>
                          </div>}
                          <div className="row-gutter">
                            <input
                              type="checkbox"
                              aria-label={`选择第 ${s.order + 1} 条`}
                              checked={checked.includes(s.id)}
                              onChange={(e) =>
                                setChecked((prev) =>
                                  e.target.checked
                                    ? [...prev, s.id]
                                    : prev.filter((id) => id !== s.id),
                                )
                              }
                            />
                            <span>{String(s.order + 1).padStart(2, "0")}</span>
                          </div>
                          <button
                            className="row-content"
                            onClick={() => {
                              setSelected(s.id);
                              setPanelMode("settings");
                              if (window.innerWidth < 1216) {
                                setInspectorOpen(true);
                              }
                            }}
                          >
                            <span className="row-meta">
                              <span
                                className={`avatar ${role?.narrator ? "narrator" : ""}`}
                              >
                                {role?.name[0] || "?"}
                              </span>
                              <strong>{role?.name || "未分配"}</strong>
                              <span className="voice-caption">
                                {voice?.name || "未绑定音色"}
                                {s.voiceSource === "override"
                                  ? " · 本条指定"
                                  : ""}
                              </span>
                              {!configurationDecided(s) && (
                                <span className="needs-confirm">待确认</span>
                              )}
                            </span>
                            <span className="spoken-text">{s.text}</span>
                            {s.performance && (
                              <span className="performance">
                                <SlidersHorizontal size={12} />
                                {s.performance}
                              </span>
                            )}
                          </button>
                          <div className="row-trailing">
                            {s.excluded ? (
                              <Status>已排除</Status>
                            ) : (
                              <>
                                <Status
                                  kind={
                                    rowStatus.review === "passed"
                                      ? "success"
                                      : rowStatus.validity !== "matched"
                                        ? "neutral"
                                        : rowStatus.review === "rework"
                                          ? "warning"
                                          : ""
                                  }
                                >
                                  {rowStatus.validity === "matched"
                                    ? names[rowStatus.review || "pending"]
                                    : names[rowStatus.validity]}
                                </Status>
                                <span className="attempt-state">{[
                                  "failed",
                                  "unknown",
                                  "running",
                                  "queued",
                                ].includes(rowStatus.latest) ? names[rowStatus.latest] : ""}</span>
                                <div className="row-actions">
                                  <button className="icon" aria-label={`为第 ${s.order+1} 条选声音`} onClick={()=>openVoice(s.roleId,s.id)}><Users size={15}/></button>
                                  {!grouped&&<><button
                                    className="icon"
                                    aria-label={`试听第 ${s.order + 1} 条${rowStatus.validity === "stale" ? "旧版" : ""}`}
                                    disabled={!connectionReady || !rowAudio || rowStatus.validity === "broken" || locked}
                                    onClick={() => {
                                      if(rowUnit && (rowUnit.kind === "group" || rowUnit.mode === "scene")) {
                                        const audioId=rowUnit.variants[rowUnit.mode].current;
                                        if(audioId){setCurrentMembers(rowUnit.kind === "group" ? rowUnit.members : []);setCurrentSegment(rowUnit.members[0]);void startPlay("audios",audioId,(rowUnit.kind === "group" ? "对戏组 · " + rowUnit.members.length + " 条" : "单条") + (rowUnit.mode === "scene" ? " · 场景版本" : " · 干声版本"),undefined,false,{id:rowUnit.id,mode:rowUnit.mode,audioId,basis:rowUnit.variants[rowUnit.mode].status.basis,state:rowUnit.state});}
                                        return;
                                      }
                                      setCurrentMembers([]);
                                      setCurrentSegment(s.id);
                                      // A spot-check must not replace an existing chapter resume point.
                                      bookmarks.current[chapterId] ??= s.id;
                                      if (s.validity !== "matched")
                                        setOldPreview(s);
                                      startPlay(
                                        "audios",
                                        s.current!,
                                        `${role?.name} · 第 ${s.order + 1} 条${s.validity !== "matched" ? "（旧版）" : ""}`,
                                      );
                                    }}
                                  >
                                    <Play size={14} />
                                  </button>
                                  <button className="icon" aria-label={`重新生成第 ${s.order + 1} 条`} title="保存有效修改后，只重做受影响声音" disabled={locked || busy} onClick={()=>void run(()=>generate([s.id],false,{regenerate:true}))}><RefreshCw size={14}/></button>
                                  <button
                                    className="icon"
                                    aria-label={`检查通过第 ${s.order + 1} 条`}
                                    disabled={
                                      !connectionReady || rowStatus.validity !== "matched" || locked
                                    }
                                    onClick={() =>
                                      run(() =>
                                        mutate("segment.review", {
                                          id: s.id,
                                          audioId: s.current,
                                          basis: basis(s),
                                          state: "passed",
                                        }),
                                      )
                                    }
                                  >
                                    <Check size={16} />
                                  </button></>}
                                </div>
                              </>
                            )}
                          </div>
                        </article>
                      );
                    })}
                    {!visible.length && (
                      <Empty
                        icon={<FileText size={28} />}
                        heading={
                          segments.length
                            ? "没有符合条件的片段"
                            : "本章还没有朗读片段"
                        }
                        action={
                          <button
                            className="button"
                            onClick={() =>
                              segments.length
                                ? (setSearch(""), setFilter("all"))
                                : setModal("manual")
                            }
                          >
                            {segments.length ? "查看全部" : "添加片段"}
                          </button>
                        }
                      >
                        {segments.length
                          ? "换一个筛选条件，或搜索其他台词。"
                          : "添加手工片段，开始配置声音。"}
                      </Empty>
                    )}
                  </div>
                  <div className="script-footer">
                    <span>
                      {visible.length} / {segments.length} 条
                    </span>
                    <span>有效修改自动保存 · 正文 {readingSize}px</span>
                  </div>
                </section>
                <aside className={`inspector ${panelMode === "analysis" ? "analysis-active" : ""}`}>
                  {!inspectorOpen && inspector}
                </aside>
              </div>
            </>
          )}
          <footer className="player">
            <div className="player-title">
              <div className="player-symbol">
                <Headphones size={19} />
              </div>
              <div>
                <strong>{player?.title || (chapter && !chapter.coverage.valid ? "当前剧本试听" : "整章试听")}</strong>
                <span>
                  {player
                    ? player.kind === "masters"
                      ? `${chapter?.coverage.valid ? "与导出共用同一母版" : "当前剧本试听，内容尚未完整"}${transitioning ? " · 片段间过渡" : ""}`
                      : player.kind === "voices"
                        ? "参考声音"
                        : "声音试听"
                    : `${ready} / ${total} 条音频就绪`}
                </span>
              </div>
            </div>
            <div className="transport">
              <button
                className="icon"
                aria-label="后退五秒"
                disabled={!player}
                onClick={() => {
                  if (audio.current)
                    audio.current.currentTime = Math.max(
                      0,
                      audio.current.currentTime - 5,
                    );
                }}
              >
                <SkipBack size={17} />
              </button>
              <button
                className="play-button"
                aria-label={playing ? "暂停" : "播放"}
                disabled={
                  !connectionReady || busy || locked || (!player && (!total || ready !== total))
                }
                onClick={() =>
                  player
                    ? playing
                      ? (()=>{playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;audio.current?.pause();})()
                      : void startPlay(player.kind, player.id, player.title, undefined, !player.chapterId)
                    : void playChapter()
                }
              >
                {playing ? <Pause size={20} /> : <Play size={20} />}
              </button>
              <button
                className="icon"
                aria-label="前进五秒"
                disabled={!player}
                onClick={() => {
                  if (audio.current)
                    audio.current.currentTime = Math.min(
                      duration,
                      audio.current.currentTime + 5,
                    );
                }}
              >
                <SkipForward size={17} />
              </button>
            </div>
            <div className="timeline">
              <input
                type="range"
                aria-label="播放进度"
                min={0}
                max={duration || 1}
                step={0.01}
                value={position}
                disabled={!player || !duration}
                onChange={(e) => {
                  if (audio.current)
                    audio.current.currentTime = Number(e.target.value);
                  setPosition(Number(e.target.value));
                }}
              />
              <div>
                <span>{time(position)}</span>
                <span>{time(duration)}</span>
              </div>
            </div>
            <div className="player-options">
              <button
                className="button small"
                disabled={!connectionReady || !total || ready !== total || locked}
                onClick={() => void playChapter()}
              >
                <AudioLines size={14} />
                {chapter?.masters.some(
                  (m) => m.arrangement === chapter.arrangement,
                )
                  ? chapter.coverage.valid ? "整章试听" : "当前剧本试听"
                  : "准备试听"}
              </button>
              <button
                className={`button secondary small ${follow ? "is-active" : ""}`}
                aria-label={currentHidden ? "当前播放被筛选隐藏，回到当前播放" : follow ? "暂停跟随播放" : "回到当前播放"}
                aria-pressed={follow}
                title={follow && !currentHidden ? "正在跟随播放；点击或手动滚动可暂停跟随" : "回到正在播放的台词，并恢复自动跟随"}
                disabled={!currentSegment}
                onClick={() => {
                  if (follow && !currentHidden) { setFollow(false); return; }
                  setSearch("");
                  setFilter("all");
                  setFollow(true);
                }}
              >
                <Link2 size={17} />{follow && !currentHidden ? "跟随播放" : "回到当前播放"}
              </button>
              <Volume2 size={17} />
            </div>
          </footer>
        </main>
      </div>
      <audio
        ref={audio}
        onPlay={() => {if(player?.intent===playIntent.current)setPlaying(true);}}
        onPause={() => setPlaying(false)}
        onEnded={() => { setPlaying(false); setTransitioning(false); }}
        onError={() => {
          if(player?.intent!==playIntent.current)return;
          playIntent.current++;
          pendingPlay.current=null;pendingPlaySnapshot.current=null;
          setPlaying(false);setPlayer(null);
          setError(player?.master ? "整章试听文件无法播放，请检查已有音频后点击“准备试听”重建本机母版。" : "音频无法播放，文件可能缺失或格式不受支持。请检查文件后再次试听。");
        }}
        onLoadedMetadata={() => {
          if(player?.intent!==playIntent.current)return;
          if (player?.resumeAt) audio.current!.currentTime = player.resumeAt;
          setDuration(
            Number.isFinite(audio.current!.duration)
              ? audio.current!.duration
              : 0,
          );
        }}
        onTimeUpdate={() => {
          if (!player||player.intent!==playIntent.current) return;
          const t = audio.current!.currentTime;
          setPosition(t);
          if (player?.master) {
            const m = player.master;
            const current = m.mapping.find(
              (x, i) =>
                t >= x.startFrame / m.sampleRate &&
                (i === m.mapping.length - 1 ||
                  t < m.mapping[i + 1].startFrame / m.sampleRate),
            );
            if (current) {
              setCurrentSegment(current.memberIds?.[0] || current.segmentId || "");
              setCurrentMembers(current.memberIds && current.memberIds.length > 1 ? current.memberIds : []);
              setTransitioning(t >= current.endFrame / m.sampleRate && current !== m.mapping.at(-1));
              if (player.chapterId)
                bookmarks.current[player.chapterId] = (t >= current.endFrame / m.sampleRate ? m.mapping.find(x => x.startFrame > current.endFrame)?.unitId || m.mapping.find(x => x.startFrame > current.endFrame)?.segmentId : current.unitId || current.segmentId) || current.memberIds?.[0] || current.segmentId || "";
            }
          }
        }}
      />
      {unitPanelId === "create" && chapter && <CreateGroup chapter={chapter} ids={checked} roles={roles} enabled={!locked && state?.settings.features?.groups !== false} state={state||undefined} refresh={refresh} close={()=>setUnitPanelId(null)} open={openMember} created={(unit,warning)=>{
        if(chapterRef.current !== unit.chapterId)return;
        setChapter(c=>c && c.id === unit.chapterId ? {...c,revision:unit.chapterRevision || c.revision,units:[...(c.units || []).filter(u=>u.id !== unit.id),unit]} : c);
        setUnitPanelId(unit.id);
        if(warning)setError(warning);
      }}/>}
      {unitPanelId === "list" && chapter && <Dialog title="对戏组与声音版本" onClose={()=>setUnitPanelId(null)} wide>
        <p className="hint">组级操作覆盖全部成员。场景版本按单元管理，切换已有版本仅做本地处理。</p>
        {(chapter.units || []).map(unit=><button className="nav-item" key={unit.id} onClick={()=>setUnitPanelId(unit.id)}>
          {unit.kind === "group" ? "对戏组" : "单条"} · {unit.members.some(id=>!chapter.segments.some(s=>s.id === id)) ? "成员记录缺失" : "第 " + unit.members.map(id=>chapter.segments.find(s=>s.id === id)!.order+1).join("、") + " 条"} · {unit.state === "pending" ? "待生成，未启用" : unit.state === "dissolved" ? "已解除 · 历史保留" : "已启用"} · {unit.mode === "scene" ? "场景" : "干声"}{!!unit.diagnostics?.length && " · 需修复"}
        </button>)}
      </Dialog>}
      {unitPanelId && chapter && state && chapter.units?.find(u=>u.id === unitPanelId) && <UnitPanel key={unitPanelId} unit={chapter.units.find(u=>u.id === unitPanelId)!}
        playingId={playing&&player?.kind==='audios'?player.id:undefined}
        initialMode={unitInitialMode} initialEventId={unitInitialEvent} chapter={chapter} roles={roles} state={state} locked={locked} connected={connectionReady} refresh={refresh} close={()=>setUnitPanelId(null)} open={openMember}
        onTask={async(jobId,attemptId)=>{
          const expectedChapter=chapter.id,expectedUnit=unitPanelId;
          const attempts=await api<{id:string;status:string;mode?:string;error?:string}[]>("/attempts/"+jobId);
          if(chapterRef.current!==expectedChapter||unitPanelRef.current!==expectedUnit)return;
          const attempt=attempts.find(item=>item.id===attemptId);
          if(!attempt)throw new Error("这次记录尚未找到，请刷新任务记录。");
          await refresh();if(chapterRef.current!==expectedChapter||unitPanelRef.current!==expectedUnit)return;
          setTaskRecord({jobId,attempt});setUnitPanelId(null);setModal("tasks");
        }}
        play={(id,title,historical)=>{const unit=chapter.units!.find(u=>u.id === unitPanelId)!;const mode=unit.variants.scene.current === id ? "scene" : "dry";setCurrentMembers(unit.kind === "group" && !historical ? unit.members : []);
          void startPlay("audios",id,title,undefined,!!historical,historical ? undefined : {id:unit.id,mode,audioId:id,basis:unit.variants[mode].status.basis,state:unit.state});}}/>}
      {generationPlan && chapter && <GeneratePlan plan={generationPlan.plan} chapter={chapter} model={state?.settings.model} grantId={grantId} unknown={generationUnknown} routeBlocked={!!state?.settings.routeBlocked} retryUnknown={generationPlan.retryUnknown} resumeRoute={generationPlan.resumeRoute} busy={busy}
        onGrant={id=>{if(generationIntent.current===planIntent)setGrantId(id);}} onRetryUnknown={value=>{if(generationIntent.current===planIntent)setGenerationPlan(current=>current?{...current,retryUnknown:value}:null);}} onResumeRoute={value=>{if(generationIntent.current===planIntent)setGenerationPlan(current=>current?{...current,resumeRoute:value}:null);}} onGenerate={submitGeneration} onClose={closeGeneration} onEdit={id=>{closeGeneration();locate(id);}} onRecheck={async()=>{
          const request=generationPlan;
          const intent=++generationIntent.current;
          const current=()=>generationIntent.current===intent&&chapterRef.current===request.plan.chapterId;
          try{
          const fresh=await api<ChapterDetail>("/chapters/"+request.plan.chapterId);
          if(!current())return;
          setChapter(fresh);await refresh();
          if(!current())return;
          await generate(request.ids,false,{regenerate:request.regenerate,actionKind:request.plan.actionKind},fresh,intent);
          }catch(error){if(current())throw error;}
        }}/>}
      {navOpen && (
        <Dialog title="项目与章节" onClose={() => setNavOpen(false)}>
          <div className="mobile-nav">{nav}</div>
        </Dialog>
      )}
      {inspectorOpen && chapter && (
        <div className="mobile-inspector">
          <Dialog title="章节工作面板" onClose={() => setInspectorOpen(false)}>
            {inspector}
          </Dialog>
        </div>
      )}
      {modal === "project" && (
        <Dialog title="新建配音项目" onClose={() => setModal(null)}>
          <Form
            label="创建项目"
            onSubmit={async (f) => {
              const p = await action<Project>("project.create", {
                name: f.get("name"),
              });
              projectRef.current = p.id;
              setProjectId(p.id);
              chapterRef.current = "";
              closeGeneration();setChapterId("");
              setChapter(null);
              await refresh();
              setModal(null);
            }}
          >
            <Field label="项目名称">
              <input
                name="name"
                autoFocus
                placeholder="例如：不要乱碰瓷"
                maxLength={100}
              />
            </Field>
            <p className="hint">
              角色档案在项目内跨章节复用，参考音色可供所有项目使用。
            </p>
          </Form>
        </Dialog>
      )}
      {modal === "project-rename" && project && (
        <RenameProject project={project} save={mutate} onClose={() => setModal(null)} />
      )}
      {modal === "chapter" && (
        <ImportChapter
          key={draftWorkspace()+"/"+projectId}
          projectId={projectId}
          onClose={() => setModal(null)}
          onCreated={async (id,prepare) => {
            if(projectRef.current!==projectId)return false;
            const workspaceIdentity=draftWorkspace();
            pickChapter(id);
            setModal(null);
            setPanelMode(prepare ? "analysis" : "settings");
            if(prepare&&window.innerWidth<1216)setInspectorOpen(true);
            await refresh();
            if(projectRef.current!==projectId||draftWorkspace()!==workspaceIdentity)return false;
            if(prepare)setNotice("原文已导入。选择AI协作方式和本章文本授权后，开始准备。");
            return true;
          }}
        />
      )}
      {modal === "manual" && chapter && (
        <Dialog title="添加手工片段" onClose={() => setModal(null)}>
          <Form
            label="保存片段"
            revision={chapter.revision}
            onSubmit={async (f, revision) => {
              await mutate("segment.create", { text: f.get("text"), revision });
              setModal(null);
            }}
          >
            <Field label="朗读正文">
              <textarea
                name="text"
                autoFocus
                placeholder="输入要朗读的文字"
                rows={7}
              />
            </Field>
            <p className="hint">
              先使用旁白角色；保存后可调整角色、音色和表演。
            </p>
          </Form>
        </Dialog>
      )}
      {modal === "source" && chapter && (
        <Dialog title="章节原文" onClose={() => setModal(null)} wide>
          <div className="source-summary">
            <Status kind={chapter.coverage.valid ? "success" : "warning"}>
              {chapter.coverage.valid
                ? "原文覆盖完整"
                : `未覆盖 ${chapter.coverage.gaps} 字 · 重复 ${chapter.coverage.overlaps} 字`}
            </Status>
            <span>原文保持不变</span>
          </div>
          <pre className="source-text">
            {chapter.source || "本章由手工片段组成，没有导入原文。"}
          </pre>
        </Dialog>
      )}
      {modal === "rename" && chapter && (
        <Dialog title="章节设置" onClose={() => setModal(null)}>
          <Form
            label="保存设置"
            revision={chapter.revision}
            onSubmit={async (f, revision) => {
              await mutate("chapter.update", { title: f.get("title"), revision });
              setModal(null);
            }}
          >
            <Field label="章节名称">
              <input name="title" defaultValue={chapter.title} />
            </Field>
          </Form>
          <div className="section-rule">
            <h3>叙事顺序</h3>
            <div className="button-row">
              <button
                className="button"
                onClick={() =>
                  run(async () => { await mutate("chapter.move", { direction: -1 }); setNotice("叙事顺序已更新，请复核各章可知的角色资料；既有音频未重做。"); })
                }
              >
                <ArrowUp size={14} />
                前移一章
              </button>
              <button
                className="button"
                onClick={() =>
                  run(async () => { await mutate("chapter.move", { direction: 1 }); setNotice("叙事顺序已更新，请复核各章可知的角色资料；既有音频未重做。"); })
                }
              >
                <ArrowDown size={14} />
                后移一章
              </button>
            </div>
          </div>
        </Dialog>
      )}
      {rebindOpen && chapter && (
        <RebindDialog
          revision={chapter.revision}
          roleVoices={chapter.roleVoices}
          rows={chapter.segments.filter((s) => checked.includes(s.id))}
          roles={roles}
          voices={voices}
          onClose={() => setRebindOpen(false)}
          onSave={async (roleId, revision) => {
            await mutate("segment.rebind", { ids: checked, roleId, revision });
            setRebindOpen(false);
          }}
        />
      )}
      {oldPreview && (
        <Dialog title="旧音频试听正文" onClose={closeOldPreview}>
          <p className="hint">
            正在试听旧音频。下面是这版音频生成时使用的正文，与当前编辑可能不同。
          </p>
          <p className="original-excerpt">{oldPreview.audio?.input.text}</p>
          <button
            className="button"
            onClick={closeOldPreview}
          >
            结束试听并返回
          </button>
        </Dialog>
      )}
      {modal === "voices" && (
        <VoiceLibrary
          voices={voices}
          projectId={projectId}
          model={state?.settings.model}
          initialCreate={voiceLibraryCreate}
          initialSessionId={voiceLibrarySession}
          sessions={state?.voiceSessions || []}
          creationEnabled={state?.settings.features?.voiceCreation !== false}
          configured={!!state?.settings.configured}
          audioTools={!!state?.settings.audioTools}
          onBind={project ? () => setModal("roles") : undefined}
          jobs={state?.jobs || []}
          playingId={playing ? player?.id : undefined}
          routeBlocked={state?.settings.routeBlocked || false}
          onClose={() => setModal(null)}
          onRefresh={refresh}
          play={(v) => startPlay("voices", v.id, v.name)}
          playSample={(v) =>
            startPlay(
              "audios",
              v.sampleAudioId!,
              `${v.name} · 测试样音`,
              undefined,
              true,
            )
          }
        />
      )}
      {modal === "roles" && state && (
        <Roles
          roles={roles}
          voices={voices}
          projectId={projectId}
          chapter={chapter}
          chapters={state.chapters.filter(c => c.projectId === projectId)}
          locked={locked}
          onClose={() => setModal(null)}
          save={mutate}
          onVoice={id=>openVoice(id)}
        />
      )}
      {modal === "overview" && state && <ProjectOverview state={state} projectId={projectId} onClose={()=>setModal(null)} onPick={id=>{setModal(null);pickChapter(id);}} onImport={()=>setModal(projectId?'chapter':'project')} onHelp={()=>setModal('help')}/>}
      {modal === "issues" && chapter && <IssueCenter chapter={chapter} roles={roles} voices={voices} onClose={()=>setModal(null)} onLocate={locate} onVoice={id=>openVoice(id)} onSource={()=>setModal('source')} onUnit={(id,mode)=>openUnit(id,mode)} onTasks={()=>setModal('tasks')} onAI={()=>{setModal(null);setPanelMode('analysis');if(window.innerWidth<1216)setInspectorOpen(true);}} onConfirm={async ids=>{await withSavedDrafts('chapter:'+chapter.id,ids.map(id=>'segment:'+id),async()=>{await mutate('segment.confirm',{ids,roleOnly:true,revision:draftScopeRevision('chapter:'+chapter.id,chapter.revision)});});}}/>}
      {modal === "recovery" && state && <RecoveryCenter state={state} chapter={chapter} onClose={()=>setModal(null)} onRecovered={(_id,target)=>{setModal(null);recoveryTarget.current=target;setDraftSignal(n=>n+1);const targetChapter=target.chapterId || (target.projectId&&target.projectId!==projectId?state.chapters.filter(c=>c.projectId===target.projectId).sort((a,b)=>b.order-a.order)[0]?.id:undefined);if(targetChapter&&targetChapter!==chapterId){recoveryTarget.current={...target,chapterId:targetChapter};pickChapter(targetChapter);}else setDraftSignal(n=>n+1);}}/>}
      {modal === "help" && <QuickHelp configured={!!state?.settings.configured} onClose={()=>setModal(null)} onDemo={playDemo} onImport={()=>setModal(projectId?'chapter':'project')}/>}
      {voiceTarget && chapter && state && <VoicePicker key={chapter.id+':'+voiceTarget.roleId+':'+voiceTarget.segmentId} state={state} chapter={chapter} roles={roles} initialTarget={voiceTarget} onClose={()=>setVoiceTarget(null)} onRefresh={refresh} playingId={playing?player?.id:undefined} play={(kind,id,title)=>void startPlay(kind,id,title,undefined,true)} onUsed={()=>{setVoiceTarget(null);setNotice('声音已应用，返回原处继续制作。');}}/>}
      {modal === "settings" && state && (
        <Dialog title="设置与连接" onClose={() => setModal(null)}>
          <div className="settings-status">
            <span className="brand-mark">
              <AudioLines size={22} />
            </span>
            <div>
              <h3>Seed Audio 1.0</h3>
              <Status kind={state.settings.configured ? "success" : "warning"}>
                {state.settings.configured
                  ? "密钥已在服务端配置"
                  : "尚未配置密钥"}
              </Status>
            </div>
          </div>
          <dl className="details-list">
            <div>
              <dt>当前模型</dt>
              <dd>{state.settings.model}</dd>
            </div>
            <div>
              <dt>音频处理</dt>
              <dd>
                {state.settings.audioTools ? "FFmpeg 已就绪" : "未找到 FFmpeg"}
              </dd>
            </div>
            <div>
              <dt>生成方式</dt>
              <dd>逐条干声 · 48 kHz</dd>
            </div>
          </dl>
          <p className="hint">
            密钥只由本地服务读取。生成会按服务商规则计费；超时结果不明时不会自动重试。
          </p>
          {state.settings.routeBlocked && (
            <p className="error-inline">
              声音接口因权限或额度错误暂停。请核对连接与额度，返回声音生成、创建候选或一起演绎面板，勾选“恢复本次声音请求”后再点击生成；已有授权无需重复添加。
            </p>
          )}
          <WorkspaceLocation directory={state.settings.workspaceDirectory} projectCount={state.projects.length} projectName={state.projects.find(p => p.id === projectId)?.name} projectFolders={state.settings.projectFolders} onMoved={async () => {
            playIntent.current++;pendingPlay.current=null;pendingPlaySnapshot.current=null;
            audio.current?.pause();
            setPlayer(null);
            setPlaying(false);
            await refresh();
          }} />
          <div className="section-rule">
            <h3>增强功能</h3><p className="hint">关闭只停止新建和生成，已有候选、对戏组、场景版本仍可查看、恢复和本地切换。</p>
            {([["voiceCreation","声音创建"],["groups","多人干声对戏 · 实验"],["scenes","场景生成 · 实验"]] as const).map(([key,label])=><label className="check-label" key={key}>
              <input type="checkbox" checked={state?.settings.features?.[key] !== false} disabled={busy} onChange={e=>void run(async()=>{await action("settings.update",{entityRevision:state?.settings.revision,features:{[key]:e.target.checked}});})}/>{label}
            </label>)}
          </div>
          <div className="section-rule">
            <h3>文本分析模型</h3>
            <Form
              successMessage="默认模型已保存；本轮手动指定的模型保持不变。"
              label="保存模型设置"
              revision={state.settings.revision}
              onSubmit={async (f, entityRevision) => {
                const saved = await action<{revision: number}>("settings.update", {
                  entityRevision,
                  textModel: f.get("textModel"),
                  defaultGap: Number(f.get("defaultGap")),
                });
                await refresh();
                return saved.revision;
              }}
            >
              <Field
                label="多模态模型名称"
                hint="填写 Kunpo 支持的完整模型名，作为新分析的默认值；本轮手动指定的模型保留，不会重跑已有任务。"
              >
                <input
                  name="textModel"
                  defaultValue={state.settings.textModel}
                  placeholder="gemini-3.8-flash"
                  maxLength={150}
                />
              </Field>
              <Field
                label="新章节默认间隔（秒）"
                hint="只影响之后创建的章节；当前章节在导出设置中调整。"
              >
                <input
                  name="defaultGap"
                  type="number"
                  min={0}
                  max={10}
                  step={0.1}
                  defaultValue={state.settings.defaultGap}
                />
              </Field>
            </Form>
          </div>
          <div className="section-rule">
            <h3>项目数据</h3>
            <p className="hint">
              关闭网页不会停止后台任务；关闭终端或电脑可能中断工作。终端按 Ctrl+C 会停止后续派发并等待在途任务结束。
              关闭本地服务后备份上方显示的整个工作区目录，包含数据库、参考声音和成品文件。恢复时使用新目录，避免覆盖原数据。
            </p>
          </div>
        </Dialog>
      )}
      {modal === "tasks" && state && (
        <Dialog title="任务记录" onClose={() => {setModal(null);setTaskRecord(null);}} wide>
          {taskRecord&&<section className="task-outcome" tabIndex={-1} ref={taskRecordRef}>
            <h3>这次{taskRecord.attempt.mode==="scene"?"声音背景":"纯人声"}生成记录</h3>
            <p>结果：{names[taskRecord.attempt.status]||taskRecord.attempt.status}。{taskRecord.attempt.status==="unknown"?"可能已计费；查看记录和试听已有声音均不会重新发送。":"已有声音和历史保留。"}</p>
            {taskRecord.attempt.error&&<p className="error-inline">{taskRecord.attempt.error}</p>}
            <p className="hint">请求记录 {taskRecord.attempt.id}</p>
          </section>}
          <div className="task-list">
            {state.jobs.length ? (
              state.jobs.map((j) => (
                <div className={"task-row"+(taskRecord?.jobId===j.id?" selected-task":"")} key={j.id}>
                  <span className="task-icon">
                    <AudioLines size={19} />
                  </span>
                  <div>
                    <strong>
                      {j.kind === "generate"
                        ? "配音生成"
                        : j.kind === "master"
                          ? "准备试听"
                          : j.kind === "voice-test"
                            ? "音色试音"
                            : j.kind === "voice-create"
                              ? "声音创建"
                              : j.kind === "unit-generate"
                                ? j.mode === "scene" ? "声音背景生成" : j.mode === "dry" ? "纯人声生成" : "声音生成（各段当前版本）"
                            : "导出成品"}{" "}
                      ·{" "}
                      {j.kind === "voice-create"
                        ? state.voiceSessions?.find(s=>s.id === j.sessionId)?.description.slice(0, 32)
                        : j.kind === "voice-test"
                        ? voices.find((v) => v.id === j.voiceId)?.name
                        : state.chapters.find((c) => c.id === j.chapterId)
                            ?.title}
                    </strong>
                    <p>
                      已成功 {j.done} / {j.total} · 失败 {j.failed || 0} · 未提交 {j.stopped || 0} · 任务历时 {j.elapsedSeconds === undefined ? "未记录" : time(j.elapsedSeconds)} ·{" "}
                      {new Date(j.createdAt).toLocaleString("zh-CN")}
                    </p>
                    {j.error && <p className="error-inline">{j.error}</p>}
                    {j.resultAudioId && <button className="text-button" onClick={() => void startPlay("audios", j.resultAudioId!, j.kind === "voice-test" ? "本次试音结果" : "本次生成结果", undefined, true)}>{j.resultNotSelected ? "试听本次结果 · 已保留，未替换当前版本" : j.kind === "voice-test" ? "试听本次样音" : j.kind === "voice-create" ? "试听本次声音候选" : "试听本次单元结果"}</button>}
                    {j.kind === "generate" && j.chapterId === chapterId && !active(j.status) && ["failed", "stopped", "unknown"].includes(j.status) && <button className="text-button" disabled={locked || busy} onClick={() => void run(async () => {
                      const current = await api<ChapterDetail>("/chapters/" + j.chapterId);
                      const remaining = current.segments.filter(s => j.ids?.includes(s.id) && !s.excluded && s.latest !== "unknown" && (s.validity !== "matched" || s.review === "rework"));
                      setChapter(current);
                      setChecked(remaining.map(s => s.id));
                      setSearch(""); setFilter("all"); setModal(null);
                      setNotice(remaining.length ? `已选择 ${remaining.length} 条余下片段，已排除结果不明项。请核对当前内容后点击“生成所选”，将创建新任务。` : "没有可直接继续的片段；结果不明项需单独核对可能重复计费后再重试。");
                    })}>选择余下片段继续</button>}
                  </div>
                  <Status
                    kind={
                      j.status === "success"
                        ? "success"
                        : j.status === "unknown" || j.status === "failed"
                          ? "warning"
                          : ""
                    }
                  >
                    {names[j.status] || j.status}
                  </Status>
                </div>
              ))
            ) : (
              <Empty icon={<AudioLines size={28} />} heading="还没有生成任务">
                完成角色和音色配置后，选择片段生成配音。
              </Empty>
            )}
          </div>
        </Dialog>
      )}
      {modal === "export" && chapter && (
        <ExportDialog
          chapter={chapter}
          ready={ready}
          total={total}
          passed={passed}
          connectionReady={connectionReady}
          jobs={state?.jobs||[]}
          onClose={() => setModal(null)}
          onRefresh={refresh}
        />
      )}
      {deleteTarget&&<ProjectDeleteDialog project={deleteTarget} onClose={()=>setDeleteTarget(null)} onDelete={async scope=>{await deleteProject(deleteTarget.id,scope);await refresh();}}/>}
    </ErrorContext.Provider>
  );
}

type ProjectDeletionPlan={projectId:string;name:string;scope:Record<string,unknown>;counts:{chapters:number;audios:number;masters:number;exports:number};chapters:{id:string;title:string;revision:number;arrangement:number}[];blockers?:{code:string;message:string}[]};
function ProjectDeleteDialog({project,onClose,onDelete}:{project:Project;onClose:()=>void;onDelete:(scope:Record<string,unknown>)=>Promise<void>}){
  const [plan,setPlan]=useState<ProjectDeletionPlan|null>(null),[pending,setPending]=useState(false),[error,setError]=useState(''),[needsReview,setNeedsReview]=useState(false);
  const live=useRef(true);
  const load=async()=>{setPending(true);setError('');try{const value=await api<ProjectDeletionPlan>('/projects/'+project.id+'/deletion-plan');if(live.current){setPlan(value);setNeedsReview(false);}}catch(failure){if(live.current)setError((failure as Error).message);}finally{if(live.current)setPending(false);}};
  useEffect(()=>{void load();return()=>{live.current=false;};},[project.id]);
  const remove=async()=>{if(!plan||pending||needsReview||plan.blockers?.length)return;setPending(true);setError('');try{await onDelete(plan.scope);if(live.current)onClose();}catch(failure){if(live.current){setError((failure as Error).message);if((failure as {status?:number}).status===409)setNeedsReview(true);}}finally{if(live.current)setPending(false);}};
  return <Dialog title={'删除项目 · '+project.name} onClose={onClose} footer={needsReview||!plan?<button className="button secondary" disabled={pending} onClick={()=>void load()}>{pending?'正在读取…':'重新核对删除范围'}</button>:<button className="button warning" disabled={pending||!!plan.blockers?.length} onClick={()=>void remove()}>{pending?'正在删除…':'删除上面列出的项目资料'}</button>}>
    {!plan&&pending&&<p className="hint" role="status">正在核对这个项目的资料…</p>}
    {plan&&<><p>将删除“{plan.name}”的 {plan.counts.chapters} 章、{plan.counts.audios} 份原始音频、{plan.counts.masters} 份试听母版及 {plan.counts.exports} 份导出文件。</p><div className="task-member-list">{plan.chapters.map(chapter=><p key={chapter.id}>{chapter.title} · 编排 {chapter.arrangement}</p>)}</div><p className="warning">删除后不能在本工具中撤销。请先保留需要的项目备份。</p></>}
    {needsReview&&<p className="warning">项目范围在核对后发生变化，本次未删除。重新查看范围后再决定。</p>}
    {plan?.blockers?.map(blocker=><p className="warning" role="alert" key={blocker.code}>{blocker.message}</p>)}
    {error&&<p className="error-inline" role="alert">{error}</p>}
  </Dialog>;
}

/* Hallmark · component: workspace location · theme: existing Ardot tokens
 * pre-emit critique: P4 H4 E4 S5 R4 V4 */
function WorkspaceLocation({ directory, projectCount, projectName, projectFolders, onMoved }: {
  directory: string; projectCount: number; projectName?: string; projectFolders: boolean; onMoved: () => Promise<void>;
}) {
  const [selected, setSelected] = useState('');
  const [choosing, setChoosing] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [source, setSource] = useState(directory);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [inventory,setInventory]=useState<{scope:string;counts:Record<string,number>;bytes:Record<string,number>;missing:{kind:string;id:string;path:string;repairable:boolean}[];primaryAvailable:boolean}|null>(null),[checking,setChecking]=useState(false);
  const checkInventory=async()=>{setCopyError('');setInventory(null);setChecking(true);try{const result=await api<NonNullable<typeof inventory>>('/workspace/diagnostics');setInventory(result);return result;}finally{setChecking(false);}};
  useEffect(()=>{setInventory(null);setSelected('');setSource(directory);},[directory]);
  return <section className="section-rule workspace-location">
    <div className="workspace-location-heading"><h3>项目保存位置</h3><span className="hint">{projectCount} 个项目</span></div>
    <p className="workspace-path">{directory || '请重启本地服务以读取实际路径'}</p>
    {projectFolders && projectName && <p className="hint">当前项目文件夹：<span className="workspace-path-inline">{projectName}/</span></p>}
    <p className="hint">每个项目以项目名称建立独立文件夹，存放音频和成品。正文、角色和任务统一保存在总目录的数据库中，音色库共用；完整备份请复制整个总目录。</p>
    <div className="workspace-location-actions">
      <button className="button secondary" disabled={!directory} onClick={async () => {
        setCopyError('');
        try { await navigator.clipboard.writeText(directory); setCopied(true); }
        catch { setCopyError('复制失败，请选中上方路径手动复制。'); }
      }}>{copied ? '路径已复制' : '复制路径'}</button>
      <button className="button secondary" disabled={!directory || choosing || migrating || checking} onClick={async()=>{try{await checkInventory();}catch(error){setCopyError((error as Error).message);}}}>{checking?'正在核对资料…':'核对资料与空间'}</button>
      <button className="button secondary" disabled={!directory || choosing || migrating || checking} onClick={async () => {
        setCopyError(''); setChoosing(true);
        try {
          await checkInventory();
          const result = await api<{directory: string | null}>('/workspace/choose', {});
          if (result.directory) { setSource(directory); setSelected(result.directory); }
        } catch (error) { setCopyError((error as Error).message); }
        finally { setChoosing(false); }
      }}>{choosing ? '请在窗口中选择…' : selected ? '重新选择文件夹' : '更改位置'}</button>
    </div>
    {inventory && <section className="inspector-section" aria-label="本工作区资料与空间"><h4>本工作区资料与空间</h4><p className="hint">按现有记录核对文件，不删除参考原件、历史声音或成品。</p>
      <dl>{([['voices','参考录音原件'],['audios','生成声音原件'],['masters','整章试听母版'],['exports','导出成品']] as const).map(([kind,label])=><div key={kind}><dt>{label}</dt><dd>{inventory.counts[kind]||0} 份 · {(inventory.bytes[kind]||0)>=1048576?((inventory.bytes[kind]||0)/1048576).toFixed(1)+' MB':Math.ceil((inventory.bytes[kind]||0)/1024)+' KB'}</dd></div>)}</dl>
      {inventory.missing.length ? <><p className={inventory.primaryAvailable?'hint':'warning'}>{inventory.primaryAvailable?'仅有可免费重建的整章试听母版缺失，原始声音仍在。':'有原件或成品缺失，暂不能迁移；请先找回文件或恢复完整备份，再重新核对。'}</p><ul>{inventory.missing.map(item=><li key={item.kind+'/'+item.id}><span className="workspace-path-inline">{item.path}</span> · {item.kind==='masters'&&item.repairable?'可免费重建整章试听母版':'原件缺失，需要找回文件或恢复备份'}</li>)}</ul></> : <p className="hint">已记录的参考原件、声音、母版和成品均可读取。</p>}
    </section>}
    {copyError && <p className="error-inline" role="alert">{copyError}</p>}
    {selected && <Form key={selected} label="迁移全部项目" busy={choosing || checking || migrating || selected === directory || source!==directory || !inventory?.primaryAvailable} successMessage="迁移完成，已使用新位置。原目录保留，后续修改仅保存到新位置。" onSubmit={async () => {
      if(source!==directory||!inventory?.primaryAvailable)throw new Error('请先核对当前工作区资料与空间，并处理缺失的原件后再迁移。');
      setMigrating(true);
      try {
        const result = await api<{directory: string}>('/workspace/move', { source, directory: selected });
        setSource(result.directory); setCopied(false); await onMoved();
      } finally { setMigrating(false); }
    }}>
      <p className="hint">已选择的项目总目录</p>
      <p className="workspace-path">{selected}</p>
      {selected === directory && <p className="hint">这是当前保存位置，无需迁移。</p>}
      <p className="hint">将迁移本工作区全部 {projectCount} 个项目、共用音色库和历史音频。请先保存编辑并停止试听；有任务进行时不能迁移。旧目录保留，下次双击启动使用新位置。</p>
    </Form>}
  </section>;
}

function RenameProject({ project, save, onClose }: { project: Project; save: (a: string, p: Record<string, unknown>) => Promise<unknown>; onClose: () => void }) {
  const [base] = useState(project);
  return <Dialog title="重命名项目" onClose={onClose}>
    <Form label="保存项目名称" onSubmit={async f => {
      await save("project.rename", { id: base.id, name: f.get("name"), entityRevision: base.revision ?? 1 });
      onClose();
    }}>
      <Field label="项目名称"><input name="name" defaultValue={base.name} maxLength={100}/></Field>
      {(project.revision ?? 1) !== (base.revision ?? 1) && <p className="warning">项目名称已在其他页面修改。当前输入保留，请复制需要保留的文字后关闭并重新打开。</p>}
    </Form>
  </Dialog>;
}

type ImportCommand = {operationId:string;payload:Record<string,unknown>;chapterId?:string;rejection?:{message:string;fieldErrors:Record<string,string>;at:string}};
type ImportDraft = {source:string;title:string;prepare:boolean;imported:{text:string;name:string}|null;command?:ImportCommand;history?:ImportCommand[]};
function ImportChapter({projectId,onClose,onCreated}:{projectId:string;onClose:()=>void;onCreated:(id:string,prepare?:boolean)=>Promise<void|boolean>}) {
  const draftId="import-chapter/"+projectId;
  const workspaceIdentity=useRef(draftWorkspace()).current;
  const [draft,setDraft]=useState<ImportDraft>(()=>readDraft<ImportDraft>(draftId)?.draft||{source:"",title:"",prepare:true,imported:null});
  const [error,setError]=useState(""),[pending,setPending]=useState(false),[reading,setReading]=useState(false),[saved,setSaved]=useState(true);
  const live=useRef(true),fileIntent=useRef(0),draftRef=useRef(draft);draftRef.current=draft;
  useEffect(()=>()=>{live.current=false;fileIntent.current++;},[]);
  const current=()=>live.current&&draftWorkspace()===workspaceIdentity;
  const persist=(value:ImportDraft,update=current())=>{
    try{
      const history=new Map([...(readDraft<ImportDraft>(draftId,workspaceIdentity)?.draft.history||[]),...(value.history||[])].map(command=>[command.operationId,command]));
      if(history.size)value={...value,history:[...history.values()]};
      if(update){draftRef.current=value;setDraft(value);}
      if(value.source||value.title||value.command||value.history?.length)writeDraft(draftId,value,0,workspaceIdentity);else clearDraft(draftId,undefined,false,workspaceIdentity);if(update)setSaved(true);
    }catch{if(update){draftRef.current=value;setDraft(value);setSaved(false);setError("未能可靠暂存到浏览器。请复制原文保存；恢复存储后再核对导入回执。");}throw new Error("未能可靠保存导入草稿，请复制原文并恢复浏览器存储后重试。");}
  };
  const recordCommand=(command:ImportCommand)=>{
    const stored=readDraft<ImportDraft>(draftId,workspaceIdentity)?.draft;
    const owns=stored?.command?.operationId===command.operationId;
    const value=owns?{...stored!,command}:{...(stored||{source:"",title:"",prepare:true,imported:null}),history:[...(stored?.history||[]).filter(item=>item.operationId!==command.operationId),command]};
    persist(value,current()&&draftRef.current.command?.operationId===command.operationId&&owns);
    return owns;
  };
  const payloadOf=(value:ImportDraft):Record<string,unknown>=>JSON.parse(JSON.stringify({projectId,title:value.title.trim()||"新章节",source:value.source,importedSource:value.imported?.text||value.source,sourceFilename:value.imported?.name,segment:!value.prepare}));
  const locked=!!draft.command&&!draft.command.rejection;
  const problems={...(draft.command?.rejection&&JSON.stringify(draft.command.payload)===JSON.stringify(payloadOf(draft))?draft.command.rejection.fieldErrors:{}),...importProblems(payloadOf(draft))};
  const edit=(change:Partial<ImportDraft>)=>{if(!current()||(draftRef.current.command&&!draftRef.current.command.rejection))return;if(change.source!==undefined){fileIntent.current++;setReading(false);}try{persist({...draftRef.current,...change});setError("");}catch{/* The full editable text remains in this page for copying. */}};
  const close=()=>{live.current=false;fileIntent.current++;onClose();};
  const submit=async()=>{
    if(!current()||pending)return;
    if(!draftRef.current.source.trim())throw new Error("请先选择文件或粘贴原文");
    fileIntent.current++;setPending(true);
    try{
      let next=draftRef.current;
      if(!next.command||next.command.rejection){
        const payload=payloadOf(next),fieldErrors=importProblems(payload);
        if(Object.keys(fieldErrors).length){setError(Object.values(fieldErrors).join('；'));return;}
        if(next.command&&JSON.stringify(next.command.payload)===JSON.stringify(payload)){setError("上次导入明确未创建章节，请修改后重新导入。");return;}
        next={...next,history:next.command?[...(next.history||[]),next.command]:next.history,command:{operationId:crypto.randomUUID(),payload}};
      }
      if(!next.command!.chapterId){
        persist(next);
        const command=next.command!;
        try{
          const chapter=await action<{id:string}>("chapter.create",{...command.payload,operationId:command.operationId});
          if(!chapter?.id)throw new Error("未取得这次导入的章节回执，请核对原操作后重试。");
          next={...next,command:{...command,chapterId:chapter.id}};
        }catch(failure){
          const rejected=failure as Error&{status?:number;code?:string;outcome?:string;notApplied?:boolean;scope?:Record<string,unknown>;fieldErrors?:Record<string,string>};
          if(rejected.status===400&&rejected.code==='import-validation-rejected'&&rejected.outcome==='notApplied'&&rejected.notApplied===true&&rejected.scope?.action==='chapter.create'&&rejected.scope.operationId===command.operationId&&rejected.scope.projectId===projectId){
            recordCommand({...command,rejection:{message:rejected.message,fieldErrors:rejected.fieldErrors||{},at:new Date().toISOString()}});
            return;
          }
          throw failure;
        }
        if(!recordCommand(next.command!))return;
      }
      if(!current()||draftRef.current.command?.operationId!==next.command!.operationId)return;
      if(await onCreated(next.command!.chapterId!,next.prepare)===false)return;
      const stored=readDraft<ImportDraft>(draftId,workspaceIdentity);
      if(stored?.draft.command?.operationId===next.command!.operationId){
        if(stored.draft.history?.length)persist({source:"",title:"",prepare:true,imported:null,history:[...stored.draft.history,next.command!]},false);
        else clearDraft(draftId,JSON.stringify(stored),false,workspaceIdentity);
      }
    }finally{if(live.current)setPending(false);}
  };
  const readFile=async(file:File)=>{
    const intent=++fileIntent.current,current=()=>live.current&&draftWorkspace()===workspaceIdentity&&fileIntent.current===intent;
    setError("");setReading(false);
    if(file.size>importLimits.fileBytes){setError("文件超过4 MB，请按章节拆成较小文件后导入。");return;}
    setReading(true);
    try{
      let bytes:ArrayBuffer;
      try{bytes=await file.arrayBuffer();}catch{if(current())setError("文件读取失败，请重新选择文件或粘贴原文。");return;}
      if(!current())return;
      let text:string;
      try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{setError("文件不是 UTF-8 编码，请转换编码后重试。");return;}
      if(text.length>importLimits.source){setError("单章文字超过100万字符，请按章拆分后导入。");return;}
      persist({...draftRef.current,imported:{text,name:file.name},source:text.replace(/\r\n?/g,"\n"),title:file.name.replace(/\.(txt|md)$/i,"")});
    }catch(failure){if(current())setError((failure as Error).message);}finally{if(current())setReading(false);}
  };
  return <Dialog title="导入章节" onClose={close} wide>
    <Form label={draft.command?.chapterId?"打开已导入章节":draft.command?.rejection?"修改后重新导入":draft.command?"恢复这次导入回执":draft.prepare?"导入并进入AI准备":"仅导入并本地分段"} busy={reading||pending} onSubmit={submit}>
      <label className="upload-zone"><Upload size={22}/><strong>{reading?"正在读取文件…":"选择 TXT / Markdown 文件"}</strong><span>UTF-8 编码 · 最多4 MB · Markdown 按纯文本保留</span><input type="file" accept=".txt,.md" disabled={pending||locked} onChange={event=>{const file=event.target.files?.[0];if(file)void readFile(file);}}/></label>
      <Field label="章节名称" hint={`${draft.title.trim().length} / ${importLimits.title} 字符 · 留空使用“新章节”`}><input value={draft.title} disabled={pending||locked} aria-invalid={!!problems.title} aria-describedby={problems.title?"import-title-error":undefined} onChange={event=>edit({title:event.target.value})} placeholder="例如：第一章"/>{problems.title&&<p id="import-title-error" className="error-inline" role="alert">{problems.title}</p>}</Field>
      <Field label="原文预览" hint="原文完整保留；编辑预览不会改写导入文件来源。"><textarea value={draft.source} disabled={pending||locked} aria-invalid={!!(problems.source||problems.importedSource)} onChange={event=>edit({source:event.target.value})} rows={9} placeholder="在这里粘贴本章原文"/>{(problems.source||problems.importedSource)&&<p className="error-inline" role="alert">{problems.source||problems.importedSource}</p>}</Field>
      <label className="check-label"><input type="checkbox" checked={draft.prepare} disabled={pending||locked} onChange={event=>edit({prepare:event.target.checked})}/>导入后进入AI准备</label>
      <p className="hint">非空草稿关闭后仍可找回。仅本地分段不产生 API 费用。</p>
      {draft.command&&<p className="hint" role="status">{draft.command.chapterId?"章节已经创建。继续只打开原章节，不会再次创建或发起AI请求。":draft.command.rejection?"上次导入明确未创建章节。原文仍保留，请修改后重新导入。":"本次导入回执尚未确认。重试只核对同一次命令，不会创建第二章。"}</p>}
      <p className={saved?"hint":"warning"} role="status">{saved?"导入草稿已暂存在本机":"草稿尚未可靠暂存，请先复制原文"}</p>
      {error&&<p className="error-inline" role="alert">{error}</p>}
      <div className="source-summary"><span>{Array.from(draft.source).length.toLocaleString()} 字符</span><span>只统一换行，不润色正文</span></div>
      {!!draft.history?.length&&<details><summary>导入命令记录 · {draft.history.length}</summary>{draft.history.map(command=><p className="hint" key={command.operationId}>{String(command.payload.title)} · {command.rejection?`未创建：${command.rejection.message}`:command.chapterId?"已创建章节":"回执待核对"}<br/>操作标识：{command.operationId}</p>)}</details>}
    </Form>
    {!!draft.source&&!draft.command&&<button className="text-button" disabled={pending||reading} onClick={()=>{try{persist({source:"",title:"",prepare:true,imported:null});setError("");}catch{/* Keep the draft available when storage is unavailable. */}}}>放弃这份导入草稿</button>}
  </Dialog>;
}

function VoiceLibrary({
  projectId,
  model,
  initialCreate=false,
  initialSessionId,
  voices,
  sessions,
  creationEnabled,
  configured,
  audioTools,
  onBind,
  playingId,
  jobs,
  routeBlocked,
  playSample,
  onClose,
  onRefresh,
  play,
}: {
  projectId?:string;
  model?:string;
  initialCreate?:boolean;
  initialSessionId?:string;
  voices: Voice[];
  sessions: VoiceSession[];
  creationEnabled: boolean;
  configured: boolean;
  audioTools: boolean;
  onBind?: () => void;
  playingId?: string;
  jobs: Job[];
  routeBlocked: boolean;
  playSample: (v: Voice) => void;
  onClose: () => void;
  onRefresh: () => Promise<void>;
  play: (v: Voice) => void;
}) {
  const stateRevision = useRef(1);
  const [inspecting, setInspecting] = useState<Voice | null>(null);
  const [testing, setTesting] = useState<Voice | null>(null);
  const [deleting, setDeleting] = useState<Voice | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [testCommand, setTestCommand] = useState(crypto.randomUUID());
  const [uploadId,setUploadId] = useState(crypto.randomUUID());
  const [testGrant,setTestGrant] = useState<string|null>(null);
  const [testRetry,setTestRetry] = useState(false);
  const [testResume,setTestResume] = useState(false);
  const [creating, setCreating] = useState(initialCreate);
  const [upload, setUpload] = useState(false),
    [file, setFile] = useState<File | null>(null),
    [query, setQuery] = useState("");
  const libraryVoices = voices.filter(inVoiceLibrary), pendingDeletes = voices.filter(v => v.deletePending);
  return (
    <Dialog title="参考音色库" onClose={onClose} wide>
      {inspecting && <VoiceInspection voice={inspecting} current={voices.find(v => v.id === inspecting.id)} play={play} playSample={playSample} onClose={() => setInspecting(null)} onSaved={onRefresh} />}
      {deleting && (
        <DeleteVoiceDialog
          voice={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            await onRefresh();
            setDeleting(null);
          }}
        />
      )}
      {libraryError && (
        <p className="error-inline" role="alert">
          {libraryError}
        </p>
      )}
      {creating ? <>
        <button className="text-button" onClick={()=>setCreating(false)}>返回参考音色列表</button>
        <VoiceCreation initialSessionId={initialSessionId} projectId={projectId} model={model} sessions={sessions} voices={voices} jobs={jobs} enabled={creationEnabled} configured={configured} audioTools={audioTools}
          routeBlocked={routeBlocked} playingId={playingId} play={(id, title)=>playSample({id, sampleAudioId:id, name:title} as Voice)} refresh={onRefresh} bind={onBind}/>
      </> : testing ? (
        <Form
          label="生成测试样音"
          onSubmit={async (f) => {
            if(!testGrant||!projectId)throw new Error("请先允许当前项目的试音范围");
            const unknown=jobs.some(j=>j.voiceId===testing.id&&j.status==='unknown');
            if(unknown&&!testRetry)throw new Error("上次结果不明，请核对后明确是否再次发送");
            if(routeBlocked&&!testResume)throw new Error("声音接口已暂停，请核对后明确恢复本次请求");
            await api("/jobs", {
              kind: "voice-test",
              voiceId: testing.id,
              entityRevision: testing.revision ?? 1,
              text: f.get("text"),
              commandId: testCommand,
              projectId,
              grantId:testGrant,
              requireGrant:true,
              ...(testRetry?{retryUnknown:true}:{}),
              ...(testResume?{resumeRoute:true}:{}),
            });
            await onRefresh();
            setTesting(null);
          }}
        >
          <h3>{testing.name}</h3>
          <Field
            label="试音正文"
            hint="最多 300 字。使用这份参考声音朗读新的文字，样音单独保存。"
          >
            <textarea
              name="text"
              maxLength={300}
              defaultValue="雨停了，远处传来熟悉的脚步声。我们出发吧。"
              rows={4}
            />
          </Field>
          {projectId?<TaskAuthorization projectId={projectId} label="测试所选声音" steps={["voice-test"]} model={model} voiceIds={[testing.id]} onReady={setTestGrant}/>:<p className="warning">先选择项目，再生成测试样音。</p>}
          {jobs.some(j=>j.voiceId===testing.id&&j.status==='unknown')&&<label className="check-label warning"><input type="checkbox" checked={testRetry} onChange={e=>setTestRetry(e.target.checked)}/>上次结果不明，可能已计费；本次明确再发送一次。</label>}
          {routeBlocked&&<label className="check-label warning"><input type="checkbox" checked={testResume} onChange={e=>setTestResume(e.target.checked)}/>已检查接口与额度，恢复本次声音请求。</label>}
          <button
            type="button"
            className="text-button"
            onClick={() => setTesting(null)}
          >
            返回音色列表
          </button>
        </Form>
      ) : upload ? (
        <Form
          label="保存到音色库"
          onSubmit={async (f) => {
            if (!file) throw new Error("请先选择参考声音文件");
            const data = await new Promise<string>((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve((r.result as string).split(",")[1]);
              r.onerror = reject;
              r.readAsDataURL(file);
            });
            await api("/voices", {
              uploadId,
              name: f.get("name"),
              filename: file.name,
              data,
            });
            await onRefresh();
            setUpload(false);
            setFile(null);
            setUploadId(crypto.randomUUID());
          }}
        >
          <Field label="音色名称">
            <input name="name" placeholder="例如：沉稳旁白" onChange={()=>setUploadId(crypto.randomUUID())}/>
          </Field>
          <label className="upload-zone">
            <Upload size={25} />
            <strong>{file?.name || "选择参考声音"}</strong>
            <span>WAV / MP3 · 最长 30 秒 · 最大 10 MB</span>
            <input
              type="file"
              accept=".wav,.mp3"
              onChange={(e) => {setFile(e.target.files?.[0] || null);setUploadId(crypto.randomUUID());}}
            />
          </label>
          <button
            type="button"
            className="text-button"
            onClick={() => setUpload(false)}
          >
            返回音色列表
          </button>
        </Form>
      ) : (
        <>
          <div className="library-toolbar">
            <div className="search-field">
              <Search size={15} />
              <input
                aria-label="搜索音色"
                placeholder="搜索音色"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <button className="button primary" onClick={() => setUpload(true)}>
              <Plus size={16} />
              添加参考
            </button>
            <button className="button secondary" disabled={!creationEnabled && !sessions.length} onClick={()=>setCreating(true)}>描述声音</button>
          </div>
          <p className="hint">
            保存参考声音，跨项目复用。绑定角色前可以先试听素材。
          </p>
          {pendingDeletes.length > 0 && <p className={pendingDeletes.some(v => v.deleteError) ? "error-inline" : "hint"} role="status">
            正在删除 {pendingDeletes.length} 份参考素材；{pendingDeletes.some(v => v.deleteError) ? "暂时无法清理的文件会在空闲时重试。" : "等待进行中的任务或试听结束。"}
          </p>}
          <div className="voice-grid">
            {libraryVoices
              .filter((v) => v.name.includes(query))
              .map((v) => {
                const task = jobs.find((j) => j.voiceId === v.id);
                return (
                  <div className="voice-card" key={v.id}>
                    <div className="voice-card-top">
                      <div className="voice-symbol">
                        <AudioLines size={25} />
                      </div>
                      <button
                        className="icon"
                        aria-label={`${playingId === v.id ? "暂停" : "试听"} ${v.name}`}
                        disabled={v.state === "deleted" || v.deletePending}
                        onClick={() => play(v)}
                      >
                        {playingId === v.id ? (
                          <Pause size={18} />
                        ) : (
                          <Play size={18} />
                        )}
                      </button>
                    </div>
                    <h3>{v.name}</h3>
                    {task && (
                      <Status
                        kind={
                          task.status === "success"
                            ? "success"
                            : ["failed", "unknown"].includes(task.status)
                              ? "warning"
                              : "neutral"
                        }
                      >
                        测试样音 · {names[task.status]}
                      </Status>
                    )}
                    {task?.error && (
                      <p className="error-inline">{task.error}</p>
                    )}
                    {task?.resultNotSelected && <p className="hint">资料或试音任务已变化，本次结果已保留，可在任务记录试听；当前样音未替换。</p>}
                    <div className="voice-actions">
                      <button
                        className="text-button"
                        disabled={
                          v.state !== "active" ||
                          jobs.some(
                            (j) =>
                              j.voiceId === v.id &&
                              ["queued", "running"].includes(j.status),
                          )
                        }
                        onClick={() => {
                          setTesting(v);
                          setTestGrant(null);setTestRetry(false);setTestResume(false);
                          setTestCommand(crypto.randomUUID());
                        }}
                      >
                        {task && ["queued", "running"].includes(task.status)
                          ? "正在生成试音…"
                          : "生成新文本试音"}
                      </button>
                      {v.sampleAudioId && (
                        <button
                          className="text-button"
                          onClick={() => playSample(v)}
                        >
                          {playingId === v.sampleAudioId
                            ? "暂停样音"
                            : "试听样音"}
                        </button>
                      )}
                    </div>
                    <button className="text-button" disabled={v.state === "deleted" || v.deletePending} onClick={() => setInspecting(structuredClone(v))}>参考观察与人工检查</button>
                    <p>{v.inspectionCurrent ? (v.inspection?.target === "sample" ? "当前样音已人工检查" : "参考录音已人工检查") : "未验证"}{v.inspection?.checked && !v.inspectionCurrent ? " · 原检查对象已变化" : ""}</p>
                    <p>
                      {v.duration.toFixed(1)} 秒 ·{" "}
                      {v.tested ? "已用于生成 · 听感未由程序验证" : "未验证 · 尚未用于生成"}
                    </p>
                    <Select
                      label={`${v.name} 使用状态`}
                      onOpen={() => { stateRevision.current = v.revision ?? 1; }}
                      disabled={v.state === "deleted" || v.deletePending}
                      value={v.state}
                      options={[
                        { value: "active", label: "可用" },
                        { value: "archived", label: "归档 · 保留已有引用" },
                        {
                          value: "stopped",
                          label: v.deletePending
                            ? "等待在途任务或读取结束后删除"
                            : "停止新生成",
                        },
                        ...(v.state === "deleted"
                          ? [{ value: "deleted", label: "参考文件已删除" }]
                          : []),
                      ]}
                      onChange={async (state) => {
                        try {
                          setLibraryError("");
                          await action("voice.update", { id: v.id, state, entityRevision: stateRevision.current });
                          await onRefresh();
                        } catch (e) {
                          setLibraryError((e as Error).message);
                        }
                      }}
                    />
                    {v.deleteError && (
                      <p className="error-inline">{v.deleteError}</p>
                    )}
                    <button
                      className="text-button warning"
                      disabled={v.state === "deleted" || v.deletePending}
                      onClick={() => setDeleting(v)}
                    >
                      删除参考素材
                    </button>
                  </div>
                );
              })}
          </div>
          {!libraryVoices.length && (
            <Empty
              icon={<AudioLines size={28} />}
              heading="让每个角色有自己的声音"
            >
              添加一段清晰、单人说话的短音频作为参考。
            </Empty>
          )}
        </>
      )}
    </Dialog>
  );
}



function TemplateDialog({segment,chapter,templates,save,onClose}: {segment:Segment;chapter:ChapterDetail;templates:State["templates"];save:(a:string,p:Record<string,unknown>)=>Promise<unknown>;onClose:()=>void}) {
  const [base] = useState(()=>({id:segment.id,chapterId:chapter.id,revision:chapter.revision,template:segment.template}));
  const available = templates.filter(t=>t.id!==base.template);
  const [target,setTarget] = useState(available.find(t=>t.current)?.id || available[0]?.id || "");
  const [confirmed,setConfirmed] = useState(false);
  const [preview,setPreview] = useState<{from:string;to:string;name:string;description:string;before:string;after:string;unavailable:string}|null>(null);
  const [error,setError] = useState("");
  useEffect(()=>{
    let cancelled=false;setPreview(null);setError("");setConfirmed(false);
    if (target) void api<typeof preview>("/templates/preview",{...base,template:target}).then(v=>{if(!cancelled)setPreview(v)}).catch(e=>{if(!cancelled)setError(e.message)});
    return ()=>{cancelled=true};
  },[target,base]);
  return <Dialog title="切换提示模板" onClose={onClose} wide>
    <p className="hint">当前片段：{base.template}。切换会使既有音频待更新；应用后需另行生成。正文、参考音色、表演和已保存数值保持原样。</p>
    {!available.length ? <p className="hint">当前没有其他可用模板。已有片段会继续使用保存的版本，普通改字和重跑不会自动升级。</p> : <Form label="应用所选模板" revision={chapter.revision} busy={!preview || !confirmed} onSubmit={async()=>{await save("segment.template",{...base,template:target,confirm:confirmed});onClose();}}>
      <Select label="目标提示模板" value={target} options={available.map(t=>({value:t.id,label:`${t.name} · ${t.id}${t.current ? " · 新建片段默认" : ""}`}))} onChange={setTarget}/>
      {error && <p className="error-inline" role="alert">{error}</p>}
      {preview && <><p className="hint">{preview.description}</p><div className="merge-comparison"><div><strong>原模板 {preview.from}</strong><p className="original-excerpt">{preview.unavailable || preview.before}</p></div><div><strong>目标模板 {preview.to}</strong><p className="original-excerpt">{preview.after}</p></div></div><label className="check-label"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>我已核对差异，应用到当前片段</label></>}
    </Form>}
  </Dialog>;
}

function VoiceInspection({voice, current, play, playSample, onClose, onSaved}: {voice:Voice; current?:Voice; play:(v:Voice)=>void; playSample:(v:Voice)=>void; onClose:()=>void; onSaved:()=>Promise<void>}) {
  const initial = voice.inspection?.target || (voice.sampleAudioId ? "sample" : "reference");
  const [target,setTarget] = useState(initial);
  const [checked,setChecked] = useState(!!voice.inspectionCurrent);
  return <Dialog title={`参考观察与检查 · ${voice.name}`} onClose={onClose}>
    <Form label="保存观察与检查" revision={current?.revision ?? 1} onSubmit={async (f,expected) => {
      await action("voice.update", {id:voice.id,entityRevision:expected,observations:Object.fromEntries(["tone","accent","performance","volume"].map(k=>[k,f.get(k)])),inspection:{target,audioId:target === "sample" ? voice.sampleAudioId : null,checked}});
      await onSaved(); onClose();
    }}>
      <p className="hint">记录参考录音的听感，供导演建议参考；不会改写人物事实或自动重做音频。</p>
      {([["tone","基础声线","例如：低沉、带气声"],["accent","口音观察","例如：普通话、轻微地域口音"],["performance","参考表演特征","例如：中性平稳、明显激动"],["volume","参考音量观察","例如：偏轻、峰值明显、音量稳定"]] as const).map(([key,label,placeholder])=><Field key={key} label={label}><textarea name={key} defaultValue={voice.observations?.[key] || ""} placeholder={placeholder} maxLength={1000} rows={2}/></Field>)}
      <Select label="人工检查对象" value={target} options={[{value:"reference",label:"参考录音"},...(voice.sampleAudioId ? [{value:"sample",label:"当前测试样音"}] : [])]} onChange={value=>{setTarget(value as "reference"|"sample");setChecked(false)}}/>
      {target === "sample" && current?.sampleAudioId !== voice.sampleAudioId && <p className="warning">当前样音已变化，此表单仍对应打开时的音频；请重新打开并检查。</p>}
      <button type="button" className="button small" onClick={()=>target === "sample" ? playSample(voice) : play(voice)}>试听所选检查音频</button>
      <label className="check-label"><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>我已试听并检查所选音频</label>
      <p className="hint">不勾选也可保存观察，状态保持未验证；播放结束或生成成功不会自动勾选。原检查时间：{voice.inspection?.checked && voice.inspection.at ? new Date(voice.inspection.at).toLocaleString() : "尚无已检查记录"}。</p>
    </Form>
  </Dialog>;
}

function Roles({
  roles,
  voices,
  projectId,
  chapter: currentChapter,
  chapters,
  locked,
  onClose,
  save,
  onVoice,
}: {
  roles: Role[];
  voices: Voice[];
  onVoice?: (id:string)=>void;
  projectId: string;
  chapter: ChapterDetail | null;
  chapters: State["chapters"];
  locked: boolean;
  onClose: () => void;
  save: (a: string, p: Record<string, unknown>) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState({ role: roles[0], chapter: currentChapter });
  const [newRole, setNewRole] = useState(false);
  const [showAllRoles, setShowAllRoles] = useState(false);
  const { role, chapter } = editing;
  const selected = role?.id || "";
  const known = currentChapter?.knownRoles?.find(r => r.id === selected);
  const [applyDefault, setApplyDefault] = useState(false);
  return (
    <Dialog title="角色档案" onClose={onClose} wide>
      <p className="hint">{showAllRoles || !currentChapter ? "项目全部档案 · 包含后续章节资料，不代表当前章已知" : `截至「${currentChapter.title}」可知的角色`}</p>
      {currentChapter && <button type="button" className="text-button" onClick={() => {
        if (showAllRoles && !known) setEditing({role: roles.find(r => currentChapter.knownRoles.some(k => k.id === r.id))!, chapter:currentChapter});
        setShowAllRoles(!showAllRoles);
      }}>{showAllRoles ? "返回本章可知角色" : "查看项目全部档案（含后续章节）"}</button>}
      <div className="roles-layout">
        <div className="role-list">
          {roles.filter(r => showAllRoles || !currentChapter || currentChapter.knownRoles.some(k => k.id === r.id)).map((r) => (
            <button
              key={r.id}
              className={r.id === selected ? "selected" : ""}
              onClick={() => {
                setEditing({ role: r, chapter: currentChapter });
                setNewRole(false);
                setApplyDefault(false);
              }}
            >
              <span className="avatar">{r.name[0]}</span>
              {r.name}
              {r.archived ? " · 已归档" : ""}
            </button>
          ))}
          <button className="text-button" onClick={() => setNewRole(true)}>
            <Plus size={14} />
            添加角色
          </button>
        </div>
        <div>
          {newRole ? (
            <Form
              label="创建角色"
              onSubmit={async (f) => {
                const r = (await save("role.create", {
                  projectId,
                  chapterId: currentChapter?.id,
                  name: f.get("name"),
                })) as Role;
                setEditing({ role: r, chapter: currentChapter });
                setNewRole(false);
              }}
            >
              <Field label="角色名称">
                <input name="name" autoFocus />
              </Field>
            </Form>
          ) : (
            role && (
              <Form
                key={`${role.id}:${role.revision ?? 1}:${chapter?.id}:${chapter?.revision}`}
                label="保存角色"
                busy={locked}
                onSubmit={async (f) => {
                  const updated = await save("role.update", {
                    id: role.id,
                    entityRevision: role.revision ?? 1,
                    name: f.get("name"),
                    archived: f.get("archived") === "on",
                    aliasSources: JSON.parse(String(f.get("aliasSources") || "[]")),
                    voiceId: f.get("voice"),
                    chapterId: chapter?.id,
                    revision: chapter?.revision,
                    apply: f.get("apply") === "on",
                    ...(chapter
                      ? {
                          note: String(f.get("note") || ""),
                          quote: String(f.get("quote") || ""),
                          gender: String(f.get("gender") || "未知"),
                        }
                      : {}),
                  }) as Role;
                  setEditing({ role: updated, chapter: chapter ? await api<ChapterDetail>("/chapters/" + chapter.id) : null });
                  setApplyDefault(false);
                }}
              >
                {((roles.find(r => r.id === role.id)?.revision ?? 1) !== (role.revision ?? 1) || currentChapter?.revision !== chapter?.revision) && <div className="warning">
                  资料已更新，当前未保存的输入仍保留。请核对后重新编辑。
                  <button type="button" className="text-button" onClick={() => { setEditing({ role: roles.find(r => r.id === role.id)!, chapter: currentChapter }); setApplyDefault(false); }}>载入最新资料（放弃本页未保存修改）</button>
                </div>}
                <section className="role-voice-primary"><h3>角色声音</h3><p>{voices.find(v=>v.id===role.voiceId)?.name||"还没有选择声音"}</p>{onVoice&&<button type="button" className="button" onClick={()=>onVoice(role.id)}>试听并选声音</button>}</section>
                <Field label="显示名称">
                  <input name="name" defaultValue={role.name} />
                </Field>
                <AliasFields role={role} validity={(roles.find(r => r.id === role.id)?.revision ?? 1) === (role.revision ?? 1) ? roles.find(r => r.id === role.id)?.aliasValidity : undefined} chapter={chapter} chapters={chapters} showAll={showAllRoles} />
                {chapter && (
                  <>
                    <details><summary>截至本章的已知人物信息</summary><p className="hint">已确认别名：{known?.aliases?.join("、") || "暂无"}</p>{known?.facts?.map(f => <p key={f.chapterId} className="hint">{f.text} · {f.gender || "未知"} · {f.kind}{f.sourceQuote ? `：${f.sourceQuote}` : ""}</p>)}{!known?.facts?.length && <p className="hint">暂无已确认事实。</p>}</details>
                    {role.facts?.some((f) => f.chapterId === chapter.id && f.sourceQuote &&
                      (f.sourceVersion || 1) !== (chapter.sourceVersion || 1)) && (
                      <p className="warning">原文已更换，这份人物依据暂不参与分析。请核对备注与出处后重新保存。</p>
                    )}
                    <GenderField
                      initial={
                        role.facts?.find((f) => f.chapterId === chapter.id)
                          ?.gender || "未知"
                      }
                    />
                    <Field
                      label="本章起生效的人物备注"
                      hint="只参与当前章及后续章节的文本分析，不会改写旧章音频。"
                    >
                      <textarea
                        name="note"
                        rows={3}
                        defaultValue={
                          role.facts?.find((f) => f.chapterId === chapter.id)
                            ?.text || ""
                        }
                      />
                    </Field>
                    <Field
                      label="原文依据（选填）"
                      hint="逐字摘录本章；留空则标记为用户补充。"
                    >
                      <input
                        name="quote"
                        defaultValue={
                          role.facts?.find((f) => f.chapterId === chapter.id)
                            ?.sourceQuote || ""
                        }
                      />
                    </Field>
                  </>
                )}
                <details><summary>未来新增台词的角色默认声音</summary><VoiceField voices={voices} initial={role.voiceId || ""} /><p className="hint">这里修改项目默认；日常换声请使用上方“试听并选声音”，只改当前章。</p></details>
                {!role.narrator && (
                  <label className="check-label">
                    <input
                      type="checkbox"
                      name="archived"
                      defaultChecked={role.archived}
                    />
                    归档空角色（须先改绑其全部片段）
                  </label>
                )}
                <label className="check-label">
                  <input
                    name="apply"
                    type="checkbox"
                    checked={applyDefault}
                    onChange={e => setApplyDefault(e.target.checked)}
                    disabled={locked || !chapter}
                  />
                  应用到本章使用角色默认的片段
                </label>
                {applyDefault && chapter && <div className="hint">将更新以下片段至上方所选默认音色：{chapter.segments.filter(s => s.roleId === role.id && s.voiceSource !== "override").map(s => <p key={s.id}>第 {s.order + 1} 条 · {voices.find(v => v.id === s.voiceId)?.name || "未绑定"} · {s.text.slice(0, 40)}</p>)}本条指定的片段不受影响。</div>}
                <p className="hint">
                  首次绑定自动补齐本章尚未指定音色的片段。后续修改默认只影响新片段；本条指定的音色保留。
                </p>
              </Form>
            )
          )}
        </div>
      </div>
    </Dialog>
  );
}
function AliasFields({ role, validity, chapter, chapters, showAll }: { role: Role; validity?: Record<string, boolean>; chapter: ChapterDetail | null; chapters: State["chapters"]; showAll: boolean }) {
  const [rows, setRows] = useState<AliasSource[]>(role.aliasSources || role.aliases.map(name => ({name, chapterId:null, needsReview:true})));
  const change = (index: number, patch: Partial<AliasSource>) => {
    if (!chapter) return;
    setRows(rows.map((a,i) => i === index ? {...a, ...patch, chapterId:chapter.id, sourceVersion:chapter.sourceVersion || 1, needsReview:false} : a));
  };
  return <div className="section-rule">
    <h3>别名及依据</h3>
    <p className="hint">保存角色后才建立正式关系。明示与推断需逐字引文；用户补充从所选章节起生效。其他章的记录请到来源章修改。</p>
    <input type="hidden" name="aliasSources" value={JSON.stringify(rows)} />
    {rows.map((a,i) => {
      const source = chapters.find(c => c.id === a.chapterId);
      if (!showAll && chapter && source && source.order > chapter.order) return null;
      const editable = chapter && (!a.chapterId || a.chapterId === chapter.id);
      const unchanged = JSON.stringify(a) === JSON.stringify(role.aliasSources?.[i]);
      return <div className="section-rule" key={i}>
        <p className="hint">{source?.title || "来源章待核对"} · {unchanged ? validity?.[a.name] ? "依据有效" : "待核对 · 暂不参与分析" : "未保存"}</p>
        {editable ? <>
          <Field label={`别名 ${i + 1}`}><input value={a.name} maxLength={100} onChange={e => change(i,{name:e.target.value})} /></Field>
          <Field label={`别名 ${i + 1} 依据类别`}><Select label={`别名 ${i + 1} 依据类别`} value={a.kind || ""} options={[
            {value:"",label:"请选择依据类别"}, {value:"原文明示",label:"原文明示"}, {value:"上下文推断",label:"上下文推断"}, {value:"用户补充",label:"用户补充"},
          ]} onChange={kind => change(i,{kind,...(kind === "用户补充" ? {sourceQuote:"",reason:""} : {})})} /></Field>
          {a.kind !== "用户补充" && <Field label={`别名 ${i + 1} 原文引文`} hint="逐字来自本章，用于核对名称与角色的关系；可定位不代表解释正确。"><textarea rows={2} value={a.sourceQuote || ""} onChange={e => change(i,{sourceQuote:e.target.value})} /></Field>}
          {a.kind === "上下文推断" && <Field label={`别名 ${i + 1} 推断说明`}><textarea rows={2} value={a.reason || ""} onChange={e => change(i,{reason:e.target.value})} /></Field>}
          <div className="button-row">
            <button type="button" className="text-button" onClick={() => change(i,{})}>确认本章依据（保存后生效）</button>
            <button type="button" className="text-button warning" onClick={() => setRows(rows.filter((_,n) => n !== i))}>移除此别名</button>
          </div>
        </> : <><strong>{a.name}</strong><p className="hint">{a.kind || "依据类别待核对"}{a.sourceQuote ? `：${a.sourceQuote}` : ""}{a.reason ? ` · ${a.reason}` : ""}</p></>}
      </div>;
    })}
    {!rows.length && <p className="hint">尚未添加别名。</p>}
    <button type="button" className="text-button" disabled={!chapter} onClick={() => chapter && setRows([...rows,{name:"",chapterId:chapter.id,kind:"用户补充",sourceQuote:"",reason:"",sourceVersion:chapter.sourceVersion || 1}])}>添加本章别名</button>
  </div>;
}

function VoiceField({ voices, initial }: { voices: Voice[]; initial: string }) {
  const [v, setV] = useState(initial);
  return (
    <Field label="默认音色">
      <Select
        label="默认音色"
        value={v}
        options={[
          { value: "", label: "尚未绑定" },
          ...voices
            .filter((x) => x.state === "active" || x.id === initial)
            .map((x) => ({ value: x.id, label: x.name })),
        ]}
        onChange={setV}
      />
      <input type="hidden" name="voice" value={v} />
    </Field>
  );
}

function Editor({
  segment: s,
  templates,
  onDraftChange,
  chapter,
  roles,
  voices,
  locked,
  connectionReady,
  save,
  run,
  generate,
  onRoles,
  onVoice,
  unit,
  onUnit,
  defaultModel,
  contextRevision,
  stateJobs,
  onSplitApplied,
}: {
  segment: Segment;
  templates: State["templates"];
  onDraftChange: (id:string,dirty:boolean)=>void;
  chapter: ChapterDetail;
  roles: Role[];
  voices: Voice[];
  locked: boolean;
  connectionReady: boolean;
  save: (a: string, p: Record<string, unknown>) => Promise<unknown>;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  generate: (ids: string[]) => Promise<void>;
  onRoles: () => void;
  onVoice?: (roleId?:string,segmentId?:string)=>void;
  unit?: GenerationUnit;
  onUnit: () => void;
  defaultModel: string;
  contextRevision: number;
  stateJobs: Job[];
  onSplitApplied: (childId:string,isCurrent:()=>boolean)=>Promise<void>;
}) {
  const enhancedUnit = unit && (unit.kind === "group" || unit.mode === "scene") ? unit : null;
  const activeVariant = enhancedUnit?.variants[enhancedUnit.mode];
  const controller = useObjectDraft("segment", s.id, s, chapter.revision, {
    legacyRaw:true, scope:"chapter:" + chapter.id, chapterRevision:chapter.revision,
    dependencies:["segment:" + s.id, "role:" + s.roleId, ...(unit?.kind === "group" ? ["unit:" + unit.id] : [])],
    changes:["segment:" + s.id, ...(unit?.kind === "group" ? ["unit:" + unit.id] : [])],
    coupled:[["roleId","voiceId","voiceSource","roleConfirmed","identityConfirmed"]], locked,
    validate:value=>unit?.kind === "group" && value.excluded ? "先取消这段共同演绎，再选择这句不朗读。" : speechDraftProblem(value),
    persist:async(value, expected, context)=>{
      const payload:Record<string,unknown>={chapterId:chapter.id,id:s.id,revision:context.chapterRevision ?? expected,autosave:true,
        text:value.text,performance:value.performance,type:value.type,roleConfirmed:value.roleConfirmed,identityConfirmed:value.identityConfirmed,
        excluded:value.excluded,config:Object.fromEntries(Object.entries(value.config).map(([key,number])=>[key,Number(number)]))};
      if(value.roleId !== s.roleId)payload.roleId=value.roleId;
      if(value.voiceSource === "override" && (value.voiceId !== s.voiceId || s.voiceSource !== "override"))payload.voiceId=value.voiceId;
      const saved=await saveAction<Segment & {chapterRevision:number}>("segment.update",payload,context.operationId,context.replay);
      return {value:saved,revision:saved.chapterRevision,chapterRevision:saved.chapterRevision};
    },
  });
  const {draft,base:revision,dirty,saving}=controller;
  const [tab,setTab]=useState("settings"), [split,setSplit]=useState(false),
    [merge,setMerge]=useState(false), [restore,setRestore]=useState<string|null>(null), [templateOpen,setTemplateOpen]=useState(false);
  const textarea=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>onDraftChange(s.id,dirty),[s.id,dirty,onDraftChange]);
  const edit=controller.edit;
  const next=chapter.segments.find(x=>x.order === s.order+1);
  const saveDraft=()=>controller.flush();
  const openSplit=()=>setSplit(true);
  return (
    <>
      <div className="inspector-head">
        <strong>第 {s.order + 1} 句 · {roles.find(role=>role.id===draft.roleId)?.name||"未分配角色"}</strong>
        <div className="row-actions">
          {unit?.kind !== 'group' && <button className="button small" disabled={locked || dirty || controller.frozen || Array.from(s.text).length < 2} onClick={openSplit}><Scissors size={13}/>拆分这条</button>}
          {onVoice && <button className="button small" disabled={locked || controller.frozen} onClick={()=>onVoice(draft.roleId,s.id)}>选声音</button>}
        </div>
      </div>
      {unit && (unit.kind === "group" || unit.mode === "scene") && <div className="inspector-unit"><button className="text-button" onClick={onUnit}>{unit.kind === "group" ? `调整整段 ${unit.members.length} 句` : "调整声音背景"}<ChevronRight size={14}/></button>{unit.kind === "group" && <span>修改后会重做整段</span>}</div>}
      <div className="inspector-tabs tabs">
        {[
          ["settings", "声音与表演"],
          ["original", "原文"],
          ["prompt", "详细设置"],
        ].map(([id, name]) => (
          <button
            key={id}
            className={tab === id ? "active" : ""}
            onClick={() => setTab(id)}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="inspector-scroll">
        {tab === "settings" ? (
          <>
            <div className="inspector-section">
              <div className="section-heading">
                <h3>角色与声音</h3>
                <button className="text-button" onClick={onRoles}>
                  角色资料
                </button>
              </div>
              <div className="inspector-identity">
              <Field label="朗读角色">
                <Select
                  label="朗读角色"
                  disabled={locked || controller.frozen}
                  value={draft.roleId}
                  options={roles
                    .filter((r) => !r.archived || r.id === draft.roleId)
                    .map((r) => ({ value: r.id, label: r.name }))}
                  onChange={(roleId) => {
                    const r = roles.find((r) => r.id === roleId)!;
                    edit({
                      roleId,
                      roleConfirmed: true,
                      ...(draft.voiceSource === "default"
                        ? { voiceId: Object.hasOwn(chapter.roleVoices||{},r.id)?chapter.roleVoices?.[r.id]||null:r.voiceId }
                        : { identityConfirmed: false }),
                    });
                  }}
                />
              </Field>
              <Field label="实际音色">
                <Select
                  label="实际音色"
                  disabled={locked || controller.frozen}
                  value={draft.voiceId || ""}
                  options={[
                    { value: "", label: "请选择参考音色" },
                    ...voices
                      .filter(
                        (v) => v.state === "active" || v.id === draft.voiceId,
                      )
                      .map((v) => ({
                        value: v.id,
                        label:
                          v.name +
                          (v.state !== "active"
                            ? "（" +
                              (v.state === "archived" ? "已归档" : "已停用") +
                              "）"
                            : ""),
                      })),
                  ]}
                  onChange={(voiceId) =>
                    edit({
                      voiceId: voiceId || null,
                      voiceSource: "override",
                      identityConfirmed: true,
                    })
                  }
                />
              </Field>
              </div>
              <div className="field-source">
                <span>
                  {draft.voiceSource === "override"
                    ? "本条指定"
                    : "继承角色默认"}
                </span>
                {s.voiceSource === "override" && (
                  <button
                    className="text-button"
                    disabled={locked || dirty}
                    onClick={() =>
                      run(() =>
                        save("segment.update", { id: s.id, resetVoice: true }),
                      )
                    }
                  >
                    恢复默认
                  </button>
                )}
              </div>
              <details className="inspector-identity-options" open={!draft.roleConfirmed||!draft.identityConfirmed}><summary>身份核对与内容类型</summary>
              <Field label="内容类型">
                <Select
                  label="内容类型"
                  disabled={locked || controller.frozen}
                  value={draft.type}
                  options={[
                    { value: "narration", label: "叙述旁白" },
                    { value: "dialogue", label: "角色对白" },
                    { value: "thought", label: "直接内心独白" },
                  ]}
                  onChange={(type) => edit({ type })}
                />
              </Field>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={draft.roleConfirmed && draft.identityConfirmed}
                  disabled={locked || controller.frozen}
                  onChange={(e) =>
                    edit({
                      roleConfirmed: e.target.checked,
                      identityConfirmed: e.target.checked,
                    })
                  }
                />
                已核对角色和声音身份
              </label>
              </details>
            </div>
            <div className="inspector-section">
              <h3>朗读正文</h3>
              <textarea
                aria-label="朗读正文"
                ref={textarea}
                rows={5}
                disabled={locked || controller.frozen}
                value={draft.text}
                onCompositionStart={controller.compositionStart}
                onCompositionEnd={controller.compositionEnd}
                onChange={(e) => edit({ text: e.target.value })}
              />
              <div className="field-source">
                <span>{Array.from(draft.text).length} 字符</span>
                <span>原文保持不变</span>
              </div>
              {Array.from(draft.text).length>350*(1+(Number(draft.config.speech_rate)||0)/100)&&<div className="warning"><p>本条较长，可能超过单次 120 秒；建议按语义拆短正文，字数不是精确时长预测。</p>{unit?.kind==='group'&&<button className="text-button" onClick={onUnit}>调整整段范围</button>}</div>}
            </div>
            <div className="inspector-section">
              <h3>表演指导</h3>
              <textarea
                aria-label="表演指导"
                rows={4}
                disabled={locked || controller.frozen}
                value={draft.performance}
                onCompositionStart={controller.compositionStart}
                onCompositionEnd={controller.compositionEnd}
                onChange={(e) => edit({ performance: e.target.value })}
                placeholder="例如：压低声音，语速稍缓，句尾收轻"
              />
              <div className="preset-chips">
                {["自然叙述", "平静克制", "轻声提醒", "坚定有力"].map((t) => (
                  <button
                    key={t}
                    disabled={locked || controller.frozen}
                    onClick={() => edit({ performance: t })}
                  >
                    {t}
                  </button>
                ))}
              </div>
              <p className="hint">只描述怎么说，不改写台词。{unit?.mode === "scene" ? "当前使用带背景声版本；环境、音乐和音效请在声音背景面板设置。" : "当前制作纯人声，不加入音乐或环境音效。"}生成时会将正文、表演要求和参考录音发送至配音服务。
              {draft.voiceId && !voices.find(v => v.id === draft.voiceId)?.tested && <span className="hint"> 当前参考尚未验证，可先试听或生成测试样音。</span>}</p>
              {!!s.promptIssues?.length && <p className="error-inline">{s.promptIssues.join("；")}</p>}
            </div>
            <details className="advanced">
              <summary>更多设置</summary>
              <div className="number-fields">
                {[
                  ["speech_rate", "语速"],
                  ["loudness_rate", "音量"],
                  ["pitch_rate", "音调"],
                ].map(([key, label]) => (
                  <Field label={label} key={key}>
                    <input
                      type="number"
                      disabled={locked || controller.frozen}
                      value={draft.config[key as keyof typeof draft.config]}
                      onChange={(e) =>
                        edit({
                          config: {
                            ...draft.config,
                            [key]: e.target.value,
                          },
                        })
                      }
                    />
                  </Field>
                ))}
              </div>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={draft.excluded}
                  disabled={locked || controller.frozen}
                  onChange={(e) => edit({ excluded: e.target.checked })}
                />
                从朗读中排除，保留原文记录
              </label>
              <div className="button-row">
                <button
                  className="button small"
                  disabled={locked || dirty || !next}
                  onClick={() => setMerge(true)}
                >
                  <Link2 size={13} />
                  合并下一条
                </button>
              </div>
            </details>
            <div className="inspector-section">
              <h3>音频版本</h3>
              {enhancedUnit && <p className="hint">当前编排来自{enhancedUnit.kind === "group" ? "整组" : "单条"}{enhancedUnit.mode === "scene" ? "场景" : "干声"}版本。检查和返工以该单元的实际音频为准。</p>}
              <dl className="details-list">
                <div>
                  <dt>最近尝试</dt>
                  <dd>{names[activeVariant?.latest || s.latest]}</dd>
                </div>
                <div>
                  <dt>当前音频</dt>
                  <dd>{names[activeVariant?.status.validity || s.validity]}</dd>
                </div>
                <div>
                  <dt>人工检查</dt>
                  <dd>{names[activeVariant?.status.review || s.review]}</dd>
                </div>
              </dl>
              <div className="button-row">
                <button
                  className="button small"
                  disabled={!(activeVariant ? activeVariant.previous : s.previous) || locked || dirty}
                  onClick={() => enhancedUnit ? onUnit() : setRestore(s.previous)}
                >
                  <RotateCcw size={13} />
                  上一版
                </button>
                <button
                  className="button small"
                  disabled={!(activeVariant ? activeVariant.approved : s.approved) || locked || dirty}
                  onClick={() => enhancedUnit ? onUnit() : setRestore(s.approved)}
                >
                  最近通过版
                </button>
              </div>
              {enhancedUnit ? <button className="button secondary small" onClick={onUnit}>查看单元检查与返工</button> : s.validity === "matched" && (
                <button
                  className="button secondary small warning"
                  disabled={!connectionReady || locked || dirty}
                  onClick={() =>
                    run(() =>
                      save("segment.review", {
                        id: s.id,
                        audioId: s.current,
                        basis: basis(s),
                        state: "rework",
                      }),
                    )
                  }
                >
                  标记需返工
                </button>
              )}
            </div>
          </>
        ) : tab === "original" ? (
          <div className="inspector-section">
            <h3>原文对照</h3>
            {s.source.spans.length > 0 && <p className="hint">前文：{Array.from(chapter.source).slice(Math.max(0, s.source.spans[0].start - 80), s.source.spans[0].start).join("") || "章节开头"}</p>}
            <p className="original-excerpt">
              {s.source.spans
                .map((span) =>
                  Array.from(chapter.source)
                    .slice(span.start, span.end)
                    .join(""),
                )
                .join("") || s.source.text || "这条旧手工片段未保存独立来源文本，无法还原最初原文。"}
            </p>
            {s.source.spans.length > 0 && <p className="hint">后文：{Array.from(chapter.source).slice(s.source.spans.at(-1)!.end, s.source.spans.at(-1)!.end + 80).join("") || "章节结尾"}</p>}
            {s.editHistory?.length ? <p className="warning">朗读正文有 {s.editHistory.length} 次显式修改。当前文字请与上方可用的来源对照。</p> : null}
            <p className="original-excerpt">当前朗读：{s.text}</p>
            <p className="hint">
              {s.source.kind === "edited"
                ? "此片段经过结构编辑，保留父片段来源。"
                : "原文区间由程序保存，编辑朗读文字不覆盖原文。"}
            </p>
          </div>
        ) : (
          <div className="inspector-section">
            <h3>{enhancedUnit ? "本片段干声提示" : "实际生成提示"}</h3>
            {enhancedUnit && <p className="hint">这份片段提示用于干声设置；当前编排的完整请求在声音版本面板。<button className="text-button" onClick={onUnit}>查看当前单元实际提示</button></p>}
            <p className="hint">模板 {s.template} · 仅显示已保存设置</p>
            <button className="button small" disabled={locked || dirty} onClick={()=>setTemplateOpen(true)}>查看与切换模板</button>
            {!!s.promptIssues?.length && <p className="error-inline">{s.promptIssues.join("；")}</p>}
            <pre className="prompt-text">{s.prompt}</pre>
          </div>
        )}
      <ObjectDraftTools controller={controller} title="这一句" inline onError={message=>void run(async()=>{throw new Error(message);})} render={value=><><p className="original-excerpt">{value.text}</p><p className="hint">{value.performance}</p></>}/>
      {dirty && !controller.error && speechDraftProblem(draft) && <p className="hint">{speechDraftProblem(draft)}</p>}
      </div>
      <div className="inspector-actions">
        <button
          className="button"
          disabled={!dirty || locked || saving}
          onClick={() => run(saveDraft)}
        >
          {controller.label}
        </button>
        <button
          className="button primary"
          disabled={locked || controller.frozen || draft.excluded}
          onClick={() => run(() => withSavedDrafts("chapter:" + chapter.id,["segment:" + s.id],()=>generate([s.id])))}
        >
          <AudioLines size={15} />
          {unit?.kind === "group" ? "打开对戏组生成" : unit?.mode === "scene" ? "打开场景版本生成" : s.current ? "重新生成" : "生成本条"}
        </button>
      </div>
      {templateOpen && <TemplateDialog segment={s} chapter={chapter} templates={templates} save={save} onClose={()=>setTemplateOpen(false)}/>}
      {split && <SegmentSplitDialog chapter={chapter} segment={s} defaultModel={defaultModel} contextRevision={contextRevision} stateJobs={stateJobs} locked={locked} onClose={()=>setSplit(false)} onApplied={onSplitApplied}/>}
      {merge && next && (
        <Dialog title="合并相邻片段" onClose={() => setMerge(false)}>
          <Form
            label="确认合并"
            revision={chapter.revision}
            onSubmit={async (f, revision) => {
              await save("segment.merge", {
                revision,
                id: s.id,
                choice: f.get("choice"),
                performance: f.get("performance"),
              });
              setMerge(false);
            }}
          >
            <p className="original-excerpt">
              {s.text}
              {next.text}
            </p>
            <p className="hint">
              本条：{voices.find((v) => v.id === s.voiceId)?.name || "无音色"} ·
              下一条：
              {voices.find((v) => v.id === next.voiceId)?.name || "无音色"}
            </p>
            <div className="merge-comparison">
              {[s, next].map((row, index) => <div key={row.id}><strong>{index === 0 ? "本条设置" : "下一条设置"}</strong><p>模型 {row.model || "seed-audio-1.0"} · 模板 {row.template}</p><p>语速 {row.config.speech_rate} · 音量 {row.config.loudness_rate} · 音高 {row.config.pitch_rate}</p><p>{row.voiceSource === "override" ? "本条指定音色" : "继承角色默认"}</p></div>)}
            </div>
            {s.voiceSource !== next.voiceSource && <p className="hint">合并后保留“本条指定”的覆盖保护。</p>}
            <label className="check-label">
              <input type="radio" name="choice" value="first" />
              使用本条音色、模型、数值配置和模板
            </label>
            <label className="check-label">
              <input type="radio" name="choice" value="second" />
              使用下一条音色、模型、数值配置和模板
            </label>
            <Field label="合并后表演指导">
              <textarea name="performance" defaultValue={s.performance} />
            </Field>
            <p className="hint">
              只允许同角色、同类型合并；合并后重新生成和检查。
            </p>
          </Form>
        </Dialog>
      )}
      {restore && (
        <RestoreDialog
          id={restore}
          segment={s}
          revision={chapter.revision}
          voices={voices}
          onClose={() => setRestore(null)}
          restore={async (revision) => {
            await save("segment.restore", {
              revision,
              id: s.id,
              audioId: restore,
              restoreSettings: true,
            });
            setRestore(null);
          }}
        />
      )}
    </>
  );
}

function RestoreDialog({
  id,
  segment: s,
  revision,
  voices,
  onClose,
  restore,
}: {
  id: string;
  segment: Segment;
  revision: number;
  voices: Voice[];
  onClose: () => void;
  restore: (revision?: number) => Promise<void>;
}) {
  const [record, setRecord] = useState<AudioRecord | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    void api<AudioRecord>("/audio-record/" + id)
      .then(setRecord)
      .catch((e) => setError(e.message));
  }, [id]);
  const label = (id: string | null) =>
    voices.find((v) => v.id === id)?.name || "未绑定";
  return (
    <Dialog title="恢复音频版本" onClose={onClose}>
      <p className="hint">
        保留当前角色归属和原文来源。以下生成设置将恢复，检查状态会按当前审核依据重新计算。
      </p>
      {error && <p role="alert">{error}</p>}
      <Form label="恢复此版设置并选用" revision={revision} busy={!record} onSubmit={(_, expected) => restore(expected)}>
        {record && (
          <div className="restore-diff">
            <h3>朗读正文</h3>
            <p className="hint">当前</p>
            <p>{s.text}</p>
            <p className="hint">此版本</p>
            <p>{record.input.text}</p>
            <h3>参考声音</h3>
            <p>
              {label(s.voiceId)} → {label(record.input.voiceId)}
            </p>
            <h3>表演指导</h3>
            <p>
              {s.performance || "自然朗读"} →{" "}
              {record.input.performance || "自然朗读"}
            </p>
            <h3>数值设置与模板</h3>
            <p>
              语速 / 音量 / 音调：{Object.values(s.config).join(" / ")} →{" "}
              {Object.values(record.input.config).join(" / ")}
            </p>
            <p>
              {s.template} → {record.input.template}
            </p>
          </div>
        )}
      </Form>
    </Dialog>
  );
}

function ExportDialog({
  chapter: c,
  ready,
  total,
  passed,
  connectionReady,
  jobs,
  onClose,
  onRefresh,
}: {
  chapter: ChapterDetail;
  ready: number;
  total: number;
  passed: number;
  connectionReady: boolean;
  jobs: Job[];
  onClose: () => void;
  onRefresh: () => Promise<void>;
}) {
  const [format, setFormat] = useState("wav"),
    [gap, setGap] = useState(c.gap);
  const [gapRevision, setGapRevision] = useState(c.revision);
  const [confirmation, setConfirmation] = useState(c);
  const [submitted,setSubmitted]=useState(false);
  const live=useRef(true);useEffect(()=>()=>{live.current=false;},[]);
  return (
    <Dialog title="检查与导出" onClose={onClose}>
      <div className="export-overview">
        <Headphones size={26} />
        <div>
          <h3>{c.title}</h3>
          <p>
            {ready} / {total} 句音频就绪 · {passed} 句检查通过 · {c.playbackItems.filter(item=>item.validity==='matched'&&item.review==='pending').length} 个声音单元待检查
          </p>
        </div>
      </div>
      <Field label="片段间隔（秒）">
        <input
          type="number"
          min={0}
          max={10}
          step={0.1}
          value={gap}
          onChange={(e) => setGap(Number(e.target.value))}
        />
      </Field>
      {gap !== c.gap && (
        <Form
          label="保存间隔"
          onSubmit={async () => {
            const saved = await action<ChapterDetail>("chapter.update", {
              chapterId: c.id,
              revision: gapRevision,
              gap,
            });
            setGapRevision(saved.revision);
            setConfirmation(previous => ({...previous, revision: saved.revision, arrangement: saved.arrangement}));
            await onRefresh();
          }}
        >
          <p className="hint">保存间隔后，将按新编排准备试听与导出。</p>
        </Form>
      )}
      <Field label="导出格式">
        <Select
          label="导出格式"
          value={format}
          options={[
            { value: "wav", label: "WAV · 48 kHz 无损母版" },
            { value: "mp3", label: "MP3 · 192 kbps" },
          ]}
          onChange={setFormat}
        />
      </Field>
      <Form
        label="确认检查并导出"
        busy={!connectionReady || gap !== c.gap || !!c.arrangementIssues?.length}
        onSubmit={async () => {
          await withSavedDrafts("chapter:"+c.id, undefined,async()=>{
          const receipt=await submitOperation("export:"+c.id+":"+format,{
            kind: "export",
            chapterId: c.id,
            revision: confirmation.revision,
            arrangement: confirmation.arrangement,
            format,
            confirm: true,
            reviewItems: confirmation.reviewItems || confirmation.segments
              .filter((s) => !s.excluded)
              .map((s) => ({ id: s.id, audioId: s.current, basis: basis(s) })),
          },jobs);
          if(receipt.error)throw new Error(receipt.error);
          if(live.current)setSubmitted(true);
          });
          await onRefresh();
        }}
      >
        {!!c.arrangementIssues?.length && <p className="error-inline" role="alert">当前编排需修复：{c.arrangementIssues.join("；")}。请先明确解除无效分组并核对单条。</p>}
        {(confirmation.revision !== c.revision || confirmation.arrangement !== c.arrangement) && <p className="warning">本章内容或音频编排已变化，请关闭后重新打开，核对再导出。</p>}
        <p className="hint">
          将当前匹配音频的待检查项统一确认为通过。需返工、身份未确认、缺漏或过期音频必须先处理。
        </p>
      </Form>
      {submitted&&<p className="hint" role="status">导出任务已提交，在本机继续处理。成品完成后会显示在下方；关闭此面板不影响任务。</p>}
      {c.exports.length > 0 && (
        <div className="section-rule">
          <h3>已导出的文件</h3>
          {c.exports.some(e=>e.current&&e.fileExists)&&<p className="success-text" role="status">成品已就绪。点击对应格式即可直接下载；下方标明实际编排和完成时间。</p>}
          {c.exports.some(e => !e.fileExists) && <p className="hint">缺失文件不能下载。源音频完整时，可在上方重新导出当前版本，不产生配音费用；历史版本请从备份恢复。</p>}
          {c.exports.slice().reverse().map((e) => (
            <a
              className="download-row"
              key={e.id}
              download={`${c.title}-编排${e.arrangement}-${e.createdAt.replace(/[:.]/g, "-")}.${e.format}`}
              href={e.fileExists ? `/api/media/exports/${e.id}` : undefined}
              aria-disabled={!e.fileExists}
            >
              <Download size={16} />
              {e.format.toUpperCase()}
              <span>
                <b>{!e.fileExists ? "文件缺失" : e.current ? "当前结果" : "非当前结果"}</b>
                <small>编排 {e.arrangement} · {new Date(e.createdAt).toLocaleString()}</small>
              </span>
            </a>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function RebindDialog({
  revision,
  roleVoices,
  rows,
  roles,
  voices,
  onClose,
  onSave,
}: {
  revision: number;
  roleVoices?: Record<string,string|null>;
  rows: Segment[];
  roles: Role[];
  voices: Voice[];
  onClose: () => void;
  onSave: (id: string, revision?: number) => Promise<void>;
}) {
  const [id, setId] = useState(roles.find((r) => !r.archived)?.id || "");
  const role = roles.find((r) => r.id === id);
  return (
    <Dialog title="改绑所选片段" onClose={onClose}>
      <Form label="确认改绑" revision={revision} onSubmit={async (_, expected) => onSave(id, expected)}>
        <Field label="改绑到已有角色">
          <Select
            value={id}
            label="目标角色"
            onChange={setId}
            options={roles
              .filter((r) => !r.archived)
              .map((r) => ({ value: r.id, label: r.name }))}
          />
        </Field>
        <p className="hint">
          只影响本章选中的 {rows.length}{" "}
          条。角色默认音色随角色切换；本条指定音色保留并重新核对身份。
        </p>
        <div className="rebind-preview">
          {rows.map((s) => (
            <div key={s.id}>
              <strong>
                第 {s.order + 1} 条 ·{" "}
                {roles.find((r) => r.id === s.roleId)?.name} → {role?.name}
              </strong>
              <p>{s.text}</p>
              <span className="hint">
                {voices.find((v) => v.id === s.voiceId)?.name || "未配置"} →{" "}
                {voices.find(
                  (v) =>
                    v.id ===
                    (s.voiceSource === "override" ? s.voiceId : role&&Object.hasOwn(roleVoices||{},role.id)?roleVoices?.[role.id]:role?.voiceId),
                )?.name || "待配置"}
                {s.voiceSource === "override" ? " · 保留本条指定" : ""}
              </span>
            </div>
          ))}
        </div>
      </Form>
    </Dialog>
  );
}

function DeleteVoiceDialog({
  voice,
  onClose,
  onDeleted,
}: {
  voice: Voice;
  onClose: () => void;
  onDeleted: () => Promise<void>;
}) {
  const [usage, setUsage] = useState<{
    chapters: { id: string; title: string; project: string; count: number }[];
    roles: string[];
    count: number;
  } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void api<typeof usage>(`/voices/${voice.id}/usage`)
      .then(setUsage)
      .catch((e) => setError(e.message));
  }, [voice.id]);
  return (
    <Dialog title="删除参考素材" onClose={onClose}>
      <p>
        删除「{voice.name}
        」的参考文件后，相关片段将无法再用它生成。已有音频和成品保留。
      </p>
      {error && (
        <p className="error-inline" role="alert">
          {error}
        </p>
      )}
      {usage ? (
        <Form
          label="确认删除参考文件"
          onSubmit={async (f) => {
            if (f.get("confirm") !== "on") throw new Error("请先确认删除影响");
            await action("voice.delete", { id: voice.id, confirm: true, entityRevision: voice.revision ?? 1 });
            await onDeleted();
          }}
        >
          <p className="hint">
            影响 {usage.count} 条片段；角色默认：
            {usage.roles.join("、") || "无"}
            。若有在途生成或正在读取，先停用并等待结束再删除。
          </p>
          <ul>
            {usage.chapters.map((c) => (
              <li key={c.id}>
                {c.project} / {c.title} · {c.count} 条
              </li>
            ))}
          </ul>
          <label className="check-label">
            <input name="confirm" type="checkbox" />
            我已了解影响，删除这份参考文件
          </label>
        </Form>
      ) : (
        !error && <p className="hint">正在检查引用…</p>
      )}
    </Dialog>
  );
}

function GenderField({ initial }: { initial: string }) {
  const [gender, setGender] = useState(initial);
  return (
    <Field label="本章确认的性别" hint="无法判断时保留未知；不从后续章节回填。">
      <input type="hidden" name="gender" value={gender} />
      <Select
        label="本章确认的性别"
        value={gender}
        options={["未知", "女", "男", "其他"].map((value) => ({
          value,
          label: value,
        }))}
        onChange={setGender}
      />
    </Field>
  );
}
