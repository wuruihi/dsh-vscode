import { memo, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { DshUi } from "./dshui.js";

/**
 * Markdown renderer. Two readability decisions borrowed from the Claude Code
 * panel (verified against its shipped CSS):
 *  - remark-breaks: single newlines become <br>. CommonMark folds them into
 *    spaces, which glues DSH model output (Chinese single-newline paragraphing)
 *    into walls of text.
 *  - headings are demoted one level (h1→h2 …) — chat panels are not documents.
 * ```dsh-ui fences render through the local GenUI subset (dshui.tsx); while
 * `live` (streaming) incomplete specs show a placeholder.
 */

const remarkPlugins = [remarkGfm, remarkBreaks] as const;

/** Index just past the balanced JSON value starting at/after `pos`
 *  (string-aware, mixed brackets); -1 when none. Balance only — validity is
 *  the JSON repair layer's business (dshui.tsx). */
function balancedJsonEnd(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && /\s/.test(s[i])) i++;
  if (s[i] !== "{" && s[i] !== "[") return -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = i; k < s.length; k++) {
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

/** Markdown-level dsh-ui fence repairs. The JSON repair layer (dshui.tsx)
 *  never sees a fence the markdown parser does not recognize, so these two
 *  model habits must be fixed before parsing:
 *  1. opening fence glued to the end of a prose line ("….```dsh-ui") — a
 *     fence must start a line, otherwise the whole spec renders as prose;
 *  2. missing closing fence — insert one right after the balanced JSON so
 *     trailing prose stays markdown instead of being swallowed as code. */
function normalizeDshUiFences(text: string): string {
  if (!text.includes("```dsh-ui")) return text;
  let s = text.replace(/(\S)[ \t]*```dsh-ui/g, "$1\n```dsh-ui");
  const FENCE = /```dsh-ui[^\n]*\n/g;
  let out = "";
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = FENCE.exec(s))) {
    const contentStart = m.index + m[0].length;
    const rest = s.slice(contentStart);
    if (/^```/m.test(rest) || rest.includes("\n```")) continue; // closer exists — parser handles it
    const end = balancedJsonEnd(s, contentStart);
    if (end < 0) continue; // no balanced JSON: fence-to-EOF is legal markdown
    out += `${s.slice(last, end)}\n\`\`\``;
    last = end;
    FENCE.lastIndex = end;
  }
  return out + s.slice(last);
}

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  const components = useMemo<Components>(() => makeComponents(live), [live]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[...remarkPlugins]} components={components}>
        {normalizeDshUiFences(text)}
      </ReactMarkdown>
    </div>
  );
});

/** Chat panels are not documents: demote every heading one level (h1→h2 …). */
function Demote({ as, children }: { as: "h2" | "h3" | "h4" | "h5" | "h5" | "h6"; children?: React.ReactNode }) {
  const Tag = as as "h2";
  return <Tag>{children}</Tag>;
}

function makeComponents(live?: boolean): Components {
  return {
    pre: ({ children }) => <pre className="code-block">{children}</pre>,
    code: ({ className, children }) => {
      const lang = /language-(\w[\w-]*)/.exec(className ?? "")?.[1];
      const text = String(children ?? "");
      if (lang === "dsh-ui") {
        // Strip the trailing newline react-markdown keeps inside fenced content.
        return <DshUi spec={text.replace(/\n$/, "")} live={live} />;
      }
      if (!className) return <code>{text}</code>;
      return <code className={className}>{text}</code>;
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
    img: ({ src, alt }) => <img className="md-img" src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />,
  };
}
