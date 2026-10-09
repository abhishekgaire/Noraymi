import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadSessionToken } from "./api.js";
import { registerServiceWorker } from "./push.js";
import { installErrorReporting } from "./telemetry.js";
import "@west4/shared/design/fonts.css";
import "@west4/shared/design/tokens.css";
import "./styles.css";
// After the app's styles, so the canvas form layer and Admin's look win their ties (V-05).
import "@west4/shared/design/controls.css";
import "./admin/admin.css";

// Uncaught errors go to error tracking, scrubbed (M8-16).
installErrorReporting();
const root = document.getElementById("root");
if (!root) throw new Error("#root is missing");
void loadSessionToken().then(() => {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
void registerServiceWorker();
