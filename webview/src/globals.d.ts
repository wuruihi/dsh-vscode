declare module "*.css" {
  const css: string;
  export default css;
}

/** 构建期注入的**本 bundle** 版本号（esbuild define，见 esbuild.mjs）。
 *  与宿主 HTML 里的版本号分开：宿主版本 ≠ 实际执行的 bundle 版本，
 *  排查"改了没生效"时要以这一行为准。 */
declare const __DSH_WEBVIEW_VERSION__: string;
