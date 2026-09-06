import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({
  config: { app: { sessionSecret: "un-secret-de-test", adminUser: "admin", adminPassword: "x", cookieSecure: false, language: "fr" } },
}));

import { createSessionToken, verifySessionToken, refreshSessionToken, shouldRefresh, SESSION_REFRESH_AFTER_MS } from "@/lib/auth";
import { timingSafeEquals } from "@/lib/timingSafeEquals";

/** La signature telle que le module la produit : HMAC-SHA256 du base64url de la charge utile. */
async function signLikeTheOldVersion(payload: Record<string, unknown>): Promise<string> {
  const encoded = btoa(JSON.stringify(payload)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode("un-secret-de-test"),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
  let raw = "";
  for (const b of sig) raw += String.fromCharCode(b);
  return `${encoded}.${btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function payloadOf(token: string): Record<string, unknown> {
  const encoded = token.slice(0, token.indexOf("."));
  const json = atob(encoded.replace(/-/g, "+").replace(/_/g, "/"));
  return JSON.parse(json);
}

describe("les secrets portés par le jeton", () => {
  // Le cœur de la correction : signer n'est pas cacher. La charge utile est du base64, et le
  // jeton Jellyfin s'y lisait en clair — un cookie volé valait un accès à Jellyfin, pas seulement
  // une session Cine App.
  it("never writes the Jellyfin token or the Jellyseerr cookie in the clear", async () => {
    const { token } = await createSessionToken("louis", "user", "louis", "jf-id", "SECRET-JF", "SECRET-JS");
    const raw = payloadOf(token);
    expect(raw.jfToken).not.toBe("SECRET-JF");
    expect(raw.jsCookie).not.toBe("SECRET-JS");
    expect(JSON.stringify(raw)).not.toContain("SECRET-JF");
    expect(JSON.stringify(raw)).not.toContain("SECRET-JS");
    // Et ce qui n'est pas secret reste lisible : l'identité sert au serveur à chaque requête.
    expect(raw.u).toBe("louis");
    expect(raw.jfId).toBe("jf-id");
  });

  it("gives them back intact on the way out", async () => {
    const { token } = await createSessionToken("louis", "user", "louis", "jf-id", "SECRET-JF", "SECRET-JS");
    const session = await verifySessionToken(token);
    expect(session?.jfToken).toBe("SECRET-JF");
    expect(session?.jsCookie).toBe("SECRET-JS");
  });

  // Deux chiffrements du même secret ne doivent pas se ressembler : sans vecteur d'initialisation
  // distinct, deux sessions du même compte porteraient le même texte chiffré.
  it("does not produce the same ciphertext twice", async () => {
    const a = await createSessionToken("louis", "user", "louis", "id", "SECRET-JF");
    const b = await createSessionToken("louis", "user", "louis", "id", "SECRET-JF");
    expect(payloadOf(a.token).jfToken).not.toEqual(payloadOf(b.token).jfToken);
  });

  // Les jetons émis avant ce changement portent ces champs en clair : les refuser aurait
  // déconnecté tout le monde d'un coup. Le jeton d'époque est reconstruit ici, signé avec le même
  // secret — c'est la seule façon de vérifier pour de vrai qu'il passe encore.
  it("still reads a token written before the fields were encrypted", async () => {
    const { token } = await createSessionToken("louis", "user");
    const legacy = { ...payloadOf(token), jfToken: "ANCIEN-EN-CLAIR", jsCookie: "ANCIEN-JS" };
    const session = await verifySessionToken(await signLikeTheOldVersion(legacy));
    expect(session?.jfToken).toBe("ANCIEN-EN-CLAIR");
    expect(session?.jsCookie).toBe("ANCIEN-JS");
  });

  // Un champ chiffré qu'on ne sait pas déchiffrer — secret changé, texte tronqué — ne doit pas
  // faire tomber la session : on perd l'accès à Jellyseerr, pas la connexion.
  it("survives a field it cannot decrypt", async () => {
    const { token } = await createSessionToken("louis", "user");
    const broken = { ...payloadOf(token), jfToken: "v1:abc.def" };
    const session = await verifySessionToken(await signLikeTheOldVersion(broken));
    expect(session).not.toBeNull();
    expect(session?.jfToken).toBeUndefined();
  });
});

describe("la session glissante", () => {
  it("does not reissue a token that was just handed out", async () => {
    const { token } = await createSessionToken("louis", "user");
    const session = await verifySessionToken(token);
    expect(shouldRefresh(session!)).toBe(false);
  });

  it("reissues one that has aged past a day", async () => {
    const { token } = await createSessionToken("louis", "user");
    const session = await verifySessionToken(token);
    const aged = { ...session!, exp: session!.exp - SESSION_REFRESH_AFTER_MS - 1000 };
    expect(shouldRefresh(aged)).toBe(true);
  });

  // Le point qui compte : prolonger, c'est la *même* session. Un nouvel identifiant à chaque jour
  // d'usage ferait apparaître une session de plus dans la liste à chaque fois.
  it("keeps the same session id, and its secrets, across a refresh", async () => {
    const { token, jti } = await createSessionToken("louis", "user", "louis", "jf-id", "SECRET-JF");
    const session = await verifySessionToken(token);
    const renewed = await verifySessionToken(await refreshSessionToken(session!));
    expect(renewed?.jti).toBe(jti);
    expect(renewed?.jfToken).toBe("SECRET-JF");
    expect(renewed!.exp).toBeGreaterThanOrEqual(session!.exp);
  });
});

describe("timingSafeEquals", () => {
  it("agrees with equality on what is equal", () => {
    expect(timingSafeEquals("motdepasse", "motdepasse")).toBe(true);
    expect(timingSafeEquals("", "")).toBe(true);
  });

  it("rejects what differs, at any position", () => {
    expect(timingSafeEquals("motdepasse", "Motdepasse")).toBe(false);
    expect(timingSafeEquals("motdepasse", "motdepassf")).toBe(false);
    expect(timingSafeEquals("motdepasse", "motdepass")).toBe(false);
  });

  it("handles non-ASCII without counting characters instead of bytes", () => {
    expect(timingSafeEquals("mot-de-passé", "mot-de-passé")).toBe(true);
    expect(timingSafeEquals("mot-de-passé", "mot-de-passe")).toBe(false);
  });
});
