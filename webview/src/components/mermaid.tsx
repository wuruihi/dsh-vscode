/**
 * Minimal mermaid subset renderer — flowcharts only (graph TD/LR), drawn as
 * pure SVG. No mermaid.js dependency (the webview bundle stays lean); node
 * shapes: rect (plain), rounded ([...]), stadium ([(...)]); edges: -->,
 * -.->, -->|label|. Good-enough layouts for the flowcharts a chat panel
 * actually emits; anything unparseable degrades upstream to a code block.
 */
import { useMemo } from "react";

interface MNode {
  id: string;
  label: string;
  shape: "rect" | "round" | "stadium";
}
interface MEdge {
  from: string;
  to: string;
  label?: string;
  dashed?: boolean;
}

const NODE_W = 150;
const NODE_H = 44;
const GAP_Y = 76;
const GAP_X = 190;

function parse(src: string): { nodes: MNode[]; edges: MEdge[]; lr: boolean } | null {
  const lines = src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("%%"));
  if (lines.length === 0) return null;
  const head = lines[0];
  const m = /^(?:graph|flowchart)\s+(TD|TB|LR|RL)/i.exec(head);
  if (!m) return null;
  const lr = /^(LR|RL)$/i.test(m[1]);
  const nodes = new Map<string, MNode>();
  const edges: MEdge[] = [];
  const edgeRe = /^([\w-]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*(-{2,3}>|-\.->)\s*([\w-]+)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?(?:\s*\|([^|]+)\|)?$/;
  const plainRe = /^([\w-]+)\s*(\[\[.*\]\]|\[.*\]|\(.*\)|\{.*\})$/;
  const labelOf = (raw?: string): { text: string; shape: MNode["shape"] } => {
    if (!raw) return { text: "", shape: "rect" };
    if (raw.startsWith("[[") && raw.endsWith("]]")) return { text: raw.slice(2, -2), shape: "rect" };
    if (raw.startsWith("[") && raw.endsWith("]")) return { text: raw.slice(1, -1), shape: "round" };
    if (raw.startsWith("(") && raw.endsWith(")")) return { text: raw.slice(1, -1), shape: "stadium" };
    return { text: raw.slice(1, -1), shape: "rect" }; // {diamond} as rect (subset)
  };
  const upsert = (id: string, raw?: string): void => {
    const { text, shape } = labelOf(raw);
    const existing = nodes.get(id);
    if (!existing) nodes.set(id, { id, label: text || id, shape });
    else if (text) existing.label = text;
  };
  for (const line of lines.slice(1)) {
    const em = edgeRe.exec(line);
    if (em) {
      upsert(em[1], em[2]);
      upsert(em[4], em[5]);
      edges.push({ from: em[1], to: em[4], label: em[6]?.trim(), dashed: em[3].includes(".") });
      continue;
    }
    const pm = plainRe.exec(line);
    if (pm) {
      upsert(pm[1], pm[2]);
      continue;
    }
    // A[...] --> B with label BEFORE arrow: A -->|label| B
    const lm = /^([\w-]+)\s*(-{2,3}>|-\.->)\s*\|([^|]+)\|\s*([\w-]+)\s*(\[[^\]]*\]|\([^)]*\))?$/;
    const lmm = lm.exec(line);
    if (lmm) {
      upsert(lmm[1]);
      upsert(lmm[4], lmm[5]);
      edges.push({ from: lmm[1], to: lmm[4], label: lmm[3]?.trim(), dashed: lmm[2].includes(".") });
    }
  }
  if (nodes.size === 0) return null;
  return { nodes: [...nodes.values()], edges, lr };
}

/** Layered topological layout (longest-path), tolerant of cycles. */
function layout(nodes: MNode[], edges: MEdge[], lr: boolean): Map<string, { x: number; y: number; layer: number }> {
  const depth = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const setDepth = (id: string, d: number, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const cur = depth.get(id) ?? 0;
    depth.set(id, Math.max(cur, d));
    for (const e of edges.filter((x) => x.from === id)) {
      if (byId.has(e.to)) setDepth(e.to, d + 1, seen);
    }
  };
  const targets = new Set(edges.map((e) => e.to));
  for (const n of nodes) {
    if (!targets.has(n.id)) setDepth(n.id, 0, new Set());
  }
  for (const n of nodes) if (depth.get(n.id) === undefined) depth.set(n.id, 0);
  // group by layer, spread within layer
  const layers = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    const arr = layers.get(d) ?? [];
    arr.push(n.id);
    layers.set(d, arr);
  }
  const pos = new Map<string, { x: number; y: number; layer: number }>();
  for (const [d, ids] of layers) {
    ids.forEach((id, i) => {
      const lane = i - (ids.length - 1) / 2;
      pos.set(id, {
        x: lr ? d * GAP_X : lane * GAP_X,
        y: lr ? lane * GAP_Y : d * GAP_Y,
        layer: d,
      });
    });
  }
  return pos;
}

export function Mermaid({ code }: { code: string }) {
  const parsed = useMemo(() => parse(code), [code]);
  if (!parsed) return <pre className="code-block dui-code">{code}</pre>;
  const { nodes, edges, lr } = parsed;
  const pos = layout(nodes, edges, lr);
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const minX = Math.min(...xs) - NODE_W / 2 - 20;
  const maxX = Math.max(...xs) + NODE_W / 2 + 20;
  const minY = Math.min(...ys) - NODE_H / 2 - 20;
  const maxY = Math.max(...ys) + NODE_H / 2 + (edges.some((e) => e.label) ? 30 : 20);
  const w = maxX - minX;
  const h = maxY - minY;
  const edgePath = (from: string, to: string): string => {
    const a = pos.get(from);
    const b = pos.get(to);
    if (!a || !b) return "";
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    if (lr) return `M ${a.x + NODE_W / 2} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${b.x - NODE_W / 2} ${b.y}`;
    return `M ${a.x} ${a.y + NODE_H / 2} C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y - NODE_H / 2}`;
  };
  return (
    <div className="dui-mermaid-wrap">
      <svg viewBox={`${minX} ${minY} ${w} ${h}`} width="100%" style={{ maxHeight: 420 }}>
        <defs>
          <marker id="dui-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
          </marker>
        </defs>
        {edges.map((e, i) => {
          const d = edgePath(e.from, e.to);
          if (!d) return null;
          return (
            <g key={i}>
              <path
                d={d}
                fill="none"
                stroke="currentColor"
                strokeOpacity={0.55}
                strokeWidth={1.4}
                strokeDasharray={e.dashed ? "5 4" : undefined}
                markerEnd="url(#dui-arrow)"
              />
              {e.label && (
                <text x={(pos.get(e.from)!.x + pos.get(e.to)!.x) / 2} y={(pos.get(e.from)!.y + pos.get(e.to)!.y) / 2 - 6} textAnchor="middle" className="dui-edge-label">
                  {e.label}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          return (
            <g key={n.id} transform={`translate(${p.x - NODE_W / 2}, ${p.y - NODE_H / 2})`}>
              <rect
                width={NODE_W}
                height={NODE_H}
                rx={n.shape === "stadium" ? NODE_H / 2 : n.shape === "round" ? 10 : 4}
                className="dui-mnode"
              />
              <text x={NODE_W / 2} y={NODE_H / 2 + 4} textAnchor="middle" className="dui-mnode-label">
                {n.label.length > 16 ? `${n.label.slice(0, 15)}…` : n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
