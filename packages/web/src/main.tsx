import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HostDeckBrowserApp } from "./app-shell.js";
import { createProductionBrowserAppStartup } from "./app-startup.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!(rootElement instanceof HTMLElement)) {
  throw new TypeError("HostDeck browser root element is unavailable.");
}

const startup = createProductionBrowserAppStartup();
globalThis.addEventListener("pagehide", () => startup.close(), { once: true });

createRoot(rootElement).render(
  <StrictMode>
    <HostDeckBrowserApp startup={startup} />
  </StrictMode>
);
