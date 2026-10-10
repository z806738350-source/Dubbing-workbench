import type { SchedulerStatus } from "./ConcurrencySettings";
export interface Voice {
  observations?: {tone: string; accent: string; performance: string; volume: string};
  inspection?: {target: "reference" | "sample"; audioId: string | null; checked: boolean; at: string};
  inspectionCurrent?: boolean;
  revision?: number;
  id: string;
  name: string;
  state: string;
  duration: number;
  tested: boolean;
  sampleAudioId?: string;
  deletePending?: boolean;
  deleteError?: string;
  sourceCandidateId?: string;
}
export interface VoiceCandidate {
  id: string;
  jobId: string;
  status: string;
  error?: string;
  audioId?: string;
  savedVoiceId?: string;
  referenceEligible?: boolean;
  discarded?: boolean;
  late?: boolean;
  input?: {description?: string};
  prompt?: string;
}
export interface VoiceSession {
  id: string;
  description: string;
  text: string;
  model: string;
  template: string;
  config: Segment["config"];
  revision: number;
  state: "active" | "abandoned";
  candidates: VoiceCandidate[];
}
export interface AliasSource {
  name: string;
  chapterId: string | null;
  kind?: string;
  sourceQuote?: string;
  reason?: string;
  sourceVersion?: number;
  needsReview?: boolean;
}
export interface Role {
  revision?: number;
  id: string;
  projectId: string;
  name: string;
  aliases: string[];
  aliasSources?: AliasSource[];
  aliasValidity?: Record<string, boolean>;
  voiceId: string | null;
  narrator: boolean;
  archived?: boolean;
  facts?: {
    chapterId: string;
    text: string;
    sourceQuote?: string;
    sourceVersion?: number;
    kind: string;
    gender?: string;
  }[];
}
export interface Project {
  revision?: number;
  id: string;
  name: string;
  contextRevision: number;
}
export interface Chapter {
  auditoryPolicy?: {version:1;mode:"legacy"|"conservative"};
  auditoryBoundaryPlan?: {version:number;mode:string;gapFrames:number[];shortenedBoundaries:number;boundaries:{leftUnitId:string;rightUnitId:string;gapFrames:number;originalGapFrames:number;reason:string;cueSegmentId?:string}[]};
  renderRevision?: number;
  renderSignature?: string | null;
  renderContentKey?: string | null;
  roleVoices?: Record<string,string | null>;
  productionStatus?: string;
  id: string;
  projectId: string;
  title: string;
  revision: number;
  arrangement: number;
  order: number;
  gap: number;
  source: string;
  sourceVersion?: number;
}
export interface Segment {
  identityPending?:boolean;
  configurationDecided?: boolean;
  analysisOrigin?: {draftId:string;itemId:string};
  protectedFields?: string[];
  decisions?: Record<string, {source:"human"|"human_accepted_ai"|"inherited"|"policy_ai"|"system";state?:"accepted"|"needsDecision";values:unknown;at:string;policyVersion?:number;draftId?:string}>;
  model?: string;
  id: string;
  chapterId: string;
  order: number;
  text: string;
  roleId: string;
  type: string;
  roleConfirmed: boolean;
  identityConfirmed: boolean;
  voiceId: string | null;
  voiceSource: string;
  performance: string;
  config: { speech_rate: number; loudness_rate: number; pitch_rate: number };
  template: string;
  excluded: boolean;
  deletion?: { at: string; excluded: boolean };
  editHistory?: { revision: number; text: string }[];
  source: {
    text?: string;
    kind: string;
    group?: string;
    spans: { start: number; end: number }[];
  };
  current: string | null;
  previous: string | null;
  approved: string | null;
  latest: string;
  validity: string;
  review: string;
  rangeContentKey?: string | null;
  prompt: string;
  promptIssues?: string[];
  audio: AudioRecord | null;
}

export interface ExperienceGrant {
  id: string;
  grantId: string;
  projectId: string;
  chapterId: string | null;
  steps: string[];
  materials: string[];
  voiceIds: string[];
  models: {text:string;audio:string};
  routes: {text:string;audio:string};
  textLimit: number;
  audioLimit: number;
  textUsed: number;
  audioUsed: number;
  textReserved: number;
  audioReserved: number;
  expiresAt: string | null;
  revoked: boolean;
  revision: number;
}
export interface ExperiencePolicy {projectId:string;mode:"smart"|"review";revision:number}
export interface PerformanceCoverage {
  chapterId:string;chapterRevision:number;sourceVersion:number;analysisContractVersion:string;
  eligibleCount:number;coveredCount:number;missingIds:string[];reviewRequiredIds:string[];waivedBasicIds:string[];
  excludedCount:number;deletedCount:number;retiredCount:number;
  currentRun:{writtenIds:string[];unchangedIds:string[];preservedHumanIds:string[];skippedChangedIds:string[];repairedIds:string[]};
  phase:"analyzing"|"validating"|"repairing"|"saving"|"complete"|"partial"|"review"|"ready"|"needsInput"|"needsAttention";
  affectedUnitIds?:string[];changeSetId?:string;uninitialized?:boolean;
}
export interface PerformanceReceipt {
  writtenIds:string[];unchangedIds:string[];preservedHumanIds:string[];skippedChangedIds:string[];repairedIds:string[];
  changeSetId?:string;coverage:PerformanceCoverage;affectedUnitIds?:string[];
}
export interface ExperienceState {policy:ExperiencePolicy;grants:ExperienceGrant[];changes:{changeId:string;chapterId:string;undoneAt?:string}[]}
export interface OperationResult<T = unknown> {
  operationId: string;
  kind: string;
  outcome: "completed"|"prepared"|"needsInput"|"processing"|"unknown";
  steps: Record<string,unknown>;
  jobIds: string[];
  createdObjectIds: string[];
  result?: T;
  error?: string;
  errorStatus?: number;
  dependencies?: {chapterId?:string;segmentIds:string[];unitIds:string[];roleIds:string[]};
}
export interface GenerationPlan {
  model?: string;
  actionKind?: "fillMissing"|"updateSelected"|"redoRejected"|"forceRegenerate";
  outstandingAttemptIds?: string[];
  rejectedUnits?: string[];
  chapterId:string;
  revision:number;
  arrangement:number;
  unitIds:string[];
  memberIds:string[];
  units:{unitId:string;members:string[];mode:"dry"|"scene";reuse:boolean;audioId:string|null;model?:string;referenceVoices?:{voiceId:string;revision:number;fileVersion:string}[];rejected?:boolean;outstandingAttemptIds?:string[];productionBeat?:Record<string,unknown>;guidance?:string;productionBeatReason?:string}[];
  productionBeatSkips?:{segmentIds:string[];reason:string}[];
  textRequests:number;
  audioRequests:number;
}
export interface AudioProvenanceMetadata {
  originalAudioId?: string;
  originalAvailability?: "retained" | "not-saved";
  provenance?: "provider-original" | "processed";
  processing?: {version?:string;profile?:string;reason?:string};
}
export interface AudioHistoryRecord extends AudioProvenanceMetadata {
  id:string;prompt:string;matched:boolean;selected:boolean;available?:boolean;createdAt?:string;duration?:number;
}
export interface AudioRecord extends AudioProvenanceMetadata {
  id: string;
  duration: number;
  input: Pick<
    Segment,
    "text" | "voiceId" | "performance" | "config" | "template"
  >;
}
export interface Master {
  renderRevision?: number;
  renderSignature?: string | null;
  renderContentKey?: string | null;
  id: string;
  arrangement: number;
  duration: number;
  sampleRate: number;
  mapping: {
    segmentId?: string;
    unitId?: string;
    memberIds?: string[];
    mode?: "dry" | "scene";
    audioId: string;
    startFrame: number;
    endFrame: number;
    clipStartFrame?: number;
    clipEndFrame?: number;
    sourceHash?: string;
    rangeRevision?: number;
    decodeProfile?: string;
    edgePolicy?: string;
    rangeContentKey?: string | null;
  }[];
}
export interface ExportRecord {
  renderRevision?: number;
  renderSignature?: string | null;
  renderContentKey?: string | null;
  path: string;
  fileExists: boolean;
  current: boolean;
  id: string;
  format: string;
  arrangement: number;
  createdAt: string;
}
export interface Job {
  counts?: {queued:number;preparing:number;inFlight:number;local:number;success:number;failed:number;unknown:number;stopped:number};
  attempts?: {id:string;ordinal:number;segmentId?:string;unitId?:string;mode?:string;memberNumbers:number[];phase:string;status:string;submitted:boolean|null}[];
  commandId?: string;
  resultAudioId?: string;
  resultNotSelected?: boolean;
  localRecoveryAttemptIds?: string[];
  localRecoveredAudioIds?: string[];
  ids?: string[];
  failed?: number;
  stopped?: number;
  unknown?: number;
  currentSegmentId?: string;
  elapsedSeconds?: number;
  voiceId?: string;
  sessionId?: string;
  unitIds?: string[];
  unitId?: string;
  mode?: "dry" | "scene";
  id: string;
  chapterId: string;
  kind: string;
  status: string;
  done: number;
  total: number;
  error?: string;
  stop: boolean;
  createdAt: string;
}
export interface SoundEvent {
  transition?: {memberId:string;quote:string;occurrence:number;development:string;volumeChange?:string};
  diagnostics?: string[];
  unitRevision?: number;
  chapterRevision?: number;
  id: string;
  unitId: string;
  kind: "environment" | "effect" | "music";
  description: string;
  memberId: string;
  position: "before" | "during" | "after";
  startMemberId?: string;
  endMemberId?: string;
  startPosition?: "before" | "during" | "after";
  endPosition?: "before" | "during" | "after";
  state: "draft" | "adopted" | "removed";
  validity: "valid" | "needsReview";
  revision?: number;
  evidence: {kind: string; quote?: string; quotes?: string[]; reason?: string};
}
export interface UnitVariant {
  resolvedCompilerId?: string;
  backgroundPresence?: "clear"|"natural"|"subtle"|"unspecified";
  outstandingAttemptIds?: string[];
  history?: AudioHistoryRecord[];
  guidance?: string;
  current: string | null;
  previous: string | null;
  approved: string | null;
  latest: string;
  revision: number;
  template?: string;
  status: {validity: string; review: string; audio: AudioRecord | null; prompt: string; promptIssues: string[]; basis: Record<string, unknown>;input?:{template:string}|null;rangeContentKey?:string|null};
}
export interface SceneReusePreview {
  id:string;draftVersion:number;chapterId:string;unitId:string;
  target:{chapterRevision:number;unitRevision:number;sceneRevision:number;contextRevision:number;sourceVersion:number};
  items:{itemId:string;historicalIssues:string[];currentIssues:string[];warnings:string[];alreadyIncluded:boolean;canReuse:boolean}[];
}
export interface GenerationUnit {
  sceneConflicts?: string[];
  scenePresenceWarnings?: string[];
  outstandingAttemptIds?: string[];
  readiness?: {generate:ActionReadiness;play:ActionReadiness;export:ActionReadiness};
  diagnostics?: string[];
  chapterRevision?: number;
  id: string;
  chapterId: string;
  kind: "single" | "group";
  members: string[];
  state: "active" | "pending" | "dissolved";
  revision: number;
  mode: "dry" | "scene";
  guidance: string;
  variants: {dry: UnitVariant; scene: UnitVariant};
}
export interface ActionReadiness {allowed:boolean;blockers:{code:string;scope:{unitId?:string;memberIds?:string[];mode?:"dry"|"scene"};message:string;resolution:string;attemptIds?:string[]}[];warnings:{code:string;message:string}[]}
export interface ChapterDetail extends Chapter {
  fidelity?: FidelitySummaryRecord;
  performanceCoverage?:PerformanceCoverage;
  outputDirectory: string;
  arrangementIssues?: string[];
  reviewItems?: {id:string;audioId:string|null;basis:Record<string,unknown>;rangeContentKey?:string|null}[];
  playbackItems: {id: string; unitId?: string; members?: string[]; mode?: "dry" | "scene"; audioId: string | null; basis: Record<string, unknown>; validity: string; review?: string; clipStartFrame?:number;clipEndFrame?:number;sourceFrames?:number;sourceHash?:string;decodeProfile?:string;rangeRevision?:number;edgePolicy?:string;rangeContentKey?:string|null}[];
  units?: GenerationUnit[];
  events?: SoundEvent[];
  knownRoles: Role[];
  segments: Segment[];
  deletedSegments?: Segment[];
  coverage: { valid: boolean; gaps: number; overlaps: number };
  masters: Master[];
  exports: ExportRecord[];
  suggestions: unknown[];
}
export interface State {
  sceneContract?: {descriptionMax:number;countUnit:string;promptMax:number;defaultTemplate?:string};
  enhancementTemplates?: {id:string;name:string;description?:string;mode:string;scope:string}[];
  templates: {id: string; name: string; description: string; current: boolean}[];
  projects: Project[];
  chapters: Omit<Chapter,"source">[];
  roles: Role[];
  voices: Voice[];
  voiceSessions?: VoiceSession[];
  jobs: Job[];
  settings: {
    storage?: {freeBytes:number|null;reservedBytes:number;safetyBytes:number;availableBytes:number|null;message?:string}|null;
    scheduler?: SchedulerStatus;
    workspaceIdentity?: string;
    workspaceDirectory: string;
    projectFolders: boolean;
    revision: number;
    configured: boolean;
    model: string;
    audioTools: boolean;
    routeBlocked: boolean;
    textModel: string;
    defaultGap: number;
    features?: {voiceCreation?: boolean; groups?: boolean; scenes?: boolean};
  };
}

export interface FidelitySummaryRecord {
  chapterId: string;
  projectId: string;
  scope: {kind:"current"|"historical";arrangement:number;sourceVersion:number};
  sourceCoverage: {valid:boolean;gaps:number;overlaps:number};
  textFidelity: {status:"retained"|"edited"|"mismatch"|"unknown";exact:number;punctuationEdits:number;wordEdits:number;unknown:number};
  participation: {active:number;excluded:number;deleted:number;retired:number;gaps:number;overlaps:number};
  spokenPayload: {status:"matched"|"mismatch"|"unknown";matched:number;missing:number;mismatches:number};
  audioProvenance: {originalAvailable:number;originalNotSaved:number;originalUnknown:number;referenceFrozen:number;referenceUnknown:number};
  listening: {reviewed:number;pending:number;quality:"not-assessed"};
}

export interface AudioRangeRecord {
  id: string;
  projectId: string;
  chapterId: string;
  unitId: string;
  mode: "dry" | "scene";
  audioId: string;
  sourceHash: string;
  decodeProfile: string;
  sampleRate: 48000;
  channels: number;
  sourceFrames: number;
  startFrame: number;
  endFrame: number;
  edgePolicy: "short-fade-v1";
  fadeInFrames: number;
  fadeOutFrames: number;
  revision: number;
  lastOperationId: string;
  updatedAt: string;
}
