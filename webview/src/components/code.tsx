/**
 * Syntax-highlighted code block (Phase 2): highlight.js core with a curated
 * language subset (keeps the bundle lean), VSCode-token-mapped palette (see
 * .hljs-* rules in styles.css, themed via body.vscode-dark/-light), and a
 * hover copy button. Falls back to plain rendering for unknown languages —
 * never blocks content.
 */
import { memo, useMemo, useState } from "react";
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import powershell from "highlight.js/lib/languages/powershell";
import css from "highlight.js/lib/languages/css";
import xml from "highlight.js/lib/languages/xml";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import yaml from "highlight.js/lib/languages/yaml";
import diff from "highlight.js/lib/languages/diff";
import java from "highlight.js/lib/languages/java";
import go from "highlight.js/lib/languages/go";
import clang from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import rust from "highlight.js/lib/languages/rust";
import php from "highlight.js/lib/languages/php";
import ini from "highlight.js/lib/languages/ini";

for (const [name, def] of Object.entries({
  javascript,
  typescript,
  json,
  python,
  bash,
  powershell,
  css,
  xml,
  markdown,
  sql,
  yaml,
  diff,
  java,
  go,
  c: clang,
  cpp,
  csharp,
  rust,
  php,
  ini,
})) {
  hljs.registerLanguage(name, def);
}

/** fence-info alias table → registered language ids */
const ALIASES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  node: "javascript",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  ps1: "powershell",
  psm1: "powershell",
  pwsh: "powershell",
  py: "python",
  python3: "python",
  yml: "yaml",
  html: "xml",
  svg: "xml",
  vue: "xml",
  md: "markdown",
  golang: "go",
  "c++": "cpp",
  cs: "csharp",
  rs: "rust",
  toml: "ini",
  conf: "ini",
  postgres: "sql",
  mysql: "sql",
};

function resolve(lang: string): string | undefined {
  const l = lang.toLowerCase();
  const id = ALIASES[l] ?? l;
  return hljs.getLanguage(id) ? id : undefined;
}

export const CodeBlock = memo(function CodeBlock({ lang, text }: { lang: string; text: string }) {
  const html = useMemo(() => {
    const id = resolve(lang);
    if (!id) return undefined;
    try {
      return hljs.highlight(text.replace(/\n$/, ""), { language: id, ignoreIllegals: true }).value;
    } catch {
      return undefined; // pathological input: plain render
    }
  }, [lang, text]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block-hl">
      <div className="code-block-bar">
        <span className="code-lang">{lang}</span>
        <button
          className="code-copy"
          title="复制代码"
          onClick={() => {
            void navigator.clipboard.writeText(text.replace(/\n$/, "")).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "已复制" : "复制"}
        </button>
      </div>
      {html !== undefined ? (
        <pre className="code-block hljs" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="code-block">{text}</pre>
      )}
    </div>
  );
});
