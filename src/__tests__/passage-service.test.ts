import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SessionPayload } from "@/lib/auth";

// Sa propre base : les fichiers tournent en parallèle et plusieurs vident `sessions` avant chaque
// test — dans le dossier commun de la suite, ils effaçaient les sessions les uns des autres.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-passage-service-`);
});

/**
 * Le cœur du passage d'adresse (DECISIONS.md §119) : les secrets (hachés, usage unique, durées), la
 * session jumelle, l'appareil Jellyfin partagé, la liste blanche des réglages, l'abonnement aux
 * notifications remplacé. Les routes et le proxy sont dans `passage-routes.test.ts`.
 */

const NOW = 1_800_000_000_000;

async function lib() {
  const db = await import("@/lib/db");
  const service = await import("@/lib/passage/service");
  return { ...db, ...service };
}

beforeEach(async () => {
  const { getDb } = await import("@/lib/db");
  for (const table of ["passages", "passage_arrivals", "sessions", "push_subscriptions"]) getDb().prepare(`DELETE FROM ${table}`).run();
});

/** Une session du foyer, ouverte comme à la connexion : jeton signé et ligne en base. */
async function household(role: "admin" | "user" = "user", device: string | null = "cine-app-origine"): Promise<SessionPayload> {
  const { createSessionToken, verifySessionToken } = await import("@/lib/auth");
  const { sessionDb } = await import("@/lib/db");
  const { token, jti } = await createSessionToken("mathis", role, "mathis", "jf-mathis", "jeton-jellyfin", "seerr-cookie");
  sessionDb.create(jti, "jf-mathis", "iPhone · Safari", device);
  return (await verifySessionToken(token))!;
}

describe("la demande", () => {
  it("rend un jeton de 32 octets et un code de 8 signes, rangés hachés, à 2 et 15 minutes", async () => {
    const { createPassage, getDb } = await lib();
    const session = await household();
    const r = await createPassage(session, {}, NOW);
    if (!r.ok) throw new Error("refusé");
    expect(Buffer.from(r.token, "base64url")).toHaveLength(32);
    expect(r.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(r.tokenExpiresAt).toBe(NOW + 2 * 60_000);
    expect(r.codeExpiresAt).toBe(NOW + 15 * 60_000);
    const rows = getDb().prepare("SELECT hash, sealed, kind FROM passages").all() as { hash: string; sealed: string; kind: string }[];
    expect(rows.map((x) => x.kind).sort()).toEqual(["code", "token"]);
    // Ni le secret ni le jeton Jellyfin en clair dans la base.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain(r.token);
    expect(dump).not.toContain(r.code);
    expect(dump).not.toContain("jeton-jellyfin");
    for (const row of rows) expect(row.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("jamais pour un lien de partage", async () => {
    const { createPassage } = await lib();
    const session = await household();
    expect(await createPassage({ ...session, role: "share", sh: "x" }, {}, NOW)).toEqual({ ok: false, reason: "forbidden" });
  });

  it("jamais pour une session fermée", async () => {
    const { createPassage, sessionDb } = await lib();
    const session = await household();
    sessionDb.delete(session.jti);
    expect(await createPassage(session, {}, NOW)).toEqual({ ok: false, reason: "forbidden" });
  });

  it("une session sans appareil Jellyfin connu doit se reconnecter d'abord (son jeton ne se partage pas)", async () => {
    const { createPassage } = await lib();
    const session = await household("user", null);
    expect(await createPassage(session, {}, NOW)).toEqual({ ok: false, reason: "relogin" });
  });

  it("une nouvelle demande remplace la précédente", async () => {
    const { createPassage, redeemPassage } = await lib();
    const session = await household();
    const first = await createPassage(session, {}, NOW);
    const second = await createPassage(session, {}, NOW + 1000);
    if (!first.ok || !second.ok) throw new Error("refusé");
    expect(await redeemPassage("code", first.code, null, NOW + 2000)).toBeNull();
    expect(await redeemPassage("code", second.code, null, NOW + 2000)).not.toBeNull();
  });
});

describe("l'échange", () => {
  it("ouvre une session jumelle : même compte, même rôle, même jeton et même appareil Jellyfin, nouveau jti", async () => {
    const { createPassage, redeemPassage, sessionDb } = await lib();
    const { verifySessionToken } = await import("@/lib/auth");
    const session = await household("admin");
    const r = await createPassage(session, {}, NOW);
    if (!r.ok) throw new Error("refusé");
    const redeemed = await redeemPassage("token", r.token, "Mac · Safari", NOW + 1000);
    expect(redeemed).not.toBeNull();
    const twin = (await verifySessionToken(redeemed!.token))!;
    expect(twin).toMatchObject({ u: "mathis", role: "admin", jfUser: "mathis", jfId: "jf-mathis", jfToken: "jeton-jellyfin", jsCookie: "seerr-cookie" });
    expect(twin.jti).not.toBe(session.jti);
    expect(sessionDb.get(twin.jti)).toEqual({ userId: "jf-mathis", jfDevice: "cine-app-origine" });
    expect(sessionDb.find(twin.jti)?.device).toBe("Mac · Safari");
  });

  it("une seule fois : la seconde présentation échoue, jeton comme code", async () => {
    const { createPassage, redeemPassage } = await lib();
    const r = await createPassage(await household(), {}, NOW);
    if (!r.ok) throw new Error("refusé");
    expect(await redeemPassage("token", r.token, null, NOW + 1)).not.toBeNull();
    expect(await redeemPassage("token", r.token, null, NOW + 2)).toBeNull();
    expect(await redeemPassage("code", r.code, null, NOW + 3)).not.toBeNull();
    expect(await redeemPassage("code", r.code, null, NOW + 4)).toBeNull();
  });

  it("deux présentations simultanées : une seule réussit", async () => {
    const { createPassage, redeemPassage } = await lib();
    const r = await createPassage(await household(), {}, NOW);
    if (!r.ok) throw new Error("refusé");
    const results = await Promise.all([redeemPassage("token", r.token, null, NOW + 1), redeemPassage("token", r.token, null, NOW + 1)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("expiré : le jeton après 2 minutes, le code après 15", async () => {
    const { createPassage, redeemPassage } = await lib();
    const r = await createPassage(await household(), {}, NOW);
    if (!r.ok) throw new Error("refusé");
    expect(await redeemPassage("token", r.token, null, NOW + 2 * 60_000)).toBeNull();
    expect(await redeemPassage("code", r.code, null, NOW + 14 * 60_000)).not.toBeNull();
    const r2 = await createPassage(await household(), {}, NOW);
    if (!r2.ok) throw new Error("refusé");
    expect(await redeemPassage("code", r2.code, null, NOW + 15 * 60_000)).toBeNull();
  });

  it("inconnu, ou présenté sous l'autre forme : refusé", async () => {
    const { createPassage, redeemPassage, generatePassageCode } = await lib();
    const r = await createPassage(await household(), {}, NOW);
    if (!r.ok) throw new Error("refusé");
    expect(await redeemPassage("code", generatePassageCode(), null, NOW + 1)).toBeNull();
    // Le jeton n'est pas un code, ni l'inverse : le haché porte la sorte.
    expect(await redeemPassage("code", r.token, null, NOW + 1)).toBeNull();
    expect(await redeemPassage("token", r.code, null, NOW + 1)).toBeNull();
  });

  it("la session d'origine fermée entre-temps invalide le passage", async () => {
    const { createPassage, redeemPassage, sessionDb } = await lib();
    const session = await household();
    const r = await createPassage(session, {}, NOW);
    if (!r.ok) throw new Error("refusé");
    sessionDb.delete(session.jti);
    expect(await redeemPassage("token", r.token, null, NOW + 1)).toBeNull();
    expect(await redeemPassage("code", r.code, null, NOW + 1)).toBeNull();
  });

  it("le code se recopie comme on le lit : tiret, espaces, minuscules, O pour 0, I ou L pour 1", async () => {
    const { normalizePassageCode } = await lib();
    expect(normalizePassageCode("ab0c-1def")).toBe("AB0C1DEF");
    expect(normalizePassageCode(" abOc 1def ")).toBe("AB0C1DEF");
    expect(normalizePassageCode("abOc-Idef")).toBe("AB0C1DEF");
    expect(normalizePassageCode("abcd-efgu")).toBeNull();
    expect(normalizePassageCode("abc")).toBeNull();
    expect(normalizePassageCode(12345678)).toBeNull();
  });
});

describe("l'appareil Jellyfin partagé", () => {
  it("se déconnecter d'une adresse ne le rend pas tant que l'autre session vit ; la dernière le rend", async () => {
    const { createPassage, redeemPassage, sessionDb } = await lib();
    const session = await household();
    const r = await createPassage(session, {}, NOW);
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("token", r.token, null, Date.now());
    expect(sessionDb.delete(session.jti)).toBeNull();
    expect(sessionDb.liveJfDevices()).toContain("cine-app-origine");
    expect(sessionDb.delete(twin!.jti)).toBe("cine-app-origine");
  });

  it("une session fermée par l'administrateur (toutes celles du compte) le rend une fois", async () => {
    const { createPassage, redeemPassage, sessionDb } = await lib();
    const session = await household();
    const r = await createPassage(session, {}, NOW);
    if (!r.ok) throw new Error("refusé");
    await redeemPassage("token", r.token, null, Date.now());
    const closed = sessionDb.deleteForUser("jf-mathis");
    expect(closed).toHaveLength(2);
    expect(closed.map((c) => c.jfDevice).filter(Boolean)).toEqual(["cine-app-origine", "cine-app-origine"]);
  });
});

describe("les réglages transportés", () => {
  it("seule la liste blanche voyage, valeurs validées ; le reste est ignoré", async () => {
    const { createPassage, redeemPassage, passageArrival } = await lib();
    const r = await createPassage(
      await household(),
      {
        settings: {
          volume: JSON.stringify({ volume: 0.4, muted: false }),
          interface: "touch",
          dialogue: "strong",
          subtitleStyle: JSON.stringify({ size: 1, color: "yellow", background: "box", v: 2 }),
          // Hors liste, ou valeurs abîmées : ignorés.
          session: "cine_session=volé",
          "cine:unsent-lines": "[]",
          frameFit: "peut-être",
          hdrCap: "9999",
          quality: "original",
        },
      },
      NOW
    );
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("code", r.code, null, NOW + 1);
    expect(passageArrival(twin!.jti)?.settings).toEqual({
      volume: JSON.stringify({ volume: 0.4, muted: false }),
      interface: "touch",
      dialogue: "strong",
      subtitleStyle: JSON.stringify({ size: 1, color: "yellow", background: "box", v: 2 }),
      quality: "original",
    });
  });

  it("à l'arrivée, l'appareil ne pose que la liste blanche, la qualité sous son propre compte", async () => {
    const { writePassageSettings, readPassageSettings } = await import("@/lib/passage/settings");
    const store = new Map<string, string>();
    const storage = { setItem: (k: string, v: string) => void store.set(k, v), getItem: (k: string) => store.get(k) ?? null };
    const n = writePassageSettings(storage, { volume: JSON.stringify({ volume: 2 }), interface: "desktop", quality: "original", "cine:unsent-stop:x": "{}" }, "mathis");
    expect(n).toBe(2);
    expect([...store.keys()].sort()).toEqual(["cine:interface", "cine:quality:mathis"]);
    // Relu tel quel par l'aller.
    expect(readPassageSettings(storage, "mathis")).toEqual({ interface: "desktop", quality: "original" });
  });

  it("un paquet trop gros est refusé en entier", async () => {
    const { cleanPassageSettings } = await import("@/lib/passage/settings");
    expect(cleanPassageSettings({ interface: "touch", bourrage: "x".repeat(4000) })).toEqual({});
    expect(cleanPassageSettings("touch")).toEqual({});
  });

  it("posés dans l'application installée, ils sont effacés ; dans un onglet, ils restent pour elle", async () => {
    const { createPassage, redeemPassage, passageArrival, ackPassageArrival } = await lib();
    const r = await createPassage(await household(), { settings: { interface: "touch" } }, NOW);
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("token", r.token, null, NOW + 1);
    ackPassageArrival(twin!.jti, false);
    expect(passageArrival(twin!.jti)).not.toBeNull();
    ackPassageArrival(twin!.jti, true);
    expect(passageArrival(twin!.jti)).toBeNull();
  });
});

describe("les notifications", () => {
  const OLD = "https://web.push.apple.com/ancienne";
  const NEW = "https://web.push.apple.com/nouvelle";

  it("l'abonnement de l'ancienne adresse est retiré quand la nouvelle s'abonne — pour ce compte", async () => {
    const { createPassage, redeemPassage, replaceArrivedPushEndpoint, pushDb } = await lib();
    pushDb.upsert("mathis", OLD, "p", "a");
    const r = await createPassage(await household(), { pushEndpoint: OLD }, NOW);
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("token", r.token, null, NOW + 1);
    pushDb.upsert("mathis", NEW, "p", "a");
    expect(replaceArrivedPushEndpoint(twin!.jti, "mathis", NEW)).toBe(true);
    expect(pushDb.getByUser("mathis").map((s) => s.endpoint)).toEqual([NEW]);
  });

  it("un abonnement d'un autre compte n'est jamais emporté ni retiré", async () => {
    const { createPassage, redeemPassage, replaceArrivedPushEndpoint, pushDb } = await lib();
    pushDb.upsert("sarah", OLD, "p", "a");
    const r = await createPassage(await household(), { pushEndpoint: OLD }, NOW);
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("token", r.token, null, NOW + 1);
    expect(replaceArrivedPushEndpoint(twin!.jti, "mathis", NEW)).toBe(false);
    expect(pushDb.getByUser("sarah").map((s) => s.endpoint)).toEqual([OLD]);
  });

  it("une arrivée d'un autre compte ne retire rien pour celui-ci", async () => {
    const { createPassage, redeemPassage, replaceArrivedPushEndpoint, pushDb } = await lib();
    pushDb.upsert("mathis", OLD, "p", "a");
    const r = await createPassage(await household(), { pushEndpoint: OLD }, NOW);
    if (!r.ok) throw new Error("refusé");
    const twin = await redeemPassage("token", r.token, null, NOW + 1);
    expect(replaceArrivedPushEndpoint(twin!.jti, "sarah", NEW)).toBe(false);
    expect(pushDb.getByUser("mathis").map((s) => s.endpoint)).toEqual([OLD]);
  });
});

describe("le ménage", () => {
  it("efface les secrets expirés, par lots bornés", async () => {
    const { createPassage, prunePassages, getDb } = await lib();
    await createPassage(await household(), {}, NOW);
    prunePassages(NOW + 3 * 60_000);
    expect((getDb().prepare("SELECT kind FROM passages").all() as { kind: string }[]).map((r) => r.kind)).toEqual(["code"]);
    prunePassages(NOW + 16 * 60_000);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM passages").get()).toEqual({ n: 0 });
  });

  it("l'échange fait aussi le ménage, même refusé", async () => {
    const { createPassage, redeemPassage, getDb } = await lib();
    await createPassage(await household(), {}, NOW);
    expect(await redeemPassage("code", "ZZZZZZZZ", null, NOW + 16 * 60_000)).toBeNull();
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM passages").get()).toEqual({ n: 0 });
  });

  it("la table est créée par migrate(), de façon idempotente", async () => {
    const { getDb } = await import("@/lib/db");
    const tables = (getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'passage%'").all() as { name: string }[]).map((r) => r.name);
    expect(tables.sort()).toEqual(["passage_arrivals", "passages"]);
  });
});
