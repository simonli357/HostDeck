import {
  createOperationDeadlineView,
  type OperationDeadline,
  operationDeadlineLimits
} from "@hostdeck/core";

type TestDeadlineInput = AbortSignal | OperationDeadline;
type TestDeadlineMethod<Method> = Method extends (
  ...args: [...infer Prefix, OperationDeadline]
) => infer Result
  ? (...args: [...Prefix, deadline?: TestDeadlineInput]) => Result
  : Method;

export type WithTestOperationDeadlines<
  Service extends object,
  Keys extends keyof Service
> = Omit<Service, Keys> & {
  [Key in Keys]: TestDeadlineMethod<Service[Key]>;
};

const neverAbortSignal = new AbortController().signal;

export function testOperationDeadline(
  signal: AbortSignal = neverAbortSignal
): OperationDeadline {
  return createOperationDeadlineView({
    timeoutMs: operationDeadlineLimits.maximumTimeoutMs,
    signal
  });
}

export function withTestOperationDeadlines<
  Service extends object,
  const Keys extends readonly (keyof Service)[]
>(
  service: Service,
  methodKeys: Keys
): WithTestOperationDeadlines<Service, Keys[number]> {
  const descriptors = Object.getOwnPropertyDescriptors(service) as Record<
    PropertyKey,
    PropertyDescriptor
  >;
  let wrapped: object;
  for (const property of methodKeys) {
    const descriptor = findPropertyDescriptor(service, property);
    if (descriptor === null || !("value" in descriptor) || typeof descriptor.value !== "function") {
      throw new TypeError("Test deadline method must be a data function.");
    }
    const method = descriptor.value as (...args: unknown[]) => unknown;
    const expectedArity = method.length;
    const wrapper = (...input: unknown[]) => {
      const args = [...input];
      if (args.length < expectedArity || args[expectedArity - 1] === undefined) {
        args[expectedArity - 1] = testOperationDeadline();
      } else if (args[expectedArity - 1] instanceof AbortSignal) {
        args[expectedArity - 1] = testOperationDeadline(
          args[expectedArity - 1] as AbortSignal
        );
      }
      return Reflect.apply(method, wrapped, args);
    };
    descriptors[property] = {
      ...descriptor,
      value: wrapper
    };
  }
  wrapped = Object.defineProperties(
    Object.create(Object.getPrototypeOf(service)) as object,
    descriptors
  );
  return Object.freeze(wrapped) as WithTestOperationDeadlines<
    Service,
    Keys[number]
  >;
}

function findPropertyDescriptor(
  value: object,
  property: PropertyKey
): PropertyDescriptor | null {
  let current: object | null = value;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, property);
    if (descriptor !== undefined) return descriptor;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return null;
}
