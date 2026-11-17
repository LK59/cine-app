import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/config", () => ({ config: { app: { sessionSecret: "un-secret-de-test" } } }));
vi.mock("@/lib/db", () => ({ sessionDb: { exists: (jti: string) => jti !== "morte" } }));

import { signLumenTvPass, verifyLumenTvPass, lumenTvAddressOf, lumenTvPassFor, withLumenTvPass, LUMEN_TV_LIFETIME_MS, __testing } from "@/lib/lumenServer/tvPass";
import { signCastToken, verifyCastPass, castPassFor } from "@/lib/castToken";

// Le laissez-passer d'une Apple TV pour Lumen serveur (DECISIONS.md §186) : la seule chose qui ouvre ces adresses
// sans session. Ce qui compte ici n'est pas qu'il marche — c'est tout ce qu'il refuse.

const ITEM = "ac7396d6fe1d5beb0c8608982c04a974";
const AUTRE = "a2aa7c752cbb8120a6af1149d3e3dd91";
const ADMIN = { u: "louis", role: "admin", jti: "vivante", jfId: "f".repeat(32) };
const req = (pathname: string, method = "GET") => ({ method, nextUrl: { pathname } });

describe("le laissez-passer Lumen", () => {
  it("ouvre cette lecture de ce titre, et rend le compte et son identifiant Jellyfin", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    expect(await verifyLumenTvPass(token, ITEM, "lect1")).toEqual({ user: "louis", role: "admin", jti: "vivante", jfId: ADMIN.jfId });
  });

  it("un autre titre, une autre lecture : rien", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    expect(await verifyLumenTvPass(token, AUTRE, "lect1")).toBeNull();
    expect(await verifyLumenTvPass(token, ITEM, "lect2")).toBeNull();
  });

  it("expire au bout de six heures", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN, 0))!;
    expect(await verifyLumenTvPass(token, ITEM, "lect1", LUMEN_TV_LIFETIME_MS - 1)).not.toBeNull();
    expect(await verifyLumenTvPass(token, ITEM, "lect1", LUMEN_TV_LIFETIME_MS + 1)).toBeNull();
  });

  it("meurt avec la session qui l'a demandé", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", { ...ADMIN, jti: "morte" }))!;
    expect(await verifyLumenTvPass(token, ITEM, "lect1")).toBeNull();
  });

  it("n'est donné qu'à un administrateur muni d'une session ; un lien de partage n'en reçoit pas", async () => {
    expect(await signLumenTvPass(ITEM, "lect1", { ...ADMIN, role: "share" })).toBeNull();
    expect(await signLumenTvPass(ITEM, "lect1", { ...ADMIN, role: "user" })).toBeNull();
    expect(await signLumenTvPass(ITEM, "lect1", { ...ADMIN, jti: null })).toBeNull();
  });

  it("forgé avec la vraie clé mais sans la portée, avec une autre portée ou un autre rôle : rien", async () => {
    const base = { i: ITEM, s: "lect1", u: "louis", r: "admin", t: "vivante", e: Date.now() + 60_000 };
    expect(await verifyLumenTvPass(await __testing.signClaims({ ...base, k: "lumen" }), ITEM, "lect1")).not.toBeNull();
    expect(await verifyLumenTvPass(await __testing.signClaims(base), ITEM, "lect1")).toBeNull();
    expect(await verifyLumenTvPass(await __testing.signClaims({ ...base, k: "stream" }), ITEM, "lect1")).toBeNull();
    expect(await verifyLumenTvPass(await __testing.signClaims({ ...base, k: "lumen", r: "share" }), ITEM, "lect1")).toBeNull();
    expect(await verifyLumenTvPass(await __testing.signClaims({ ...base, k: "lumen", t: undefined }), ITEM, "lect1")).toBeNull();
  });

  it("un `castToken` n'ouvre pas Lumen serveur, et un laissez-passer Lumen n'ouvre pas le flux Jellyfin", async () => {
    const cast = await signCastToken(ITEM, "louis", Date.now(), "vivante", ADMIN.jfId);
    expect(await verifyLumenTvPass(cast, ITEM, "lect1")).toBeNull();
    const lumen = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    expect(await verifyCastPass(lumen, ITEM, Date.now(), () => true)).toBeNull();
    expect(await castPassFor({ method: "GET", nextUrl: { pathname: `/api/jellyfin/stream/${ITEM}/main.m3u8`, searchParams: new URLSearchParams({ castToken: lumen }) } })).toBeNull();
  });

  it("refuse une signature ou une charge modifiée, et ce qui n'est pas un jeton, sans lever", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    const [payload, signature] = token.split(".");
    const altered = signature.slice(0, 5) + (signature[5] === "A" ? "B" : "A") + signature.slice(6);
    expect(await verifyLumenTvPass(`${payload}.${altered}`, ITEM, "lect1")).toBeNull();
    const forged = Buffer.from(JSON.stringify({ k: "lumen", i: AUTRE, s: "lect1", u: "louis", r: "admin", t: "vivante", e: Date.now() + 60_000 })).toString("base64url");
    expect(await verifyLumenTvPass(`${forged}.${signature}`, AUTRE, "lect1")).toBeNull();
    for (const bad of ["", "x", "a.b", "a.b.c", "...", null, undefined, "a".repeat(5000)]) expect(await verifyLumenTvPass(bad, ITEM, "lect1")).toBeNull();
  });
});

describe("l'adresse", () => {
  it("le jeton dans le chemin, juste avant le nom ; les URI relatives des listes en héritent", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    const master = withLumenTvPass(`/api/lumen/${ITEM}/5-0123456789ab/lect1/master.m3u8?audio=2`, token);
    expect(master).toBe(`/api/lumen/${ITEM}/5-0123456789ab/lect1/tv.${token}/master.m3u8?audio=2`);
    // Une URI relative de la liste (`v/12.m4s`) se résout sous le même dossier : le jeton suit.
    const segment = new URL("v/12.m4s", `https://cine.example${master}`).pathname;
    expect(lumenTvAddressOf(segment)).toEqual({ itemId: ITEM, version: "5-0123456789ab", s: "lect1", token, rest: ["v", "12.m4s"] });
    expect(await lumenTvPassFor(req(segment))).not.toBeNull();
  });

  it("GET seulement, la forme exacte, aucun autre chemin sous /api/lumen", async () => {
    const token = (await signLumenTvPass(ITEM, "lect1", ADMIN))!;
    const segment = `/api/lumen/${ITEM}/5-0123456789ab/lect1/tv.${token}/v/12.m4s`;
    expect(await lumenTvPassFor(req(segment, "POST"))).toBeNull();
    expect(await lumenTvPassFor(req(segment, "OPTIONS"))).toBeNull();
    for (const path of [
      `/api/lumen/${ITEM}/eligibility/tv.${token}/x`,
      `/api/lumen/${ITEM}/prepare`,
      `/api/lumen/${ITEM}/tv.${token}/master.m3u8`,
      `/api/lumen/${ITEM}/5-0123456789ab/lect1/tv.${token}/`,
      `/api/lumen/${ITEM}/5-0123456789ab/lect1/tv.${token}/../../eligibility`,
      `/api/lumen/not-an-id/5-0123456789ab/lect1/tv.${token}/v/12.m4s`,
      `/api/jellyfin/stream/${ITEM}/tv.${token}/main.m3u8`,
    ]) {
      expect(await lumenTvPassFor(req(path)), path).toBeNull();
    }
  });
});
