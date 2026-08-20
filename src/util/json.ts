export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * Serialize a value for measurement or display, never throwing.
 *
 * `JSON.stringify` throws outright on a cycle or a BigInt, and returns `undefined`
 * for `undefined` and for functions. Callers here want something printable out of
 * whatever they were handed — a value they cannot serialize is a value to describe,
 * not a reason to fail.
 */
export function jsonOf(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
