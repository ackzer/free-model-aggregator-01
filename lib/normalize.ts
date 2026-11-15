export function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>();

  const serialize = (item: unknown): string | undefined => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? JSON.stringify(Object.is(item, -0) ? 0 : item) : 'null';
    if (typeof item === 'undefined') return undefined;
    if (Array.isArray(item)) {
      if (ancestors.has(item)) throw new TypeError('cannot canonicalize circular JSON');
      ancestors.add(item);
      const result = `[${item.map((entry) => serialize(entry) ?? 'null').join(',')}]`;
      ancestors.delete(item);
      return result;
    }
    if (typeof item === 'object') {
      if (ancestors.has(item)) throw new TypeError('cannot canonicalize circular JSON');
      ancestors.add(item);
      const record = item as Record<string, unknown>;
      const fields = Object.keys(record).sort().flatMap((key) => {
        const encoded = serialize(record[key]);
        return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
      });
      ancestors.delete(item);
      return `{${fields.join(',')}}`;
    }
    throw new TypeError(`cannot canonicalize ${typeof item} as JSON`);
  };

  return serialize(value) ?? 'null';
}

export function buildCacheKey(providerId: string, api: string, model: string, body: unknown): string {
  return canonicalJson([providerId, api, model, canonicalJson(body)]);
}
