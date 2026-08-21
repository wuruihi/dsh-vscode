import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { DshUi } from "./dshui.js";

/**
 * Assistant markdown renderer with HOST-ALIGNED dsh-ui fence handling.
 *
 * The native GUI treats dsh-ui fences as first-class segments (its own
 * micromark/mdast pipeline + a fence registry the genui plugin hooks), and
 * its incremental parser streams them. react-markdown gives us CommonMark
 * fence semantics instead — and models DO break those (opener glued to a
 * prose line, missing closing fence, prose swallowed inside an unclosed
 * block). Feeding broken fences to CommonMark renders the whole spec as
 * prose, so the JSON repair layer never even runs.
 *
 * Architecture here: a dedicated splitter extracts dsh-ui segments BEFORE
 * markdown parsing, using structural scanning (balanced-brace walk) that is
 * immune to every observed fence-breaking habit. Whatever the model does,
 * the fence boundary is "first balanced JSON value after the opener" —
 * text before/after stays ordinary markdown. react-markdown then only ever
 * sees clean prose.
 */

interface Segment {
  kind: "text" | "fence";
  text: string; // prose for text segments, the raw spec for fence segments
}

/** First index of `{` or `[` at/after pos, skipping whitespace; -1 if none. */
function specStart(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && /\s/.test(s[i])) i++;
  return s[i] === "{" || s[i] === "[" ? i : -1;
}

/** Index just past the balanced JSON value at pos (string-aware, mixed
 *  brackets). Balance only — JSON validity is dshui.tsx's repair business. */
function balancedEnd(s: string, pos: number): number {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = pos; k < s.length; k++) {
    const ch = s[k];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return k + 1;
    }
  }
  return -1;
}

/** Split accumulated assistant text into prose and dsh-ui fence segments.
 *  Line-walks with a plain-fence state so a ``` block CONTAINING the literal
 *  "```dsh-ui" as sample code never false-positives. The opener may be glued
 *  to a prose line ("….```dsh-ui") — the scanner recognizes it anyway. An
 *  opener whose JSON never balances consumes the rest (streaming partial, or
 *  a truncated tail the JSON repair layer degrades). */
function splitDshUiSegments(text: string): Segment[] {
  if (!text.includes("```dsh-ui")) return [{ kind: "text", text }];
  const lines = text.split("\n");
  // find the first dsh-ui opener outside a plain code fence
  let inPlainFence = false;
  let openerLine = -1;
  let prosePrefix: string[] = [];
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (inPlainFence) {
      if (/^\s*```/.test(line)) inPlainFence = false;
      continue;
    }
    const hit = line.indexOf("```dsh-ui");
    if (hit >= 0) {
      openerLine = li;
      const prefix = line.slice(0, hit);
      if (prefix.trim()) prosePrefix.push(prefix);
      break;
    }
    if (/^\s*```/.test(line)) inPlainFence = true;
    else prosePrefix.push(line);
  }
  if (openerLine < 0) return [{ kind: "text", text }];
  const segs: Segment[] = [];
  if (prosePrefix.length > 0) segs.push({ kind: "text", text: prosePrefix.join("\n") });
  const rest = lines.slice(openerLine + 1).join("\n");
  const start = specStart(rest, 0);
  if (start < 0) {
    // no JSON behind the opener at all: treat the opener line as prose
    const rebuilt = [...prosePrefix, lines[openerLine], ...lines.slice(openerLine + 1)].join("\n");
    return [{ kind: "text", text: rebuilt }];
  }
  const end = balancedEnd(rest, start);
  if (end < 0) {
    // never balances: streaming partial or truncated — take the rest
    segs.push({ kind: "fence", text: rest.slice(start) });
    return segs;
  }
  segs.push({ kind: "fence", text: rest.slice(start, end) });
  // after the balanced JSON: drop ONE leading closing fence (if present),
  // then recurse on the remainder so nested plain fences keep their state
  let tail = rest.slice(end);
  const tm = /^[ \t]*\r?\n?[ \t]*```[^\n]*\n?/.exec(tail);
  if (tm) tail = tail.slice(tm[0].length);
  else {
    // same-line closer? e.g. `} ``` ` — rare; strip trailing ``` on line 1
    tail = tail.replace(/^([ \t]*)```/, "$1");
  }
  const tailSegs = tail.trim() ? splitDshUiSegments(tail) : [];
  return [...segs, ...tailSegs];
}

/** Memoized prose runner: early segments keep element identity across
 *  streaming re-renders, so only the growing tail re-parses (the same
 *  freeze-the-stable-prefix idea as the host's incremental parser, at
 *  segment granularity). */
const TextRun = memo(function TextRun({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents}>
      {text}
    </ReactMarkdown>
  );
});

const mdComponents: Components = makeComponents();

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  const segments = useMemo(() => splitDshUiSegments(text), [text]);
  return (
    <div className="md">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <TextRun key={i} text={seg.text} />
        ) : (
          <DshUi key={`f${i}`} spec={seg.text} live={live} />
        ),
      )}
    </div>
  );
});

/** Chat panels are not documents: demote every heading one level (h1→h2 …). */
function Demote({ as, children }: { as: "h2" | "h3" | "h4" | "h5" | "h5" | "h6"; children?: React.ReactNode }) {
  const Tag = as as "h2";
  return <Tag>{children}</Tag>;
}

function makeComponents(): Components {
  return {
    pre: ({ children }) => <pre className="code-block">{children}</pre>,
    // Defensive tail: the splitter already extracts every dsh-ui fence, but
    // if a well-formed one still reaches react-markdown, render it as UI.
    code: ({ className, children }) => {
      const lang = /language-(\w[\w-]*)/.exec(className ?? "")?.[1];
      const codeText = String(children ?? "");
      if (lang === "dsh-ui") {
        return <DshUi spec={codeText.replace(/\n$/, "")} />;
      }
      if (!className) return <code>{codeText}</code>;
      return <code className={className}>{codeText}</code>;
    },
    h1: ({ children }) => <Demote as="h2">{children}</Demote>,
    h2: ({ children }) => <Demote as="h3">{children}</Demote>,
    h3: ({ children }) => <Demote as="h4">{children}</Demote>,
    h4: ({ children }) => <Demote as="h5">{children}</Demote>,
    h5: ({ children }) => <Demote as="h6">{children}</Demote>,
    h6: ({ children }) => <Demote as="h6">{children}</Demote>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),
    img: ({ src, alt }) => (typeof src === "string" && /^https:/.test(src) ? <img className="md-img" src={src} alt={alt ?? ""} /> : null),
  };
}
