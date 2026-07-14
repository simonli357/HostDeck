import { z } from "zod";

const invalidDataObject = Symbol("invalid-data-object");

export function exactDataObject<const Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((input) => copyExactDataObject(input), schema);
}

function copyExactDataObject(input: unknown): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return input;

  try {
    const prototype: unknown = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) return invalidDataObject;

    const descriptors = Object.getOwnPropertyDescriptors(input);
    const copy = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors];
      if (typeof key !== "string" || descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        return invalidDataObject;
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      });
    }
    return copy;
  } catch {
    return invalidDataObject;
  }
}
