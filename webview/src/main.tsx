import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import css from "./styles.css";

// Inject bundled CSS (esbuild loader: .css -> text).
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

// Which BUILD is actually executing? The host HTML prints its own (extension
// host) version, which is NOT proof about this bundle — a cached old webview
// would still report the new host version. This line is the bundle's own
// identity, injected at build time; ask for it when "改了没生效" is suspected.
console.log(`[dsh-vscode] webview bundle v${__DSH_WEBVIEW_VERSION__}`);

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
