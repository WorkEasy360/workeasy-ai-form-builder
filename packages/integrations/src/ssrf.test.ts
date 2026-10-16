import { describe, expect, it } from "vitest";
import { checkWebhookUrl, DestinationBlockedError, isBlockedAddress, resolveDestination, STRICT_POLICY } from "./ssrf.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "127.10.20.30",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fd00:ec2::254", // AWS metadata over IPv6
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "::127.0.0.1",
    "64:ff9b::a00:1",
    "2002:7f00:1::",
    "ff02::1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "93.184.215.14", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });
});

describe("checkWebhookUrl", () => {
  it.each([
    ["not a url", "INVALID_URL"],
    ["http://hooks.example.com/x", "HTTPS_REQUIRED"],
    ["ftp://hooks.example.com/x", "HTTPS_REQUIRED"],
    ["https://user:pass@hooks.example.com/x", "CREDENTIALS_IN_URL"],
    ["https://hooks.example.com:22/x", "PORT_NOT_ALLOWED"],
    ["https://localhost/x", "DESTINATION_NOT_ALLOWED"],
    ["https://metadata.google.internal/x", "DESTINATION_NOT_ALLOWED"],
    ["https://169.254.169.254/latest/meta-data", "DESTINATION_NOT_ALLOWED"],
    ["https://[::1]/x", "DESTINATION_NOT_ALLOWED"],
    ["https://[::ffff:10.0.0.1]/x", "DESTINATION_NOT_ALLOWED"],
  ])("rejects %s", (url, code) => {
    expect(checkWebhookUrl(url)?.code).toBe(code);
  });

  it("accepts public HTTPS URLs on allowed ports", () => {
    expect(checkWebhookUrl("https://hooks.example.com/workeasy?team=1")).toBeUndefined();
    expect(checkWebhookUrl("https://hooks.example.com:8443/x")).toBeUndefined();
  });

  it("allows local destinations only under the development policy", () => {
    const dev = { allowHttp: true, allowPrivateNetworks: true, allowedPorts: [443] };
    expect(checkWebhookUrl("http://127.0.0.1:9999/hook", dev)).toBeUndefined();
  });
});

describe("resolveDestination", () => {
  const answers = (...addresses: string[]) => () => Promise.resolve(addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })));

  it("returns a checked public address to pin the connection to", async () => {
    expect(await resolveDestination("hooks.example.com", STRICT_POLICY, answers("93.184.215.14"))).toEqual({ address: "93.184.215.14", family: 4 });
  });

  it("blocks a host if any of its answers is private, in IPv4 or IPv6", async () => {
    await expect(resolveDestination("rebind.example.com", STRICT_POLICY, answers("93.184.215.14", "127.0.0.1"))).rejects.toBeInstanceOf(DestinationBlockedError);
    await expect(resolveDestination("v6.example.com", STRICT_POLICY, answers("2606:4700::1", "fd00::5"))).rejects.toBeInstanceOf(DestinationBlockedError);
    await expect(resolveDestination("metadata.example.com", STRICT_POLICY, answers("169.254.169.254"))).rejects.toBeInstanceOf(DestinationBlockedError);
    await expect(resolveDestination("empty.example.com", STRICT_POLICY, answers())).rejects.toBeInstanceOf(DestinationBlockedError);
  });

  it("checks IP literals without asking DNS", async () => {
    const neverCalled = () => Promise.reject(new Error("DNS should not be used"));
    await expect(resolveDestination("10.0.0.5", STRICT_POLICY, neverCalled)).rejects.toBeInstanceOf(DestinationBlockedError);
    await expect(resolveDestination("[::1]", STRICT_POLICY, neverCalled)).rejects.toBeInstanceOf(DestinationBlockedError);
  });
});
