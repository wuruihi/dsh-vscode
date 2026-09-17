/**
 * locate-regress.cjs — resolving node.exe + the dsh CLI for "start dsh web".
 *
 * Regression for the 2026-09-17 report ("一键拉起失败"): package.json shipped
 * machine-specific defaults for both paths — the dsh one even contained the
 * publisher's own user name — so on this machine startDsh handed a nonexistent
 * bin.js to Start-Process and the failure surfaced only 120 s later as "did not
 * become ready in 120s", pointing at nothing.
 *
 * Fixtures are real directory trees under a temp dir, so the assertions cover
 * the layout conventions instead of this machine's specifics. Asserts: the
 * validator accepts a conventional layout and a relocated-but-real bin.js,
 * rejects look-alikes; an explicit setting wins; a STALE explicit path is both
 * reported and bypassed (the case the user actually hit); probing order is the
 * documented one; every candidate is listed with its source. Env-driven cases
 * (%APPDATA%, PATH, npm_config_prefix) override process.env, which the module
 * reads lazily on purpose.
 */
const { buildSync } = require("esbuild");
const fs = require("fs");
const os = require("os");
const path = require("path");

const out = path.join(os.tmpdir(), `locate-regress-${Date.now()}.cjs`);
buildSync({
  entryPoints: [path.join(__dirname, "..", "src", "connection", "locate.ts")],
  bundle: true,
  format: "cjs",
  platform: "node",
  outfile: out,
  logLevel: "silent",
});
const { looksLikeDshBin, looksLikeNodeExe, locateDshBin, locateNodeExe, nearestExistingDir } = require(out);

let passed = 0;
const fails = [];
const ok = (name, cond) => {
  if (cond) {
    passed++;
    console.log(`  ok  ${name}`);
  } else {
    fails.push(name);
    console.log(`FAIL  ${name}`);
  }
};

// ---- fixtures ---------------------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "locate-regress-"));
const MARKED = '#!/usr/bin/env node\nimport { loadLayeredEnv } from "@deepseek-ai/dsh-app-boot";\n';
const mkFile = (p, body = MARKED) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};
/** <base>/node_modules/@deepseek-ai/dsh/lib/bin.js — the layout npm produces. */
const dshUnder = (base) => path.join(base, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

const homeLocal = path.join(root, "home-local"); // ~/dsh/wrapper layout
const localBin = mkFile(dshUnder(path.join(homeLocal, "dsh")));
const homeRoot = path.join(root, "home-root"); // ~/node_modules layout
const rootBin = mkFile(dshUnder(homeRoot));
const appData = path.join(root, "appdata"); // npm global prefix
const appDataBin = mkFile(dshUnder(path.join(appData, "npm")));
const pathPrefix = path.join(root, "path-prefix"); // a prefix that is on PATH
const pathBin = mkFile(dshUnder(pathPrefix));
const workspace = path.join(root, "workspace"); // an open workspace folder
const wsBin = mkFile(dshUnder(workspace));
const relocated = mkFile(path.join(root, "relocated", "bin.js")); // marker, off-convention
const disguised = mkFile(path.join(root, "disguised", "bin.js"), "#!/usr/bin/env node\nconsole.log('not dsh');\n");
const nodeExe = mkFile(path.join(root, "nodejs", "node.exe"), "stub\n");
const nodeTxt = mkFile(path.join(root, "nodejs", "node.txt"), "stub\n");
const emptyHome = path.join(root, "empty-home"); // no DSH anywhere near it
fs.mkdirSync(emptyHome, { recursive: true });

/** Baseline environment = a machine with no DSH installed and no node anywhere.
 *  withEnv applies it first, then the case-specific patch, then restores. */
const BASE = { APPDATA: undefined, PATH: path.join(emptyHome, "nothing-on-path"), npm_config_prefix: undefined, ProgramFiles: undefined, PROGRAMFILES: undefined, LOCALAPPDATA: undefined };
const withEnv = (patch, fn) => {
  const saved = {};
  for (const k of Object.keys(BASE)) saved[k] = process.env[k];
  const apply = (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  apply(BASE);
  apply(patch);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ---- 1. validation ---------------------------------------------------------
ok("a conventional install validates", looksLikeDshBin(localBin));
ok("a relocated bin.js validates by its boot marker", looksLikeDshBin(relocated));
ok("a bin.js without marker and off-convention is rejected", !looksLikeDshBin(disguised));
ok("a directory named bin.js is rejected", !looksLikeDshBin(path.dirname(relocated)));
ok("a missing path is rejected", !looksLikeDshBin(path.join(root, "gone", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js")));
ok("node.exe validates, node.txt does not", looksLikeNodeExe(nodeExe) && !looksLikeNodeExe(nodeTxt));
ok("nearest existing ancestor stops at a real dir", nearestExistingDir(path.join(root, "deep", "nested", "bin.js"), emptyHome) === root);

// ---- 2. explicit setting wins ---------------------------------------------
withEnv({}, () => {
  const r = locateDshBin({ explicit: appDataBin, home: homeLocal });
  ok("explicit dshBinPath wins over auto-detection", r.hit && r.hit.path === appDataBin && r.hit.source.includes("dshBinPath") && !r.explicitRejected);
});

// ---- 3. THE reported case: a stale explicit path must not block startup ----
withEnv({}, () => {
  const stale = path.join(root, "old-machine", "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  const r = locateDshBin({ explicit: stale, home: homeLocal });
  ok("stale explicit path is reported", r.explicitRejected === stale);
  ok("stale explicit path is bypassed, auto-detection still succeeds", r.hit && r.hit.path === localBin);
});

// ---- 4. layout probing order ----------------------------------------------
withEnv({}, () => {
  const r = locateDshBin({ explicit: "", home: homeLocal });
  ok("~/dsh local deployment found with its source", r.hit && r.hit.path === localBin && r.hit.source.includes("家目录本地部署"));
});
withEnv({}, () => {
  const r = locateDshBin({ explicit: "", home: homeRoot });
  ok("~/node_modules layout found", r.hit && r.hit.path === rootBin && r.hit.source.includes("家目录"));
});
withEnv({ APPDATA: appData }, () => {
  const r = locateDshBin({ explicit: "", home: homeLocal });
  ok("%APPDATA%\\npm outranks ~/dsh", r.hit && r.hit.path === appDataBin && r.hit.source.includes("%APPDATA%"));
});
withEnv({ npm_config_prefix: pathPrefix }, () => {
  const r = locateDshBin({ explicit: "", home: emptyHome });
  ok("npm_config_prefix honored", r.hit && r.hit.path === pathBin && r.hit.source.includes("npm_config_prefix"));
});
withEnv({ PATH: [pathPrefix, path.join(emptyHome, "nothing-on-path")].join(";") }, () => {
  const r = locateDshBin({ explicit: "", home: emptyHome });
  ok("PATH prefix probed", r.hit && r.hit.path === pathBin && r.hit.source.includes("PATH 前缀"));
});
withEnv({}, () => {
  const r = locateDshBin({ explicit: "", home: emptyHome, extraRoots: [workspace] });
  ok("open workspace folder probed", r.hit && r.hit.path === wsBin && r.hit.source.includes("工作区"));
});

// ---- 5. the searched[] trail (what the failure dialog shows) ---------------
withEnv({}, () => {
  const r = locateDshBin({ explicit: "", home: emptyHome });
  ok("nothing found → no hit, but every candidate is listed", !r.hit && r.searched.length >= 3);
  ok("each candidate carries its source", r.searched.every((s) => s.includes("bin.js") && s.includes("←")));
  const r2 = locateDshBin({ explicit: "", home: homeLocal, extraRoots: [workspace] });
  ok("the hit is part of the listed trail", r2.searched.some((s) => s.startsWith(localBin)));
});
withEnv({}, () => {
  const r = locateDshBin({ explicit: rootBin, home: homeRoot });
  ok("a path given twice is listed once (explicit still first)", r.searched[0].startsWith(rootBin) && r.searched.filter((s) => s.startsWith(rootBin)).length === 1);
});

// ---- 6. node.exe ----------------------------------------------------------
withEnv({}, () => {
  const r = locateNodeExe({ explicit: nodeExe });
  ok("explicit nodePath wins", r.hit && r.hit.path === nodeExe && r.hit.source.includes("nodePath"));
  const bad = locateNodeExe({ explicit: nodeTxt });
  ok("stale nodePath reported, not fatal", bad.explicitRejected === nodeTxt && !bad.hit);
});
withEnv({ ProgramFiles: root }, () => {
  const r = locateNodeExe({ explicit: "" });
  ok("standard Node install dir probed", r.hit && r.hit.path === nodeExe && r.hit.source.includes("标准安装目录"));
});
withEnv({}, () => {
  const r = locateNodeExe({ explicit: "" });
  ok("no node anywhere → no hit, candidates listed", !r.hit && r.searched.length >= 1);
});

// ---- 7. this machine, end to end (skipped when the layout is absent) ------
const realBin = path.join(os.homedir(), "dsh", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (fs.existsSync(realBin)) {
  const r = locateDshBin({ explicit: "", home: os.homedir() });
  ok("real machine: deployed CLI found with NO settings", !!r.hit && looksLikeDshBin(r.hit.path));
} else {
  console.log("  --  real-machine /dsh layout absent, integration case skipped");
}
const realNode = locateNodeExe({ explicit: "" }); // real environment, no patching
ok("real machine: node.exe found with NO settings", !!realNode.hit && looksLikeNodeExe(realNode.hit.path));

// ---- cleanup --------------------------------------------------------------
fs.rmSync(out, { force: true });
fs.rmSync(root, { recursive: true, force: true });
console.log(fails.length === 0 ? `\n${passed}/${passed} passed` : `\nFAILED: ${fails.length}`);
process.exit(fails.length === 0 ? 0 : 1);
