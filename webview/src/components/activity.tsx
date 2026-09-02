import { memo, useState } from "react";
import type { ToolActivity } from "../fold.js";
import { Icon } from "./icons.js";

/** Tool-name → line icon (competitor look: every command row carries its
 *  glyph; default is a neutral box). Matched on the lowercase name. */
function toolIcon(name?: string): string {
  const n = (name ?? "").toLowerCase();
  if (/read|view|cat$/.test(n)) return "eye";
  if (/edit|write|str-replace|patch/.test(n)) return "edit";
  if (/grep|glob|search|find/.test(n)) return "search";
  if (/pwsh|bash|shell|terminal/.test(n)) return "ledger";
  if (/todo|task/.test(n)) return "check";
  if (/web|fetch|browser/.test(n)) return "globe";
  if (/subagent|agent|workflow|ralph/.test(n)) return "box";
  if (/skill/.test(n)) return "help";
  if (/goal/.test(n)) return "info";
  if (/diff/.test(n)) return "list";
  return "box";
}

/** Collapsed-by-default tool card; the running one is highlighted. */
export const ActivityCard = memo(function ActivityCard({ act }: { act: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const isEdit = isEditTool(act.name);
  return (
    <div className={`activity activity-${act.state}${act.state === "running" ? " is-live" : ""}`}>
      <button className="activity-head" onClick={() => setOpen((v) => !v)}>
        <span className={`tool-status tool-status-${act.state === "error" ? "failed" : act.state === "done" ? "done" : "running"}`}>
          {act.state === "running" ? (
            <span className="tool-status-spin" />
          ) : (
            <Icon name={act.state === "error" ? "x" : "check"} size={12} />
          )}
        </span>
        <span className="tool-glyph"><Icon name={toolIcon(act.name)} size={12} /></span>
        <span className="activity-label">{act.label}</span>
        {act.kind === "subagent" && <span className="badge badge-sub">子代理</span>}
        {isEdit && <span className="badge badge-edit">编辑</span>}
        {act.detail && !open && <span className="activity-detail">{act.detail.slice(0, 80)}</span>}
        {isEdit && (
          <span
            role="button"
            className="link-btn diff-link"
            title="用 VSCode 原生 diff 查看这次变更"
            onClick={(e) => {
              e.stopPropagation();
              window.dispatchEvent(new CustomEvent("dsh-open-diff", { detail: act.key }));
            }}
          >
            查看 diff
          </span>
        )}
      </button>
      {open && (
        <div className="activity-body">
          {act.args !== undefined && (
            <pre className="code-block">
              {(() => {
                try {
                  return typeof act.args === "string" ? act.args : JSON.stringify(act.args, null, 2);
                } catch {
                  return String(act.args);
                }
              })()}
            </pre>
          )}
          {act.resultPreview && <pre className="code-block result">{act.resultPreview}</pre>}
        </div>
      )}
    </div>
  );
});

function isEditTool(name?: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase();
  return n === "edit" || n === "str-replace-editor" || n === "write" || n.includes("edit") || n.includes("write");
}
