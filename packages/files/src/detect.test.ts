import { describe, expect, it } from "vitest";
import { detectType, DOCX, safeFileName, XLSX } from "./detect.js";
import { parseClamdReply, ScannerUnavailableError } from "./scanner.js";
import { attachmentDisposition } from "./storage.js";

describe("file type detection", () => {
  it("recognises the offered types from their bytes", () => {
    expect(detectType(Buffer.from("%PDF-1.7\n..."), "application/pdf")).toBe("application/pdf");
    expect(detectType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), "image/png")).toBe("image/png");
    expect(detectType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]), "image/jpeg")).toBe("image/jpeg");
    expect(detectType(Buffer.from("Plain text, café ✓"), "text/plain")).toBe("text/plain");
  });

  it("ignores the declared type when the bytes say otherwise", () => {
    expect(detectType(Buffer.from("not a pdf"), "application/pdf")).toBe("text/plain");
    expect(detectType(Buffer.from([0x4d, 0x5a, 0x90, 0x00]), "text/plain")).toBe("application/octet-stream");
  });

  it("accepts a ZIP as Word or Excel only when it carries the Office manifest", () => {
    const zip = (body: string) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(body)]);
    expect(detectType(zip("....[Content_Types].xml...."), DOCX)).toBe(DOCX);
    expect(detectType(zip("....[Content_Types].xml...."), XLSX)).toBe(XLSX);
    expect(detectType(zip("....payload.exe...."), DOCX)).toBe("application/zip");
    expect(detectType(zip("....[Content_Types].xml...."), "text/plain")).toBe("application/zip");
  });
});

describe("safe file names", () => {
  it("keeps the base name only, without control or reserved characters", () => {
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName("C:\\Users\\me\\report.pdf")).toBe("report.pdf");
    expect(safeFileName('a<b>:"c|?*\u0000d.txt')).toBe("a_b___c____d.txt");
    expect(safeFileName("...hidden")).toBe("hidden");
    expect(safeFileName("   ")).toBe("file");
    expect(safeFileName("x".repeat(300) + ".txt")).toHaveLength(200);
  });

  it("builds an attachment header that is safe and keeps Unicode names", () => {
    expect(attachmentDisposition('résumé "final".pdf')).toBe(`attachment; filename="r_sum_ _final_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22final%22.pdf`);
  });
});

describe("clamd replies", () => {
  it("reads clean and infected verdicts", () => {
    expect(parseClamdReply("stream: OK\0")).toEqual({ status: "clean" });
    expect(parseClamdReply("stream: Win.Test.EICAR_HDB-1 FOUND\0")).toEqual({ status: "infected", signature: "Win.Test.EICAR_HDB-1" });
  });

  it("treats anything else as the scanner being unavailable, never as clean", () => {
    expect(() => parseClamdReply("INSTREAM size limit exceeded. ERROR\0")).toThrow(ScannerUnavailableError);
    expect(() => parseClamdReply("")).toThrow(ScannerUnavailableError);
  });
});
