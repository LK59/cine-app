import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { addressMatches, clientAddressOf, forgetResolvedProxies, fromLoopback, isPrivateAddress, normalizeAddress } from "@/lib/trustedProxy";

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

  it("sans relais déclaré, croit le dernier maillon d'une connexion locale ou privée seulement", () => {
    // Le relais typique, sur le même réseau Docker.
    expect(clientAddressOf(h({ "x-cine-peer": "172.20.0.9", "x-forwarded-for": "1.2.3.4" }), "")).toBe("1.2.3.4");
    expect(clientAddressOf(h({ "x-cine-peer": "::ffff:127.0.0.1", "x-forwarded-for": "6.6.6.6, 1.2.3.4" }), "")).toBe("1.2.3.4");
    expect(clientAddressOf(h({ "x-cine-peer": "fd00::5", "x-forwarded-for": "1.2.3.4" }), "")).toBe("1.2.3.4");
    // Pas d'en-tête : la connexion elle-même plutôt que rien.
    expect(clientAddressOf(h({ "x-cine-peer": "192.168.1.20" }), "")).toBe("192.168.1.20");
  });

  it("sans relais déclaré, un client joint directement garde son adresse quoi qu'il écrive", () => {
    // Le port publié sur Internet : chaque essai de connexion avec un `X-Forwarded-For` différent
    // échappait à la limite des tentatives.
    expect(clientAddressOf(h({ "x-cine-peer": "::ffff:203.0.113.7", "x-forwarded-for": "10.9.9.9" }), "")).toBe("203.0.113.7");
    expect(clientAddressOf(h({ "x-cine-peer": "2001:db8::7", "x-forwarded-for": "1.2.3.4" }), "")).toBe("2001:db8::7");
    expect(clientAddressOf(h({ "x-cine-peer": "203.0.113.7" }), "")).toBe("203.0.113.7");
  });

  it("le nom du relais pas encore résolu ne fait pas croire un client public", () => {
    expect(clientAddressOf(h({ "x-cine-peer": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }), "nom-pas-encore-resolu-2.invalid")).toBe("203.0.113.7");
  });

  it("reconnaît les adresses privées, de boucle et de lien local", () => {
    for (const ip of ["127.0.0.1", "127.8.1.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.10", "169.254.1.1", "::1", "fc00::1", "fd12:3456::9", "fe80::1", "fe80::1%eth0", "febf::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["8.8.8.8", "172.32.0.1", "172.15.255.255", "192.169.0.1", "203.0.113.7", "2001:db8::1", "fec0::1", "::", "::2", "garbage", ""]) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it("garde l'ancienne règle sans l'adresse notée au démarrage (next dev)", () => {
    delete process.env.CINE_PEER_HEADER;
    expect(clientAddressOf(h({ "x-cine-peer": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }), "")).toBe("1.2.3.4");
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
