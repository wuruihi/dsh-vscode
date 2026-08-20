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

export const Markdown = memo(function Markdown({ text, live }: { text: string; live?: boolean }) {
  const components = useMemo<Components>(() => makeComponents(live), [live]);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[...remarkPlugins]} components={components}>
        {text}
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
