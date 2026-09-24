import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Une base et un dossier de données à ce fichier seul.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-reports-`);
});

const push = { admins: vi.fn(async () => {}), user: vi.fn(async () => {}) };
vi.mock("@/lib/push", () => ({
  sendPushToAdmins: (...a: unknown[]) => push.admins(...(a as [])),
  sendPushToUser: (...a: unknown[]) => push.user(...(a as [])),
}));

/** Trois personnes : deux spectateurs et l'administrateur, reconnus par la valeur de leur cookie. */
const SESSIONS: Record<string, unknown> = {
  lucas: { u: "lucas", jfUser: "lucas", jfId: "id-lucas", role: "user", jti: "j1" },
  sarah: { u: "sarah", jfUser: "sarah", jfId: "id-sarah", role: "user", jti: "j2" },
  louis: { u: "louis", jfUser: "louis", jfId: "id-louis", role: "admin", jti: "j3" },
};
vi.mock("@/lib/session", () => ({ verifySessionFull: async (token: string) => SESSIONS[token] ?? null }));

function req(who: string, init: { form?: FormData; json?: unknown; url?: string } = {}): NextRequest {
  return {
    cookies: { get: () => ({ value: who }) },
    headers: new Headers({ "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1" }),
    nextUrl: new URL(init.url ?? "https://cine.example/api/reports"),
    formData: async () => init.form ?? new FormData(),
    json: async () => init.json ?? null,
  } as unknown as NextRequest;
}
const params = (id: number | string) => ({ params: Promise.resolve({ id: String(id) }) });
const imageParams = (id: number | string, imageId: number) => ({ params: Promise.resolve({ id: String(id), imageId: String(imageId) }) });

function reportForm(report: Record<string, unknown>, opts: { draft?: boolean; images?: File[] } = {}): FormData {
  const form = new FormData();
  form.set("report", JSON.stringify(report));
  form.set("context", JSON.stringify({ lang: "fr", url: "/#compte=1" }));
  if (opts.draft) form.set("draft", "1");
  for (const image of opts.images ?? []) form.append("images", image);
  return form;
}

const AUDIO = { zone: "player", element: "playerAudio", issue: "none", itemId: "abc", itemTitle: "Red Dragon", itemKind: "movie", description: "Plus de son après 20 minutes." };

async function create(who: string, report: Record<string, unknown>, opts: { draft?: boolean; images?: File[] } = {}) {
  const { POST } = await import("@/app/api/reports/route");
  const res = await POST(req(who, { form: reportForm(report, opts) }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> & { id: number; status: string } };
}

// Les notifications partent sans être attendues (la route répond sans elles) : on laisse finir celles
// d'un test avant le suivant, et on attend celles qu'on compte.
const settle = async () => {
  await (await import("@/lib/reports")).__testing.drain();
};
beforeEach(async () => {
  await settle();
  vi.clearAllMocks();
});

describe("signalements — créer et voir", () => {
  it("refuse un chemin qui n'existe pas, ou incomplet, à l'envoi", async () => {
    expect((await create("lucas", { ...AUDIO, element: "playerNope" })).status).toBe(400);
    expect((await create("lucas", { ...AUDIO, issue: null })).status).toBe(400);
    expect((await create("lucas", { ...AUDIO, element: "other", elementOther: "" })).status).toBe(400);
    expect((await create("lucas", { ...AUDIO, itemTitle: null })).status).toBe(400);
    // « Autre », précisé, passe à chaque niveau.
    expect((await create("lucas", { ...AUDIO, element: "other", elementOther: "Le bouton AirPlay", issue: "other", issueOther: "Il disparaît" })).status).toBe(201);
    // Une suggestion n'a pas de type de souci.
    expect((await create("lucas", { zone: "suggestion", element: "suggestPlayer", description: "Un bouton pour passer le générique." })).status).toBe(201);
  });

  it("envoyé, il fige les journaux et prévient l'administrateur ; l'auteur le voit, un autre non", async () => {
    const { status, body } = await create("lucas", AUDIO);
    expect(status).toBe(201);
    expect(body.status).toBe("open");
    await settle();
    expect(push.admins).toHaveBeenCalledTimes(1);
    const { GET } = await import("@/app/api/reports/[id]/route");
    expect((await GET(req("sarah"), params(body.id))).status).toBe(404);
    const mine = (await (await GET(req("lucas"), params(body.id))).json()) as Record<string, unknown>;
    // Les journaux et le contexte ne sont pas pour l'auteur.
    expect(mine.logs).toBeUndefined();
    const admin = (await (await GET(req("louis"), params(body.id))).json()) as Record<string, unknown>;
    expect(admin.logs).toMatchObject({ seances: [], itemSeances: [] });
    expect((admin.context as Record<string, unknown>).agent).toContain("iPhone");
  });

  it("un brouillon reste privé, se modifie, puis s'envoie", async () => {
    const { body } = await create("sarah", { zone: "home", element: "homeResume" }, { draft: true });
    expect(body.status).toBe("draft");
    await settle();
    expect(push.admins).not.toHaveBeenCalled();
    const { GET, PUT } = await import("@/app/api/reports/[id]/route");
    expect((await GET(req("louis"), params(body.id))).status).toBe(404);
    const { GET: list } = await import("@/app/api/admin/activity/reports/route");
    const adminList = (await (await list(req("louis"))).json()) as { reports: { id: number }[] };
    expect(adminList.reports.some((r) => r.id === body.id)).toBe(false);

    // Modifié sans l'envoyer : un chemin encore incomplet est accepté.
    let form = reportForm({ zone: "home", element: "homeResume", description: "Un film fini reste dans la rangée." });
    expect((await PUT(req("sarah", { form }), params(body.id))).status).toBe(200);
    // Envoyé : il lui faut tout.
    form = reportForm({ zone: "home", element: "homeResume", description: "Un film fini reste dans la rangée." });
    form.set("send", "1");
    expect((await PUT(req("sarah", { form }), params(body.id))).status).toBe(400);
    form = reportForm({ zone: "home", element: "homeResume", issue: "unexpected", description: "Un film fini reste dans la rangée." });
    form.set("send", "1");
    const sent = (await (await PUT(req("sarah", { form }), params(body.id))).json()) as { status: string };
    expect(sent.status).toBe("open");
    await settle();
    expect(push.admins).toHaveBeenCalledTimes(1);
    // Envoyé, il ne se réécrit plus.
    expect((await PUT(req("sarah", { form: reportForm(AUDIO) }), params(body.id))).status).toBe(409);
  });
});

describe("signalements — échanges, états, pastilles", () => {
  it("une réponse de l'administrateur allume la pastille de l'auteur, qui s'éteint à la lecture", async () => {
    const { body } = await create("lucas", AUDIO);
    const { POST: comment } = await import("@/app/api/reports/[id]/messages/route");
    const { GET: unread } = await import("@/app/api/reports/unread/route");
    const { GET: open } = await import("@/app/api/reports/[id]/route");
    const count = async (who: string) => (await (await unread(req(who))).json()) as { mine: number; admin: number };

    const before = await count("lucas");
    const form = new FormData();
    form.set("body", "Tu peux réessayer ?");
    expect((await comment(req("louis", { form }), params(body.id))).status).toBe(201);
    await settle();
    expect(push.user).toHaveBeenCalledTimes(1);
    expect((await count("lucas")).mine).toBe(before.mine + 1);
    await open(req("lucas"), params(body.id));
    expect((await count("lucas")).mine).toBe(before.mine);

    // L'auteur répond : c'est l'administrateur qui est prévenu.
    const reply = new FormData();
    reply.set("body", "Toujours pareil.");
    await comment(req("lucas", { form: reply }), params(body.id));
    await settle();
    expect(push.admins).toHaveBeenCalledTimes(2);
    expect((await count("louis")).admin).toBeGreaterThan(0);
  });

  it("l'auteur ferme et rouvre ; l'administrateur fait tout ; un autre ne fait rien", async () => {
    const { body } = await create("lucas", AUDIO);
    const { POST: status } = await import("@/app/api/reports/[id]/status/route");
    const set = async (who: string, s: string) => (await status(req(who, { json: { status: s } }), params(body.id))).status;
    expect(await set("lucas", "in_progress")).toBe(403);
    expect(await set("louis", "in_progress")).toBe(200);
    await settle();
    expect(push.user).toHaveBeenCalledTimes(1);
    expect(await set("lucas", "open")).toBe(403);
    expect(await set("lucas", "closed")).toBe(200);
    expect(await set("lucas", "open")).toBe(200);
    expect(await set("sarah", "closed")).toBe(404);
  });
});

describe("signalements — images", () => {
  it("garde l'original, montre une version WebP, et dit quand rien n'a pu la lire", async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 3000, height: 1000, channels: 3, background: "#224488" } }).png().toBuffer();
    const unreadable = new File([new Uint8Array([0, 1, 2, 3])], "photo.heic", { type: "image/heic" });
    const { body } = await create("lucas", AUDIO, { images: [new File([png], "capture.png", { type: "image/png" }), unreadable] });
    const images = body.images as { url: string | null; originalUrl: string; width: number | null }[];
    expect(images).toHaveLength(2);
    // Bornée à 2560 px, proportions gardées.
    expect(images[0].width).toBe(2560);
    expect(images[0].url).not.toBeNull();
    // Illisible, et rien de converti par le navigateur : l'original seul, et l'écran le saura.
    expect(images[1].url).toBeNull();

    const { GET } = await import("@/app/api/reports/[id]/images/[imageId]/route");
    const id = (body.images as { id: number }[])[0].id;
    const shown = await GET(req("lucas", { url: `https://cine.example/api/reports/${body.id}/images/${id}` }), imageParams(body.id, id));
    expect(shown.headers.get("content-type")).toBe("image/webp");
    const other = await GET(req("sarah", { url: `https://cine.example/api/reports/${body.id}/images/${id}` }), imageParams(body.id, id));
    expect(other.status).toBe(404);
  });

  it("refuse ce qui n'est pas une image", async () => {
    const res = await create("lucas", AUDIO, { images: [new File(["<script>"], "page.html", { type: "text/html" })] });
    expect(res.status).toBe(400);
  });
});
