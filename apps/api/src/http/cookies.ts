export interface CookieOptions {
  maxAgeSeconds?: number;
  path?: string;
  secure: boolean;
  httpOnly?: boolean;
  sameSite?: "Lax" | "Strict";
}

/** Parses a Cookie header; the first occurrence of a name wins. Malformed values are skipped. */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (cookies.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore values that are not valid percent-encoding.
    }
  }
  return cookies;
}

export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path ?? "/"}`, `SameSite=${options.sameSite ?? "Lax"}`];
  if (options.httpOnly !== false) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAgeSeconds))}`);
  return parts.join("; ");
}

export function clearCookie(name: string, options: Omit<CookieOptions, "maxAgeSeconds">): string {
  return serializeCookie(name, "", { ...options, maxAgeSeconds: 0 });
}
