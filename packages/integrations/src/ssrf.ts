import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * Server-side request forgery defenses for webhooks (docs/05 §6, OWASP SSRF
 * cheat sheet). A destination must be HTTPS on an allowed port, without
 * credentials in the URL; its host must resolve only to public addresses.
 * The check runs when an integration is saved and again before every
 * delivery, and the connection is pinned to the address that was checked, so
 * a DNS answer that changes in between (rebinding) cannot redirect it.
 * Redirects are never followed. An egress proxy is still recommended in
 * production as a second layer.
 */
export interface DestinationPolicy {
  /** Local development and tests only: allow http:// destinations. */
  allowHttp: boolean;
  /** Local development and tests only: allow loopback and private addresses. */
  allowPrivateNetworks: boolean;
  /** Ports a destination may use. */
  allowedPorts: readonly number[];
}

export const STRICT_POLICY: DestinationPolicy = { allowHttp: false, allowPrivateNetworks: false, allowedPorts: [443, 8443] };

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8],
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8],
  ["169.254.0.0", 16], // link-local, including cloud metadata 169.254.169.254
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64, can reach IPv4 private ranges
  ["64:ff9b:1::", 48],
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments, Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4, can embed private IPv4
  ["fc00::", 7], // unique local, including fd00:ec2::254 metadata
  ["fe80::", 10], // link-local
  ["ff00::", 8], // multicast
] as const) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/** True for addresses a webhook must never reach. */
export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, "ipv4");
  if (family !== 6) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return blocked.check(mapped[1]!, "ipv4");
  // IPv4-mapped in hex form (::ffff:7f00:1) and IPv4-compatible (::a.b.c.d) are refused outright.
  if (/^::ffff:/i.test(address) || /^::\d+\.\d+\.\d+\.\d+$/.test(address)) return true;
  return blocked.check(address, "ipv6");
}

export type DestinationProblem = { code: string; message: string };

/** Checks a URL's form (not its DNS) when an integration is saved. */
export function checkWebhookUrl(raw: string, policy: DestinationPolicy = STRICT_POLICY): DestinationProblem | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { code: "INVALID_URL", message: "Enter a full URL starting with https://" };
  }
  if (url.protocol !== "https:" && !(policy.allowHttp && url.protocol === "http:")) return { code: "HTTPS_REQUIRED", message: "Webhooks must use https://" };
  if (url.username || url.password) return { code: "CREDENTIALS_IN_URL", message: "Don't put a user name or password in the URL" };
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!policy.allowPrivateNetworks && !policy.allowedPorts.includes(port)) {
    return { code: "PORT_NOT_ALLOWED", message: `Use one of these ports: ${policy.allowedPorts.join(", ")}` };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!policy.allowPrivateNetworks) {
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
      return { code: "DESTINATION_NOT_ALLOWED", message: "Webhooks can't be sent to local or internal addresses" };
    }
    if (isIP(host) && isBlockedAddress(host)) return { code: "DESTINATION_NOT_ALLOWED", message: "Webhooks can't be sent to private or reserved addresses" };
  }
  return undefined;
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export const systemResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

/** Thrown when a destination resolves to an address it may not use. */
export class DestinationBlockedError extends Error {
  constructor() {
    super("destination_blocked");
    this.name = "DestinationBlockedError";
  }
}

/**
 * Resolves a host and returns one checked address to connect to. Every
 * answer must be allowed: one private answer blocks the destination.
 */
export async function resolveDestination(hostname: string, policy: DestinationPolicy, resolve: Resolver = systemResolver): Promise<{ address: string; family: 4 | 6 }> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  if (answers.length === 0) throw new DestinationBlockedError();
  if (!policy.allowPrivateNetworks && answers.some((a) => isBlockedAddress(a.address))) throw new DestinationBlockedError();
  const first = answers[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}
