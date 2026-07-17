import { z } from "zod";

const invalidDataObject = Symbol("invalid-data-object");
const invalidDataArray = Symbol("invalid-data-array");

export function exactDataObject<const Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((input) => copyExactDataObject(input), schema);
}

export function exactDataArray<const Schema extends z.ZodType>(schema: Schema) {
  return z.preprocess((input) => copyExactDataArray(input), schema);
}

function copyExactDataObject(input: unknown): unknown {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return input;
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

function copyExactDataArray(input: unknown): unknown {
  try {
    if (!Array.isArray(input)) return input;
    if (Object.getPrototypeOf(input) !== Array.prototype) return invalidDataArray;
    const descriptors = Object.getOwnPropertyDescriptors(input) as Record<
      string,
      PropertyDescriptor | undefined
    >;
    const lengthDescriptor = descriptors.length;
    const length = lengthDescriptor?.value;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      Reflect.ownKeys(descriptors).length !== length + 1 ||
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      lengthDescriptor.enumerable
    ) {
      return invalidDataArray;
    }

    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalidDataArray;
      }
      copy.push(descriptor.value);
    }
    return copy;
  } catch {
    return invalidDataArray;
  }
}
