import { describe, it, expect, vi, beforeEach } from "vitest";

const incoming = new Headers();
vi.mock("next/headers", () => ({ headers: vi.fn(async () => incoming) }));

import { lastForwardedAddress, forwardedFor } from "@/lib/clientAddress";
import { headers } from "next/headers";

beforeEach(() => incoming.delete("x-forwarded-for"));

describe("lastForwardedAddress", () => {
  // La première entrée est celle que le client écrit lui-même ; la dernière, celle du relais.
  it("takes what the proxy saw, not what the client claimed", () => {
    expect(lastForwardedAddress("6.6.6.6, 203.0.113.7")).toBe("203.0.113.7");
    expect(lastForwardedAddress("2001:db8::1")).toBe("2001:db8::1");
  });

  // Elle repart vers Jellyfin dans un en-tête : rien qui ne soit une adresse.
  it("refuses anything that is not an address", () => {
    expect(lastForwardedAddress(null)).toBeNull();
    expect(lastForwardedAddress("1.2.3.4, evil\r\nX-Other: 1")).toBeNull();
    expect(lastForwardedAddress("unknown")).toBeNull();
  });
});

// Jellyfin inscrivait chaque connexion depuis 172.20.0.13, l'adresse du conteneur (23/09/2026).
describe("forwardedFor", () => {
  it("hands Jellyfin the viewer's address", async () => {
    incoming.set("x-forwarded-for", "10.0.0.1, 203.0.113.7");
    expect(await forwardedFor()).toEqual({ "X-Forwarded-For": "203.0.113.7" });
  });

  it("says nothing outside a request", async () => {
    vi.mocked(headers).mockRejectedValueOnce(new Error("outside a request scope"));
    expect(await forwardedFor()).toEqual({});
  });
});
