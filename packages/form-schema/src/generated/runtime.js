// Runtime helpers for the generated validator, replacing Ajv's CommonJS
// runtime modules so the validator is plain ESM with no dependencies.

/** String length in Unicode code points (JSON Schema maxLength semantics), as Ajv's ucs2length. */
export function ucs2length(str) {
  const len = str.length;
  let length = 0;
  let pos = 0;
  while (pos < len) {
    length++;
    const value = str.charCodeAt(pos++);
    if (value >= 0xd800 && value <= 0xdbff && pos < len) {
      const next = str.charCodeAt(pos);
      if ((next & 0xfc00) === 0xdc00) pos++;
    }
  }
  return length;
}

/** Deep equality for JSON values (uniqueItems), as Ajv's equal. */
export function equal(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
      return true;
    }
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !equal(a[key], b[key])) return false;
    }
    return true;
  }
  // NaN cannot occur in JSON; mirror fast-deep-equal anyway.
  return a !== a && b !== b;
}
