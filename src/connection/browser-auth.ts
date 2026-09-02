/**
 * browser-auth.ts — mint a v012 browser-session cookie directly from the
 * durable client-connection secret, without the per-launch token.
 *
 * Wire facts (probed from @deepseek-ai/dsh-client-connection, alpha.5):
 *  - the server persists a 32-byte signing secret as base64url in
 *    ~/.dsh/.credentials.yaml → records["client-connection/browser-session"]
 *    .payload.secret, and REUSES it across restarts (created once);
 *  - cookie name  = "dsh-auth-" + base64url(sha256(authority)); authority is
 *    the Host header value, e.g. "127.0.0.1:3080";
 *  - cookie value = "v1." + base64url(JSON payload) + "." +
 *    base64url(hmac-sha256(secretBytes, bodyString));
 *  - payload = {version:1, authority, issuedAt, expiresAt} with
 *    issuedAt <= now < expiresAt and lifetime <= cookieMaxAgeDays (30).
 *
 * Consequence: a locally minted cookie authenticates forever, surviving
 * server restarts (which rotate the launch token but not this secret).
 * The credentials file is user-readable only — same trust level as reading
 * the launch token from the terminal scrollback.
 */
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";

const COOKIE_PREFIX = "dsh-auth-";
const SECRET_RECORD = /browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/;
/** stay well under the server's 30-day cookieMaxAgeDays ceiling */
const COOKIE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const SECRET_BYTES = 32;

const b64u = (buf: Buffer) => buf.toString("base64url");

/** Authority string the fence expects: the URL host (hostname[:port]) as
 *  fetch will send it in the Host header. */
export function authorityOf(baseUrl: string): string {
  return new URL(baseUrl).host;
}

/** Parse the browser-session secret out of a credentials.yaml. */
export async function readBrowserSecret(credentialsPath: string): Promise<Buffer | undefined> {
  let text: string;
  try {
    text = await readFile(credentialsPath, "utf8");
  } catch {
    return undefined;
  }
  const m = SECRET_RECORD.exec(text);
  if (!m) return undefined;
  const secret = Buffer.from(m[1], "base64url");
  return secret.byteLength === SECRET_BYTES ? secret : undefined;
}

/** Mint the signed cookie value pair {name, value} for an authority. */
export function mintBrowserCookie(authority: string, secret: Buffer): { name: string; value: string } {
  const name = COOKIE_PREFIX + b64u(createHash("sha256").update(authority).digest());
  const issuedAt = Date.now() - 1000; // tolerate clock skew (issuedAt <= now)
  const body = b64u(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + COOKIE_LIFETIME_MS })));
  const value = `v1.${body}.${b64u(createHmac("sha256", secret).update(body).digest())}`;
  return { name, value };
}

/** Full path: credentials file → secret → minted "name=value" cookie. */
export async function mintFromCredentialsFile(baseUrl: string, credentialsPath: string): Promise<string | undefined> {
  const secret = await readBrowserSecret(credentialsPath);
  if (!secret) return undefined;
  const { name, value } = mintBrowserCookie(authorityOf(baseUrl), secret);
  return `${name}=${value}`;
}
