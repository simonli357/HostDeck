import { describe, expect, it } from "vitest";
import { deepFreezeExactData } from "./exact-data-object.js";

describe("shared exact-data deep freeze", () => {
  it("freezes nested plain data in place and returns the same reference", () => {
    const value = { a: 1, nested: { b: [{ c: "d" }] } };
    const result = deepFreezeExactData(value);
    expect(result).toBe(value);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested.b)).toBe(true);
    expect(Object.isFrozen(value.nested.b[0])).toBe(true);
  });

  it("returns primitives and null unchanged instead of throwing", () => {
    // One prior variant declared `<T extends object>` and threw on a primitive, because
    // Object.values(null) throws. Every other variant passed it through; that is the
    // behaviour kept here.
    expect(deepFreezeExactData(null)).toBeNull();
    expect(deepFreezeExactData(undefined)).toBeUndefined();
    expect(deepFreezeExactData(7)).toBe(7);
    expect(deepFreezeExactData("x")).toBe("x");
    expect(deepFreezeExactData(false)).toBe(false);
  });

  it("terminates on a cyclic graph rather than recursing forever", () => {
    // This is the reason the shared implementation freezes the parent BEFORE its children.
    // The 79-file post-order majority recursed into a cycle that re-entered a parent which
    // was not frozen yet, so it never terminated. Freezing first lets Object.isFrozen stop
    // the walk. If this test hangs, that ordering has been reverted.
    const parent: Record<string, unknown> = { name: "parent" };
    const child: Record<string, unknown> = { name: "child", parent };
    parent.child = child;

    expect(deepFreezeExactData(parent)).toBe(parent);
    expect(Object.isFrozen(parent)).toBe(true);
    expect(Object.isFrozen(child)).toBe(true);
  });

  it("terminates on a self-referencing array", () => {
    const list: unknown[] = [1, 2];
    list.push(list);
    deepFreezeExactData(list);
    expect(Object.isFrozen(list)).toBe(true);
  });

  it("short-circuits on an already-frozen value without descending", () => {
    const inner = { mutable: true };
    const outer = Object.freeze({ inner });
    deepFreezeExactData(outer);
    // The outer object was already frozen, so the walk stops there and `inner` is untouched.
    // Every prior variant behaved this way; consolidation must not silently deepen it.
    expect(Object.isFrozen(inner)).toBe(false);
  });

  it("leaves Map and Set contents alone, matching every prior variant", () => {
    const map = new Map([["a", { b: 1 }]]);
    deepFreezeExactData(map);
    expect(Object.isFrozen(map)).toBe(true);
    // Object.freeze does not stop Map mutation, and Object.values reports no entries.
    expect(() => map.set("c", { b: 2 })).not.toThrow();
  });

  it("actually prevents mutation of frozen data", () => {
    const value = deepFreezeExactData({ nested: { count: 1 } });
    // ES modules are already strict, so the assignment throws rather than failing silently.
    expect(() => {
      (value.nested as { count: number }).count = 2;
    }).toThrow(TypeError);
    expect(value.nested.count).toBe(1);
  });
});
