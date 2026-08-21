/**
 * postMessage contract between the extension host and the webview.
 * Shared mental model — the extension host never speaks HTTP/WS to the
 * webview; it forwards already-parsed frames and typed commands back.
 *
 * Raw mux payloads / history entries pass through as `unknown` (loose JSON):
 * the fold in the webview interprets them; the extension host does NOT
 * re-interpret session events (incremental by construction).
 */

export type ConnState = "connecting" | "connected" | "disconnected" | "starting";

export interface SessionItem {
  sessionId: string;
  title?: string;
  running: boolean;
  blank: boolean;
  cwd?: string;
  agentPreset?: string;
}

export interface ModelsData {
  current: { provider: string; model: string; reasoningEffort?: string };
  routable: boolean;
  groups: {
    id: string;
    name: string;
    models: { id: string; name: string; description?: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[];
  }[];
  failures: { id: string; name: string; message: string }[];
}

export type PromptPart =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; data: string; name?: string }
  /** Placeholder expanded host-side into a real [引用文件 …] text part
   *  (the webview cannot read the filesystem). */
  | { type: "file"; path: string; rel?: string };

export interface QueueItem {
  id: string;
  placement: string;
  text: string;
}

export interface ApprovalCard {
  sessionId: string;
  approvalId: string;
  rpcId: string;
  toolName?: string;
  reason?: string;
  extra?: Record<string, string>;
}

export interface QuestionCard {
  sessionId: string;
  rpcId: string;
  questions: {
    id: string;
    question: string;
    header?: string;
    multi?: boolean;
    options?: { label: string; description?: string }[];
  }[];
}

export interface PermissionData {
  value: string | null;
  revision: number | null;
  presets: { id: string; label: string }[];
}

export interface PresetData {
  presets: { id: string; name?: string; description?: string; isDefault: boolean; broken?: string }[];
}

/** extension host -> webview */
export type ExtToView =
  | { t: "hello" }
  | { t: "conn"; state: ConnState; baseUrl?: string }
  | { t: "sessions"; items: SessionItem[]; current?: string }
  | { t: "history"; sessionId: string; entries: unknown[]; hasMore: boolean }
  | { t: "history-older"; sessionId: string; entries: unknown[]; hasMore: boolean }
  | { t: "mux-batch"; sessionId: string; frames: unknown[] }
  | { t: "approval"; card: ApprovalCard }
  | { t: "approval-gone"; approvalId: string }
  | { t: "question"; card: QuestionCard }
  | { t: "question-gone"; rpcId: string }
  | { t: "models"; sessionId: string; data: ModelsData }
  | { t: "queue"; sessionId: string; items: QueueItem[] }
  | { t: "projection"; sessionId: string; key: string; value: unknown }
  | { t: "tokens"; label: string }
  | { t: "permission"; data: PermissionData }
  | { t: "presets"; data: PresetData }
  | { t: "inject-attachment"; label: string; text: string }
  | { t: "files"; reqId: number; items: { path: string; rel: string }[] }
  | { t: "notify"; kind: "info" | "warn" | "error"; message: string };

/** webview -> extension host */
export type ViewToExt =
  | { t: "ready" }
  | { t: "prompt"; sessionId: string; mode: "queue" | "steer"; parts: PromptPart[] }
  | { t: "cancel"; sessionId: string }
  | { t: "new-session" }
  | { t: "switch"; sessionId: string }
  | { t: "rename"; sessionId: string; title: string }
  | { t: "fork-session"; sessionId: string }
  | { t: "archive-session"; sessionId: string }
  | { t: "respond-approval"; rpcId: string; sessionId: string; approvalId: string; outcome: "allowed-once" | "rejected" }
  | { t: "respond-question"; rpcId: string; sessionId: string; answers: { id: string; selected: string[]; custom?: string }[] }
  | { t: "select-model"; sessionId: string; provider: string; model: string; reasoningEffort?: string }
  | { t: "select-preset"; sessionId: string; agentPreset: string }
  | { t: "set-session-permission"; sessionId: string; preset: string }
  | { t: "get-models"; sessionId: string }
  | { t: "queue-remove"; sessionId: string; itemId: string }
  | { t: "load-older"; sessionId: string; beforeSeq: number }
  | { t: "list-files"; reqId: number; query: string }
  | { t: "open-diff"; callId: string }
  | { t: "log"; message: string };
