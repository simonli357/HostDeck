import { createOperationDeadline, OperationDeadlineExceededError } from "@hostdeck/core";
import { describe, expect, it, vi } from "vitest";
import {
  requireOpenOperationDeadline,
  runSerializedWithDeadline
} from "./operation-deadline-serialization.js";

function mapped(cause: unknown): Error {
  return new Error("mapped deadline failure", { cause });
}

describe("operation deadline serialization", () => {
  it("rejects invalid, expired, and disposed deadlines before execution", async () => {
    expect(() => requireOpenOperationDeadline({}, mapped)).toThrow(
      "mapped deadline failure"
    );

    const expired = createOperationDeadline({ timeoutMs: 1 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(() => requireOpenOperationDeadline(expired, mapped)).toThrow(
      "mapped deadline failure"
    );

    const disposed = createOperationDeadline({ timeoutMs: 100 });
    disposed.dispose();
    expect(() => requireOpenOperationDeadline(disposed, mapped)).toThrow(
      "mapped deadline failure"
    );
  });

  it("rejects an aborted queued operation promptly and never runs it later", async () => {
    const tails = new Map<string, Promise<void>>();
    const firstDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const queuedDeadline = createOperationDeadline({ timeoutMs: 20 });
    let releaseFirst: (() => void) | undefined;
    const first = runSerializedWithDeadline(
      tails,
      "session_1",
      firstDeadline,
      mapped,
      () => new Promise<void>((resolve) => {
        releaseFirst = resolve;
      })
    );
    const queuedOperation = vi.fn(async () => "never");
    const queued = runSerializedWithDeadline(
      tails,
      "session_1",
      queuedDeadline,
      mapped,
      queuedOperation
    );

    await expect(queued).rejects.toMatchObject({
      message: "mapped deadline failure",
      cause: expect.any(OperationDeadlineExceededError)
    });
    expect(queuedOperation).not.toHaveBeenCalled();

    releaseFirst?.();
    await first;
    await tails.get("session_1");
    expect(queuedOperation).not.toHaveBeenCalled();
    expect(tails.size).toBe(0);
    firstDeadline.dispose();
    queuedDeadline.dispose();
  });

  it("preserves ordering for work queued after an aborted reservation", async () => {
    const tails = new Map<string, Promise<void>>();
    const order: string[] = [];
    const firstDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    const abortedOwner = new AbortController();
    const abortedDeadline = createOperationDeadline({
      timeoutMs: 1_000,
      parentSignal: abortedOwner.signal
    });
    const thirdDeadline = createOperationDeadline({ timeoutMs: 1_000 });
    let releaseFirst: (() => void) | undefined;

    const first = runSerializedWithDeadline(
      tails,
      "session_1",
      firstDeadline,
      mapped,
      () => new Promise<void>((resolve) => {
        order.push("first-start");
        releaseFirst = () => {
          order.push("first-end");
          resolve();
        };
      })
    );
    const second = runSerializedWithDeadline(
      tails,
      "session_1",
      abortedDeadline,
      mapped,
      async () => {
        order.push("second");
      }
    );
    const third = runSerializedWithDeadline(
      tails,
      "session_1",
      thirdDeadline,
      mapped,
      async () => {
        order.push("third");
      }
    );

    await Promise.resolve();
    abortedOwner.abort(new Error("client disconnected"));
    await expect(second).rejects.toThrow("mapped deadline failure");
    expect(order).toEqual(["first-start"]);
    releaseFirst?.();
    await Promise.all([first, third]);
    expect(order).toEqual(["first-start", "first-end", "third"]);
    expect(tails.size).toBe(0);

    firstDeadline.dispose();
    abortedDeadline.dispose();
    thirdDeadline.dispose();
  });
});
