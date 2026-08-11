export function createBoundFunctionView<
  TSource extends object,
  const TKey extends keyof TSource & string
>(source: TSource, keys: readonly TKey[]): Pick<TSource, TKey> {
  const view: Partial<Pick<TSource, TKey>> = Object.create(null) as Partial<
    Pick<TSource, TKey>
  >;
  for (const key of keys) {
    const value = source[key];
    if (typeof value !== "function") {
      throw new TypeError(`HostDeck production function port ${key} is invalid.`);
    }
    view[key] = value.bind(source) as TSource[TKey];
  }
  return Object.freeze(view) as Pick<TSource, TKey>;
}
