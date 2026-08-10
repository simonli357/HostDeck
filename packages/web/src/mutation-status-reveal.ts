import { type RefObject, useLayoutEffect, useRef } from "react";

export function useMutationStatusReveal(
  phase: string
): RefObject<HTMLDivElement | null> {
  const statusRef = useRef<HTMLDivElement>(null);
  const previousPhaseRef = useRef(phase);

  useLayoutEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    if (phase !== "submitting" && previousPhase !== "submitting") return;

    const status = statusRef.current;
    if (status === null || typeof status.scrollIntoView !== "function") return;
    status.scrollIntoView({ block: "nearest" });
  }, [phase]);

  return statusRef;
}
