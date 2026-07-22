import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HostDeckBrowserApp } from "./app-shell.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!(rootElement instanceof HTMLElement)) {
  throw new TypeError("HostDeck browser root element is unavailable.");
}

createRoot(rootElement).render(
  <StrictMode>
    <HostDeckBrowserApp />
  </StrictMode>
);
