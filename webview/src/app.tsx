import { useMemo, useRef, useState, useEffect } from "react";
import type { ReactNode } from "react";
import type {
  ApprovalCard,
  ConnState,
  ExtToView,
  ModelsData,
  PermissionData,
  PresetData,
  PromptPart,
  QuestionCard,
  QueueItem,
  SessionItem,
  SettingsNs,
  ViewToExt,
  WorkspaceView,
} from "./protocol.js";
import { ConversationFold, stripSystemContext, type FoldImage, type FoldItem, type ToolActivity, type TurnItem } from "./fold.js";

/** HH:MM:SS clock for jobs / trajectory rows. */
function fmtClock(ms: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact duration (ms → "1分23秒" / "45秒"). */
function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}分${s % 60}秒`;
  return `${Math.floor(m / 60)}时${m % 60}分`;
}
import { Markdown } from "./components/markdown.js";
import { ActivityCard } from "./components/activity.js";
import { ApprovalCardView, QuestionCardView } from "./components/cards.js";
import { Icon } from "./components/icons.js";

declare function acquireVsCodeApi(): { postMessage(m: ViewToExt): void; getState(): unknown; setState(s: unknown): void };

// The boot-error hook (panel.ts inline script) may have acquired the API
// first — acquireVsCodeApi can be called only ONCE per webview.
const vscodeApi = (window as unknown as { __dshApi?: { postMessage(m: ViewToExt): void } }).__dshApi ?? acquireVsCodeApi();
(window as unknown as { __dshApi?: unknown }).__dshApi = vscodeApi;
const post = (m: ViewToExt) => vscodeApi.postMessage(m);

const RENDER_WINDOW = 250; // items rendered max; older pages on demand

// ---- durable-image cache (webview-side, keyed by attachmentId) ----
// The fold carries refs only; bytes are pulled on demand via the extension
// host (protocol knowledge stays host-side) and cached here. Survives re-folds
// (settle reloads, older pages) — only a webview reload refetches.
type ImgEntry = { mediaType: string; data: string } | "loading" | "error";
const imgCache = new Map<string, ImgEntry>();
const IMG_CACHE_MAX = 32;
const imgListeners = new Set<() => void>();
function imgNotify(): void {
  for (const l of imgListeners) l();
}
function imgCacheSet(id: string, entry: ImgEntry): void {
  imgCache.delete(id); // LRU touch: re-insert at the end
  imgCache.set(id, entry);
  while (imgCache.size > IMG_CACHE_MAX) {
    const oldest = imgCache.keys().next().value;
    if (oldest === undefined) break;
    imgCache.delete(oldest);
  }
  imgNotify();
}

export function App() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [items, setItems] = useState<FoldItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [models, setModels] = useState<ModelsData | undefined>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [editingQueueId, setEditingQueueId] = useState<string | null>(null);
  const [queueEditText, setQueueEditText] = useState("");
  const [tokens, setTokens] = useState<string>("");
  const [ctxPct, setCtxPct] = useState<number | undefined>();
  // goal projection: {goal:{id,revision,objective,phase,maxGoalRounds,blockedReason?},roundsStarted,…}
  const [goalData, setGoalData] = useState<any>(null);
  const [notify, setNotify] = useState<{ kind: string; message: string } | undefined>();
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [permission, setPermission] = useState<PermissionData | undefined>();
  const [presetData, setPresetData] = useState<PresetData | undefined>();
  const [draft, setDraft] = useState("");
  const [drawer, setDrawer] = useState<"" | "sessions" | "workspace" | "jobs" | "traj" | "subs" | "settings">("");
  // trajectory raw events (capped; fed from history + live mux frames)
  const [rawEvents, setRawEvents] = useState<{ event: { type: string; seq: number; time?: number; data?: any }; view?: any }[]>([]);
  const [jobs, setJobs] = useState<{ id: string; kind: string; label: string; status: string; detail?: string; startedAt: number; finishedAt?: number }[]>([]);
  const [subagentEntries, setSubagentEntries] = useState<{ id: string; mode: string; label: string; activity: string; hasChildren: boolean }[]>([]);
  // subagent transcript sheet: which child is open + its history events
  const [subView, setSubView] = useState<{ id: string; label?: string; mode: string; activity: string } | null>(null);
  const [subEvents, setSubEvents] = useState<{ event: { type: string; seq?: number; time?: number; data?: any }; view?: any }[] | null>(null);
  const [subDraft, setSubDraft] = useState("");
  // settings sheet (settings/describe + settings/update)
  const [settingsData, setSettingsData] = useState<{ writable: boolean; hasDocument: boolean; namespaces: SettingsNs[] } | null>(null);
  const [settingsEdits, setSettingsEdits] = useState<Record<string, unknown>>({});
  const [settingsError, setSettingsError] = useState<string | null>(null);
  // workspace sheet: real server workspaces + management state
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([]);
  const [wsArchived, setWsArchived] = useState<Set<string>>(new Set());
  const [wsRenaming, setWsRenaming] = useState<{ id: string; title: string } | null>(null);
  const [wsDelConfirm, setWsDelConfirm] = useState<string | null>(null);
  const [wsMoveFor, setWsMoveFor] = useState<string | null>(null);
  const [wsQuery, setWsQuery] = useState("");
  const [trajFilter, setTrajFilter] = useState("");
  const [trajOpenSeq, setTrajOpenSeq] = useState<number | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const pickReqRef = useRef(0);
  const [renaming, setRenaming] = useState<{ sessionId: string; title: string } | undefined>();
  const [running, setRunning] = useState(false);
  // unread dots: a non-current session that finished a run while we watched
  const [unread, setUnread] = useState<Set<string>>(new Set());
  const prevRunningRef = useRef<Map<string, boolean>>(new Map());
  // plan mode + todos arrive as session projections ("plan" / "todos")
  const [planActive, setPlanActive] = useState(false);
  const [todos, setTodos] = useState<{ content: string; status: string }[] | null>(null);
  const [todoOpen, setTodoOpen] = useState(false);
  // @ file completion + / skill-command completion: attachments + popup state
  const [fileAtt, setFileAtt] = useState<{ path: string; rel: string }[]>([]);
  const [filePopup, setFilePopup] = useState<{ items: { path: string; rel: string }[]; sel: number; tokenStart: number } | undefined>();
  const fileReqRef = useRef(0);
  const fileDebounceRef = useRef<number>(0);
  // slash menu: skills (insert `/name `) + built-in commands (dispatch)
  const [slashPopup, setSlashPopup] = useState<{ items: { kind: "skill" | "command"; name: string; description: string }[]; sel: number; tokenStart: number; query: string } | undefined>();
  const slashReqRef = useRef(0);
  const slashCacheRef = useRef<{ at: number; items: { kind: "skill" | "command"; name: string; description: string }[] } | undefined>();
  const SLASH_TTL = 60_000;

  const foldRef = useRef(new ConversationFold());
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const hasMoreRef = useRef(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const imgInputRef = useRef<HTMLInputElement>(null);
  const loadingOlderRef = useRef(false);
  // Scroll anchor for prepended history: {height, top} captured before the
  // load fires; after render, scrollTop is restored so the viewport stays on
  // the message the user was reading instead of jumping to the batch's oldest.
  const anchorRef = useRef<{ height: number; top: number } | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const m = e.data as ExtToView;
      if (!m || typeof m.t !== "string") return;
      switch (m.t) {
        case "conn":
          setConn(m.state);
          break;
        case "sessions":
          setSessions(m.items);
          setCurrent(m.current);
          break;
        case "history": {
          const fold = new ConversationFold();
          fold.pushMany(m.entries);
          hasMoreRef.current = m.hasMore;
          foldRef.current = fold;
          loadingOlderRef.current = false;
          anchorRef.current = null;
          setLoadingOlder(false);
          setItems([...fold.items]);
          setRunning(fold.isRunning);
          setRawEvents((m.entries as any[]).slice(-800));
          break;
        }
        case "history-older": {
          foldRef.current.unshiftMany(m.entries);
          hasMoreRef.current = m.hasMore;
          loadingOlderRef.current = false;
          setLoadingOlder(false);
          setItems([...foldRef.current.items]);
          setRawEvents((re) => [...(m.entries as any[]), ...re].slice(-800));
          break;
        }
        case "mux-batch": {
          if (!current || m.sessionId !== current) break; // only the active session renders
          foldRef.current.pushMany(m.frames);
          setItems([...foldRef.current.items]);
          setRunning(foldRef.current.isRunning);
          setRawEvents((re) => [...re, ...(m.frames as any[])].slice(-800));
          break;
        }
        case "approval":
          setApprovals((a) => [...a.filter((x) => x.approvalId !== m.card.approvalId), m.card]);
          break;
        case "approval-gone":
          setApprovals((a) => a.filter((x) => x.approvalId !== m.approvalId));
          break;
        case "question":
          setQuestions((q) => [...q.filter((x) => x.rpcId !== m.card.rpcId), m.card]);
          break;
        case "question-gone":
          setQuestions((q) => q.filter((x) => x.rpcId !== m.rpcId));
          break;
        case "models":
          setModels(m.data);
          break;
        case "permission":
          setPermission((prev) => (prev && prev.presets.length > 0 ? { ...m.data, presets: prev.presets } : m.data));
          break;
        case "presets":
          setPresetData(m.data);
          break;
        case "files":
          // Only the latest request renders; stale responses are dropped.
          setFilePopup((cur) =>
            m.reqId === fileReqRef.current && cur
              ? { ...cur, items: m.items, sel: Math.min(cur.sel, Math.max(0, m.items.length - 1)) }
              : cur,
          );
          break;
        case "slash": {
          if (m.reqId !== slashReqRef.current) break; // stale response
          slashCacheRef.current = { at: Date.now(), items: m.items };
          setSlashPopup((cur) => (cur ? { ...cur, items: m.items, sel: Math.min(cur.sel, Math.max(0, m.items.length - 1)) } : cur));
          break;
        }
        case "queue":
          setQueue(m.items);
          break;
        case "projection":
          // Session-scoped UI state must never leak across sessions: pushes
          // arrive for EVERY session (background runs included) — a foreign
          // todo list / plan banner / token readout overwriting this panel
          // was a real cross-session contamination bug.
          if (m.sessionId !== current) break;
          if (m.key === "tokenUsage" || m.key === "liveTokenUsage") {
            const v = (m.value ?? {}) as Record<string, number>;
            const parts: string[] = [];
            if (v.outputTokens != null) parts.push(`输出 ${v.outputTokens}`);
            if (v.uncachedInputTokens != null) parts.push(`输入 ${v.uncachedInputTokens}`);
            if (v.cacheReadTokens != null) parts.push(`缓存命中 ${v.cacheReadTokens}`);
            setTokens(parts.join(" · "));
          } else if (m.key === "contextPressure" && m.value != null) {
            const v = m.value as any;
            const pct = typeof v === "number" ? v : (v.percent ?? v.ratio);
            setCtxPct(typeof pct === "number" ? Math.max(0, Math.min(1, pct)) : undefined);
          } else if (m.key === "goal") {
            setGoalData(m.value ?? null);
          } else if (m.key === "plan") {
            setPlanActive(Boolean((m.value as any)?.active));
          } else if (m.key === "todos") {
            setTodos(Array.isArray(m.value) ? (m.value as { content: string; status: string }[]) : null);
          }
          break;
        case "notify":
          setNotify({ kind: m.kind, message: m.message });
          setTimeout(() => setNotify(undefined), 6000);
          break;
        case "picked": {
          if (m.reqId !== pickReqRef.current) break; // stale response
          setFileAtt((f) => [...f, ...m.items.filter((it) => !f.some((x) => x.path === it.path))]);
          break;
        }
        case "jobs":
          if (!current || m.sessionId !== current) break;
          setJobs(m.jobs);
          break;
        case "subagents":
          if (!current || m.sessionId !== current) break;
          setSubagentEntries(m.entries as any);
          break;
        case "subagent-history":
          setSubEvents(m.entries as any);
          break;
        case "workspaces":
          setWorkspaces((m.items ?? []) as any);
          setWsArchived(new Set(m.archivedSessionIds ?? []));
          break;
        case "settings-describe":
          setSettingsData(m.data);
          setSettingsError(null);
          break;
        case "settings-saved":
          if (m.ok) {
            setSettingsEdits({});
          } else {
            setSettingsError(`${m.ns}：${m.error ?? "保存失败"}`);
          }
          break;
        case "attachment":
          if (m.data) imgCacheSet(m.attachmentId, { mediaType: m.mediaType, data: m.data });
          else imgCacheSet(m.attachmentId, "error");
          break;
        case "attachment-error":
          imgCacheSet(m.attachmentId, "error");
          break;
        default:
          break;
      }
    };
    window.addEventListener("message", handler);
    post({ t: "ready" });
    return () => window.removeEventListener("message", handler);
  }, [current]);

  useEffect(() => {
    const openDiff = (e: Event) => {
      const callId = (e as CustomEvent<string>).detail;
      if (callId) post({ t: "open-diff", callId });
    };
    window.addEventListener("dsh-open-diff", openDiff);
    return () => window.removeEventListener("dsh-open-diff", openDiff);
  }, []);

  // reset session-scoped UI state when the current session changes (fresh
  // values arrive right after via the seeded projections in the history load)
  useEffect(() => {
    setPlanActive(false);
    setTodos(null);
    setTodoOpen(false);
    setCtxPct(undefined);
    setGoalData(null);
    setJobs([]);
    setSubagentEntries([]);
    setRawEvents([]);
  }, [current]);

  // Restore scroll after prepended history (runs before the pinned autoscroll
  // effect by declaration order; prepending never coincides with pin-to-bottom
  // since the user is at the top when it fires).
  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight - anchor.height + anchor.top;
    anchorRef.current = null;
  }, [items]);

  // Autoscroll when pinned to bottom.
  useEffect(() => {
    const el = listRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [items, approvals, questions]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    // Infinite scroll upward: hit the top → load one older page automatically.
    if (el.scrollTop <= 40 && hasMoreRef.current && !loadingOlderRef.current) {
      const before = foldRef.current.oldestSeq;
      if (before >= 0 && current) {
        loadingOlderRef.current = true;
        setLoadingOlder(true);
        anchorRef.current = { height: el.scrollHeight, top: el.scrollTop };
        post({ t: "load-older", sessionId: current, beforeSeq: before });
        // Watchdog: if the response never arrives (disconnect), re-arm.
        window.setTimeout(() => {
          if (loadingOlderRef.current) {
            loadingOlderRef.current = false;
            setLoadingOlder(false);
          }
        }, 4000);
      }
    }
  };

  const send = (parts: PromptPart[]) => {
    if (!current || parts.length === 0) return;
    post({ t: "prompt", sessionId: current, mode, parts });
    setDraft("");
    setFileAtt([]);
    setFilePopup(undefined);
    pinnedRef.current = true;
  };

  /** Draft change + @token/@file & /slash detection (token = word before the caret). */
  const onDraftChange = (value: string, caret: number): void => {
    setDraft(value);
    const before = value.slice(0, caret);
    // slash menu: `/word` at a line start (skill gesture grammar: [a-z0-9-]+)
    const sl = /(?:^|\n)[ \t]*\/([a-z0-9-]*)$/.exec(before);
    if (sl && current) {
      const tokenStart = caret - sl[1].length - 1; // index of '/'
      setFilePopup(undefined);
      const cached = slashCacheRef.current;
      if (cached && Date.now() - cached.at < SLASH_TTL) {
        const q = sl[1];
        const items = q ? cached.items.filter((it) => it.name.startsWith(q)) : cached.items;
        setSlashPopup({ items, sel: 0, tokenStart, query: q });
        return;
      }
      setSlashPopup({ items: [], sel: 0, tokenStart, query: sl[1] });
      slashReqRef.current += 1;
      post({ t: "list-slash", reqId: slashReqRef.current, sessionId: current });
      return;
    }
    setSlashPopup(undefined);
    const m = /(?:^|\s)@([^\s@]*)$/.exec(before);
    if (!m) {
      setFilePopup(undefined);
      return;
    }
    const tokenStart = caret - m[1].length - 1; // index of '@'
    setFilePopup({ items: [], sel: 0, tokenStart });
    window.clearTimeout(fileDebounceRef.current);
    fileDebounceRef.current = window.setTimeout(() => {
      fileReqRef.current += 1;
      post({ t: "list-files", reqId: fileReqRef.current, query: m[1] });
    }, 120);
  };

  /** Pick a slash entry: skill inserts `/name ` (host pre-step gesture injects
   *  its content); built-in command dispatches via RPC and clears the token. */
  const pickSlash = (it: { kind: "skill" | "command"; name: string }): void => {
    const p = slashPopup;
    setSlashPopup(undefined);
    if (!p || !current) return;
    const end = taRef.current?.selectionStart ?? draft.length;
    if (it.kind === "skill") {
      const next = `${draft.slice(0, p.tokenStart)}/${it.name} ${draft.slice(end)}`;
      setDraft(next);
      const caret = p.tokenStart + it.name.length + 2;
      window.setTimeout(() => taRef.current?.setSelectionRange(caret, caret), 0);
    } else {
      const next = draft.slice(0, p.tokenStart) + draft.slice(end).replace(/^\s+/, "");
      setDraft(next);
      post({ t: "run-command", sessionId: current, line: `/${it.name}` });
    }
  };

  /** Pick a file from the popup: strip the @token, add an attachment chip. */
  const pickFile = (f: { path: string; rel: string }): void => {
    setFilePopup((p) => {
      if (!p) return undefined;
      const end = taRef.current?.selectionStart ?? draft.length;
      const next = draft.slice(0, p.tokenStart) + draft.slice(end);
      setDraft(next);
      // caret lands right where the token was removed
      window.setTimeout(() => taRef.current?.setSelectionRange(p.tokenStart, p.tokenStart), 0);
      return undefined;
    });
    setFileAtt((xs) => (xs.some((x) => x.path === f.path) ? xs : [...xs, f]));
  };

  const onSendDraft = () => {
    const text = draft.trim();
    if (!text && fileAtt.length === 0) return;
    const parts: PromptPart[] = [];
    if (text) parts.push({ type: "text", text });
    for (const a of fileAtt) parts.push({ type: "file", path: a.path, rel: a.rel });
    send(parts);
  };

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) {
      const data = await fileToBase64(f);
      if (data) send([{ type: "image", mediaType: f.type, data }]);
    }
  };

  const visible = useMemo(() => items.slice(-RENDER_WINDOW), [items]);
  const hiddenCount = Math.max(0, items.length - visible.length);
  const currentSession = sessions.find((s) => s.sessionId === current);
  const currentTitle = currentSession?.title ?? (current ? "新会话" : "—");
  const busy = running || sessions.find((s) => s.sessionId === current)?.running === true;
  // unread flip detection: running→idle on a session we are NOT looking at
  useEffect(() => {
    const prev = prevRunningRef.current;
    const flips: string[] = [];
    for (const s of sessions) {
      const was = prev.get(s.sessionId);
      if (was === true && !s.running && s.sessionId !== current) flips.push(s.sessionId);
      prev.set(s.sessionId, s.running);
    }
    if (flips.length > 0) setUnread((u) => new Set([...u, ...flips]));
  }, [sessions, current]);
  const stats = useMemo(() => {
    let turns = 0;
    let tools = 0;
    for (const it of items) {
      if (it.kind === "turn" && it.ended) {
        turns++;
        tools += it.activities.length;
      }
    }
    return { turns, tools };
  }, [items]);
  const liveTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "turn") return it.liveTool;
    }
    return undefined;
  }, [items]);

  return (
    <div className="app">
      {/* header — two rows: session row + tool row (competitor layout) */}
      <div className="header">
        <div className="header-row header-session-row">
          <span className={`dot dot-${conn}`} title={conn} />
          <button className="title-btn" onClick={() => setDrawer((d) => (d === "sessions" ? "" : "sessions"))} title="点击切换会话；✎ 重命名">
            <span className="title-text">{currentTitle}</span>
            <span className="chev">⌄</span>
          </button>
          <button
            className="icon-btn mini"
            title="重命名会话"
            onClick={() => current && setRenaming({ sessionId: current, title: currentTitle === "—" ? "" : currentTitle })}
          >
            <Icon name="edit" size={12} />
          </button>
        </div>
        <div className="header-row header-tool-row">
          <PresetPicker
            presets={presetData}
            current={current}
            presetOf={currentSession?.agentPreset}
            locked={!currentSession?.blank}
            onSelect={(p) => current && post({ t: "select-preset", sessionId: current, agentPreset: p })}
          />
          <span className="spacer" />
          <button
            className={`icon-btn${drawer === "workspace" ? " is-on" : ""}`}
            title="工作区：分组 / 重排 / 归档 / 移组"
            onClick={() => {
              const opening = drawer !== "workspace";
              setDrawer((d) => (d === "workspace" ? "" : "workspace"));
              if (opening) post({ t: "list-workspaces" });
            }}
          >
            <Icon name="folder" size={13} />
          </button>
          <button
            className={`icon-btn${drawer === "jobs" ? " is-on" : ""}`}
            title="后台任务：本会话 agent 启动的 bash/pwsh/子代理任务"
            onClick={() => setDrawer((d) => (d === "jobs" ? "" : "jobs"))}
          >
            <Icon name="ledger" size={13} />
          </button>
          <button
            className={`icon-btn${drawer === "traj" ? " is-on" : ""}`}
            title="轨迹：事件台账（原始事件流）"
            onClick={() => setDrawer((d) => (d === "traj" ? "" : "traj"))}
          >
            <Icon name="list" size={13} />
          </button>
          <button
            className={`icon-btn${drawer === "subs" ? " is-on" : ""}`}
            title="子代理目录"
            onClick={() => {
              const opening = drawer !== "subs";
              setDrawer((d) => (d === "subs" ? "" : "subs"));
              if (current && opening) post({ t: "list-subagents", reqId: Date.now(), sessionId: current });
            }}
          >
            <Icon name="box" size={13} />
          </button>
          <button
            className={`icon-btn${drawer === "settings" ? " is-on" : ""}`}
            title="设置：服务器设置表单（模型 / 界面 / Agent 行为）"
            onClick={() => {
              const opening = drawer !== "settings";
              setDrawer((d) => (d === "settings" ? "" : "settings"));
              if (opening) post({ t: "get-settings" });
            }}
          >
            <Icon name="gear" size={13} />
          </button>
          <button className="icon-btn" title="在浏览器打开 DSH GUI" onClick={() => post({ t: "open-browser" })}>
            <Icon name="globe" size={13} />
          </button>
          <button className="icon-btn" title="新建会话" onClick={() => post({ t: "new-session" })}>
            <Icon name="plus" size={13} />
          </button>
        </div>
      </div>

      {/* goal dock bar — active-session goal projection (GUI GoalBar look) */}
      <GoalBar data={goalData} />
      {drawer === "sessions" && (
        <Sheet title="会话列表" onClose={() => setDrawer("")}>
        <div className="session-list">
          {sessions.length === 0 && <div className="muted pad">（暂无会话）</div>}
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`session-row ${s.sessionId === current ? "is-current" : ""}`}
              onClick={() => {
                setDrawer("");
                setUnread((u) => {
                  if (!u.has(s.sessionId)) return u;
                  const n = new Set(u);
                  n.delete(s.sessionId);
                  return n;
                });
                post({ t: "switch", sessionId: s.sessionId });
              }}
              title={s.cwd ?? s.sessionId}
            >
              <span className={`dot dot-${s.running ? "running" : "idle"}`} />
              {unread.has(s.sessionId) && <span className="unread-dot" title="有新消息" />}
              <span className="session-title">{s.title ?? "（未命名会话）"}</span>
              {s.subagents && s.subagents.total > 0 && (
                <span
                  className={`subagent-badge${s.subagents.running > 0 ? " is-busy" : ""}`}
                  title={`${s.subagents.total} 个子代理任务（${s.subagents.running} 个进行中）— 子代理详情在 DSH 本体会话页查看`}
                >
                  🔧 {s.subagents.running > 0 ? `${s.subagents.running}/${s.subagents.total}` : s.subagents.total}
                </span>
              )}
              <button
                className="icon-btn mini"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming({ sessionId: s.sessionId, title: s.title ?? "" });
                }}
              >
                <Icon name="edit" size={12} />
              </button>
              <button
                className="icon-btn mini"
                title="分叉会话（从最后一个完成的轮次复制出新会话）"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ t: "fork-session", sessionId: s.sessionId });
                }}
              >
                <Icon name="branch" size={12} />
              </button>
              <button
                className="icon-btn mini"
                title="归档（从列表隐藏，可在 DSH 网页版找回）"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ t: "archive-session", sessionId: s.sessionId });
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
          ))}
        </div>
        </Sheet>
      )}

      {/* workspace sheet — REAL server workspaces (rename/move/delete/add,
          session archive + move between groups) + ungrouped fallback */}
      {drawer === "workspace" && (
        <Sheet
          title="📁 工作区"
          onClose={() => setDrawer("")}
          headControls={
            <>
              <input
                className="drawer-search sheet-search"
                placeholder="搜索会话标题…"
                value={wsQuery}
                onChange={(e) => setWsQuery(e.target.value)}
              />
              <button className="link-btn" title="选择一个文件夹注册为工作区" onClick={() => post({ t: "workspace-add" })}>
                ＋ 工作区
              </button>
            </>
          }
        >
          {(() => {
            const q = wsQuery.trim().toLowerCase();
            const match = (s: SessionItem) => !q || (s.title ?? "").toLowerCase().includes(q);
            const openSession = (sessionId: string) => {
              setDrawer("");
              setUnread((u) => {
                if (!u.has(sessionId)) return u;
                const n = new Set(u);
                n.delete(sessionId);
                return n;
              });
              post({ t: "switch", sessionId });
            };
            const sessionRow = (s: SessionItem, groupId?: string) => {
              if (wsMoveFor === s.sessionId) {
                return (
                  <div key={s.sessionId} className="session-row ws-move-row">
                    <span className="muted tiny">移到分组：</span>
                    {workspaces
                      .filter((w) => w.workspaceId !== groupId)
                      .map((w) => (
                        <button
                          key={w.workspaceId}
                          className="link-btn"
                          onClick={() => {
                            post({ t: "workspace-move-session", sessionId: s.sessionId, toWorkspaceId: w.workspaceId });
                            setWsMoveFor(null);
                          }}
                        >
                          {w.title}
                        </button>
                      ))}
                    <button className="link-btn" onClick={() => setWsMoveFor(null)}>取消</button>
                  </div>
                );
              }
              return (
                <div
                  key={s.sessionId}
                  className={`session-row ${s.sessionId === current ? "is-current" : ""}`}
                  title={s.cwd ?? s.sessionId}
                  onClick={() => openSession(s.sessionId)}
                >
                  <span className={`dot dot-${s.running ? "running" : "idle"}`} />
                  <span className="session-title">{s.title ?? "（未命名会话）"}</span>
                  <button
                    className="icon-btn mini"
                    title="移到其他工作区分组"
                    onClick={(e) => {
                      e.stopPropagation();
                      setWsMoveFor(s.sessionId);
                    }}
                  >
                    <Icon name="box" size={12} />
                  </button>
                  <button
                    className="icon-btn mini"
                    title="归档（从列表隐藏，可在 DSH 网页版找回）"
                    onClick={(e) => {
                      e.stopPropagation();
                      post({ t: "archive-session", sessionId: s.sessionId });
                    }}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                </div>
              );
            };
            const byId = new Map(sessions.map((s) => [s.sessionId, s]));
            const grouped = new Set(workspaces.flatMap((w) => w.sessionIds ?? []));
            const ungrouped = sessions.filter((s) => !grouped.has(s.sessionId) && !wsArchived.has(s.sessionId) && match(s));

            return (
              <>
                {workspaces.map((w, i) => {
                  const rows = (w.sessionIds ?? [])
                    .filter((sid) => byId.has(sid) && !wsArchived.has(sid) && match(byId.get(sid)!))
                    .map((sid) => byId.get(sid)!);
                  return (
                    <div key={w.workspaceId} className="ws-group">
                      <div className="ws-group-title" title={w.path}>
                        {wsRenaming?.id === w.workspaceId ? (
                          <input
                            autoFocus
                            className="settings-input"
                            value={wsRenaming.title}
                            onChange={(e) => setWsRenaming({ id: w.workspaceId, title: e.target.value })}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && wsRenaming.title.trim()) {
                                post({ t: "workspace-rename", workspaceId: w.workspaceId, title: wsRenaming.title.trim() });
                                setWsRenaming(null);
                              } else if (e.key === "Escape") setWsRenaming(null);
                            }}
                            onBlur={() => setWsRenaming(null)}
                          />
                        ) : (
                          <>
                            📁 {w.title} <span className="muted">({rows.length})</span>
                            <button className="icon-btn mini" title="重命名" onClick={() => setWsRenaming({ id: w.workspaceId, title: w.title })}>
                              <Icon name="edit" size={11} />
                            </button>
                            <button className="icon-btn mini" title="上移" disabled={i === 0} onClick={() => post({ t: "workspace-move", workspaceId: w.workspaceId, beforeWorkspaceId: workspaces[i - 1]?.workspaceId })}>
                              <Icon name="up" size={11} />
                            </button>
                            <button className="icon-btn mini" title="下移" disabled={i === workspaces.length - 1} onClick={() => post({ t: "workspace-move", workspaceId: workspaces[i + 1]?.workspaceId, beforeWorkspaceId: w.workspaceId })}>
                              <Icon name="down" size={11} />
                            </button>
                            {wsDelConfirm === w.workspaceId ? (
                              <span>
                                <button className="link-btn" onClick={() => { post({ t: "workspace-delete", workspaceId: w.workspaceId }); setWsDelConfirm(null); }}>确认删除</button>
                                <button className="link-btn" onClick={() => setWsDelConfirm(null)}>取消</button>
                              </span>
                            ) : (
                              <button className="icon-btn mini" title="删除分组（会话不删除，归入未分组）" onClick={() => setWsDelConfirm(w.workspaceId)}>
                                <Icon name="trash" size={11} />
                              </button>
                            )}
                          </>
                        )}
                      </div>
                      {rows.map((s) => sessionRow(s, w.workspaceId))}
                    </div>
                  );
                })}
                {ungrouped.length > 0 && (
                  <div className="ws-group">
                    <div className="ws-group-title">📄 未分组 <span className="muted">({ungrouped.length})</span></div>
                    {ungrouped.map((s) => sessionRow(s))}
                  </div>
                )}
                {workspaces.length === 0 && ungrouped.length === 0 && <div className="muted pad">没有匹配的会话</div>}
              </>
            );
          })()}
        </Sheet>
      )}

      {/* background jobs sheet (session/jobs frames; current session only) */}
      {drawer === "jobs" && (
        <Sheet title="⚙️ 后台任务" onClose={() => setDrawer("")}>
          {jobs.length === 0 ? (
            <div className="muted pad">
              当前会话没有后台任务。agent 启动的 bash/pwsh/子代理等任务会出现在这里；
              需要终止时可让 agent 执行 job_kill。
            </div>
          ) : (
            jobs.map((j) => {
              const dur =
                j.startedAt && j.finishedAt
                  ? `${fmtClock(j.startedAt)} → ${fmtClock(j.finishedAt)}（${fmtDur(j.finishedAt - j.startedAt)}）`
                  : j.startedAt
                    ? `${fmtClock(j.startedAt)} · 已运行 ${fmtDur(Date.now() - j.startedAt)}`
                    : "";
              return (
                <div key={j.id} className="job-row" title={j.detail ?? j.label}>
                  <span className={`job-dot job-${j.status}`} />
                  <span className="job-main">
                    <span className="job-label">{j.label || j.kind}</span>
                    <span className="job-meta muted">
                      [{j.kind}] {j.status}
                      {dur ? ` · ${dur}` : ""}
                      {j.detail ? ` · ${j.detail}` : ""}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </Sheet>
      )}

      {/* trajectory sheet — raw event ledger, turn separators, clock (wide) */}
      {drawer === "traj" && (
        <Sheet
          wide
          title={`🧭 事件轨迹（${rawEvents.length} 条）`}
          onClose={() => setDrawer("")}
          headControls={
            <input
              className="drawer-search sheet-search"
              placeholder="筛选事件类型（如 tool/call）…"
              value={trajFilter}
              onChange={(e) => setTrajFilter(e.target.value)}
            />
          }
        >
          {(() => {
            const q = trajFilter.trim().toLowerCase();
            const rows = rawEvents.filter((e) => !q || (e.event?.type ?? "").toLowerCase().includes(q));
            if (rows.length === 0) return <div className="muted pad">（没有匹配的事件）</div>;
            let turnNo = 0;
            return (
              <div className="traj-list">
                {rows.slice(-300).reverse().map((e, i) => {
                  const seq = e.event?.seq ?? i;
                  const open = trajOpenSeq === seq;
                  if (e.event?.type === "turn/start") turnNo += 1;
                  return (
                    <div key={`${seq}-${i}`}>
                      {e.event?.type === "turn/start" && <div className="traj-turn-sep">━ 回合 {turnNo} ━</div>}
                      <div className="traj-row" onClick={() => setTrajOpenSeq(open ? null : seq)}>
                        <span className="traj-seq">#{seq}</span>
                        <span className="traj-clock muted">{e.event?.time ? fmtClock(e.event.time) : ""}</span>
                        <span className="traj-type">{e.event?.type ?? "?"}</span>
                        <span className="traj-brief">{JSON.stringify(e.event?.data ?? null).slice(0, 90)}</span>
                        {open && <pre className="code-block traj-full">{JSON.stringify(e, null, 2)}</pre>}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
        </Sheet>
      )}

      {/* subagents drawer (subagent.list / subagents/list) */}
      {/* subagents sheet — list + read-only transcript (wide, like the GUI) */}
      {drawer === "subs" && (
        <Sheet
          wide
          title={subView ? `📦 ${subView.label ?? subView.id.slice(0, 12)}` : "📦 子代理目录"}
          onClose={() => {
            if (subView) {
              setSubView(null);
              setSubEvents(null);
            } else {
              setDrawer("");
            }
          }}
          headControls={
            subView ? (
              <button className="link-btn" onClick={() => { setSubView(null); setSubEvents(null); }}>
                ← 返回目录
              </button>
            ) : (
              <button
                className="link-btn"
                onClick={() => current && post({ t: "list-subagents", reqId: Date.now(), sessionId: current })}
              >
                刷新
              </button>
            )
          }
        >
          {subView ? (
            <>
              <SubagentTranscript events={subEvents} />
              {subView.mode === "continuable" && (
                <div className="sub-composer">
                  {subView.activity === "active" && (
                    <button
                      className="btn sub-interrupt"
                      title="打断正在运行的子代理"
                      onClick={() => post({ t: "subagent-interrupt", childId: subView.id })}
                    >
                      打断
                    </button>
                  )}
                  <input
                    className="settings-input sub-input"
                    placeholder="给子代理发消息（追问 / 补充指令）…"
                    value={subDraft}
                    onChange={(e) => setSubDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && subDraft.trim()) {
                        post({ t: "subagent-prompt", childId: subView.id, text: subDraft.trim() });
                        setSubDraft("");
                      }
                    }}
                  />
                  <button
                    className="btn btn-primary"
                    disabled={!subDraft.trim()}
                    onClick={() => {
                      if (subDraft.trim()) {
                        post({ t: "subagent-prompt", childId: subView.id, text: subDraft.trim() });
                        setSubDraft("");
                      }
                    }}
                  >
                    发送
                  </button>
                </div>
              )}
            </>
          ) : subagentEntries.length === 0 ? (
            <div className="muted pad">本会话没有子代理。continuable 子代理可在面板里直接查看对话、追问和打断。</div>
          ) : (
            subagentEntries.map((sa) => (
              <div
                key={sa.id}
                className="sub-row sub-row-click"
                title={`${sa.id}\n点击查看对话`}
                onClick={() => {
                  setSubView({ id: sa.id, label: sa.label, mode: sa.mode, activity: sa.activity });
                  setSubEvents(null);
                  post({ t: "subagent-history", childId: sa.id });
                }}
              >
                <span className={`dot dot-${sa.activity === "active" ? "running" : "idle"}`} />
                <span className="sub-label">{sa.label || sa.id.slice(0, 8)}</span>
                <span className="sub-mode muted">{sa.mode === "continuable" ? "可持续" : "一次性"}</span>
                <span className="muted">›</span>
              </div>
            ))
          )}
        </Sheet>
      )}
      {/* settings sheet — schema-driven server settings form (wide) */}
      {drawer === "settings" && (
        <Sheet wide title="⚙️ 服务器设置" onClose={() => setDrawer("")}>
          <SettingsSheet
            data={settingsData}
            edits={settingsEdits}
            error={settingsError}
            onEdit={(key, value) => setSettingsEdits((e) => ({ ...e, [key]: value }))}
            onSave={(ns, patch, revision) => {
              setSettingsError(null);
              post({ t: "save-setting", ns, patch, revision });
            }}
            onOpenExtSettings={() => post({ t: "open-settings" })}
          />
        </Sheet>
      )}
      {renaming && (
        <div className="rename-bar">
          <input
            autoFocus
            className="q-custom"
            value={renaming.title}
            placeholder="会话标题…"
            onChange={(e) => setRenaming({ ...renaming, title: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renaming.title.trim()) {
                post({ t: "rename", sessionId: renaming.sessionId, title: renaming.title.trim() });
                setRenaming(undefined);
              } else if (e.key === "Escape") {
                setRenaming(undefined);
              }
            }}
          />
          <button className="btn btn-primary" onClick={() => { if (renaming.title.trim()) { post({ t: "rename", sessionId: renaming.sessionId, title: renaming.title.trim() }); setRenaming(undefined); } }}>保存</button>
          <button className="btn" onClick={() => setRenaming(undefined)}>取消</button>
        </div>
      )}

      {/* messages */}
      <div className="messages" ref={listRef} onScroll={onScroll}>
        {loadingOlder && <div className="muted pad">⏳ 正在加载更早消息…</div>}
        {!hasMoreRef.current && items.length > 0 && !loadingOlder && (
          <div className="muted pad tiny">— 已到最早消息 —</div>
        )}
        {hiddenCount > 0 && <div className="muted pad">（{hiddenCount} 条更早消息已折叠，向上滚动定位）</div>}
        {visible.map((it) => (
          <ItemView key={it.key} item={it} sessionId={current} />
        ))}
        {approvals.map((a) => (
          <ApprovalCardView
            key={a.approvalId}
            card={a}
            sourceTitle={a.sessionId !== current ? (sessions.find((s) => s.sessionId === a.sessionId)?.title ?? "未命名会话") : undefined}
            onJump={a.sessionId !== current ? () => post({ t: "switch", sessionId: a.sessionId }) : undefined}
            onAnswer={(outcome) => {
              setApprovals((xs) => xs.filter((x) => x.approvalId !== a.approvalId));
              post({ t: "respond-approval", rpcId: a.rpcId, sessionId: a.sessionId, approvalId: a.approvalId, outcome });
            }}
          />
        ))}
        {questions.map((q) => (
          <QuestionCardView
            key={q.rpcId}
            card={q}
            sourceTitle={q.sessionId !== current ? (sessions.find((s) => s.sessionId === q.sessionId)?.title ?? "未命名会话") : undefined}
            onJump={q.sessionId !== current ? () => post({ t: "switch", sessionId: q.sessionId }) : undefined}
            onAnswer={(answers) => {
              setQuestions((xs) => xs.filter((x) => x.rpcId !== q.rpcId));
              post({ t: "respond-question", rpcId: q.rpcId, sessionId: q.sessionId, answers });
            }}
          />
        ))}
      </div>

      {/* queue strip — chips with remove / edit / steer (server updateQueue) */}
      {queue.length > 0 && (
        <div className="queue-strip">
          {queue.map((qi) =>
            editingQueueId === qi.id ? (
              <span key={qi.id} className="queue-edit-box">
                <textarea
                  autoFocus
                  rows={2}
                  value={queueEditText}
                  onChange={(e) => setQueueEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setEditingQueueId(null);
                    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                      if (current && queueEditText.trim()) post({ t: "queue-edit", sessionId: current, itemId: qi.id, text: queueEditText });
                      setEditingQueueId(null);
                    }
                  }}
                />
                <button
                  className="link-btn"
                  title="保存（Ctrl+Enter）"
                  onClick={() => {
                    if (current && queueEditText.trim()) post({ t: "queue-edit", sessionId: current, itemId: qi.id, text: queueEditText });
                    setEditingQueueId(null);
                  }}
                >
                  保存
                </button>
                <button className="link-btn" onClick={() => setEditingQueueId(null)}>取消</button>
              </span>
            ) : (
              <span key={qi.id} className="queue-chip" title={qi.text}>
                {qi.placement === "steering" ? "⇢ " : "⏳ "}
                {qi.text.slice(0, 40)}
                {qi.placement !== "steering" && (
                  <button
                    className="icon-btn mini"
                    title="插队：转为引导消息，立即影响当前轮"
                    onClick={() => current && post({ t: "queue-steer", sessionId: current, itemId: qi.id })}
                  >
                    <Icon name="rewind" size={11} />
                  </button>
                )}
                <button
                  className="icon-btn mini"
                  title="编辑内容"
                  onClick={() => {
                    setEditingQueueId(qi.id);
                    setQueueEditText(qi.text);
                  }}
                >
                  <Icon name="edit" size={11} />
                </button>
                <button className="icon-btn mini" title="移除" onClick={() => current && post({ t: "queue-remove", sessionId: current, itemId: qi.id })}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ),
          )}
        </div>
      )}

      {/* notify */}
      {notify && <div className={`notify notify-${notify.kind}`}>{notify.message}</div>}

      {/* live tool indicator — directly above the composer (reading order:
          messages flow down into "what's running now", then the input) */}
      {(busy || liveTool) && (
        <div className="live-bar">
          <span className="turn-status-dot" />
          <span className="turn-status-text">{liveTool ? `正在执行：${liveTool}` : "深度思考中…"}</span>
          <Elapsed />
          <span className="spacer" />
          <button className="link-btn" onClick={() => current && post({ t: "cancel", sessionId: current })}>停止</button>
        </div>
      )}

      {/* plan mode indicator */}
      {planActive && (
        <div className="plan-strip">
          <span>🗺 Plan 模式 — 只读研究，方案需批准后执行</span>
          <span className="spacer" />
          <button
            className="link-btn"
            title="执行 /plan off"
            onClick={() => current && post({ t: "run-command", sessionId: current, line: "/plan off" })}
          >
            退出
          </button>
        </div>
      )}

      {/* todo progress */}
      {todos && todos.length > 0 && (() => {
        const done = todos.filter((t) => t.status === "completed").length;
        const cur = todos.find((t) => t.status === "in_progress");
        return (
          <div className="todo-strip">
            <button className="todo-head" onClick={() => setTodoOpen((v) => !v)} title="展开/收起任务清单">
              <span className="todo-count">{done}/{todos.length}</span>
              <span className="todo-bar">
                <span className="todo-bar-fill" style={{ width: `${todos.length ? (done / todos.length) * 100 : 0}%` }} />
              </span>
              <span className="todo-cur">{cur ? cur.content : done === todos.length ? "全部完成" : "…"}</span>
              <span className="todo-chev">{todoOpen ? "▾" : "▸"}</span>
            </button>
            {todoOpen && (
              <ul className="todo-list">
                {todos.map((t, i) => (
                  <li key={i} className={`todo-item is-${t.status}`}>
                    <span className="todo-mark">{t.status === "completed" ? "✓" : t.status === "in_progress" ? "●" : "○"}</span>
                    {t.content}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })()}

      {/* composer */}
      <div className="composer">
        {/* slash menu (skills + commands) */}
        {slashPopup && (
          <div className="file-popup">
            {slashPopup.items.length === 0 && (
              <div className="file-item muted">
                {slashPopup.query
                  ? "无匹配"
                  : slashCacheRef.current
                    ? "暂无可用技能"
                    : "加载中…"}
              </div>
            )}
            {slashPopup.items.map((it, i) => (
              <div
                key={`${it.kind}:${it.name}`}
                className={`file-item ${i === slashPopup.sel ? "is-sel" : ""}`}
                onMouseEnter={() => setSlashPopup((p) => (p ? { ...p, sel: i } : p))}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pickSlash(it);
                }}
              >
                <span className="slash-kind">{it.kind === "skill" ? "🔧" : "⌘"}</span>
                <span className="slash-name">/{it.name}</span>
                <span className="slash-desc">{it.description.slice(0, 60)}</span>
              </div>
            ))}
          </div>
        )}
        {/* @ file completion popup */}
        {filePopup && (
          <div className="file-popup">
            {filePopup.items.length === 0 && <div className="file-item muted">搜索中…</div>}
            {filePopup.items.map((f, i) => (
              <div
                key={f.path}
                className={`file-item ${i === filePopup.sel ? "is-sel" : ""}`}
                onMouseEnter={() => setFilePopup((p) => (p ? { ...p, sel: i } : p))}
                onMouseDown={(e) => {
                  e.preventDefault(); // keep textarea focus
                  pickFile(f);
                }}
              >
                <span className="file-rel">{f.rel}</span>
              </div>
            ))}
          </div>
        )}
        {/* attachment chips */}
        {fileAtt.length > 0 && (
          <div className="attach-chips">
            {fileAtt.map((a) => (
              <span key={a.path} className="attach-chip" title={a.path}>
                📎 {a.rel}
                <button
                  className="icon-btn mini"
                  title="移除"
                  onClick={() => setFileAtt((xs) => xs.filter((x) => x.path !== a.path))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="composer-row composer-input-wrap">
          <textarea
            ref={taRef}
            value={draft}
            placeholder={busy ? "运行中，Enter 排队追加…" : "输入消息，Enter 发送；@ 引用文件；/ 触发技能"}
            onChange={(e) => onDraftChange(e.target.value, e.target.selectionStart ?? 0)}
            onKeyDown={(e) => {
              if (slashPopup && slashPopup.items.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSlashPopup((p) => (p ? { ...p, sel: (p.sel + 1) % p.items.length } : p));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSlashPopup((p) => (p ? { ...p, sel: (p.sel - 1 + p.items.length) % p.items.length } : p));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickSlash(slashPopup.items[slashPopup.sel]);
                  return;
                }
              }
              if (e.key === "Escape" && (filePopup || slashPopup)) {
                setFilePopup(undefined);
                setSlashPopup(undefined);
                return;
              }
              if (e.key === "Escape") {
                // CC muscle memory: Esc interrupts the run; on an idle box it
                // clears the draft.
                if (busy) {
                  e.preventDefault();
                  if (current) post({ t: "cancel", sessionId: current });
                } else if (draft) {
                  setDraft("");
                }
                return;
              }
              if (filePopup && filePopup.items.length > 0) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setFilePopup((p) => (p ? { ...p, sel: (p.sel + 1) % p.items.length } : p));
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setFilePopup((p) => (p ? { ...p, sel: (p.sel - 1 + p.items.length) % p.items.length } : p));
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickFile(filePopup.items[filePopup.sel]);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSendDraft();
              }
            }}
            onBlur={() => {
              // delay so mousedown-pick still fires before the popup unmounts
              window.setTimeout(() => {
                setFilePopup(undefined);
                setSlashPopup(undefined);
              }, 150);
            }}
            onPaste={(e) => void onPaste(e)}
            rows={3}
          />
          {busy ? (
            <button
              className="send-fab send-fab-stop"
              title="停止当前回答（Esc 同效）——停止后可直接发送下一条"
              aria-label="停止"
              onClick={() => current && post({ t: "cancel", sessionId: current })}
            >
              <span className="stop-square" />
            </button>
          ) : (
            <button
              className="send-fab"
              title="发送（Enter）"
              aria-label="发送"
              disabled={!draft.trim() && fileAtt.length === 0}
              onClick={onSendDraft}
            >
              <Icon name="send" size={15} />
            </button>
          )}
        </div>
        <div className="composer-actions">
          <input
            ref={imgInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = "";
              void (async () => {
                for (const f of files) {
                  const data = await fileToBase64(f);
                  if (data) send([{ type: "image", mediaType: f.type, data }]);
                }
              })();
            }}
          />
          <div className="add-menu-wrap">
            {addMenuOpen && (
              <div className="add-menu">
                <button
                  className="add-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    pickReqRef.current += 1;
                    post({ t: "pick-file", reqId: pickReqRef.current });
                  }}
                >
                  <Icon name="edit" size={12} /> 添加文件
                </button>
                <button
                  className="add-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    pickReqRef.current += 1;
                    post({ t: "pick-folder", reqId: pickReqRef.current });
                  }}
                >
                  <Icon name="folder" size={12} /> 添加文件夹
                </button>
                <button
                  className="add-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    imgInputRef.current?.click();
                  }}
                >
                  <Icon name="image" size={12} /> 添加图片
                </button>
              </div>
            )}
            <button
              className={`icon-btn${addMenuOpen ? " is-on" : ""}`}
              title="添加附件（文件 / 文件夹 / 图片）"
              onClick={() => setAddMenuOpen((v) => !v)}
            >
              <Icon name="plus" size={13} />
            </button>
          </div>
          <button
            className="icon-btn"
            title="命令与技能（/）"
            onClick={() => {
              setDraft("/");
              setSlashPopup({ items: slashCacheRef.current?.items ?? [], sel: 0, tokenStart: 0, query: "" });
              slashReqRef.current += 1;
              if (current) post({ t: "list-slash", reqId: slashReqRef.current, sessionId: current });
              taRef.current?.focus();
            }}
          >
            <Icon name="slash" size={13} />
          </button>
          <button
            className={`chip-btn ${mode === "steer" ? "is-on" : ""}`}
            title="steer：运行中追加引导，插队生效"
            onClick={() => setMode((m) => (m === "queue" ? "steer" : "queue"))}
          >
            {mode === "queue" ? "排队" : "引导"}
          </button>
          <ModelPicker
            models={models}
            onSelect={(p, m) => current && post({ t: "select-model", sessionId: current, provider: p, model: m })}
          />
          <EffortPicker
            models={models}
            onSelect={(effort) => {
              const cur = models?.current;
              if (cur && current) post({ t: "select-model", sessionId: current, provider: cur.provider, model: cur.model, reasoningEffort: effort });
            }}
          />
          {permission && permission.presets.length > 0 && (
            <select
              className="chip-btn"
              value={permission.value ?? ""}
              title="权限预设（当前会话，立即生效）"
              onChange={(e) => {
                const v = e.target.value;
                if (v && current) post({ t: "set-session-permission", sessionId: current, preset: v });
              }}
            >
              {permission.value && !permission.presets.some((p) => p.id === permission.value) && (
                <option value={permission.value}>{permission.value}</option>
              )}
              {permission.presets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* stats line — always visible below the composer (web GUI dock style):
          turn/tool counts + token usage + context pressure bar */}
      <div className="stats-line">
        <span>轮 {stats.turns} · 工具 {stats.tools}</span>
        {tokens && <span> · {tokens}</span>}
        {ctxPct !== undefined && (
          <span className="context-bar" title={`上下文压力 ${Math.round(ctxPct * 100)}%`}>
            <span className="context-label">上下文</span>
            <span className="context-fill-wrap">
              <span
                className={`context-fill${ctxPct >= 0.85 ? " hot" : ctxPct >= 0.6 ? " warm" : ""}`}
                style={{ width: `${Math.min(100, Math.round(ctxPct * 100))}%` }}
              />
            </span>
          </span>
        )}
      </div>
    </div>
  );
}

function ItemView({ item, sessionId }: { item: FoldItem; sessionId?: string }) {
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <div className="msg-role">你</div>
        {item.text ? <div className="bubble user-bubble">{item.text}</div> : null}
        {item.files && item.files.length > 0 && (
          <div className="msg-files">
            {item.files.map((f) => (
              <span key={f} className="attach-chip" title={f}>📎 {f}</span>
            ))}
          </div>
        )}
        {item.images && item.images.length > 0 && (
          <div className="msg-images">
            {item.images.map((im, i) => (
              <MsgImage key={im.attachmentId ?? `inl${i}`} img={im} sessionId={sessionId} />
            ))}
          </div>
        )}
      </div>
    );
  }
  if (item.kind === "info") {
    return <div className="msg muted">{item.text}</div>;
  }
  return <TurnView item={item} sessionId={sessionId} />;
}

/** One image in a user message. Durable refs pull bytes through the extension
 *  host (session.attachment) with an LRU cache; inline legacy shapes render
 *  straight from their data URL. Click toggles thumbnail/full size. */
function MsgImage({ img, sessionId }: { img: FoldImage; sessionId?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [, forceRender] = useState(0);
  useEffect(() => {
    const h = () => forceRender((v) => v + 1);
    imgListeners.add(h);
    return () => {
      imgListeners.delete(h);
    };
  }, []);
  // Request-on-miss lives in the effect: render stays pure (no cache writes
  // that would synchronously notify other mounted images).
  useEffect(() => {
    if (img.dataUrl || !sessionId || !img.attachmentId) return;
    if (!imgCache.has(img.attachmentId)) {
      imgCache.set(img.attachmentId, "loading");
      post({ t: "get-attachment", sessionId, attachmentId: img.attachmentId });
    }
  }, [img.attachmentId, img.dataUrl, sessionId]);

  const title = [img.name, img.width && img.height ? `${img.width}×${img.height}` : undefined]
    .filter(Boolean)
    .join(" · ") || undefined;

  if (img.dataUrl) {
    return (
      <img
        className={`msg-img${expanded ? " is-open" : ""}`}
        src={img.dataUrl}
        alt={img.name ?? "图片"}
        title={title}
        onClick={() => setExpanded((v) => !v)}
      />
    );
  }

  const entry = imgCache.get(img.attachmentId!);
  if (entry === undefined || entry === "loading") {
    return <span className="msg-img-box" title={title}>🖼…</span>;
  }
  if (entry === "error") {
    return (
      <span className="msg-img-box is-error" title="加载失败：宿主不支持或引用已失效">
        🖼✕
      </span>
    );
  }
  return (
    <img
      className={`msg-img${expanded ? " is-open" : ""}`}
      src={`data:${entry.mediaType};base64,${entry.data}`}
      alt={img.name ?? "图片"}
      title={title}
      onClick={() => setExpanded((v) => !v)}
    />
  );
}

/** Read-only transcript of a subagent child session (folds its history with
 *  the same pipeline as the main view; null events = loading). */
function SubagentTranscript({ events }: { events: { event: { type: string; seq?: number; time?: number; data?: any }; view?: any }[] | null }) {
  const items = useMemo(() => {
    if (!events) return null;
    const fold = new ConversationFold();
    fold.pushMany(events);
    return fold.items;
  }, [events]);
  if (events === null) return <div className="muted pad">⏳ 正在读取子代理对话…</div>;
  if (!items || items.length === 0) return <div className="muted pad">（子代理还没有对话内容）</div>;
  return (
    <div className="sub-transcript">
      {items.map((it) => (
        <ItemView key={it.key} item={it} sessionId={undefined} />
      ))}
    </div>
  );
}

/** Schema-driven server settings form (settings/describe namespaces).
 *  schemastery serialization: schema.refs[id] = {type, meta, value?...},
 *  schema.dict = {field → refId}. Secrets/credential-refs render as status
 *  only (configured or not) — credential values are never shipped here. */
function SettingsSheet({
  data,
  edits,
  error,
  onEdit,
  onSave,
  onOpenExtSettings,
}: {
  data: { writable: boolean; hasDocument: boolean; namespaces: SettingsNs[] } | null;
  edits: Record<string, unknown>;
  error: string | null;
  onEdit: (key: string, value: unknown) => void;
  onSave: (ns: string, patch: Record<string, unknown>, revision: number) => void;
  onOpenExtSettings: () => void;
}) {
  if (!data) return <div className="muted pad">⏳ 正在读取服务器设置…</div>;
  if (data.namespaces.length === 0) return <div className="muted pad">（该服务器未开放设置描述）</div>;
  return (
    <div className="settings-list">
      {error && <div className="settings-error">⚠️ {error}</div>}
      {!data.writable && <div className="muted pad tiny">⚠️ 服务器标记为只读（配置文件不可写），保存会被拒绝。</div>}
      {data.namespaces.map((ns) => {
        const dict = ns.schema?.dict ?? {};
        const fields = Object.entries(dict)
          .map(([field, refId]) => ({ field, ref: ns.schema?.refs?.[refId as number] ?? ns.schema?.refs?.[String(refId)] }))
          .filter((f) => !!f.ref);
        const patch: Record<string, unknown> = {};
        for (const { field, ref } of fields) {
          const key = `${ns.ns}.${field}`;
          if (!(key in edits)) continue;
          const base = effectiveSetting(ns, field, ref);
          if (JSON.stringify(edits[key]) !== JSON.stringify(base)) patch[field] = edits[key];
        }
        const dirty = Object.keys(patch).length > 0;
        return (
          <details key={ns.ns} className="settings-ns" open={fields.length <= 8}>
            <summary>
              <span className="settings-ns-name">{ns.ns}</span>
              {ns.applies === "restart" && <span className="badge badge-restart">需重启</span>}
              {ns.applies === "live" && <span className="badge badge-live">即时生效</span>}
              {dirty && <span className="badge badge-edit">未保存</span>}
            </summary>
            <div className="settings-fields">
              {fields.map(({ field, ref }) => {
                const key = `${ns.ns}.${field}`;
                const role = ref.meta?.role;
                const secret = role === "secret" || role === "credential-ref";
                const current = key in edits ? edits[key] : effectiveSetting(ns, field, ref);
                if (secret) {
                  const set = (ns.secrets ?? []).some((s) => s.path?.includes(field) && s.set);
                  return (
                    <div className="settings-field" key={field}>
                      <span className="settings-label" title={`${field}（${role === "credential-ref" ? "凭据引用" : "密钥"}）`}>
                        {field}
                      </span>
                      <span className={`settings-value muted${set ? " is-set" : ""}`}>{set ? "🔒 已配置" : "🔓 未配置（在服务器侧配置）"}</span>
                    </div>
                  );
                }
                if (ref.type === "const") {
                  return (
                    <div className="settings-field" key={field}>
                      <span className="settings-label">{field}</span>
                      <span className="settings-value muted">{String(ref.value ?? "—")}</span>
                    </div>
                  );
                }
                if (ref.type === "boolean") {
                  return (
                    <div className="settings-field" key={field}>
                      <span className="settings-label">{field}</span>
                      <label className="settings-check">
                        <input type="checkbox" checked={!!current} onChange={(e) => onEdit(key, e.target.checked)} />
                      </label>
                    </div>
                  );
                }
                if (ref.type === "number") {
                  return (
                    <div className="settings-field" key={field}>
                      <span className="settings-label" title={ref.meta?.description ?? field}>{field}</span>
                      <input
                        className="settings-input"
                        type="number"
                        step={ref.meta?.step ?? 1}
                        min={ref.meta?.min}
                        max={ref.meta?.max}
                        value={current === undefined || current === null ? "" : String(current)}
                        onChange={(e) => onEdit(key, e.target.value === "" ? ref.meta?.default ?? "" : Number(e.target.value))}
                      />
                    </div>
                  );
                }
                if (ref.type === "string") {
                  return (
                    <div className="settings-field" key={field}>
                      <span className="settings-label" title={ref.meta?.description ?? field}>{field}</span>
                      <input
                        className="settings-input"
                        value={current === undefined || current === null ? "" : String(current)}
                        placeholder={ref.meta?.default !== undefined ? String(ref.meta.default) : ""}
                        onChange={(e) => onEdit(key, e.target.value)}
                      />
                    </div>
                  );
                }
                // nested objects / arrays: read-only JSON view (v1)
                return (
                  <div className="settings-field" key={field}>
                    <span className="settings-label">{field}</span>
                    <pre className="settings-json">{JSON.stringify(current ?? null, null, 2)}</pre>
                  </div>
                );
              })}
            </div>
            {data.writable && fields.length > 0 && (
              <div className="settings-foot">
                <button className="btn btn-primary" disabled={!dirty} onClick={() => onSave(ns.ns, patch, ns.revision)}>
                  保存{dirty ? `（${Object.keys(patch).length} 项）` : ""}
                </button>
                <span className="muted tiny">rev {ns.revision}</span>
              </div>
            )}
          </details>
        );
      })}
      <div className="settings-ext-link">
        <button className="link-btn" onClick={onOpenExtSettings}>
          扩展自身设置（服务器地址 / 认证）→ VSCode 设置页
        </button>
      </div>
    </div>
  );
}

/** Effective value: user override → live value → base → schema default. */
function effectiveSetting(ns: SettingsNs, field: string, ref: any): unknown {
  return ns.user?.[field] ?? ns.value?.[field] ?? ns.base?.[field] ?? ref?.meta?.default;
}

/** Right-side sheet (competitor panel interaction, probed from its CSS):
 *  fixed scrim + right-anchored sheet, Esc / click-scrim closes, 0.16s
 *  slide-in. wide = 620px (trajectory / subagent transcript), else 400px. */
function Sheet({ title, onClose, wide, headControls, children }: { title: ReactNode; onClose: () => void; wide?: boolean; headControls?: ReactNode; children: ReactNode }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="sheet-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`sheet${wide ? " sheet-wide" : ""}`}>
        <div className="sheet-head">
          <span className="sheet-title">{title}</span>
          {headControls && <span className="sheet-controls">{headControls}</span>}
          <button className="icon-btn mini sheet-close" title="关闭 (Esc)" onClick={onClose}>
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

const TurnView = ({ item, sessionId }: { item: TurnItem; sessionId?: string }) => {
  const [openThinking, setOpenThinking] = useState(false);
  const text = stripSystemContext(item.text ?? "");
  // INTERLEAVED render: segments are the source of truth (text → tool →
  // thinking → text …) in true arrival order — the same reading flow as the
  // GUI and the competitor panel, instead of a fixed thinking/tools/text stack.
  const segs = item.segments && item.segments.length > 0 ? item.segments : fallbackSegs(item);
  const lastSeg = segs[segs.length - 1];
  return (
    <div className="msg assistant">
      {item.ended && item.turnNo !== undefined && item.lastSeq !== undefined && sessionId && (
        <div className="fork-divider">
          <div className="fork-divider-line">
            <button
              className="fork-divider-btn"
              title="从本轮结束处分叉出新会话"
              onClick={() => post({ t: "fork-at", sessionId, atSeq: item.lastSeq! })}
            >
              <Icon name="branch" size={11} /> 第 {item.turnNo} 轮
            </button>
          </div>
        </div>
      )}
      <div className="msg-role">DSH</div>
      {segs.map((s, i) => {
        if (s.kind === "thinking") {
          const t = stripSystemContext(s.text ?? "");
          if (!t) return null;
          return (
            <div className="thinking turn-seg" key={`h${i}`}>
              <button className="link-btn" onClick={() => setOpenThinking((v) => !v)}>
                💭 思考过程 {openThinking ? "▾" : "▸"}
              </button>
              {openThinking && <div className="thinking-body"><Markdown text={t} /></div>}
            </div>
          );
        }
        if (s.kind === "tool" && s.act) return <ActivityCard key={`a${s.act.key}-${i}`} act={s.act} />;
        if (s.kind !== "text") return null;
        const segText = stripSystemContext(s.text ?? "");
        if (!segText) return null;
        return (
          <div className="bubble assistant-bubble turn-seg" key={`t${i}`}>
            <Markdown text={segText} live={!item.ended && i === segs.length - 1} />
          </div>
        );
      })}
      {!item.ended && (!lastSeg || lastSeg.kind !== "text") && <div className="cursor">▍</div>}
      {item.ended && item.produced && item.produced.length > 0 && <ProducedCard files={item.produced} />}
      {item.ended && text && sessionId && <TurnActions item={item} sessionId={sessionId} />}
    </div>
  );
};

/** Pre-segments items (old folds) still render via the flat views. */
function fallbackSegs(item: TurnItem): { kind: "text" | "thinking" | "tool"; text?: string; act?: ToolActivity }[] {
  const out: { kind: "text" | "thinking" | "tool"; text?: string; act?: ToolActivity }[] = [];
  if (item.thinking) out.push({ kind: "thinking", text: item.thinking });
  for (const a of item.activities) out.push({ kind: "tool", act: a });
  if (item.text) out.push({ kind: "text", text: item.text });
  return out;
}

/** Files produced by a finished turn (diff/edit locations) — accent-bordered
 *  card between the answer and the action bar (web GUI ProducedFiles look). */
function ProducedCard({ files }: { files: string[] }) {
  return (
    <div className="files-card">
      <div className="files-card-head">
        <Icon name="box" size={12} /> 本轮产出（{files.length}）
      </div>
      <div className="files-card-rows">
        {files.map((f) => {
          const isDir = /[\\/]$/.test(f);
          const label = f.split(/[\\/]/).filter(Boolean).pop() ?? f;
          return (
            <button key={f} className="files-card-row" title={f} onClick={() => post({ t: "open-file", path: f })}>
              <Icon name={isDir ? "folder" : "edit"} size={11} />
              <span className="files-card-path">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Per-turn action bar: copy / vote / fork-from-here (web GUI msg-actions). */
function TurnActions({ item, sessionId }: { item: TurnItem; sessionId: string }) {
  const [vote, setVote] = useState<"up" | "down" | undefined>();
  return (
    <div className="msg-actions">
      <button
        className="msg-action-btn"
        title="复制回答"
        onClick={() => void navigator.clipboard.writeText(stripSystemContext(item.text ?? ""))}
      >
        <Icon name="copy" />
      </button>
      <button
        className={`msg-action-btn${vote === "up" ? " selected-positive" : ""}`}
        title="有帮助"
        onClick={() => {
          setVote("up");
          post({ t: "feedback", sessionId, kind: "up" });
        }}
      >
        <Icon name="up" />
      </button>
      <button
        className={`msg-action-btn${vote === "down" ? " selected-negative" : ""}`}
        title="没帮助"
        onClick={() => {
          setVote("down");
          post({ t: "feedback", sessionId, kind: "down" });
        }}
      >
        <Icon name="down" />
      </button>
    </div>
  );
}

/** Elapsed-seconds readout for the running turn (tabular numerals). */
function Elapsed() {
  const [sec, setSec] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setSec((s) => s + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className="turn-status-elapsed">{sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}`}</span>;
}

const GOAL_PHASE_LABEL: Record<string, string> = {
  active: "进行中",
  complete: "已完成",
  paused: "已暂停",
  blocked: "受阻",
};

/** Goal dock bar — the current session's goal projection, pinned under the
 *  header (web GUI GoalBar dock). phase: active|complete|paused|blocked. */
function GoalBar({ data }: { data: any }) {
  const goal = data?.goal;
  if (!goal || typeof goal.objective !== "string") return null;
  const phase = typeof goal.phase === "string" ? goal.phase : "active";
  const label = GOAL_PHASE_LABEL[phase] ?? phase;
  const rounds = typeof data?.roundsStarted === "number" ? data.roundsStarted : undefined;
  const max = typeof goal.maxGoalRounds === "number" ? goal.maxGoalRounds : undefined;
  const blockedMsg = phase === "blocked" ? goal.blockedReason?.message : undefined;
  return (
    <div
      className={`goal-bar goal-${phase}`}
      title={blockedMsg ? `受阻：${blockedMsg}` : goal.objective}
    >
      <span className="goal-glyph">◎</span>
      <span className="goal-objective">{goal.objective}</span>
      <span className="goal-phase-badge">{label}</span>
      {rounds !== undefined && <span className="goal-rounds">{max !== undefined ? `${rounds}/${max}` : rounds} 轮</span>}
    </div>
  );
}

/** Native agent-preset picker: selectable only while the session is blank
 *  (DSH locks the assembly after the first turn — agent-preset-locked). */
function PresetPicker({
  presets,
  current,
  presetOf,
  locked,
  onSelect,
}: {
  presets?: PresetData;
  current?: string;
  presetOf?: string;
  locked?: boolean;
  onSelect: (preset: string) => void;
}) {
  const list = presets?.presets ?? [];
  const active = presetOf ?? list.find((p) => p.isDefault)?.id ?? "标准";
  const activeLabel = list.find((p) => p.id === active)?.name ?? active;
  if (list.length === 0) return null;
  if (locked || !current) {
    return (
      <span className="chip-btn is-locked" title="会话已发过消息，模式已固定">
        🔒 {activeLabel}
      </span>
    );
  }
  return (
    <select
      className="chip-btn"
      value={active}
      title="Agent 模式（发消息前可切换，发出后固定）"
      onChange={(e) => {
        const v = e.target.value;
        if (v && v !== active) onSelect(v);
      }}
    >
      {list.map((p) => (
        <option key={p.id} value={p.id} disabled={!!p.broken}>
          {p.name ?? p.id}
          {p.isDefault ? "（默认）" : ""}
          {p.broken ? `（不可用：${p.broken.slice(0, 30)}）` : ""}
        </option>
      ))}
    </select>
  );
}

/** Model picker: shows "provider/model" for the current selection; choosing
 *  sends selectModel WITHOUT effort (the effort picker follows up). */
function ModelPicker({ models, onSelect }: { models?: ModelsData; onSelect: (provider: string, model: string) => void }) {
  const cur = models?.current;
  const curModelName = useMemo(() => {
    if (!cur) return "模型…";
    // Match by provider id FIRST: the same model id may exist in several
    // groups (e.g. vision-toolkit wrapper adapters) — name search would then
    // pick the wrong provider in the display label.
    const own = (models?.groups ?? []).find((g) => g.id === cur.provider);
    const hit = own?.models.find((x) => x.id === cur.model);
    if (own) return `${own.name}/${hit?.name ?? cur.model}`;
    for (const g of models?.groups ?? []) {
      const h = g.models.find((x) => x.id === cur.model);
      if (h) return `${g.name}/${h.name}`;
    }
    return `${cur.provider}/${cur.model}`;
  }, [cur, models]);
  return (
    <select
      className="chip-btn"
      value=""
      title={`当前模型：${cur ? `${cur.provider}/${cur.model}` : "未选择"}`}
      onChange={(e) => {
        const v = e.target.value;
        if (!v) return;
        const [provider, model] = v.split("::");
        onSelect(provider, model);
        e.target.value = "";
      }}
    >
      <option value="">{curModelName}</option>
      {(models?.groups ?? []).map((g) => (
        <optgroup key={g.id} label={g.name}>
          {g.models.map((m) => (
            <option key={m.id} value={`${g.id}::${m.id}`}>
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/** Effort picker: options come from the CURRENT model's reasoning metadata. */
function EffortPicker({ models, onSelect }: { models?: ModelsData; onSelect: (effort: string) => void }) {
  const cur = models?.current;
  const efforts = useMemo(() => {
    if (!cur) return [];
    // Match by provider FIRST: the same model id may exist in several
    // providers — a same-id model elsewhere may support reasoning (with
    // different efforts) while the current one does not, and picking from
    // that stale list makes the server reject the switch.
    const own = (models?.groups ?? []).find((g) => g.id === cur.provider);
    const hit = own?.models.find((x) => x.id === cur.model);
    return hit?.reasoning?.efforts ?? [];
  }, [cur, models]);
  if (efforts.length === 0) return null;
  return (
    <select
      className="chip-btn"
      value={cur?.reasoningEffort ?? ""}
      title="思考强度"
      onChange={(e) => {
        const v = e.target.value;
        if (v) onSelect(v);
      }}
    >
      {!cur?.reasoningEffort && <option value="">思考强度…</option>}
      {efforts.map((ef) => (
        <option key={ef.id} value={ef.id}>
          {ef.name}
        </option>
      ))}
    </select>
  );
}

async function fileToBase64(f: File): Promise<string | undefined> {
  if (!/image\/(png|jpeg|webp|gif)/.test(f.type)) return undefined;
  // Size pre-check: reject oversize early (server limit comes via imageLimits
  // projection; 20MB is a hard local ceiling).
  if (f.size > 20 * 1024 * 1024) {
    setNotifyViaPost(`图片过大（${(f.size / 1048576).toFixed(1)}MB），跳过`);
    return undefined;
  }
  const buf = await f.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function setNotifyViaPost(message: string): void {
  post({ t: "log", message });
}
