/**
 * v012 browser auth (design.md §3.0): every /api request needs a signed
 * cookie. Two ways to get one, tried in order:
 *
 *  1. `dsh-vscode.authToken` setting (manual escape hatch) → /?token= exchange;
 *  2. MINT from the durable browser-session secret in
 *     ~/.dsh/.credentials.yaml (see browser-auth.ts) — zero-config, survives
 *     server restarts, works even though the per-launch token never touches
 *     disk (alpha.5 behavior);
 *  3. our own start log `~/.dsh/dsh-vscode-web.log` (we started the server);
 *  4. best effort: newest `*.log` under ~/.dsh (externally started servers).
 */
import { readdir, stat } from "node:fs/promises";
import * as vscode from "vscode";
import { log, warn } from "../log.js";
import { mintFromCredentialsFile } from "./browser-auth.js";

const TOKEN_PATTERN = /token=([A-Za-z0-9_-]+)/;

export class Auth {
  private cookie: string | undefined;
  private exchangeInFlight: Promise<boolean> | undefined;
  private manualToken: string | undefined;
  private discoveredToken: string | undefined;

  get hasCookie(): boolean {
    return this.cookie !== undefined;
  }

  /** Cookie header value for HTTP + WS handshake ("" when legacy/no-auth). */
  cookieHeader(): Record<string, string> {
    return this.cookie ? { cookie: this.cookie } : {};
  }

  /** Forget the cookie (server restarted / expired) so the next request
   *  triggers a fresh exchange. */
  invalidate(): void {
    this.cookie = undefined;
  }

  /** Manual `dsh-vscode.authToken` setting (explicit user intent). */
  private async manualSettingToken(): Promise<string | undefined> {
    if (this.manualToken !== undefined) return this.manualToken;
    const cfg = vscode.workspace.getConfiguration("dsh-vscode");
    const manual = cfg.get<string>("authToken", "").trim();
    if (manual) this.manualToken = manual;
    return this.manualToken;
  }

  /** Find a launch token via settings → own start log → ~/.dsh logs. */
  async discoverToken(home: string): Promise<string | undefined> {
    const manual = await this.manualSettingToken();
    if (manual) return manual;

    const candidates = [
      `${home}/.dsh/dsh-vscode-web.log`, // our Start-Process redirect
      `${home}/.dsh/dsh-vscode-web.err.log`,
    ];
    // Externally started: scan ~/.dsh (+ ~/.dsh/logs) newest-first.
    try {
      for (const dir of [`${home}/.dsh/logs`, `${home}/.dsh`]) {
        const names = await readdir(dir).catch(() => [] as string[]);
        const logs = names.filter((n) => n.endsWith(".log"));
        const withTime = await Promise.all(
          logs.map(async (n) => ({ path: `${dir}/${n}`, mtime: (await stat(`${dir}/${n}`).catch(() => undefined))?.mtimeMs ?? 0 })),
        );
        withTime.sort((a, b) => b.mtime - a.mtime);
        candidates.push(...withTime.map((x) => x.path));
      }
    } catch {
      /* best effort */
    }

    for (const file of candidates) {
      const token = await tokenFromLogTail(file);
      if (token) {
        this.discoveredToken = token;
        log(`[auth] launch token found in ${file}`);
        return token;
      }
    }
    return undefined;
  }

  get tokenForExchange(): string | undefined {
    return this.manualToken ?? this.discoveredToken;
  }

  /** GET /?token=<launch token> → signed cookie (first set-cookie pair). */
  async exchangeCookie(baseUrl: string, token: string): Promise<boolean> {
    try {
      const url = new URL("/", new URL(baseUrl));
      url.searchParams.set("token", token);
      const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5000) });
      const setCookie = res.headers.get("set-cookie");
      if (setCookie) {
        this.cookie = setCookie.split(";")[0].trim();
        log(`[auth] cookie exchanged (HTTP ${res.status})`);
        return true;
      }
      // Old servers without auth reply without set-cookie: treat as ok.
      if (res.status === 200 || res.status === 302) {
        this.cookie = "";
        return true;
      }
      warn(`[auth] exchange failed: HTTP ${res.status}`);
      return false;
    } catch (err) {
      warn(`[auth] exchange error: ${String(err)}`);
      return false;
    }
  }

  /** Ensure a cookie exists (concurrency-deduped). False = every source
   *  failed → caller surfaces the auth problem. Order: explicit setting →
   *  credentials mint (zero-config, restart-proof) → own start log → ~/.dsh
   *  logs. Each failed source falls through to the next. */
  ensureCookie(baseUrl: string, home: string): Promise<boolean> {
    if (this.cookie !== undefined) return Promise.resolve(true);
    if (this.exchangeInFlight) return this.exchangeInFlight;
    this.exchangeInFlight = (async () => {
      // 1. manual token (explicit user intent wins when it works)
      const manual = await this.manualSettingToken();
      if (manual && (await this.exchangeCookie(baseUrl, manual))) return true;
      // 2. mint from the durable secret — no launch token needed at all
      const minted = await mintFromCredentialsFile(baseUrl, `${home}/.dsh/.credentials.yaml`);
      if (minted) {
        this.cookie = minted;
        log("[auth] cookie minted from credentials browser-session secret");
        return true;
      }
      // 3. log-discovered token (own start log / ~/.dsh logs — pre-alpha.5)
      const token = await this.discoverToken(home);
      if (token && (await this.exchangeCookie(baseUrl, token))) return true;
      warn("[auth] all cookie sources failed (no token, no credentials secret)");
      return false;
    })().finally(() => {
      this.exchangeInFlight = undefined;
    });
    return this.exchangeInFlight;
  }
}

async function tokenFromLogTail(path: string, tailBytes = 262_144): Promise<string | undefined> {
  try {
    const info = await stat(path);
    const handle = await import("node:fs/promises").then((m) => m.open(path, "r"));
    try {
      const start = Math.max(0, info.size - tailBytes);
      const buf = Buffer.alloc(info.size - start);
      await handle.read(buf, 0, buf.length, start);
      const text = buf.toString("utf8");
      const m = TOKEN_PATTERN.exec(text);
      return m ? m[1] : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
