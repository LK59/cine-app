import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Les routes du passage d'adresse (DECISIONS.md §119) — demande, entrée, réglages d'arrivée — sur la
 * vraie base et les vrais jetons de session. Jellyfin n'est jamais appelé : la révocation est doublée.
 */

const revoked = vi.hoisted(() => [] as unknown[]);
vi.mock("@/lib/jellyfinRevoke", () => ({
  revokeJellyfinDevices: vi.fn(async (devices: unknown) => void revoked.push(devices)),
  revokeJellyfinToken: vi.fn(async (token: unknown) => void revoked.push(token)),
}));

const TARGET = "app.example.org";

beforeEach(async () => {
  vi.stubEnv("NEWS_LATERNA_ADDRESS", TARGET);
  revoked.length = 0;
  const { getDb } = await import("@/lib/db");
  for (const table of ["passages", "passage_arrivals", "sessions", "push_subscriptions"]) getDb().prepare(`DELETE FROM ${table}`).run();
  const { resetPassageAttempts, passageTiming } = await import("@/lib/passage/attempts");
  resetPassageAttempts();
  passageTiming.floorMs = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let households = 0;
/** Un compte neuf à chaque appel : la limite de dix demandes par heure vit dans le module de la route. */
async function household(role: "admin" | "user" = "user"): Promise<{ cookie: string; jti: string; user: string }> {
  const user = `mathis-${++households}`;
  const { createSessionToken } = await import("@/lib/auth");
  const { sessionDb } = await import("@/lib/db");
  const { token, jti } = await createSessionToken(user, role, user, `jf-${user}`, "jeton-jellyfin");
  sessionDb.create(jti, `jf-${user}`, "iPhone · Safari", `cine-app-${user}`);
  return { cookie: token, jti, user };
}

function request(method: string, path: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; host?: string } = {}): NextRequest {
  const host = opts.host ?? "cine.example.org";
  return new NextRequest(`https://${host}${path}`, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ...(opts.cookie ? { cookie: `cine_session=${opts.cookie}` } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

async function create(cookie: string, body: unknown = {}) {
  const { POST } = await import("@/app/api/passage/route");
  return POST(request("POST", "/api/passage", { cookie, body, headers: { "sec-fetch-site": "same-origin" } }));
}

async function redeem(body: unknown, opts: { cookie?: string; headers?: Record<string, string> } = {}) {
  const { POST } = await import("@/app/api/passage/redeem/route");
  return POST(request("POST", "/api/passage/redeem", { host: TARGET, body, cookie: opts.cookie, headers: { "sec-fetch-site": "same-origin", ...opts.headers } }));
}

describe("GET /api/passage", () => {
  it("dit la destination du réglage, ou rien", async () => {
    const { GET } = await import("@/app/api/passage/route");
    const { cookie } = await household();
    expect(await (await GET(request("GET", "/api/passage", { cookie }))).json()).toEqual({ target: `https://${TARGET}` });
    vi.stubEnv("NEWS_LATERNA_ADDRESS", "");
    expect(await (await GET(request("GET", "/api/passage", { cookie }))).json()).toEqual({ target: null });
  });
});

describe("POST /api/passage — la demande", () => {
  it("un compte du foyer reçoit l'adresse du réglage, le jeton dans le fragment, et le code", async () => {
    for (const role of ["user", "admin"] as const) {
      const { cookie } = await household(role);
      const res = await create(cookie);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { url: string; code: string };
      expect(data.url).toMatch(new RegExp(`^https://${TARGET.replace(/\./g, "\\.")}/passage#t=[A-Za-z0-9_-]{43}$`));
      expect(data.code).toMatch(/^[0-9A-Z]{8}$/);
    }
  });

  it("l'adresse ne vient jamais du client", async () => {
    const { cookie } = await household();
    const res = await create(cookie, { url: "https://evil.example/", target: "https://evil.example" });
    expect(((await res.json()) as { url: string }).url.startsWith(`https://${TARGET}/passage#t=`)).toBe(true);
  });

  it("refusée sans session, à un lien de partage, d'un autre site, et sans nouvelle adresse", async () => {
    const { POST } = await import("@/app/api/passage/route");
    expect((await POST(request("POST", "/api/passage", { body: {} }))).status).toBe(401);
    // Un lien de partage : jeton `share` valide, ligne en base.
    const { createShareSessionToken } = await import("@/lib/auth");
    const { sessionDb } = await import("@/lib/db");
    const share = await createShareSessionToken("0123456789abcdef", "partage-1", "f".repeat(32), "jt", Date.now() + 86_400_000);
    sessionDb.create(share.jti, "f".repeat(32), null, "cine-app-partage");
    expect((await POST(request("POST", "/api/passage", { cookie: share.token, body: {} }))).status).toBe(401);
    const { cookie } = await household();
    expect((await POST(request("POST", "/api/passage", { cookie, body: {}, headers: { "sec-fetch-site": "same-site", origin: "https://autre.example.org" } }))).status).toBe(403);
    vi.stubEnv("NEWS_LATERNA_ADDRESS", "");
    expect((await create(cookie)).status).toBe(404);
  });

  it("dix demandes par heure et par compte", async () => {
    const { cookie } = await household();
    // Le compteur vit dans le module de la route : un autre compte pour ne pas hériter des autres tests.
    const { createSessionToken } = await import("@/lib/auth");
    const { sessionDb } = await import("@/lib/db");
    const own = await createSessionToken("limite", "user", "limite", "jf-limite", "jt");
    sessionDb.create(own.jti, "jf-limite", null, "cine-app-limite");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await create(own.token)).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await create(cookie)).status).toBe(200);
  });

  it("une ligne « passage demandé » au journal des connexions", async () => {
    const { cookie, user } = await household();
    await create(cookie);
    const fs = await import("node:fs");
    const { AUTH_LOG } = await import("@/lib/eventLogs");
    const last = JSON.parse(fs.readFileSync(AUTH_LOG(), "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ kind: "passage-requested", user, device: "Mac · Safari", to: TARGET });
  });
});

describe("POST /api/passage/redeem — l'entrée", () => {
  it("ouvre une session comme une connexion : mêmes cookies, mêmes attributs", async () => {
    const { cookie, user } = await household();
    const { url } = (await (await create(cookie)).json()) as { url: string };
    const res = await redeem({ token: url.split("#t=")[1] });
    expect(res.status).toBe(200);
    const { SESSION_MAX_AGE } = await import("@/lib/auth");
    const session = res.cookies.get("cine_session")!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });
    expect(res.cookies.get("cine-lang")).toMatchObject({ sameSite: "lax", path: "/", maxAge: SESSION_MAX_AGE });

    // Et ce que la connexion elle-même pose, comparé attribut par attribut.
    const { NextResponse } = await import("next/server");
    const { setSignedInCookies } = await import("@/lib/sessionCookies");
    const login = NextResponse.json({});
    setSignedInCookies(login, "x", "fr");
    const strip = (c: Record<string, unknown> | undefined) => ({ ...c, value: undefined, expires: undefined });
    expect(strip(session as never)).toEqual(strip(login.cookies.get("cine_session") as never));
    expect(strip(res.cookies.get("cine-lang") as never)).toEqual(strip(login.cookies.get("cine-lang") as never));

    const { verifySessionFull } = await import("@/lib/session");
    expect(await verifySessionFull(session.value)).toMatchObject({ u: user, role: "user", jfToken: "jeton-jellyfin" });
  });

  it("le même code d'échec pour un secret réutilisé, inconnu, mal formé, expiré ou dont la session est fermée", async () => {
    const { sessionDb } = await import("@/lib/db");
    const bodies: unknown[] = [];
    const { cookie, jti } = await household();
    const first = (await (await create(cookie)).json()) as { url: string; code: string };
    const token = first.url.split("#t=")[1];
    expect((await redeem({ token })).status).toBe(200);
    const answers = [await redeem({ token }), await redeem({ token: "A".repeat(43) }), await redeem({ token: "court" })];
    // Session d'origine fermée : le code, encore valable, est refusé.
    sessionDb.delete(jti);
    answers.push(await redeem({ code: first.code }));
    for (const res of answers) {
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toEqual({ error: "Ce passage n'est plus valable", code: "passage-refused" });
  });

  it("expiré : refusé de la même façon", async () => {
    const { cookie } = await household();
    const { url } = (await (await create(cookie)).json()) as { url: string };
    vi.useFakeTimers({ now: Date.now() + 3 * 60_000, toFake: ["Date"] });
    try {
      const res = await redeem({ token: url.split("#t=")[1] });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Ce passage n'est plus valable", code: "passage-refused" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("une écriture d'un autre site est refusée avant tout", async () => {
    const { cookie } = await household();
    const { url } = (await (await create(cookie)).json()) as { url: string };
    const token = url.split("#t=")[1];
    expect((await redeem({ token }, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    // Et le jeton n'a pas été consommé.
    expect((await redeem({ token })).status).toBe(200);
  });

  it("cinq codes faux, puis le sixième essai est bloqué — même un bon", async () => {
    const { cookie } = await household();
    const { code } = (await (await create(cookie)).json()) as { code: string };
    for (let i = 0; i < 5; i++) expect((await redeem({ code: "ZZZZ-ZZZZ" })).status).toBe(401);
    const blocked = await redeem({ code });
    expect(blocked.status).toBe(429);
    expect(((await blocked.json()) as { code: string }).code).toBe("rate_limited");
  });

  // Trouvé à l'essai de bout en bout : le champ `kind: "code"` remplaçait l'événement dans auth.log.
  it("« passage reçu » et « passage refusé » au journal des connexions, sous leur nom", async () => {
    const { cookie, user } = await household();
    const { code } = (await (await create(cookie)).json()) as { code: string };
    await redeem({ code });
    await redeem({ code });
    const fs = await import("node:fs");
    const { AUTH_LOG } = await import("@/lib/eventLogs");
    const lines = fs.readFileSync(AUTH_LOG(), "utf8").trim().split("\n").slice(-2).map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: "passage-received", user, via: "code" });
    expect(lines[1]).toMatchObject({ kind: "passage-refused", via: "code" });
  });

  it("un refus prend au moins le délai plancher", async () => {
    const { passageTiming } = await import("@/lib/passage/attempts");
    passageTiming.floorMs = 120;
    const started = Date.now();
    expect((await redeem({ code: "ZZZZ-ZZZZ" })).status).toBe(401);
    expect(Date.now() - started).toBeGreaterThanOrEqual(115);
  });

  it("la session que ce navigateur avait sur la nouvelle adresse est fermée, pas seulement recouverte", async () => {
    const { cookie } = await household();
    const { url } = (await (await create(cookie)).json()) as { url: string };
    const { createSessionToken } = await import("@/lib/auth");
    const { sessionDb } = await import("@/lib/db");
    const other = await createSessionToken("sarah", "user", "sarah", "jf-sarah", "jt-sarah");
    sessionDb.create(other.jti, "jf-sarah", null, "cine-app-sarah");
    expect((await redeem({ token: url.split("#t=")[1], replace: true }, { cookie: other.token })).status).toBe(200);
    expect(sessionDb.exists(other.jti)).toBe(false);
    expect(revoked).toContainEqual(["cine-app-sarah"]);
  });

  // Relecture de sécurité du 23/10/2026 : un lien `/passage#t=<jeton d'un autre compte>` connectait un
  // navigateur déjà connecté au compte du lien, en fermant sa session, sans rien lui demander.
  it("déjà connecté : sans accord (`replace`), 409 — rien d'échangé, rien de fermé, le jeton intact", async () => {
    const { cookie } = await household();
    const { url, code } = (await (await create(cookie)).json()) as { url: string; code: string };
    const token = url.split("#t=")[1];
    const { createSessionToken } = await import("@/lib/auth");
    const { sessionDb } = await import("@/lib/db");
    const victim = await createSessionToken("sarah", "user", "sarah", "jf-sarah", "jt-sarah");
    sessionDb.create(victim.jti, "jf-sarah", null, "cine-app-sarah");
    for (const body of [{ token }, { code }, { token, replace: "oui" }]) {
      const res = await redeem(body, { cookie: victim.token });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("passage-confirm");
      expect(res.cookies.get("cine_session")).toBeUndefined();
    }
    expect(sessionDb.exists(victim.jti)).toBe(true);
    expect(revoked.flat()).toEqual([]);
    // Ni consommé ni compté comme un échec : le même jeton passe encore, avec l'accord.
    expect((await redeem({ token, replace: true }, { cookie: victim.token })).status).toBe(200);
    expect(sessionDb.exists(victim.jti)).toBe(false);
  });

  it("un cookie de session déjà fermée ne demande pas d'accord", async () => {
    const { cookie } = await household();
    const { url } = (await (await create(cookie)).json()) as { url: string };
    const { createSessionToken } = await import("@/lib/auth");
    const gone = await createSessionToken("sarah", "user", "sarah", "jf-sarah", "jt-sarah");
    expect((await redeem({ token: url.split("#t=")[1] }, { cookie: gone.token })).status).toBe(200);
  });
});

describe("/api/passage/arrival", () => {
  it("rend les réglages de la session arrivée, rien aux autres ; posés dans l'app installée, effacés", async () => {
    const { cookie } = await household();
    const { code } = (await (await create(cookie, { settings: { interface: "touch", inconnu: "x" } })).json()) as { code: string };
    const arrived = await redeem({ code });
    const twin = arrived.cookies.get("cine_session")!.value;
    const route = await import("@/app/api/passage/arrival/route");
    const got = (await (await route.GET(request("GET", "/api/passage/arrival", { cookie: twin, host: TARGET }))).json()) as { settings?: unknown };
    expect(got.settings).toEqual({ interface: "touch" });
    expect(await (await route.GET(request("GET", "/api/passage/arrival", { cookie }))).json()).toEqual({});
    await route.POST(request("POST", "/api/passage/arrival", { cookie: twin, host: TARGET, body: { installed: true } }));
    expect(await (await route.GET(request("GET", "/api/passage/arrival", { cookie: twin, host: TARGET }))).json()).toEqual({});
  });
});

describe("POST /api/push/subscribe après un passage", () => {
  it("retire l'abonnement de l'ancienne adresse du même compte, et garde le nouveau", async () => {
    const { pushDb } = await import("@/lib/db");
    const OLD = "https://web.push.apple.com/ancienne";
    const NEW = "https://web.push.apple.com/nouvelle";
    const { cookie, user } = await household();
    pushDb.upsert(user, OLD, "p".repeat(20), "a".repeat(10));
    const { code } = (await (await create(cookie, { pushEndpoint: OLD })).json()) as { code: string };
    const twin = (await redeem({ code })).cookies.get("cine_session")!.value;
    const { POST } = await import("@/app/api/push/subscribe/route");
    const res = await POST(request("POST", "/api/push/subscribe", { cookie: twin, host: TARGET, body: { endpoint: NEW, keys: { p256dh: "p".repeat(20), auth: "a".repeat(10) } } }));
    expect(res.status).toBe(200);
    expect(pushDb.getByUser(user).map((s) => s.endpoint)).toEqual([NEW]);
  });
});

describe("POST /api/auth/logout et la session jumelle", () => {
  // Relecture de sécurité du 23/10/2026 : la ligne d'origine déjà fermée (« Déconnecter les autres
  // appareils », l'administrateur), la déconnexion de l'origine révoquait le jeton par repli — celui
  // que la jumelle partage — et la coupait de Jellyfin.
  it("ligne d'origine déjà fermée : la jumelle reste valide, ni jeton ni appareil révoqué", async () => {
    const { cookie, jti } = await household();
    const { code } = (await (await create(cookie)).json()) as { code: string };
    const twin = (await redeem({ code })).cookies.get("cine_session")!.value;
    const { sessionDb } = await import("@/lib/db");
    sessionDb.delete(jti);
    const { POST } = await import("@/app/api/auth/logout/route");
    expect((await POST(request("POST", "/api/auth/logout", { cookie }))).status).toBe(200);
    const { verifySessionFull } = await import("@/lib/session");
    expect(await verifySessionFull(twin)).toMatchObject({ jfToken: "jeton-jellyfin" });
    // (L'ouverture de la jumelle passe une liste vide d'appareils expirés : aplatie.)
    expect(revoked.flat()).toEqual([]);
  });
});
