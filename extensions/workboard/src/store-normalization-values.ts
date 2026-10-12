import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeBoundedString(
  value: unknown,
  fallback: string | undefined,
  maxLength: number,
  fieldName: string,
): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return fallback;
  }
  if (normalized.length > maxLength) {
    throw new Error(
      `${fieldName} must be ${maxLength} characters or fewer (got ${normalized.length}).`,
    );
  }
  return normalized;
}

export function normalizeEnumValue<T extends string, TFallback extends T | undefined>(
  value: unknown,
  allowed: readonly T[],
  fallback: TFallback,
): T | TFallback {
  // SAFETY: The cast types the membership test; the result is used only after matching a declared enum member.
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

export function normalizeTimestamp(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : fallback;
}
