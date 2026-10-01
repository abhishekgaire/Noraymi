import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { loadSessionToken } from "./api.js";
import { registerServiceWorker } from "./push.js";
import "./styles.css";

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
