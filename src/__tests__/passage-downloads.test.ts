import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

// Sa propre base, comme `passage-routes.test.ts` : les fichiers tournent en parallèle.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-passage-downloads-`);
});

/**
 * Les téléchargements hors ligne et le passage d'adresse (DECISIONS.md §119) — côté serveur, sur la
 * vraie base et les vrais jetons : la liste emportée et revalidée, proposée une seule fois et sans
 * titre masqué, et l'attestation que l'ancienne adresse attend pour effacer ses fichiers, réservée à
 * la session d'origine du compte lui-même. Jellyfin est doublé.
 */

vi.mock("@/lib/jellyfinRevoke", () => ({ revokeJellyfinDevices: vi.fn(async () => undefined), revokeJellyfinToken: vi.fn(async () => undefined) }));
const jellyfin = vi.hoisted(() => ({ visible: new Set<string>(), down: false, calls: [] as string[] }));
vi.mock("@/lib/jellyfinBreaker", () => ({
  passJellyfinFetch: vi.fn(async (url: string) => {
    jellyfin.calls.push(url);
    if (jellyfin.down) return new Response("", { status: 503 });
    const ids = new URL(url).searchParams.get("Ids")?.split(",") ?? [];
    return Response.json({ Items: ids.filter((id) => jellyfin.visible.has(id)).map((Id) => ({ Id })) });
  }),
}));

const TARGET = "app.example.org";
const A = "a".repeat(32);
const B = "b".repeat(32);
const HIDDEN = "c".repeat(32);
const JOB = "d".repeat(32);

const entry = (itemId: string, extra: Record<string, unknown> = {}) => ({
  itemId,
  quality: "standard",
  codec: "hevc",
  audioIndex: 1,
  title: `Titre ${itemId.slice(0, 1)}`,
  expectedBytes: 300_000_000,
  bytes: 300_000_000,
  year: 2020,
  radarrId: null,
  runtimeSeconds: 1500,
  audioLabel: "Français — 5.1",
  audioTracks: [{ index: 1, label: "Français — 5.1" }],
  ...extra,
});

beforeEach(async () => {
  vi.stubEnv("NEWS_LATERNA_ADDRESS", TARGET);
  jellyfin.visible = new Set([A, B]);
  jellyfin.down = false;
  jellyfin.calls = [];
  const { getDb } = await import("@/lib/db");
  for (const table of ["passages", "passage_arrivals", "sessions", "offline_jobs", "offline_requests"]) getDb().prepare(`DELETE FROM ${table}`).run();
  const { resetPassageAttempts, passageTiming } = await import("@/lib/passage/attempts");
  resetPassageAttempts();
  passageTiming.floorMs = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

let households = 0;
async function household(role: "admin" | "user" | "share" = "user", user = `lea-${++households}`): Promise<{ cookie: string; jti: string; user: string }> {
  const { createSessionToken } = await import("@/lib/auth");
  const { sessionDb } = await import("@/lib/db");
  const { token, jti } = await createSessionToken(user, role, user, `${"0".repeat(28)}${String(households).padStart(4, "0")}`, "jeton-jellyfin");
  sessionDb.create(jti, `jf-${user}`, "Mac · Chrome", `cine-app-${user}-${jti.slice(0, 6)}`);
  return { cookie: token, jti, user };
}

function request(method: string, url: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string>; host?: string } = {}): NextRequest {
  const host = opts.host ?? "cine.example.org";
  return new NextRequest(`https://${host}${url}`, {
    method,
    headers: {
      host,
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
      ...(opts.cookie ? { cookie: `cine_session=${opts.cookie}` } : {}),
      ...opts.headers,
    },
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

/** Un passage demandé avec cette liste, échangé sur la nouvelle adresse : le cookie de la jumelle. */
async function passWith(cookie: string, downloads: unknown): Promise<{ twin: string; downloadsFlag: unknown }> {
  const { POST } = await import("@/app/api/passage/route");
  const { code } = (await (await POST(request("POST", "/api/passage", { cookie, body: { downloads } }))).json()) as { code: string };
  const redeem = await import("@/app/api/passage/redeem/route");
  const res = await redeem.POST(request("POST", "/api/passage/redeem", { host: TARGET, body: { code } }));
  const body = (await res.json()) as { downloads?: unknown };
  return { twin: res.cookies.get("cine_session")!.value, downloadsFlag: body.downloads };
}

async function arrival(cookie: string) {
  const route = await import("@/app/api/passage/arrival/route");
  return (await (await route.GET(request("GET", "/api/passage/arrival", { cookie, host: TARGET }))).json()) as { at?: number; downloads?: { itemId: string }[] };
}

describe("la liste emportée", () => {
  it("revalidée : les entrées hors format sont ignorées, les autres passent, une par titre, bornée", async () => {
    const { cleanPassageDownloads, PASSAGE_DOWNLOADS_MAX } = await import("@/lib/passage/downloads");
    const kept = cleanPassageDownloads([
      entry(A),
      entry("../../Users", {}),
      entry(B, { quality: "ultra" }),
      entry(B, { audioIndex: 1.5 }),
      entry(B, { audioIndex: "1" }),
      entry(B, { codec: "av1" }),
      entry(B, { episode: { sonarrId: 3, seriesTitle: "Série", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Deux", autoNext: true, seriesItemId: "pas-un-id" } }),
      entry(A, { title: "doublon" }),
      entry(B, { episode: { sonarrId: 3, seriesTitle: "Série", seasonNumber: 1, episodeNumber: 2, episodeTitle: "Deux", autoNext: true, audioLanguage: "fre", next: null } }),
      "n'importe quoi",
    ]);
    expect(kept.map((d) => [d.itemId, d.title])).toEqual([
      [A, "Titre a"],
      [B, "Titre b"],
    ]);
    expect(kept[1].episode).toMatchObject({ seasonNumber: 1, episodeNumber: 2, audioLanguage: "fre", next: null });
    const many = Array.from({ length: 80 }, (_, i) => entry(i.toString(16).padStart(32, "0")));
    expect(cleanPassageDownloads(many)).toHaveLength(PASSAGE_DOWNLOADS_MAX);
    expect(cleanPassageDownloads({ not: "a list" })).toEqual([]);
  });

  it("voyage avec le passage, dit à l'entrée qu'il y en a, et n'est rendue qu'à la session arrivée", async () => {
    const origin = await household();
    const { twin, downloadsFlag } = await passWith(origin.cookie, [entry(A), entry(B), entry("zz")]);
    expect(downloadsFlag).toBe(true);
    const got = await arrival(twin);
    expect(got.downloads?.map((d) => d.itemId)).toEqual([A, B]);
    // L'identité Jellyfin du compte, pas la clé seule : Jellyfin applique ses tags bloqués.
    expect(jellyfin.calls.at(-1)).toContain(`/Users/`);
    // La session d'origine n'a rien à poser.
    expect(await arrival(origin.cookie)).toEqual({});
  });

  it("sans téléchargement, l'entrée ne dit rien", async () => {
    const origin = await household();
    const { downloadsFlag } = await passWith(origin.cookie, []);
    expect(downloadsFlag).toBe(false);
  });

  it("un titre devenu indisponible — supprimé, masqué par les tags bloqués du compte — est ignoré sans bruit", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A), entry(HIDDEN)]);
    const got = await arrival(twin);
    expect(got.downloads?.map((d) => d.itemId)).toEqual([A]);
    expect(JSON.stringify(got)).not.toContain(HIDDEN);
  });

  it("Jellyfin muet : pas de liste montrée, elle reste pour le lancement suivant", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    jellyfin.down = true;
    expect(await arrival(twin)).toEqual({});
    jellyfin.down = false;
    expect((await arrival(twin)).downloads?.map((d) => d.itemId)).toEqual([A]);
  });

  it("proposée une seule fois : prise par l'appareil, le serveur l'oublie", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    expect((await arrival(twin)).downloads).toHaveLength(1);
    const route = await import("@/app/api/passage/arrival/route");
    await route.POST(request("POST", "/api/passage/arrival", { cookie: twin, host: TARGET, body: { installed: false, settings: false, downloads: true } }));
    expect(await arrival(twin)).toEqual({});
  });
});

describe("l'attestation de l'ancienne adresse", () => {
  async function fetchedFor(cookie: string, items: string[]) {
    const route = await import("@/app/api/passage/fetched/route");
    const res = await route.GET(request("GET", `/api/passage/fetched?items=${items.join(",")}`, { cookie }));
    return { status: res.status, body: (await res.json()) as { fetched?: Record<string, string>; arrived?: boolean } };
  }

  /** Une version finie de `itemId`, demandée par `account`, son fichier écrit. */
  async function readyJob(account: string, itemId: string, bytes = 1000) {
    const { getDb } = await import("@/lib/db");
    const now = Date.now();
    getDb()
      .prepare(
        "INSERT INTO offline_jobs (id, item_id, file_version, audio_index, quality, codec, status, generation, bytes, expected_bytes, runtime_s, created_at, accessed_at) VALUES (?, ?, 'v1', 1, 'standard', 'hevc', 'done', 1, ?, ?, 1500, ?, ?)"
      )
      .run(JOB, itemId, bytes, bytes, now, now);
    getDb().prepare("INSERT INTO offline_requests (account, job_id, created_at) VALUES (?, ?, ?)").run(account, JOB, now);
    const { offlineFile } = await import("@/lib/offline/jobs");
    fs.mkdirSync(path.dirname(offlineFile(JOB)), { recursive: true });
    fs.writeFileSync(offlineFile(JOB), Buffer.alloc(bytes, 7));
  }

  async function serve(cookie: string, range: string, host = TARGET) {
    const route = await import("@/app/api/offline/jobs/[jobId]/file/route");
    const res = await route.GET(request("GET", `/api/offline/jobs/${JOB}/file`, { cookie, host, headers: { range } }), { params: Promise.resolve({ jobId: JOB }) });
    await res.arrayBuffer();
    return res.status;
  }

  it("rien avant que la nouvelle adresse ait reçu la dernière plage ; puis le titre et sa version", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    await readyJob(origin.user, A);
    expect((await fetchedFor(origin.cookie, [A])).body.fetched).toEqual({});
    expect(await serve(twin, "bytes=0-499")).toBe(206);
    expect((await fetchedFor(origin.cookie, [A])).body.fetched).toEqual({});
    expect(await serve(twin, "bytes=500-999")).toBe(206);
    expect((await fetchedFor(origin.cookie, [A, B])).body.fetched).toEqual({ [A]: JOB });
  });

  it("`arrived` : seulement la session dont un passage a ouvert une session sur la nouvelle adresse", async () => {
    const origin = await household();
    expect((await fetchedFor(origin.cookie, [A])).body.arrived).toBe(false);
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    expect((await fetchedFor(origin.cookie, [A])).body.arrived).toBe(true);
    const otherDevice = await household("user", origin.user);
    expect((await fetchedFor(otherDevice.cookie, [A])).body.arrived).toBe(false);
    expect((await fetchedFor(twin, [A])).body.arrived).toBe(false);
  });

  it("la dernière plage servie à l'ancienne adresse elle-même n'atteste rien", async () => {
    const origin = await household();
    await passWith(origin.cookie, [entry(A)]);
    await readyJob(origin.user, A);
    expect(await serve(origin.cookie, "bytes=0-999", "cine.example.org")).toBe(206);
    expect((await fetchedFor(origin.cookie, [A])).body.fetched).toEqual({});
  });

  it("réservée au compte lui-même et à la session partie : un autre compte, un autre appareil du même compte n'apprennent rien", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    await readyJob(origin.user, A);
    await serve(twin, "bytes=0-999");
    expect((await fetchedFor(origin.cookie, [A])).body.fetched).toEqual({ [A]: JOB });
    const stranger = await household();
    expect((await fetchedFor(stranger.cookie, [A])).body.fetched).toEqual({});
    const otherDevice = await household("user", origin.user);
    expect((await fetchedFor(otherDevice.cookie, [A])).body.fetched).toEqual({});
    // La jumelle elle-même n'est l'origine de rien.
    expect((await fetchedFor(twin, [A])).body.fetched).toEqual({});
  });

  it("refusée sans session, à un lien de partage, et pour une liste mal formée", async () => {
    const route = await import("@/app/api/passage/fetched/route");
    expect((await route.GET(request("GET", `/api/passage/fetched?items=${A}`))).status).toBe(401);
    const share = await household("share");
    expect((await fetchedFor(share.cookie, [A])).status).toBe(401);
    const origin = await household();
    expect((await fetchedFor(origin.cookie, ["../x"])).status).toBe(400);
  });

  it("l'effacement fait sur l'ancienne adresse écrit une ligne au journal, pour les seuls titres attestés", async () => {
    const origin = await household();
    const { twin } = await passWith(origin.cookie, [entry(A)]);
    await readyJob(origin.user, A);
    await serve(twin, "bytes=0-999");
    const route = await import("@/app/api/passage/fetched/route");
    const res = await route.POST(request("POST", "/api/passage/fetched", { cookie: origin.cookie, body: { removed: [A, B] } }));
    expect(await res.json()).toEqual({ ok: true, logged: 1 });
    const { SERVER_LOG_FILE } = await import("@/lib/logger");
    const last = JSON.parse(fs.readFileSync(SERVER_LOG_FILE, "utf8").trim().split("\n").at(-1)!);
    expect(last).toMatchObject({ scope: "offline", event: "passage-freed", user: origin.user, items: [A] });
    // D'un autre site : refusée avant tout.
    const cross = await route.POST(request("POST", "/api/passage/fetched", { cookie: origin.cookie, body: { removed: [A] }, headers: { "sec-fetch-site": "cross-site" } }));
    expect(cross.status).toBe(403);
  });
});
