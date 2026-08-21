import { useMemo, useRef, useState, useEffect } from "react";
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
  ViewToExt,
} from "./protocol.js";
import { ConversationFold, stripSystemContext, type FoldItem, type ToolActivity } from "./fold.js";
import { Markdown } from "./components/markdown.js";
import { ActivityCard } from "./components/activity.js";
import { ApprovalCardView, QuestionCardView } from "./components/cards.js";

declare function acquireVsCodeApi(): { postMessage(m: ViewToExt): void; getState(): unknown; setState(s: unknown): void };

// The boot-error hook (panel.ts inline script) may have acquired the API
// first — acquireVsCodeApi can be called only ONCE per webview.
const vscodeApi = (window as unknown as { __dshApi?: { postMessage(m: ViewToExt): void } }).__dshApi ?? acquireVsCodeApi();
(window as unknown as { __dshApi?: unknown }).__dshApi = vscodeApi;
const post = (m: ViewToExt) => vscodeApi.postMessage(m);

const RENDER_WINDOW = 250; // items rendered max; older pages on demand

export function App() {
  const [conn, setConn] = useState<ConnState>("connecting");
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [current, setCurrent] = useState<string | undefined>();
  const [items, setItems] = useState<FoldItem[]>([]);
  const [approvals, setApprovals] = useState<ApprovalCard[]>([]);
  const [questions, setQuestions] = useState<QuestionCard[]>([]);
  const [models, setModels] = useState<ModelsData | undefined>();
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tokens, setTokens] = useState<string>("");
  const [notify, setNotify] = useState<{ kind: string; message: string } | undefined>();
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [permission, setPermission] = useState<PermissionData | undefined>();
  const [presetData, setPresetData] = useState<PresetData | undefined>();
  const [draft, setDraft] = useState("");
  const [showSessionList, setShowSessionList] = useState(false);
  const [renaming, setRenaming] = useState<{ sessionId: string; title: string } | undefined>();
  const [running, setRunning] = useState(false);

  const foldRef = useRef(new ConversationFold());
  const listRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const hasMoreRef = useRef(false);
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
          break;
        }
        case "history-older": {
          foldRef.current.unshiftMany(m.entries);
          hasMoreRef.current = m.hasMore;
          loadingOlderRef.current = false;
          setLoadingOlder(false);
          setItems([...foldRef.current.items]);
          break;
        }
        case "mux-batch": {
          if (!current || m.sessionId !== current) break; // only the active session renders
          foldRef.current.pushMany(m.frames);
          setItems([...foldRef.current.items]);
          setRunning(foldRef.current.isRunning);
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
        case "queue":
          setQueue(m.items);
          break;
        case "projection":
          if (m.key === "tokenUsage" || m.key === "liveTokenUsage") {
            const v = (m.value ?? {}) as Record<string, number>;
            const parts: string[] = [];
            if (v.outputTokens != null) parts.push(`out ${v.outputTokens}`);
            if (v.uncachedInputTokens != null) parts.push(`in ${v.uncachedInputTokens}`);
            if (v.cacheReadTokens != null) parts.push(`cache ${v.cacheReadTokens}`);
            setTokens(parts.join(" · "));
          } else if (m.key === "contextPressure" && m.value != null) {
            const v = m.value as any;
            const pct = typeof v === "number" ? v : (v.percent ?? v.ratio);
            if (typeof pct === "number") setTokens((t) => `${t ? `${t} · ` : ""}ctx ${Math.round(pct * 100)}%`);
          }
          break;
        case "notify":
          setNotify({ kind: m.kind, message: m.message });
          setTimeout(() => setNotify(undefined), 6000);
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
    pinnedRef.current = true;
  };

  const onSendDraft = () => {
    const text = draft.trim();
    if (!text) return;
    send([{ type: "text", text }]);
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
  const liveTool = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (it.kind === "turn") return it.liveTool;
    }
    return undefined;
  }, [items]);

  return (
    <div className="app">
      {/* header */}
      <div className="header">
        <span className={`dot dot-${conn}`} title={conn} />
        <button className="title-btn" onClick={() => setShowSessionList((v) => !v)} title="点击切换会话；✎ 重命名">
          <span className="title-text">{currentTitle}</span>
          <span className="chev">⌄</span>
        </button>
        <button
          className="icon-btn mini"
          title="重命名会话"
          onClick={() => current && setRenaming({ sessionId: current, title: currentTitle === "—" ? "" : currentTitle })}
        >
          ✎
        </button>
        <PresetPicker
          presets={presetData}
          current={current}
          presetOf={currentSession?.agentPreset}
          locked={!currentSession?.blank}
          onSelect={(p) => current && post({ t: "select-preset", sessionId: current, agentPreset: p })}
        />
        <span className="spacer" />
        <button className="icon-btn" title="新建会话" onClick={() => post({ t: "new-session" })}>＋</button>
      </div>
      {showSessionList && (
        <div className="session-list">
          {sessions.length === 0 && <div className="muted pad">（暂无会话）</div>}
          {sessions.map((s) => (
            <div
              key={s.sessionId}
              className={`session-row ${s.sessionId === current ? "is-current" : ""}`}
              onClick={() => {
                setShowSessionList(false);
                post({ t: "switch", sessionId: s.sessionId });
              }}
              title={s.cwd ?? s.sessionId}
            >
              <span className={`dot dot-${s.running ? "running" : "idle"}`} />
              <span className="session-title">{s.title ?? "（未命名会话）"}</span>
              <button
                className="icon-btn mini"
                title="重命名"
                onClick={(e) => {
                  e.stopPropagation();
                  setRenaming({ sessionId: s.sessionId, title: s.title ?? "" });
                }}
              >
                ✎
              </button>
              <button
                className="icon-btn mini"
                title="分叉会话（从最后一个完成的轮次复制出新会话）"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ t: "fork-session", sessionId: s.sessionId });
                }}
              >
                ⑂
              </button>
              <button
                className="icon-btn mini"
                title="归档（从列表隐藏，可在 DSH 网页版找回）"
                onClick={(e) => {
                  e.stopPropagation();
                  post({ t: "archive-session", sessionId: s.sessionId });
                }}
              >
                🗄
              </button>
            </div>
          ))}
        </div>
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
          <ItemView key={it.key} item={it} />
        ))}
        {approvals.map((a) => (
          <ApprovalCardView
            key={a.approvalId}
            card={a}
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
            onAnswer={(answers) => {
              setQuestions((xs) => xs.filter((x) => x.rpcId !== q.rpcId));
              post({ t: "respond-question", rpcId: q.rpcId, sessionId: q.sessionId, answers });
            }}
          />
        ))}
      </div>

      {/* queue strip */}
      {queue.length > 0 && (
        <div className="queue-strip">
          {queue.map((qi) => (
            <span key={qi.id} className="queue-chip" title={qi.text}>
              {qi.placement === "steering" ? "⇢ " : "⏳ "}
              {qi.text.slice(0, 40)}
              <button className="icon-btn mini" title="移除" onClick={() => current && post({ t: "queue-remove", sessionId: current, itemId: qi.id })}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* notify */}
      {notify && <div className={`notify notify-${notify.kind}`}>{notify.message}</div>}

      {/* live tool indicator — directly above the composer (reading order:
          messages flow down into "what's running now", then the input) */}
      {(busy || liveTool) && (
        <div className="live-bar">
          <span className="spinner" /> {liveTool ? `正在执行：${liveTool}` : "思考中…"}
          <span className="spacer" />
          <button className="link-btn" onClick={() => current && post({ t: "cancel", sessionId: current })}>停止</button>
        </div>
      )}

      {/* composer */}
      <div className="composer">
        <div className="composer-row composer-input-wrap">
          <textarea
            value={draft}
            placeholder={busy ? "运行中，Enter 排队追加…" : "输入消息，Enter 发送，Shift+Enter 换行；可粘贴图片"}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSendDraft();
              }
            }}
            onPaste={(e) => void onPaste(e)}
            rows={3}
          />
          <button
            className="send-fab"
            title="发送（Enter）"
            aria-label="发送"
            disabled={!draft.trim()}
            onClick={onSendDraft}
          >
            ➤
          </button>
        </div>
        <div className="composer-actions">
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
        {tokens && <div className="composer-meta">{tokens}</div>}
      </div>
    </div>
  );
}

function ItemView({ item }: { item: FoldItem }) {
  if (item.kind === "user") {
    return (
      <div className="msg user">
        <div className="bubble user-bubble">{stripSystemContext(item.text)}</div>
      </div>
    );
  }
  if (item.kind === "info") {
    return <div className="msg muted">{item.text}</div>;
  }
  return <TurnView item={item} />;
}

const TurnView = ({ item }: { item: any }) => {
  const [showThinking, setShowThinking] = useState(false);
  const text = stripSystemContext(item.text ?? "");
  return (
    <div className="msg assistant">
      {item.thinking ? (
        <div className="thinking">
          <button className="link-btn" onClick={() => setShowThinking((v) => !v)}>
            💭 思考过程 {showThinking ? "▾" : "▸"}
          </button>
          {showThinking && <div className="thinking-body"><Markdown text={stripSystemContext(item.thinking)} /></div>}
        </div>
      ) : null}
      {item.activities.length > 0 && (
        <div className="activities">
          {item.activities.map((a: ToolActivity) => (
            <ActivityCard key={a.key} act={a} />
          ))}
        </div>
      )}
      {text ? (
        <div className="bubble assistant-bubble">
          <Markdown text={text} live={!item.ended} />
        </div>
      ) : !item.ended ? (
        <div className="cursor">▍</div>
      ) : null}
    </div>
  );
};

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
    for (const g of models?.groups ?? []) {
      const hit = g.models.find((x) => x.id === cur.model);
      if (hit?.reasoning) return hit.reasoning.efforts;
    }
    return [];
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
