import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { clearCookie, parseCookies, serializeCookie } from "./cookies.js";
import { requireSameOrigin } from "./same-origin.js";

describe("cookies", () => {
  it("parses cookie headers, keeping the first value for a repeated name", () => {
    const cookies = parseCookies("a=1; we_session=abc%2Fdef; a=2; broken; =x; bad=%E0%A4%A");
    expect(cookies.get("a")).toBe("1");
    expect(cookies.get("we_session")).toBe("abc/def");
    expect(cookies.has("bad")).toBe(false);
    expect(parseCookies(undefined).size).toBe(0);
  });

  it("serializes HttpOnly SameSite=Lax cookies and adds Secure on request", () => {
    expect(serializeCookie("s", "v", { secure: false, maxAgeSeconds: 60 })).toBe("s=v; Path=/; SameSite=Lax; HttpOnly; Max-Age=60");
    expect(serializeCookie("s", "v", { secure: true, path: "/auth" })).toBe("s=v; Path=/auth; SameSite=Lax; HttpOnly; Secure");
    expect(clearCookie("s", { secure: false })).toContain("Max-Age=0");
  });
});

describe("requireSameOrigin", () => {
  const app = express();
  app.use(requireSameOrigin("http://localhost:3000"));
  app.all("/x", (_req, res) => {
    res.sendStatus(204);
  });

  it("allows safe methods from anywhere", async () => {
    expect((await request(app).get("/x").set("Origin", "https://evil.example")).status).toBe(204);
  });

  it("allows mutations from the console origin by Origin or Referer", async () => {
    expect((await request(app).post("/x").set("Origin", "http://localhost:3000")).status).toBe(204);
    expect((await request(app).post("/x").set("Referer", "http://localhost:3000/o/1/forms")).status).toBe(204);
  });

  it("rejects mutations from other origins, null origins or with no origin information", async () => {
    expect((await request(app).post("/x").set("Origin", "https://evil.example")).status).toBe(403);
    expect((await request(app).post("/x").set("Origin", "http://localhost:3000.evil.example")).status).toBe(403);
    expect((await request(app).post("/x").set("Origin", "null")).status).toBe(403);
    expect((await request(app).delete("/x")).status).toBe(403);
    expect((await request(app).post("/x").set("Referer", "not a url")).status).toBe(403);
  });
});
