/**
 * Pure model-selection helpers (no vscode/host imports — regression-testable).
 *
 * Why this module exists: the panel used to show, and remember, the host's
 * GLOBAL default model (`session/modelCatalog` → `default`) as if it were the
 * session's own model. Real case (2026-09-11, session 洛阳案件分析): every
 * request in that session ran `comleader/glm-5.3`, while the chip showed
 * `deepseek-v4.1-flash` — the global default. The user switched models, saw the
 * new name in the chip, and concluded the session had switched. It had not: the
 * chip was showing a value shared by every project.
 *
 * The host exposes the session's own model in the `modelSelection` projection
 * (`{lastUsed, next}`), which these helpers turn into (a) the chip label and
 * (b) this workspace's "last model used here" memory.
 */

export interface ModelChoice {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** One projection entry (`{provider, model, reasoningEffort?}`), or undefined. */
function asChoice(value: unknown): ModelChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const v = value as Record<string, unknown>;
  const provider = typeof v.provider === "string" ? v.provider : "";
  const model = typeof v.model === "string" ? v.model : "";
  if (!provider || !model) return undefined;
  const effort = typeof v.reasoningEffort === "string" && v.reasoningEffort ? v.reasoningEffort : undefined;
  return { provider, model, ...(effort ? { reasoningEffort: effort } : {}) };
}

/**
 * The model a session is set to use next.
 *
 * Host semantics (`modelSelectionProjectionOf`): `lastUsed` = the route of the
 * last real request; `next` = the pending selection, falling back to
 * `lastUsed`. `next` wins so a switch shows up before the next message.
 */
export function realModelOf(modelSelection: unknown): ModelChoice | undefined {
  if (!modelSelection || typeof modelSelection !== "object") return undefined;
  const p = modelSelection as Record<string, unknown>;
  return asChoice(p.next) ?? asChoice(p.lastUsed);
}

/**
 * Parse the pinned `dsh-vscode.defaultModel` setting
 * (`"provider/model"` or `"provider/model/reasoningEffort"`).
 *
 * @returns `{choice}` when well-formed, `{malformed: <raw>}` when the setting
 *          is set but unusable (caller warns; user-authored config is never
 *          silently discarded), `{}` when unset.
 */
export function parsePinnedModel(raw: string): { choice?: ModelChoice; malformed?: string } {
  const text = (raw ?? "").trim();
  if (!text) return {};
  const parts = text.split("/").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return { malformed: text };
  const effort = parts.length >= 3 ? parts[parts.length - 1] : undefined;
  const model = parts.length >= 3 ? parts.slice(1, -1).join("/") : parts[1];
  if (!model) return { malformed: text };
  return { choice: { provider: parts[0], model, ...(effort ? { reasoningEffort: effort } : {}) } };
}

/**
 * The model a NEW chat in this workspace starts on: an explicit pin wins,
 * otherwise this workspace's own last-used model.
 *
 * Deliberately has no access to the host's global default: that value is shared
 * by every project, and inheriting it is exactly the cross-project leak this
 * scoping exists to prevent. Neither input → undefined, and the host's own
 * default applies (first-ever chat in a project).
 *
 * Trust boundary: this helper only validates the shape it is handed. The
 * guarantee that a GLOBAL default never becomes a project default lives one
 * level up — the workspace memory is written exclusively from
 * {@link realModelOf} (see SessionManager.noteSessionModel), and a
 * catalog-default payload resolves to `undefined` there.
 */
export function pickChatDefault(pin: unknown, wsMemory: unknown): ModelChoice | undefined {
  return asChoice(pin) ?? asChoice(wsMemory);
}
