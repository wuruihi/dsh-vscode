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
  /** INTERLEAVED segments in true arrival order — the render source of
   *  truth (text/thinking/activities above stay synced as flat views). */
  segments: TurnSeg[];
  /** current running tool label for the live indicator */
  liveTool?: string;
  /** files produced by this turn's successful mutation tools (diff/edit
   *  call-view locations, web-GUI ProducedFiles semantics) */
  produced?: string[];
  /** last event seq seen in this turn — the fork-at anchor */
  lastSeq?: number;
  /** 1-based turn number for the separator pill */
  turnNo?: number;
}

export type TurnSeg =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; act: ToolActivity };

export interface UserItem {
  kind: "user";
  key: string;
  text: string;
  /** attachment labels (file names) carried by this message — rendered as
   *  chips, never as inline content. */
  files?: string[];
  /** images carried by this message. rc.8+ logs durable refs
   *  ({attachment, attachmentId}); pre-rc.8 logs inline base64. */
  images?: FoldImage[];
}

/** One renderable image in a user message: either a durable ref to pull via
 *  session.attachment, or an already-complete data URL (legacy inline shape). */
export interface FoldImage {
  attachmentId?: string;
  dataUrl?: string;
  mediaType: string;
  name?: string;
  width?: number;
  height?: number;
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
        // Image parts: rc.8+ durable refs / pre-rc.8 inline base64.
        const { text, files, images } = extractUserPayload(ev.data);
        if (text || files.length > 0 || images.length > 0) {
          this.items.push({
            kind: "user",
            key: `u${this.lastSeq}-${this.items.length}`,
            text,
            ...(files.length > 0 ? { files } : {}),
            ...(images.length > 0 ? { images } : {}),
          });
        }
        break;
      }
      case "turn/start": {
        this.running = true;
        this.turnCounter += 1;
        this.items.push({ kind: "turn", key: `t${this.turnCounter}-${this.lastSeq}`, text: "", thinking: "", activities: [], segments: [], ended: false, turnNo: this.turnCounter });
        break;
      }
      case "turn/end": {
        this.running = false;
        const cur = this.currentTurn();
        if (cur) {
          cur.ended = true;
          cur.liveTool = undefined;
          cur.lastSeq = this.lastSeq; // fork-at anchor: everything through this seq
        } else {
          // Warmup/empty turn with no start seen — ignore.
        }
        break;
      }
      case "assistant/chunk": {
        this.applyChunk(ev.data?.chunk, view);
        break;
      }
      // History replay (session/page) compacts text/reasoning deltas into
      // chunkrow rows — text-delta chunks are NOT persisted (probed: 3474
      // assistant/chunk events in a real history contain only
      // block/tool-call/usage/finish frames). Without these two cases every
      // reloaded conversation lost all its prose.
      case "chunkrow/text-chunks": {
        const texts = ev.data?.texts;
        if (Array.isArray(texts) && texts.length > 0) this.appendSeg("text", texts.join(""));
        break;
      }
      case "chunkrow/reasoning-chunks": {
        const texts = ev.data?.texts;
        if (Array.isArray(texts) && texts.length > 0) this.appendSeg("thinking", texts.join(""));
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
        const args = parseJson(d.arguments);
        const meta = subagentMeta(d.name, args);
        this.toolActivity({
          key: String(d.callId ?? `tc${this.lastSeq}`),
          name: meta?.displayName ?? d.name,
          args,
          label: meta ? meta.label : String(d.name ?? "工具"),
        });
        break;
      }
      case "tool/result": {
        const d = ev.data ?? {};
        const preview = extractResultPreview(d, view?.view);
        const isError = isErrorResult(d);
        if (!isError) this.addProduced(producedPathsFromCallView(view?.view));
        // wire fact (rc.2/alpha.5 probed): the callId lives at
        // data.callId OR nested in data.message.source.callId /
        // data.message.content[0].toolCallId — the top-level read alone
        // left every activity "running" forever.
        this.finishTool(resultCallId(d), preview, isError);
        break;
      }
      case "step/start": {
        const d = ev.data ?? {};
        const key = `st:${d.id ?? `${d.turn ?? "?"}-${d.step ?? "?"}`}`;
        this.toolActivity({ key, name: d.title ?? d.name, label: `📍 ${d.title ?? d.name ?? `步骤 ${d.step ?? ""}`}`.trim() });
        break;
      }
      case "step/end": {
        const d = ev.data ?? {};
        const key = `st:${d.id ?? `${d.turn ?? "?"}-${d.step ?? "?"}`}`;
        this.finishTool(key, "", false);
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
    this.ensureTurn(); // early chunk before turn/start still gets a turn
    switch (chunk.type) {
      case "text-delta":
        if (typeof chunk.text === "string") this.appendSeg("text", chunk.text);
        break;
      case "reasoning-delta":
        if (typeof chunk.text === "string") this.appendSeg("thinking", chunk.text);
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
          label: meta ? meta.label : String(name ?? "工具"),
        });
        break;
      }
      case "tool-result":
      case "tool-call-result": {
        const preview = extractResultPreview(chunk, view?.view);
        const isError = isErrorResult(chunk);
        if (!isError) this.addProduced(producedPathsFromCallView(view?.view));
        this.finishTool(resultCallId(chunk), preview, isError);
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
      cur = { kind: "turn", key: `t${this.turnCounter}-${this.lastSeq}`, text: "", thinking: "", activities: [], segments: [], ended: false, turnNo: this.turnCounter };
      this.items.push(cur);
      this.running = true;
    }
    return cur;
  }

  /** Append a text/thinking delta to the LAST segment of its kind — creating
   *  one when the kind changes — so segments stay interleaved in true
   *  arrival order (text → tool → text renders in exactly that order). */
  private appendSeg(kind: "text" | "thinking", delta: string): void {
    const cur = this.ensureTurn();
    if (kind === "text") cur.text += delta;
    else cur.thinking += delta;
    const last = cur.segments[cur.segments.length - 1];
    if (last && last.kind === kind) {
      (last as { text: string }).text += delta;
    } else {
      cur.segments.push(kind === "text" ? { kind: "text", text: delta } : { kind: "thinking", text: delta });
    }
  }

  /** Produced-files derivation (web-GUI ProducedFiles semantics): only diff
   *  cards or kind=edit generic cards count; reads/deletes/failed calls don't.
   *  First-seen order, de-duplicated. */
  private addProduced(paths: string[]): void {
    if (paths.length === 0) return;
    const cur = this.ensureTurn();
    cur.produced ??= [];
    for (const p of paths) {
      if (!cur.produced.includes(p)) cur.produced.push(p);
    }
  }

  private currentTurn(): TurnItem | undefined {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      if (it.kind === "user") return undefined; // turn belongs to an older user msg already closed
      if (it.kind === "turn") return it;
    }
    return undefined;
  }

  private toolActivity(init: { key: string; name?: string; args?: unknown; label: string; kind?: ToolActivity["kind"] }): void {
    const cur = this.ensureTurn();
    const existing = cur.activities.find((a) => a.key === init.key);
    if (existing) {
      if (init.name) existing.name = init.name;
      if (init.args !== undefined) existing.args = init.args;
      return;
    }
    const act: ToolActivity = {
      key: init.key,
      kind: init.kind ?? (init.label.startsWith("👥") ? "subagent" : init.label.startsWith("👤") ? "agent" : init.label.startsWith("📍") ? "step" : "tool"),
      label: init.label,
      detail: argsPreview(init.args),
      state: "running",
      callId: init.key,
      name: init.name,
      args: init.args,
    };
    cur.activities.push(act);
    cur.segments.push({ kind: "tool", act });
    cur.liveTool = liveLabel(act);
  }

  private finishTool(key: string, preview: string | undefined, isError: boolean): void {
    if (!key) return;
    // current turn first, then a bounded backward scan — a result landing
    // after turn/end (edge orderings) must still resolve its activity.
    const turns: TurnItem[] = [];
    for (let i = this.items.length - 1; i >= 0 && turns.length < 5; i--) {
      const it = this.items[i];
      if (it.kind === "turn") turns.push(it);
    }
    for (const turn of turns) {
      const act = turn.activities.find((a) => a.key === key);
      if (act) {
        act.state = isError ? "error" : "done";
        if (preview) act.resultPreview = preview;
        break;
      }
    }
    // live indicator: point to the next still-running activity or clear
    const turn = turns[0];
    if (!turn) return;
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

/** Web-GUI producedPaths: only diff cards or kind=edit generic cards carry
 *  produced locations (reads/deletes never count). */
function producedPathsFromCallView(view: any): string[] {
  if (!view || typeof view !== "object") return [];
  if (view.card !== "diff" && !(view.card === "generic" && view.kind === "edit")) return [];
  if (!Array.isArray(view.locations)) return [];
  return view.locations.map((l: any) => l?.path).filter((p: unknown): p is string => typeof p === "string");
}

function resultPreviewOf(result: unknown): string | undefined {  if (result === undefined || result === null) return undefined;
  try {
    const s = typeof result === "string" ? result : JSON.stringify(result);
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  } catch {
    return undefined;
  }
}

/** Wire fact (rc.2 + alpha.5 probed): the tool/result callId can sit at
 *  data.callId, data.message.source.callId, or
 *  data.message.content[0].toolCallId — accept all three (loose parsing). */
function resultCallId(d: any): string {
  return String(
    d?.callId ?? d?.toolCallId ?? d?.message?.source?.callId ?? d?.message?.content?.[0]?.toolCallId ?? d?.id ?? "",
  );
}

function extractResultPreview(data: any, view: any): string | undefined {
  // persistent tool/result nesting (probed): message.content[0] is a
  // {type:"tool-result", content:[{type:"text",text}]} block — the text
  // lives one level deeper than the legacy {type:"text",text} shape.
  const text =
    data?.message?.content?.[0]?.content?.[0]?.text ??
    data?.message?.content?.[0]?.text ??
    data?.content?.[0]?.text ??
    data?.text;
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

/** Extract (human text, attachment labels, images) from a user/message payload.
 *  Attachment parts are text blocks starting with "[引用文件 X]"; their
 *  content is dropped here — the bubble shows chips, never file content. */
function extractUserPayload(data: unknown): { text: string; files: string[]; images: FoldImage[] } {
  const d = (data ?? {}) as any;
  const parts: string[] = [];
  const files: string[] = [];
  const images: FoldImage[] = [];
  const consider = (t: string): void => {
    const m = /^\[引用文件 (.+?)\]\n?/.exec(t.trim());
    if (m) {
      files.push(m[1]);
      return;
    }
    parts.push(t);
  };
  const imageOf = (c: any): FoldImage | undefined => {
    if (!c || typeof c !== "object") return undefined;
    // rc.8+ durable: {type:"image", attachment:{attachmentId, mediaType, name?, width?, height?}}
    const ref = c.attachment;
    if (ref && typeof ref === "object" && typeof ref.attachmentId === "string" && ref.attachmentId) {
      return {
        attachmentId: ref.attachmentId,
        mediaType: typeof ref.mediaType === "string" ? ref.mediaType : "image/png",
        ...(typeof ref.name === "string" && ref.name ? { name: ref.name } : {}),
        ...(typeof ref.width === "number" ? { width: ref.width } : {}),
        ...(typeof ref.height === "number" ? { height: ref.height } : {}),
      };
    }
    // pre-rc.8 inline: {type:"image", mediaType, data(base64)}
    if (typeof c.data === "string" && c.data) {
      const mediaType = typeof c.mediaType === "string" ? c.mediaType : "image/png";
      return { dataUrl: `data:${mediaType};base64,${c.data}`, mediaType };
    }
    return undefined;
  };
  if (typeof d.text === "string") consider(d.text);
  else if (Array.isArray(d.content)) {
    for (const c of d.content) {
      const img = c?.type === "image" ? imageOf(c) : undefined;
      if (img) {
        images.push(img);
        continue;
      }
      if (c && typeof c.text === "string" && c.text) consider(c.text);
    }
  } else if (typeof d.content === "string") consider(d.content);
  const raw = parts.join("\n\n");
  // Instruction injections (AGENTS.md / CLAUDE.md / skill docs) arrive as
  // standalone MULTI-paragraph documents — paragraph-level stripping would
  // only remove the head paragraph and keep the whole body. A message whose
  // first paragraph is an instruction head is an injection carrier: drop all.
  const firstLine = (raw.split(/\n\s*\n/, 1)[0] ?? "").split("\n", 1)[0]?.trim() ?? "";
  if (/^Instructions from\b/.test(firstLine)) return { text: "", files, images };
  return { text: stripSystemContext(raw), files, images };
}

// ---- stripSystemContext (paragraph-level, Obsidian-proven core + VSCode extras) ----

/** Paragraph heads that mark a DSH-injected block (snapshot / policy notice). */
const INJECTED_HEADS = [
  /^Instructions from\b/,
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
