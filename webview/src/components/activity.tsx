import { memo, useState } from "react";
import type { ToolActivity } from "../fold.js";

/** Collapsed-by-default tool card; the running one is highlighted. */
export const ActivityCard = memo(function ActivityCard({ act }: { act: ToolActivity }) {
  const [open, setOpen] = useState(false);
  const icon = act.state === "running" ? "⏳" : act.state === "error" ? "❌" : "✅";
  const isEdit = isEditTool(act.name);
  return (
    <div className={`activity activity-${act.state}${act.state === "running" ? " is-live" : ""}`}>
      <button className="activity-head" onClick={() => setOpen((v) => !v)}>
        <span>{icon}</span>
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
