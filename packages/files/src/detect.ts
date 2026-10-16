/**
 * File type from content, not from the name or the declared Content-Type
 * (docs/06 §3). Only the types the builder offers for upload fields are
 * recognised; anything else is "application/octet-stream" and is rejected
 * unless a field allows it.
 */

export const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** How many leading bytes detection needs. */
export const SNIFF_BYTES = 8192;

const startsWith = (head: Buffer, bytes: number[]) => bytes.every((b, i) => head[i] === b);

function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (head.includes(0)) return false;
  // Valid UTF-8 (a multi-byte character cut at the end of the sample is fine).
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(head.subarray(0, Math.max(0, head.length - 3)));
    return true;
  } catch {
    return false;
  }
}

/**
 * The detected type of a file's first bytes. Office Open XML files are ZIP
 * archives: they are accepted as the declared Word or Excel type only when
 * they carry the OOXML manifest.
 */
export function detectType(head: Buffer, declared: string): string {
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const ooxml = head.includes(Buffer.from("[Content_Types].xml"));
    if (ooxml && (declared === DOCX || declared === XLSX)) return declared;
    return "application/zip";
  }
  if (looksLikeText(head)) return "text/plain";
  return "application/octet-stream";
}

/**
 * A display name safe to store and to offer in a download: no path, no
 * control characters, bounded length. The stored object key never uses it.
 */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    // Control characters are exactly what this removes.
    // oxlint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  const limited = cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
  return limited || "file";
}
