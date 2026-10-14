/**
 * Exact base-10 decimals as canonical strings (docs/03 §1): no binary floating
 * point is involved in parsing or comparison.
 */

const DECIMAL_PATTERN = /^(-)?(\d+)(?:\.(\d+))?$/;
/** Digits allowed after canonicalization (integer + fraction). */
export const DECIMAL_MAX_DIGITS = 30;

interface ParsedDecimal {
  negative: boolean;
  integer: string;
  fraction: string;
}

function parse(text: string): ParsedDecimal | undefined {
  const match = DECIMAL_PATTERN.exec(text);
  if (!match) return undefined;
  const integer = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  if (integer.length + fraction.length > DECIMAL_MAX_DIGITS) return undefined;
  const negative = match[1] === "-" && !(integer === "0" && fraction === "");
  return { negative, integer, fraction };
}

function format({ negative, integer, fraction }: ParsedDecimal): string {
  return `${negative ? "-" : ""}${integer}${fraction ? `.${fraction}` : ""}`;
}

/** Canonical form ("1.50" → "1.5", "-0.0" → "0", "007" → "7"), or undefined if not a decimal. */
export function canonicalDecimal(text: string): string | undefined {
  const parsed = parse(text);
  return parsed ? format(parsed) : undefined;
}

/**
 * Canonical decimal from a definition literal. Numbers are accepted only
 * when their JavaScript string form is plain decimal notation (no exponent).
 */
export function decimalFromLiteral(value: unknown): string | undefined {
  if (typeof value === "string") return canonicalDecimal(value);
  if (typeof value === "number" && Number.isFinite(value)) {
    const text = String(value);
    return /e/i.test(text) ? undefined : canonicalDecimal(text);
  }
  return undefined;
}

function compareMagnitude(a: ParsedDecimal, b: ParsedDecimal): number {
  if (a.integer.length !== b.integer.length) return a.integer.length < b.integer.length ? -1 : 1;
  if (a.integer !== b.integer) return a.integer < b.integer ? -1 : 1;
  const width = Math.max(a.fraction.length, b.fraction.length);
  const fa = a.fraction.padEnd(width, "0");
  const fb = b.fraction.padEnd(width, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}

/** Compares two canonical (or at least valid) decimal strings: -1, 0 or 1. */
export function compareDecimal(left: string, right: string): number {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) throw new Error("compareDecimal requires valid decimals");
  if (a.negative !== b.negative) return a.negative ? -1 : 1;
  const magnitude = compareMagnitude(a, b);
  return a.negative ? -magnitude : magnitude;
}
