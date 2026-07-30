import "./zod-csp-runtime.js";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HostDeckBrowserApp } from "./app-shell.js";
import {
  bindBrowserAppPageLifecycle,
  createProductionBrowserAppStartup
} from "./app-startup.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!(rootElement instanceof HTMLElement)) {
  throw new TypeError("HostDeck browser root element is unavailable.");
}

const startup = createProductionBrowserAppStartup();
bindBrowserAppPageLifecycle({
  startup,
  target: globalThis,
  reload: () => globalThis.location.reload()
});

createRoot(rootElement).render(
  <StrictMode>
    <HostDeckBrowserApp startup={startup} />
  </StrictMode>
);
