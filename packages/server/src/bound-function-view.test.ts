import { describe, expect, it } from "vitest";
import { createHostDeckBoundFunctionView } from "./production-application-composition.js";

describe("production bound function views", () => {
  it("preserves the owning receiver through a detached route port", () => {
    class ReceiverPort {
      constructor(private readonly owner: string) {}

      read(value: string): string {
        return `${this.owner}:${value}`;
      }
    }

    const source = new ReceiverPort("managed-session-service");
    const view = createHostDeckBoundFunctionView(source, ["read"]);
    const detached = view.read;

    expect(Object.getPrototypeOf(view)).toBeNull();
    expect(Object.isFrozen(view)).toBe(true);
    expect(Reflect.apply(detached, undefined, ["start"])).toBe(
      "managed-session-service:start"
    );
  });

  it("rejects a selected port that is not callable", () => {
    expect(() =>
      createHostDeckBoundFunctionView({ read: "not-callable" }, ["read"])
    ).toThrow("HostDeck production function port read is invalid.");
  });
});
