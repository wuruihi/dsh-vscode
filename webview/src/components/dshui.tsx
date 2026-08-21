import { useState } from "react";
import { Mermaid } from "./mermaid.js";

/**
 * dsh-ui fence renderer — pragmatic subset of the GenUI vocabulary.
 * - streaming (live) with incomplete JSON → placeholder, never raw JSON
 * - settled but unparseable → failure callout + collapsible raw spec
 * - unknown component types degrade to a code block
 */

type Node = Record<string, any>;

// ---- spec parsing: strict → cheap fixes → items-merge repair ----
// The native GUI repairs malformed-but-recoverable fences; a strict client
// diverges from it on exactly those (models do emit them). Mirroring the
// dominant failure: root object closes after the first items element, the
// remaining components follow as orphan top-level values (+ stray `]}`).

/** Bracket-balance repair for a spec fragment: when a `}` arrives while the
 *  container stack top is `[` (impossible in valid JSON — the model closed an
 *  object while an array stayed open), insert the missing `]`; auto-close
 *  whatever is left open at the end (truncation tails). Null = not fixable
 *  (stack underflow, mid-string cut, or too many fixes). */
function balanceClose(s: string): string | null {
  const stack: string[] = [];
  let out = "";
  let inStr = false;
  let esc = false;
  let fixes = 0;
  for (const ch of s) {
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      out += ch;
      continue;
    }
    if (ch === "}") {
      if (stack[stack.length - 1] === "[") {
        if (++fixes > 8) return null;
        out += "]";
        stack.pop();
      }
      if (stack.pop() !== "{") return null;
      out += ch;
      continue;
    }
    if (ch === "]") {
      if (stack.pop() !== "[") return null;
      out += ch;
      continue;
    }
    out += ch;
  }
  if (inStr) return null; // mid-string truncation: never guess
  while (stack.length) out += stack.pop() === "{" ? "}" : "]";
  return out;
}

function scanValue(text: string, pos: number): [number, unknown] | null {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  if (i >= text.length) return null;
  const open = text[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) {
    let j = i;
    while (j < text.length && !",]}".includes(text[j])) j++;
    try {
      return [j, JSON.parse(text.slice(start, j).trim())];
    } catch {
      return null;
    }
  }
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = i; k < text.length; k++) {
    const ch = text[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const slice = text.slice(start, k + 1);
        try {
          return [k + 1, JSON.parse(slice)];
        } catch {
          /* balanced-but-invalid (e.g. items [ left open by an early root
             close): retry with the bracket-balance repair before giving up */
        }
        const balanced = balanceClose(slice);
        if (balanced) {
          try {
            return [k + 1, JSON.parse(balanced)];
          } catch {
            /* fallthrough */
          }
        }
        return null;
      }
    }
  }
  return null;
}

function repairSpec(raw: string): Node | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  const first = scanValue(text, 0);
  if (!first) return null;
  const [end1, v1] = first;
  const root = v1 as Node;
  if (!root || typeof root !== "object" || !Array.isArray(root.items)) return null;
  let pos = end1;
  const orphans: unknown[] = [];
  let guard = 0;
  while (guard++ < 50) {
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    if (pos >= text.length) break;
    if (text[pos] === "]" || text[pos] === "}") {
      if (/^[\]}]+$/.test(text.slice(pos))) break; // trailing stray closers
      return null; // structural shape we don't understand — bail, never guess
    }
    const nxt = scanValue(text, pos);
    if (!nxt) return null;
    orphans.push(nxt[1]);
    pos = nxt[0];
  }
  if (orphans.length === 0) return null;
  root.items = [...root.items, ...orphans];
  return root;
}

function cheapRepairs(s: string): string {
  return s.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'").replace(/,\s*([}\]])/g, "$1");
}

function parseSpec(raw: string): Node | null {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : null;
  } catch {
    /* fallthrough */
  }
  const cheap = cheapRepairs(raw);
  try {
    const v = JSON.parse(cheap);
    return v && typeof v === "object" ? v : null;
  } catch {
    /* fallthrough */
  }
  // truncation tails: the fence settled while containers were still open
  const closed = balanceClose(cheap);
  if (closed) {
    try {
      const v = JSON.parse(closed);
      if (v && typeof v === "object") return v;
    } catch {
      /* fallthrough */
    }
  }
  const fixed = repairSpec(cheap);
  return fixed;
}

export function DshUi({ spec, live }: { spec: string; live?: boolean }) {
  const parsed = parseSpec(spec);
  if (!parsed || !Array.isArray((parsed as Node).items)) {
    if (live) return <div className="dui dui-pending">⚙️ 组件生成中…</div>;
    return (
      <div className="dui dui-broken">
        <div className="dui-callout dui-callout-warning">⚠️ 组件渲染失败（JSON 无法解析）</div>
        <details>
          <summary className="muted">原始内容</summary>
          <pre className="code-block">{spec}</pre>
        </details>
      </div>
    );
  }
  // The ROOT is a container spec ({title?, gap?, items}), NOT a component
  // node — it has no `type`, so it must not go through RenderNode's switch.
  return (
    <div className="dui" style={typeof parsed.gap === "number" ? { gap: parsed.gap } : undefined}>
      {parsed.title ? <div className="dui-text dui-text-h3">{parsed.title}</div> : null}
      {parsed.items.map((c: Node, i: number) => (
        <RenderNode key={i} node={c} />
      ))}
    </div>
  );
}

export function RenderNode({ node }: { node: Node }) {
  const t = typeof node?.type === "string" ? node.type : "";
  switch (t) {
    case "text": {
      const size = node.size ?? "body";
      if (size === "h1" || size === "h2" || size === "h3") {
        const Tag = size === "h1" ? "h2" : size === "h2" ? "h3" : "h4";
        return <Tag className={`dui-text dui-text-${size}${node.center ? " dui-center" : ""}`}>{node.content ?? ""}</Tag>;
      }
      return <div className={`dui-text dui-text-${size}${node.center ? " dui-center" : ""}`}>{node.content ?? ""}</div>;
    }
    case "table":
      return <Table node={node} />;
    case "list":
      return (
        <ul className="dui-list">
          {(node.items ?? []).map((it: any, i: number) => {
            if (typeof it === "string") return <li key={i}>{it}</li>;
            return (
              <li key={i} className="dui-list-rich">
                {it?.title ? <span className="dui-list-t">{it.title}</span> : null}
                {it?.desc ? <span className="muted">{it.desc}</span> : null}
              </li>
            );
          })}
        </ul>
      );
    case "steps":
      return (
        <ol className="dui-steps">
          {(node.steps ?? []).map((s: any, i: number) => {
            const active = i === (node.current ?? 0) - 1;
            const done = i < (node.current ?? 0) - 1;
            return (
              <li key={i} className={`${active ? "is-active" : ""}${done ? " is-done" : ""}`}>
                <span className="dui-step-n">{done ? "✓" : i + 1}</span>
                <div className="dui-step-body">
                  <span className="dui-step-t">{s?.title ?? ""}</span>
                  {s?.desc ? <div className="muted dui-step-d">{s.desc}</div> : null}
                </div>
              </li>
            );
          })}
        </ol>
      );
    case "timeline":
      return (
        <div className="dui-timeline">
          {(node.items ?? []).map((it: any, i: number) => (
            <div key={i} className="dui-tl-row">
              <div className="dui-tl-dot" />
              <div>
                <div className="dui-tl-head">
                  <span className="dui-step-t">{it?.title ?? ""}</span>
                  {it?.time ? <span className="dui-badge dui-badge-accent">{it.time}</span> : null}
                </div>
                {it?.desc ? <div className="muted">{it.desc}</div> : null}
              </div>
            </div>
          ))}
        </div>
      );
    case "callout": {
      const tone = node.tone ?? "info";
      const icon = tone === "success" ? "✅" : tone === "warning" ? "⚠️" : tone === "error" ? "❌" : "ℹ️";
      return (
        <div className={`dui-callout dui-callout-${tone}`}>
          <div className="dui-callout-inner">
            <span className="dui-callout-ic">{icon}</span>
            <div>
              {node.title ? <div className="dui-callout-title">{node.title}</div> : null}
              <div>{node.content ?? ""}</div>
            </div>
          </div>
        </div>
      );
    }
    case "badge":
      return (
        <span className={`dui-badge dui-badge-${node.tone ?? "accent"}`}>
          {typeof node.icon === "string" ? `${node.icon} ` : ""}
          {node.label ?? ""}
        </span>
      );
    case "link":
      return typeof node.href === "string" && /^https?:\/\//.test(node.href) ? (
        <a className="dui-link" href={node.href} target="_blank" rel="noreferrer noopener">
          {node.label ?? node.href}
        </a>
      ) : (
        <span className="muted">{node.label ?? ""}</span>
      );
    case "copy":
      return <CopyBtn text={typeof node.text === "string" ? node.text : safeJson(node.text)} label={node.label ?? "复制"} />;
    case "json":
      return <pre className="code-block dui-code">{safeJson(node.value)}</pre>;
    case "code":
      return <pre className="code-block dui-code">{node.code ?? ""}</pre>;
    case "keyvalue":
      return (
        <div className="dui-kv">
          {(node.pairs ?? []).map((p: any, i: number) => (
            <div key={i} className="dui-kv-row">
              <span className="dui-kv-k">{p?.key ?? ""}</span>
              <span className="dui-kv-v">{toText(p?.value)}</span>
            </div>
          ))}
        </div>
      );
    case "grid":
      return (
        <div className={`dui-grid dui-cols-${node.cols ?? 2}`}>
          {(node.items ?? []).map((c: Node, i: number) => (
            <RenderNode key={i} node={c} />
          ))}
        </div>
      );
    case "stat":
      return (
        <div className="dui-stat">
          <div className="muted dui-stat-l">{node.label ?? ""}</div>
          <div className="dui-stat-v">{node.value ?? ""}</div>
          {node.delta ? <div className={`dui-stat-d ${String(node.delta).startsWith("-") ? "is-down" : ""}`}>{node.delta}</div> : null}
        </div>
      );
    case "progress":
      return (
        <div className="dui-progress-wrap">
          <div className="dui-progress-head">
            <span className="muted">{node.label ?? ""}</span>
            <span className="muted">{node.valueLabel ?? `${clampPct(node.value)}%`}</span>
          </div>
          <div className="dui-progress">
            <div className="dui-progress-fill" style={{ width: `${clampPct(node.value)}%` }} />
          </div>
        </div>
      );
    case "divider":
      return <hr className="dui-divider" />;
    case "spacer":
      return <div className="dui-spacer" />;
    case "col":
      return (
        <div className="dui-col">
          {(node.items ?? []).map((c: Node, i: number) => (
            <RenderNode key={i} node={c} />
          ))}
        </div>
      );
    case "row":
      return (
        <div className="dui-row" style={{ flexWrap: node.wrap === false ? "nowrap" : undefined }}>
          {(node.items ?? []).map((c: Node, i: number) => (
            <RenderNode key={i} node={c} />
          ))}
        </div>
      );
    case "card":
      return (
        <div className="dui-card">
          {node.title ? <div className="dui-card-title">{node.title}</div> : null}
          {(node.items ?? []).map((c: Node, i: number) => (
            <RenderNode key={i} node={c} />
          ))}
        </div>
      );
    case "avatar":
      return (
        <span className="dui-avatar" title={node.name ?? ""}>
          {(node.name ?? "?").trim().charAt(0).toUpperCase()}
        </span>
      );
    case "breadcrumb":
      return (
        <div className="dui-row dui-breadcrumb">
          {(node.items ?? []).map((it: unknown, i: number) => (
            <span key={i} className="dui-crumb">
              {toText(it)}
              {i < (node.items ?? []).length - 1 && <span className="muted"> › </span>}
            </span>
          ))}
        </div>
      );
    case "tabs":
      return <Tabs node={node} />;
    case "accordion":
      return (
        <div className="dui-acc">
          {(node.items ?? []).map((it: any, i: number) => (
            <Accordion key={i} title={it?.title ?? ""} items={it?.items ?? []} />
          ))}
        </div>
      );
    case "chart":
      return <Chart node={node} />;
    case "mermaid":
      return <Mermaid code={String(node.code ?? "")} />;
    case "plot":
      return <Plot node={node} />;
    default:
      // Unknown / interactive (quiz, plot, mermaid, scene3d, …): degrade to code.
      return <pre className="code-block dui-code">{safeJson(node)}</pre>;
  }
}

/** Numeric-aware sortable table (header click cycles asc → desc → original). */
function Table({ node }: { node: Node }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const columns: string[] = node.columns ?? [];
  const rows: any[][] = node.rows ?? [];
  const sorted = (() => {
    if (!sort) return rows;
    const { col, dir } = sort;
    return [...rows].sort((a, b) => {
      const av = a?.[col];
      const bv = b?.[col];
      const an = Number(String(av ?? "").replace(/[+%-]/g, ""));
      const bn = Number(String(bv ?? "").replace(/[+%-]/g, ""));
      if (Number.isFinite(an) && Number.isFinite(bn) && /[\d]/.test(String(av)) && /[\d]/.test(String(bv))) {
        return (an - bn) * dir;
      }
      return String(av ?? "").localeCompare(String(bv ?? ""), "zh-Hans-CN") * dir;
    });
  })();
  return (
    <div className="dui-table-wrap">
      <table className="dui-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i} className="dui-sortable" onClick={() => setSort((s) => (s?.col !== i ? { col: i, dir: 1 } : s.dir === 1 ? { col: i, dir: -1 } : null))}>
                {c}
                <span className="dui-sort-mark">{sort?.col === i ? (sort.dir === 1 ? " ▲" : " ▼") : ""}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr key={i}>
              {(row ?? []).map((cell, j) => (
                <td key={j}>{toText(cell)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="dui-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? "✓ 已复制" : label}
    </button>
  );
}

function Tabs({ node }: { node: Node }) {
  const [sel, setSel] = useState(0);
  const tabs = node.tabs ?? [];
  const cur = tabs[Math.min(sel, tabs.length - 1)];
  return (
    <div className="dui-tabs">
      <div className="dui-tab-bar" role="tablist">
        {tabs.map((tb: any, i: number) => (
          <button key={i} className={`dui-tab${i === sel ? " is-on" : ""}`} onClick={() => setSel(i)}>
            {tb?.label ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div className="dui-tab-body">
        {(cur?.items ?? []).map((c: Node, i: number) => (
          <RenderNode key={i} node={c} />
        ))}
      </div>
    </div>
  );
}

function Accordion({ title, items }: { title: string; items: Node[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`dui-acc-item${open ? " is-open" : ""}`}>
      <button className="dui-acc-head" onClick={() => setOpen((v) => !v)}>
        <span className={`dui-acc-chev${open ? " is-open" : ""}`}>▸</span>
        {title}
      </button>
      {open && (
        <div className="dui-acc-body">
          {items.map((c, i) => (
            <RenderNode key={i} node={c} />
          ))}
        </div>
      )}
    </div>
  );
}

function Chart({ node }: { node: Node }) {
  const data: any[] = node.data ?? [];
  if (data.length === 0) return null;
  const kind = node.kind ?? "bars";
  if (kind === "donut") {
    const total = data.reduce((s, d) => s + (Number(d.value) || 0), 0) || 1;
    let acc = 0;
    const segs = data
      .map((d) => {
        const start = (acc / total) * 360;
        acc += Number(d.value) || 0;
        const end = (acc / total) * 360;
        return `${d.color ?? "#3794ff"} ${start}deg ${end}deg`;
      })
      .join(", ");
    return (
      <div className="dui-donut-wrap">
        <div className="dui-donut" style={{ background: `conic-gradient(${segs})` }} />
        <div className="dui-legend">
          {data.map((d, i) => (
            <div key={i} className="dui-legend-row">
              <span className="dui-legend-dot" style={{ background: d.color ?? "#3794ff" }} />
              <span>{d.label}</span>
              <span className="muted">{d.value}</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (kind === "line") return <pre className="code-block dui-code">{safeJson(node)}</pre>; // line needs an axis — degrade
  // bars — the bar wrapper chain must have definite heights for percentage
  // bars to resolve (.dui-bars fixed height → column 100% → wrap flex:1).
  const max = Math.max(...data.map((d) => Number(d.value) || 0), 1);
  return (
    <div className="dui-bars">
      {data.map((d, i) => (
        <div key={i} className="dui-bar-col" title={`${d.label}: ${d.value}`}>
          <span className="dui-bar-v">{d.value}</span>
          <div className="dui-bar-wrap">
            <div className="dui-bar" style={{ height: `${((Number(d.value) || 0) / max) * 100}%`, background: d.color ?? "var(--vscode-charts-blue, #3794ff)" }} />
          </div>
          <span className="dui-bar-l">{d.label}</span>
        </div>
      ))}
    </div>
  );
}

function toText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return safeJson(v);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}

function clampPct(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

// ---- plot: whitelisted-expression function graph (sampled polyline) ----

const PLOT_FN_RE = /^[-+*/%().,\d\sxA-Fa-f]|^(sin|cos|tan|asin|acos|atan|sqrt|cbrt|exp|log|ln|abs|floor|ceil|round|min|max|pow|pi|tau|e|x)/;

/** Compile a whitelisted math expression into f(x); null when unsafe/unparseable. */
function compileExpr(expr: string): ((x: number) => number) | null {
  const src = expr.trim();
  if (!src || src.length > 200) return null;
  if (!PLOT_FN_RE.test(src)) return null;
  const idents = src.match(/[A-Za-z]+/g) ?? [];
  const ALLOWED = new Set(["sin", "cos", "tan", "asin", "acos", "atan", "sqrt", "cbrt", "exp", "log", "ln", "abs", "floor", "ceil", "round", "min", "max", "pow", "pi", "tau", "e", "x"]);
  for (const id of idents) {
    if (!ALLOWED.has(id)) return null;
  }
  try {
    const f = new Function(
      `"use strict"; const {sin,cos,tan,asin,acos,atan,sqrt,cbrt,exp,abs,floor,ceil,round,min,max,pow}=Math; const log=Math.log, ln=Math.log, pi=Math.PI, tau=Math.PI*2, e=Math.E; return (x) => (${src});`,
    )() as (x: number) => number;
    if (typeof f(1) !== "number") return null;
    return f;
  } catch {
    return null;
  }
}

const PALETTE = ["#3794ff", "#3fb950", "#d29922", "#f47067", "#bc8cff", "#39c5cf"];

function Plot({ node }: { node: Node }) {
  const xMin = typeof node.xMin === "number" ? node.xMin : -5;
  const xMax = typeof node.xMax === "number" ? node.xMax : 5;
  const width = 460;
  const height = 240;
  const pad = 28;
  const series = Array.isArray(node.series) ? node.series : [];
  const compiled = series
    .map((s: Node) => ({ expr: String(s.expr ?? ""), f: compileExpr(String(s.expr ?? "")), label: s.label }))
    .filter((s: { f: ((x: number) => number) | null }) => s.f);
  const yBounds = (() => {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of compiled as { f: (x: number) => number }[]) {
      for (let i = 0; i <= 200; i++) {
        const v = s.f(xMin + ((xMax - xMin) * i) / 200);
        if (Number.isFinite(v)) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
      const mid = Number.isFinite(lo) ? lo : 0;
      return { lo: mid - 1, hi: mid + 1 };
    }
    return { lo: lo - (hi - lo) * 0.08, hi: hi + (hi - lo) * 0.08 };
  })();
  const sx = (x: number): number => pad + ((x - xMin) / (xMax - xMin)) * (width - 2 * pad);
  const sy = (y: number): number => height - pad - ((y - yBounds.lo) / (yBounds.hi - yBounds.lo)) * (height - 2 * pad);
  return (
    <div className="dui-plot-wrap">
      {node.title ? <div className="dui-text dui-text-h3">{String(node.title)}</div> : null}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%">
        <rect x={pad} y={pad} width={width - 2 * pad} height={height - 2 * pad} fill="none" stroke="currentColor" strokeOpacity={0.2} rx={6} />
        {yBounds.lo < 0 && yBounds.hi > 0 && (
          <line x1={pad} x2={width - pad} y1={sy(0)} y2={sy(0)} stroke="currentColor" strokeOpacity={0.25} />
        )}
        {xMin < 0 && xMax > 0 && <line x1={sx(0)} x2={sx(0)} y1={pad} y2={height - pad} stroke="currentColor" strokeOpacity={0.25} />}
        {(compiled as { f: (x: number) => number; expr: string; label?: string }[]).map((s, i) => {
          const pts: string[] = [];
          for (let k = 0; k <= 200; k++) {
            const x = xMin + ((xMax - xMin) * k) / 200;
            const y = s.f(x);
            if (Number.isFinite(y)) pts.push(`${sx(x)},${sy(y)}`);
          }
          return <polyline key={i} points={pts.join(" ")} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth={1.8} />;
        })}
      </svg>
      {(compiled as { label?: string; expr: string }[]).length > 0 && (
        <div className="dui-plot-legend">
          {(compiled as { label?: string; expr: string }[]).map((s, i) => (
            <span key={i}>
              <span className="dui-dot" style={{ background: PALETTE[i % PALETTE.length] }} />
              {s.label ?? s.expr}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
