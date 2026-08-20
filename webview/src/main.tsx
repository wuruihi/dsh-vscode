import { createRoot } from "react-dom/client";
import { App } from "./app.js";
import css from "./styles.css";

// Inject bundled CSS (esbuild loader: .css -> text).
const style = document.createElement("style");
style.textContent = css;
document.head.appendChild(style);

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
