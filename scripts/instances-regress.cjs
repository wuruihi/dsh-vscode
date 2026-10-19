/**
 * instances-regress.cjs — instance resolution after DSH 0.2.1 moved the desktop
 * gateway port from the fixed literal 19387 to an OS-assigned port per launch.
 *
 * The module under test has no vscode dependency by design, but it logs through
 * `src/log.ts` (which does), so esbuild bundles it with `vscode` aliased to a
 * throwaway stub. Probe/discovery are injected seams: every assertion below runs
 * offline and deterministically; the last case is a live-machine check that
 * skips itself when no desktop App is listening.
 *
 * Asserts: discovered ports become the first candidates (desktop/profile), an
 * empty discovery falls back to the legacy 19387 → 3080 table, multiple ports
 * are all probed and the first live one wins, a pinned baseUrl bypasses
 * discovery entirely, discovery failures degrade instead of throwing, and
 * waitForDesktopInstance keeps polling until the App's port appears.
 */
const { buildSync } = require("esbuild");
const fs = require("fs");
const os = require("os");
const path = require("path");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "instances-regress-"));
// `vscode` is only reachable through src/log.ts; keep it external and satisfy it
// with a module inside the bundle's own directory (Node resolves it from there).
const stubDir = path.join(dir, "node_modules", "vscode");
fs.mkdirSync(stubDir, { recursive: true });
fs.writeFileSync(
  path.join(stubDir, "index.js"),
  "module.exports = { window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) } };\n",
);
const bundle = path.join(dir, "instances.cjs");
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "connection", "instances.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: bundle,
  logLevel: "silent",
  external: ["vscode"],
});

const {
  candidateInstances,
  discoverDesktopPorts,
  readPermissionPreset,
  resolveInstance,
  waitForDesktopInstance,
} = require(bundle);

let passed = 0;
const fails = [];
const ok = (name, cond, detail = "") => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
};
const urls = (list) => list.map((c) => c.baseUrl.replace("http://", ""));
const probeOnly = (ports, running = ports) => async (inst) => {
  const port = Number(new URL(inst.baseUrl).port);
  return running.includes(port) ? { ...inst, running: true, needsAuth: true } : undefined;
};

(async () => {
  const home = path.join(dir, "home");
  const noApp = () => undefined;

  // ---- 1. discovered port becomes the first desktop candidate ----------------
  {
    const res = await resolveInstance({
      home,
      appExe: noApp,
      probe: probeOnly([59204]),
      discoverPorts: async () => [59204],
    });
    const first = res.candidates[0];
    ok("discovered port is the first candidate", first && first.baseUrl === "http://127.0.0.1:59204", JSON.stringify(urls(res.candidates)));
    ok("discovered candidate is a desktop instance", first && first.kind === "desktop-app" && first.profile === "desktop");
    ok("discovered instance wins resolution", res.instance && res.instance.baseUrl === "http://127.0.0.1:59204");
  }

  // ---- 2. empty discovery → legacy fixed table -------------------------------
  {
    const res = await resolveInstance({
      home,
      appExe: noApp,
      probe: async () => undefined,
      discoverPorts: async () => [],
    });
    ok(
      "empty discovery falls back to 19387 → 3080",
      JSON.stringify(urls(res.candidates)) === JSON.stringify(["127.0.0.1:19387", "127.0.0.1:3080"]),
      JSON.stringify(urls(res.candidates)),
    );
    ok("nothing answered → no instance", res.instance === undefined);
  }

  // ---- 3. several discovered ports: ascending, all probed, first live wins ---
  {
    const res = await resolveInstance({
      home,
      appExe: noApp,
      probe: probeOnly([59204, 59211], [59211]),
      discoverPorts: async () => [59211, 59204], // deliberately unsorted
    });
    ok(
      "discovered ports are tried in ascending order",
      urls(res.candidates).slice(0, 2).join(",") === "127.0.0.1:59204,127.0.0.1:59211",
      JSON.stringify(urls(res.candidates)),
    );
    ok("first LIVE discovered port wins", res.instance && res.instance.baseUrl === "http://127.0.0.1:59211");
  }

  // ---- 3b. dynamic-vs-legacy id contract (extension keys "do not pin me" off
  //          `id !== "desktop-app"`; a format change here would silently start
  //          pinning ephemeral ports again) ----------------------------------
  {
    const cands = candidateInstances(undefined, [59204]);
    const dynamic = cands.find((c) => c.baseUrl === "http://127.0.0.1:59204");
    const legacy = cands.find((c) => c.baseUrl === "http://127.0.0.1:19387");
    ok(
      "discovered desktop candidate keeps a dynamic id (≠ desktop-app) and profile",
      !!dynamic && dynamic.id === "desktop-app:59204" && dynamic.id !== "desktop-app" && dynamic.profile === "desktop",
      JSON.stringify(dynamic),
    );
    ok("legacy 19387 candidate keeps id desktop-app", !!legacy && legacy.id === "desktop-app");
  }

  // ---- 4. pinned baseUrl bypasses discovery --------------------------------
  {
    let discoverCalls = 0;
    let probed = [];
    const res = await resolveInstance({
      home,
      explicitBaseUrl: "http://127.0.0.1:8080",
      appExe: noApp,
      probe: async (inst) => {
        probed.push(inst.baseUrl);
        return { ...inst, running: true, needsAuth: false };
      },
      discoverPorts: async () => {
        discoverCalls++;
        return [59204];
      },
    });
    ok("pinned baseUrl does not run discovery", discoverCalls === 0);
    ok("pinned baseUrl is the only candidate probed", JSON.stringify(probed) === JSON.stringify(["http://127.0.0.1:8080"]));
    ok("pinned resolution reports pinned", res.pinned === true && res.instance?.baseUrl === "http://127.0.0.1:8080");
  }

  // ---- 5. discovery failure degrades, never throws --------------------------
  {
    let threw = false;
    let res;
    try {
      res = await resolveInstance({
        home,
        appExe: noApp,
        probe: probeOnly([19387]),
        discoverPorts: async () => {
          throw new Error("powershell exploded");
        },
      });
    } catch {
      threw = true;
    }
    ok("discovery failure does not throw", !threw);
    ok("discovery failure still probes the fixed candidates", res?.instance?.baseUrl === "http://127.0.0.1:19387");
  }

  // ---- 6. waitForDesktopInstance polls discovery until it appears ------------
  {
    let calls = 0;
    const inst = await waitForDesktopInstance(undefined, {
      launch: false,
      intervalMs: 5,
      timeoutMs: 2000,
      probe: probeOnly([59204]),
      discoverPorts: async () => {
        calls++;
        return calls >= 2 ? [59204] : [];
      },
    });
    ok("waitForDesktopInstance waits for the port to appear", inst && inst.baseUrl === "http://127.0.0.1:59204", `calls=${calls}`);

    const timedOut = await waitForDesktopInstance(undefined, {
      launch: false,
      intervalMs: 5,
      timeoutMs: 25,
      probe: async () => undefined,
      discoverPorts: async () => [],
    });
    ok("waitForDesktopInstance returns undefined on timeout", timedOut === undefined);

    const noExe = await waitForDesktopInstance(undefined, { launch: true, timeoutMs: 50 });
    ok("waitForDesktopInstance without an app path cannot attach", noExe === undefined);
  }

  // ---- 7. permission preset still reads the profile patch -------------------
  {
    const patch = path.join(home, ".dsh", "profiles", "desktop", "cordis.patch.yml");
    fs.mkdirSync(path.dirname(patch), { recursive: true });
    fs.writeFileSync(patch, "- id: permission\n  config:\n    defaultPreset: danger-full-access\n");
    ok("permission preset read from the desktop profile", readPermissionPreset(home, "desktop") === "danger-full-access");
    ok("unknown profile has no preset", readPermissionPreset(home, "nope") === undefined);
  }

  // ---- 8. live machine (opt-in: --live; a silent skip is how the args:audit
  //         "SKIP exit 0 = not audited" trap started) --------------------------
  {
    const live = process.argv.includes("--live");
    if (!live) {
      console.log("  --  live: skipped (pass --live to require a running desktop App)");
    } else {
      const ports = await discoverDesktopPorts();
      if (ports.length === 0) {
        ok("live: --live requires a discoverable desktop App port", false, "discovery returned no ports");
      } else {
        const res = await resolveInstance({ home, timeoutMs: 3000 });
        const port = res.instance ? Number(new URL(res.instance.baseUrl).port) : undefined;
        ok(
          `live: resolveInstance selects a discovered port (${ports.join("/")})`,
          res.instance?.kind === "desktop-app" && port !== undefined && ports.includes(port),
          JSON.stringify(urls(res.candidates)),
        );
      }
    }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${fails.length} failed`);
  if (fails.length > 0) {
    console.log("failed:\n  " + fails.join("\n  "));
    process.exit(1);
  }
})().catch((err) => {
  fs.rmSync(dir, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
