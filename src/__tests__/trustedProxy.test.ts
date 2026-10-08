import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { addressMatches, clientAddressOf, forgetResolvedProxies, fromLoopback, normalizeAddress } from "@/lib/trustedProxy";

/**
 * `X-Forwarded-For` n'est cru que d'un relais déclaré (§57) : un voisin du réseau Docker qui écrit
 * l'en-tête qu'il veut garde sa propre adresse, et la limite des tentatives de connexion le freine.
 */
const h = (map: Record<string, string>) => ({ get: (name: string) => map[name] ?? null });

beforeEach(() => {
  process.env.CINE_PEER_HEADER = "1";
  forgetResolvedProxies();
});
afterEach(() => {
  delete process.env.CINE_PEER_HEADER;
});

describe("l'adresse du client", () => {
  it("vient du relais déclaré : le dernier maillon qui n'est pas un relais", () => {
    expect(clientAddressOf(h({ "x-cine-peer": "::ffff:172.20.0.16", "x-forwarded-for": "6.6.6.6, 213.44.247.148" }), "172.20.0.16")).toBe("213.44.247.148");
  });

  it("ne croit pas l'en-tête d'un voisin qui n'est pas un relais", () => {
    expect(clientAddressOf(h({ "x-cine-peer": "172.20.0.9", "x-forwarded-for": "1.2.3.4" }), "172.20.0.16")).toBe("172.20.0.9");
  });

  it("accepte un réseau déclaré", () => {
    expect(addressMatches("172.20.0.16", "172.20.0.0/16")).toBe(true);
    expect(addressMatches("172.21.0.16", "172.20.0.0/16")).toBe(false);
  });

  it("garde l'ancienne règle sans relais déclaré, ou sans l'adresse notée au démarrage", () => {
    expect(clientAddressOf(h({ "x-cine-peer": "172.20.0.9", "x-forwarded-for": "1.2.3.4" }), "")).toBe("1.2.3.4");
    delete process.env.CINE_PEER_HEADER;
    // Sous `next dev`, `x-cine-peer` pourrait venir du client : il est ignoré.
    expect(clientAddressOf(h({ "x-cine-peer": "172.20.0.16", "x-forwarded-for": "1.2.3.4" }), "172.20.0.16")).toBe("1.2.3.4");
    expect(fromLoopback(h({ "x-cine-peer": "127.0.0.1" }))).toBeNull();
  });

  it("reconnaît la boucle locale du préchauffage", () => {
    expect(fromLoopback(h({ "x-cine-peer": "::ffff:127.0.0.1" }))).toBe(true);
    expect(fromLoopback(h({ "x-cine-peer": "172.20.0.16" }))).toBe(false);
    expect(normalizeAddress("::ffff:10.0.0.1")).toBe("10.0.0.1");
  });
});

describe("un relais déclaré par son nom", () => {
  it("garde l'ancienne règle tant que le nom n'est pas résolu", () => {
    expect(clientAddressOf(h({ "x-cine-peer": "172.20.0.16", "x-forwarded-for": "213.44.247.148" }), "nom-pas-encore-resolu.invalid")).toBe("213.44.247.148");
  });
});
