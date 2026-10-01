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
  prompt: string;
  promptIssues?: string[];
  audio: AudioRecord | null;
}
export interface AudioRecord {
  id: string;
  duration: number;
  input: Pick<
    Segment,
    "text" | "voiceId" | "performance" | "config" | "template"
  >;
}
export interface Master {
  id: string;
  arrangement: number;
  duration: number;
  sampleRate: number;
  mapping: {
    segmentId: string;
    audioId: string;
    startFrame: number;
    endFrame: number;
  }[];
}
export interface ExportRecord {
  fileExists: boolean;
  current: boolean;
  id: string;
  format: string;
  arrangement: number;
  createdAt: string;
}
export interface Job {
  resultAudioId?: string;
  resultNotSelected?: boolean;
  ids?: string[];
  failed?: number;
  stopped?: number;
  unknown?: number;
  currentSegmentId?: string;
  elapsedSeconds?: number;
  voiceId?: string;
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
export interface ChapterDetail extends Chapter {
  playbackItems: {id: string; audioId: string | null; basis: Record<string, unknown>; validity: string}[];
  knownRoles: Role[];
  segments: Segment[];
  coverage: { valid: boolean; gaps: number; overlaps: number };
  masters: Master[];
  exports: ExportRecord[];
  suggestions: unknown[];
}
export interface State {
  templates: {id: string; name: string; description: string; current: boolean}[];
  projects: Project[];
  chapters: Chapter[];
  roles: Role[];
  voices: Voice[];
  jobs: Job[];
  settings: {
    revision: number;
    configured: boolean;
    model: string;
    audioTools: boolean;
    routeBlocked: boolean;
    textModel: string;
    defaultGap: number;
  };
}
