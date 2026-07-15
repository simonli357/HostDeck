import { bootstrapWindowPairing } from "../../../packages/web/src/pairing-bootstrap.js";

type PhysicalPairingSummary = Readonly<{
  readonly state: string;
  readonly permission: "read" | "write" | null;
  readonly csrf_generation: number | null;
}>;

declare global {
  interface Window {
    __hostDeckPhysicalPairing: PhysicalPairingSummary;
  }
}

function publish(summary: PhysicalPairingSummary): void {
  window.__hostDeckPhysicalPairing = Object.freeze(summary);
  document.documentElement.dataset.pairingState = summary.state;
  const status = document.querySelector("#status");
  if (status !== null) status.textContent = summary.state;
}

publish({ state: "starting", permission: null, csrf_generation: null });

void bootstrapWindowPairing()
  .then((result) => {
    publish({
      state: result.state,
      permission:
        result.state === "paired" || result.state === "paired_csrf_unavailable"
          ? result.permission
          : null,
      csrf_generation: result.state === "paired" ? result.csrf_generation : null
    });
  })
  .catch(() => {
    publish({ state: "internal_failure", permission: null, csrf_generation: null });
  });
