/**
 * Fold: raw session events (live mux frames + history entries) -> view model.
 * Handles BOTH shapes:
 *  - persistent events: turn/start|end, user/message, tool/call, tool/result
 *  - chunk stream: assistant/chunk {chunk.type: text-delta|reasoning-delta|
 *    tool-call|tool-result|agent-*|subagent-*|block-*|usage|finish}
 * Every input is O(1) amortized append; React renders memoized items.
 */

export interface ToolActivity {
  key: string;
  kind: "tool" | "agent" | "subagent" | "block" | "step" | "other";
  label: string;
  detail: string;
  state: "running" | "done" | "error";
  /** raw parsed args for diff/inspect */
  callId?: string;
  name?: string;
  args?: unknown;
  resultPreview?: string;
  isError?: boolean;
}

export interface TurnItem {
  kind: "turn";
  key: string;
  text: string;
  thinking: string;
  activities: ToolActivity[];
  ended: boolean;
  /** current running tool label for the live indicator */
  liveTool?: string;
}

export interface UserItem {
  kind: "user";
  key: string;
  text: string;
  /** attachment labels (file names) carried by this message — rendered as
   *  chips, never as inline content. */
  files?: string[];
}

export interface InfoItem {
  kind: "info";
  key: string;
  text: string;
}

export type FoldItem = UserItem | TurnItem | InfoItem;

export class ConversationFold {
  items: FoldItem[] = [];
  private lastSeq = -1;
  private firstSeq = -1;
  private turnCounter = 0;
  private running = false;

  get seq(): number {
    return this.lastSeq;
  }

  /** Oldest event seq currently folded in (pagination cursor); -1 = none. */
  get oldestSeq(): number {
    return this.firstSeq;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Accept one mux payload (session/event frame), one history entry ({event,view?}), or one bare event. */
  push(entryOrEvent: unknown): void {
    const anyE = entryOrEvent as any;
    // Unwrap the live mux envelope: {type:"session/event", event, view?}.
    // The check must come FIRST — the payload's own .type would otherwise be
    // mistaken for the event type and every live frame silently dropped.
    let ev: any;
    let view: { view?: any } | undefined;
    if (anyE?.type === "session/event" && anyE.event && typeof anyE.event === "object") {
      ev = anyE.event;
      view = anyE;
    } else if (anyE?.event && typeof anyE.event === "object") {
      ev = anyE.event; // history entry {event, view?}
      view = anyE;
    } else {
      ev = anyE; // bare event
    }
    if (!ev || typeof ev.type !== "string") return;
    if (typeof ev.seq === "number") {
      if (ev.seq <= this.lastSeq) return; // dedupe across WS/reconnect/history overlap
      if (this.firstSeq < 0) this.firstSeq = ev.seq;
      this.lastSeq = ev.seq;
    }
    switch (ev.type) {
      case "user/message": {
        // Injections arrive as their OWN user/message events (runtime-context
        // snapshots, policy-change notices) — drop them whole; mixed messages
        // keep their human text after paragraph-level stripping.
        // File-attachment content parts arrive as separate text blocks shaped
        // "[引用文件 X]\n<content>" — extract the label, drop the content.
        const { text, files } = extractUserPayload(ev.data);
        if (text || files.length > 0) {
          this.items.push({ kind: "user", key: `u${this.lastSeq}-${this.items.length}`, text, ...(files.length > 0 ? { files } : {}) });
        }
        break;
      }
      case "turn/start": {
        this.running = true;
        this.turnCounter += 1;
        this.items.push({ kind: "turn", key: `t${this.turnCounter}-${this.lastSeq}`, text: "", thinking: "", activities: [], ended: false });
        break;
      }
      case "turn/end": {
        this.running = false;
        const cur = this.currentTurn();
        if (cur) {
          cur.ended = true;
          cur.liveTool = undefined;
        } else {
          // Warmup/empty turn with no start seen — ignore.
        }
        break;
      }
      case "assistant/chunk": {
        this.applyChunk(ev.data?.chunk, view);
        break;
      }
      case "assistant/message": {
        // Degradation path: some versions put the full message here.
        const cur = this.currentTurn();
        if (cur && !cur.text) {
          const m = ev.data?.message ?? ev.data?.content ?? ev.data;
          const mt = typeof m === "string" ? m : m?.content;
          if (typeof mt === "string") cur.text = stripSystemContext(mt);
        }
        break;
      }
      case "tool/call": {
        const d = ev.data ?? {};
        const args = parseJson(d.arguments) ?? (view?.view?.card ? undefined : undefined);
        const meta = subagentMeta(d.name, args);
        this.toolActivity({
          key: String(d.callId ?? `tc${this.lastSeq}`),
          name: meta?.displayName ?? d.name,
          args,
          label: meta ? meta.label : `🔧 ${d.name ?? "工具"}`,
        });
        break;
      }
      case "tool/result": {
        const d = ev.data ?? {};
        const preview = extractResultPreview(d, view?.view);
        this.finishTool(String(d.callId ?? ""), preview, isErrorResult(d));
        break;
      }
      default:
        break; // unknown persistent events: ignore (loose by design)
    }
  }

  pushMany(entries: unknown[]): void {
    for (const e of entries) this.push(e);
  }

  /** Prepend older history page (entries arrive oldest-first). */
  unshiftMany(entries: unknown[]): void {
    // Fold them in a scratch fold, then splice the resulting items in front.
    const scratch = new ConversationFold();
    scratch.pushMany(entries);
    if (scratch.firstSeq >= 0 && (this.firstSeq < 0 || scratch.firstSeq < this.firstSeq)) {
      this.firstSeq = scratch.firstSeq;
    }
    this.items = [...scratch.items, ...this.items];
  }

  reset(): void {
    this.items = [];
    this.lastSeq = -1;
    this.firstSeq = -1;
    this.turnCounter = 0;
    this.running = false;
  }

  private applyChunk(chunk: any, view: { view?: any } | undefined): void {
    if (!chunk || typeof chunk.type !== "string") return;
    const cur = this.ensureTurn();
    switch (chunk.type) {
      case "text-delta":
        if (typeof chunk.text === "string") cur.text += chunk.text;
        break;
      case "reasoning-delta":
        if (typeof chunk.text === "string") cur.thinking += chunk.text;
        break;
      case "usage":
      case "finish":
        break; // metadata
      case "tool-call":
      case "tool-call-delta": {
        const name = chunk.name ?? chunk.toolName;
        const args = parseJson(chunk.arguments ?? chunk.args ?? chunk.input);
        const meta = subagentMeta(name, args);
        this.toolActivity({
          key: String(chunk.callId ?? chunk.toolCallId ?? chunk.id ?? `c${this.lastSeq}`),
          name: meta?.displayName ?? name,
          args,
          label: meta ? meta.label : `🔧 ${name ?? "工具"}`,
        });
        break;
      }
      case "tool-result":
      case "tool-call-result": {
        const preview = extractResultPreview(chunk, view?.view);
        this.finishTool(String(chunk.callId ?? chunk.toolCallId ?? chunk.id ?? ""), preview, isErrorResult(chunk));
        break;
      }
      case "agent-start":
        this.toolActivity({ key: `ag:${chunk.agentId ?? chunk.id ?? this.lastSeq}`, name: chunk.name, label: `👤 Agent ${chunk.name ?? ""}` });
        break;
      case "agent-end":
        this.finishTool(`ag:${chunk.agentId ?? chunk.id ?? ""}`, resultPreviewOf(chunk.result), !!chunk.error);
        break;
      case "subagent-start":
        this.toolActivity({
          key: `sa:${chunk.subagentId ?? chunk.id ?? this.lastSeq}`,
          name: chunk.name ?? chunk.agentId,
          label: `👥 子代理 ${chunk.name ?? chunk.agentId ?? ""}${chunk.task ? `（${String(chunk.task).slice(0, 30)}）` : ""}`,
        });
        break;
      case "subagent-end":
        this.finishTool(`sa:${chunk.subagentId ?? chunk.id ?? ""}`, resultPreviewOf(chunk.result), !!chunk.error);
        break;
      case "step-start":
        this.toolActivity({ key: `st:${chunk.id ?? this.lastSeq}`, name: chunk.title, label: `📍 ${chunk.title ?? chunk.name ?? "步骤"}` });
        break;
      case "step-end":
        this.finishTool(`st:${chunk.id ?? ""}`, "", false);
        break;
      case "block-start":
      case "block-end":
        break; // noise by default (FocusView-lite)
      default:
        break; // unknown chunk: ignore silently (diagnostics live ext-side)
    }
  }

  private ensureTurn(): TurnItem {
    let cur = this.currentTurn();
    if (!cur || cur.ended) {
      this.turnCounter += 1;
      cur = { kind: "turn", key: `t${this.turnCounter}-${this.lastSeq}`, text: "", thinking: "", activities: [], ended: false };
      this.items.push(cur);
      this.running = true;
    }
    return cur;
  }

  private currentTurn(): TurnItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "user") return undefined; // turn belongs to an older user msg already closed
      if (it.kind === "turn") return it;
    }
    return undefined;
  }

  private toolActivity(init: { key: string; name?: string; args?: unknown; label: string }): void {
    const cur = this.ensureTurn();
    const existing = cur.activities.find((a) => a.key === init.key);
    if (existing) {
      if (init.name) existing.name = init.name;
      if (init.args !== undefined) existing.args = init.args;
      return;
    }
    const act: ToolActivity = {
      key: init.key,
      kind: init.label.startsWith("🔧") ? "tool" : init.label.startsWith("👥") ? "subagent" : init.label.startsWith("👤") ? "agent" : "other",
      label: init.label,
      detail: argsPreview(init.args),
      state: "running",
      callId: init.key,
      name: init.name,
      args: init.args,
    };
    cur.activities.push(act);
    cur.liveTool = liveLabel(act);
  }

  private finishTool(key: string, preview: string | undefined, isError: boolean): void {
    const turn = this.currentTurn();
    if (!turn) return;
    const act = turn.activities.find((a) => a.key === key);
    if (act) {
      act.state = isError ? "error" : "done";
      if (preview) act.resultPreview = preview;
    }
    // live indicator: point to the next still-running activity or clear
    for (let i = turn.activities.length - 1; i >= 0; i--) {
      const a = turn.activities[i];
      if (a.state === "running") {
        turn.liveTool = liveLabel(a);
        return;
      }
    }
    turn.liveTool = undefined;
  }
}

function liveLabel(a: ToolActivity): string {
  if (a.kind === "subagent" && a.name) return `子代理 ${a.name}`;
  return a.name ? `${a.name}${a.detail ? ` · ${a.detail.slice(0, 60)}` : ""}` : a.label;
}

/**
 * Subagent delegations surface as ordinary tool/call rows (name `subagent`,
 * `workflow`, `ralph`, …) on this host — there are no agent-* chunks. Give
 * them a distinct face: 👥 label built from the human description.
 */
function subagentMeta(name: unknown, args: unknown): { label: string; displayName: string } | null {
  const n = typeof name === "string" ? name.toLowerCase() : "";
  if (!["subagent", "subagent_fork", "ralph", "workflow", "agent_teams_add_member"].includes(n)) return null;
  const a = (args ?? {}) as Record<string, any>;
  const desc =
    (typeof a.description === "string" && a.description) ||
    (typeof a.prompt === "string" ? a.prompt.split("\n", 1)[0].slice(0, 40) : "") ||
    (typeof a.objective === "string" ? a.objective.split("\n", 1)[0].slice(0, 40) : "") ||
    "";
  return {
    label: `👥 子代理${desc ? ` · ${desc.slice(0, 50)}` : ""}`,
    displayName: desc.slice(0, 50) || String(name),
  };
}

function argsPreview(args: unknown): string {
  if (args === undefined) return "";
  try {
    const s = typeof args === "string" ? args : JSON.stringify(args);
    return s.length > 160 ? `${s.slice(0, 160)}…` : s;
  } catch {
    return "";
  }
}

function resultPreviewOf(result: unknown): string | undefined {
  if (result === undefined || result === null) return undefined;
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return undefined;
  }
}

function extractResultPreview(data: any, view: any): string | undefined {
  // persistent tool/result: {message:{content:[{type:'text',text}]}, meta}
  const text = data?.message?.content?.[0]?.text ?? data?.content?.[0]?.text;
  if (typeof text === "string" && text) return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  if (view?.card && typeof view.card === "string") {
    return view.card.length > 200 ? `${view.card.slice(0, 200)}…` : view.card;
  }
  return resultPreviewOf(data?.result);
}

function isErrorResult(data: any): boolean {
  if (data?.isError === true) return true;
  const content = data?.message?.content?.[0];
  return content?.isError === true;
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/** Extract (human text, attachment labels) from a user/message payload.
 *  Attachment parts are text blocks starting with "[引用文件 X]"; their
 *  content is dropped here — the bubble shows chips, never file content. */
function extractUserPayload(data: unknown): { text: string; files: string[] } {
  const d = (data ?? {}) as any;
  const parts: string[] = [];
  const files: string[] = [];
  const consider = (t: string): void => {
    const m = /^\[引用文件 (.+?)\]\n?/.exec(t.trim());
    if (m) {
      files.push(m[1]);
      return;
    }
    parts.push(t);
  };
  if (typeof d.text === "string") consider(d.text);
  else if (Array.isArray(d.content)) {
    for (const c of d.content) {
      if (c && typeof c.text === "string" && c.text) consider(c.text);
    }
  } else if (typeof d.content === "string") consider(d.content);
  return { text: stripSystemContext(parts.join("\n\n")), files };
}

// ---- stripSystemContext (paragraph-level, Obsidian-proven core + VSCode extras) ----

/** Paragraph heads that mark a DSH-injected block (snapshot / policy notice). */
const INJECTED_HEADS = [
  /^Current runtime context\b/,
  /^Current DSH file policy:/,
  /^The DSH file policy changed\b/,
  /^Approval policy:/,
  /^Approval prompts are disabled\b/,
  /^The approval policy changed\b/,
  /^This snapshot supersedes\b/,
  /^The available skill catalog changed\b/,
];

function isInjectedParagraphStart(para: string): boolean {
  const first = para.split("\n", 1)[0]?.trim() ?? "";
  if (!first) return false;
  if (INJECTED_HEADS.some((re) => re.test(first))) return true;
  return isSystemContextStart(first);
}

function isSystemContextStart(s: string): boolean {
  if (!s) return false;
  return (
    /Current runtime context\b/.test(s) ||
    /<system\b/.test(s) ||
    /<available_skills>/.test(s) ||
    /Current DSH file policy:/.test(s) ||
    /Approval prompts are disabled/.test(s)
  );
}

function findSystemContextEnd(s: string): number {
  // closing tags appear in order of specificity; generic </system…> last
  let i = s.search(/<\/available_skills>/i);
  if (i >= 0) return i + "</available_skills>".length;
  i = s.search(/<\/system-reminder>/i);
  if (i >= 0) return i + "</system-reminder>".length;
  i = s.search(/<\/system-[a-z-]*>/i);
  if (i >= 0) {
    const m = /<\/system-[a-z-]*>/i.exec(s);
    if (m) return i + m[0].length;
  }
  i = s.search(/<\/system>/i);
  if (i >= 0) return i + "</system>".length;
  return -1;
}

export function stripSystemContext(text: string): string {
  if (!text) return text;
  // 1) tagged reminder spans (<system-reminder>…</system-reminder>) anywhere:
  //    drop the whole span; an unclosed one (streaming) drops to the end.
  let s = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").replace(/<system-reminder>[\s\S]*$/g, "");
  // 2) legacy tagged blocks (<system>, <available_skills>) at the head
  let guard = 0;
  while (guard++ < 8 && isSystemContextStart(s)) {
    const end = findSystemContextEnd(s);
    if (end < 0) break; // no clear boundary: keep text (never over-delete)
    s = s.slice(end).replace(/^\s*\n+/, "");
  }
  // 3) injected paragraphs (runtime-context snapshots / policy notices):
  //    drop every paragraph whose head matches an injection marker — they
  //    arrive standalone OR appended after the user's own text.
  const paras = s.split(/\n\s*\n/);
  const kept = paras.filter((p) => !isInjectedParagraphStart(p.trim()));
  const stripped = kept.join("\n\n").trim();
  return stripped;
}
