// Standalone test of the repair algorithm against the real broken fence.
import { readFileSync } from "node:fs";

/** Extract one top-level JSON value starting at pos (string-aware, depth-tracked). Returns [end, value] or null. */
function scanValue(text: string, pos: number): [number, unknown] | null {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  if (i >= text.length) return null;
  const open = text[i];
  const close = open === "{" ? "}" : open === "[" ? "]" : null;
  if (!close) {
    // primitive: read until , or ] or } or end at depth-0
    let j = i;
    while (j < text.length && !",]}".includes(text[j])) j++;
    const raw = text.slice(start, j).trim();
    try {
      return [j, JSON.parse(raw)];
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
        try {
          return [k + 1, JSON.parse(text.slice(start, k + 1))];
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Best-effort repair for the dominant model-error pattern: the root object
 *  closes right after the first items element, and the remaining components
 *  follow as orphan top-level values (often with a stray `]}` tail). */
function repairSpec(raw: string): unknown | null {
  const text = raw.trim();
  if (!text.startsWith("{")) return null;
  const first = scanValue(text, 0);
  if (!first) return null;
  const [end1, v1] = first;
  const root = v1 as Record<string, any>;
  if (!root || typeof root !== "object" || !Array.isArray(root.items)) return null;
  let pos = end1;
  const orphans: unknown[] = [];
  let guard = 0;
  while (guard++ < 50) {
    // skip separators and stray closers between/after top-level values
    while (pos < text.length && /[\s,]/.test(text[pos])) pos++;
    if (pos >= text.length) break;
    if (text[pos] === "]" || text[pos] === "}") {
      // stray closer junk — allow only if the rest is pure closers
      if (/^[\]}]+$/.test(text.slice(pos))) break;
      return null; // something structural we don't understand — bail
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

function parseSpec(raw: string): { ok: boolean; via?: string; value?: any } {
  try {
    return { ok: true, via: "strict", value: JSON.parse(raw) };
  } catch {
    /* fallthrough */
  }
  try {
    return { ok: true, via: "cheap", value: JSON.parse(cheapRepairs(raw)) };
  } catch {
    /* fallthrough */
  }
  const fixed = repairSpec(cheapRepairs(raw));
  if (fixed) return { ok: true, via: "items-merge", value: fixed };
  return { ok: false };
}

const bad = readFileSync("D:\\work\\bad-fence.json", "utf8");
const r = parseSpec(bad);
console.log("ok:", r.ok, "| via:", r.via);
if (r.ok) {
  console.log("title:", r.value.title);
  console.log("items:", r.value.items.map((i: any) => i.type).join(", "));
}
// Also ensure strict-valid specs still parse via the strict path.
const good = JSON.stringify({ title: "t", items: [{ type: "text", content: "hi" }] });
console.log("good still ok:", parseSpec(good).via);
