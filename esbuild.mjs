import * as esbuild from "esbuild";
import { readFileSync } from "node:fs";

const watch = process.argv.includes("--watch");
/** 版本号注入 webview bundle：日志里能区分"宿主 HTML 的版本"与"真正在跑的 bundle 版本"。 */
const pkgVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

/** Extension host bundle (CommonJS, external vscode). MUST be .cjs: the
 *  package.json carries "type":"module" for tooling, which would otherwise
 *  make Node load this bundle as ESM and crash activation. */
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.cjs",
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["vscode"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
};

/** Webview bundle (ESM, React inlined; CSS imported as text). */
const webview = {
  entryPoints: ["webview/src/main.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  sourcemap: false,
  minify: true,
  loader: { ".css": "text" },
  define: { __DSH_WEBVIEW_VERSION__: JSON.stringify(pkgVersion) },
  logLevel: "info",
};

if (watch) {
  const ctx1 = await esbuild.context(extension);
  const ctx2 = await esbuild.context(webview);
  await Promise.all([ctx1.watch(), ctx2.watch()]);
  console.log("[esbuild] watching...");
} else {
  await esbuild.build(extension);
  await esbuild.build(webview);
  console.log("[esbuild] built dist/extension.cjs + dist/webview.js");
}
