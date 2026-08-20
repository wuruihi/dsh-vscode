import { useState } from "react";
import type { ApprovalCard, QuestionCard } from "../protocol.js";

export function ApprovalCardView({
  card,
  onAnswer,
}: {
  card: ApprovalCard;
  onAnswer: (outcome: "allowed-once" | "rejected") => void;
}) {
  return (
    <div className="msg">
      <div className="card approval-card">
        <div className="card-title">
          🔐 审批请求{card.sessionId ? <span className="muted"> · {card.sessionId.slice(0, 8)}</span> : null}
        </div>
        {card.toolName && (
          <div className="card-line">
            工具：<b>{card.toolName}</b>
          </div>
        )}
        {card.reason && <div className="card-line muted">{card.reason}</div>}
        {card.extra &&
          Object.entries(card.extra)
            .slice(0, 6)
            .map(([k, v]) => (
              <div key={k} className="card-line kv">
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </div>
            ))}
        <div className="card-actions">
          <button className="btn btn-primary" onClick={() => onAnswer("allowed-once")}>
            允许一次
          </button>
          <button className="btn btn-danger" onClick={() => onAnswer("rejected")}>
            拒绝
          </button>
        </div>
      </div>
    </div>
  );
}

export function QuestionCardView({
  card,
  onAnswer,
}: {
  card: QuestionCard;
  onAnswer: (answers: { id: string; selected: string[]; custom?: string }[]) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(card.questions.map((q) => [q.id, [] as string[]])),
  );
  const [custom, setCustom] = useState<Record<string, string>>(() => Object.fromEntries(card.questions.map((q) => [q.id, ""])));

  const toggle = (id: string, multi: boolean | undefined, label: string) => {
    setSelected((prev) => {
      const cur = prev[id] ?? [];
      if (multi) {
        return { ...prev, [id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      }
      return { ...prev, [id]: cur.includes(label) && cur.length === 1 ? [] : [label] };
    });
  };

  const complete = card.questions.every((q) => (selected[q.id]?.length ?? 0) > 0 || (custom[q.id] ?? "").trim().length > 0);

  const submit = () => {
    onAnswer(
      card.questions.map((q) => {
        const sel = selected[q.id] ?? [];
        const c = (custom[q.id] ?? "").trim();
        return { id: q.id, selected: sel, ...(c ? { custom: c } : {}) };
      }),
    );
  };

  return (
    <div className="msg">
      <div className="card question-card">
        <div className="card-title">❓ DSH 提问</div>
        {card.questions.map((q) => (
          <div key={q.id} className="q-block">
            {q.header && <div className="q-header">{q.header}</div>}
            <div className="q-text">{q.question}</div>
            {(q.options ?? []).map((o) => {
              const on = (selected[q.id] ?? []).includes(o.label);
              return (
                <label key={o.label} className={`q-option${on ? " is-on" : ""}`}>
                  <input type={q.multi ? "checkbox" : "radio"} name={q.id} checked={on} onChange={() => toggle(q.id, q.multi, o.label)} />
                  <span>
                    {o.label}
                    {o.description ? <span className="muted"> — {o.description}</span> : null}
                  </span>
                </label>
              );
            })}
            <input
              className="q-custom"
              placeholder="或输入自定义回答…"
              value={custom[q.id] ?? ""}
              onChange={(e) => setCustom((prev) => ({ ...prev, [q.id]: e.target.value }))}
            />
          </div>
        ))}
        <div className="card-actions">
          <button className="btn btn-primary" disabled={!complete} onClick={submit}>
            提交回答
          </button>
        </div>
      </div>
    </div>
  );
}
