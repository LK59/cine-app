import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Une base et un dossier de données à ce fichier seul.
vi.hoisted(() => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-reports-`);
  // Une séance de lucas sur « Red Dragon » (abc), une heure avant : celle que ses tickets citeront.
  mkdirSync(`${process.env.DATA_DIR}/logs`, { recursive: true });
  const t = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const base = { user: "lucas", itemId: "abc", title: "Red Dragon", session: "sess-abc", agent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X)" };
  writeFileSync(
    `${process.env.DATA_DIR}/logs/player.log`,
    [
      { timestamp: t(60), kind: "start", at: 0, ...base },
      { timestamp: t(58), kind: "stall", position: 120, ...base },
      { timestamp: t(55), kind: "stop", at: 300, why: "close", watched: 280, ...base },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + "\n"
  );
});

vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getUsers: async () => [{ Id: "id-lucas", Name: "lucas" }, { Id: "id-sarah", Name: "sarah" }],
    getItemRunTimeTicks: async () => 7_200 * 10_000_000,
  },
}));

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
  // Réservée aux plafonds : ses créations ne doivent pas compter dans celles des autres tests.
  noe: { u: "noe", jfUser: "noe", jfId: "id-noe", role: "user", jti: "j4" },
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
    // La séance de lucas sur ce titre, figée avec le ticket.
    const logs = admin.logs as { itemSeances: { id: string; stalls: number }[] };
    expect(logs.itemSeances).toMatchObject([{ id: "sess-abc", stalls: 1 }]);
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

describe("signalements — ce qui allume une pastille (24/09/2026)", () => {
  const counts = async (who: string) => {
    const { GET } = await import("@/app/api/reports/unread/route");
    return (await (await GET(req(who))).json()) as { mine: number; admin: number };
  };
  const setStatus = async (who: string, id: number, s: string) => {
    const { POST } = await import("@/app/api/reports/[id]/status/route");
    return (await POST(req(who, { json: { status: s } }), params(id))).status;
  };

  // L'administrateur est aussi l'auteur de ses propres signalements : l'ouvrir ne marquait que le
  // côté auteur, et sa pastille d'administrateur restait allumée sur un ticket déjà lu.
  it("l'administrateur ne se notifie pas lui-même, et ouvrir un ticket l'éteint des deux côtés", async () => {
    const before = await counts("louis");
    const { body } = await create("louis", AUDIO);
    expect(await counts("louis")).toEqual(before);
    const { POST: comment } = await import("@/app/api/reports/[id]/messages/route");
    const form = new FormData();
    form.set("body", "Précision.");
    await comment(req("louis", { form }), params(body.id));
    expect(await counts("louis")).toEqual(before);

    // Un ticket d'un autre, ouvert : lu.
    const { body: other } = await create("sarah", AUDIO);
    expect((await counts("louis")).admin).toBe(before.admin + 1);
    const { GET } = await import("@/app/api/reports/[id]/route");
    await GET(req("louis"), params(other.id));
    expect((await counts("louis")).admin).toBe(before.admin);
  });

  it("une fermeture n'allume rien et ne notifie personne, d'un côté comme de l'autre", async () => {
    const { body } = await create("lucas", AUDIO);
    const { GET } = await import("@/app/api/reports/[id]/route");
    await GET(req("louis"), params(body.id));
    await settle();
    vi.clearAllMocks();
    const admin = (await counts("louis")).admin;
    expect(await setStatus("lucas", body.id, "closed")).toBe(200);
    expect(await setStatus("lucas", body.id, "open")).toBe(200);
    await GET(req("louis"), params(body.id));
    const mine = (await counts("lucas")).mine;
    expect(await setStatus("louis", body.id, "closed")).toBe(200);
    await settle();
    expect((await counts("lucas")).mine).toBe(mine);
    // La réouverture par l'auteur, elle, prévient l'administrateur — une seule fois.
    expect(push.admins).toHaveBeenCalledTimes(1);
    expect(push.user).not.toHaveBeenCalled();
    expect((await counts("louis")).admin).toBe(admin);
  });
});

describe("signalements — les séances qu'ils concernent (24/09/2026)", () => {
  it("un ticket sur un titre cite la séance de ce titre, et la séance le retrouve", async () => {
    const { body } = await create("lucas", AUDIO);
    expect(body.seanceId).toBe("sess-abc");
    const { GET } = await import("@/app/api/admin/activity/seances/[id]/route");
    const seance = (await (await GET(req("louis"), params("sess-abc"))).json()) as { runtime: number; reports: { id: number }[] };
    expect(seance.runtime).toBe(7200);
    expect(seance.reports.map((r) => r.id)).toContain(body.id);
    // Un souci de recherche n'a pas de séance : en citer une au hasard égarerait.
    const search = await create("lucas", { zone: "search", element: "searchResults", issue: "unexpected", description: "Rien ne sort." });
    expect(search.body.seanceId).toBeNull();
  });

  it("l'administrateur écrit à quelqu'un depuis sa séance : un ticket à son nom, sa pastille, sa notification", async () => {
    const { POST } = await import("@/app/api/admin/activity/seances/[id]/report/route");
    const { GET: unread } = await import("@/app/api/reports/unread/route");
    const count = async (who: string) => ((await (await unread(req(who))).json()) as { mine: number; admin: number });
    const before = await count("lucas");
    const adminBefore = (await count("louis")).admin;
    expect((await POST(req("lucas", { json: { message: "Salut" } }), params("sess-abc"))).status).toBe(403);
    const res = await POST(req("louis", { json: { message: "J'ai vu un blocage à 2:00, tu peux m'en dire plus ?" } }), params("sess-abc"));
    expect(res.status).toBe(201);
    const report = (await res.json()) as { id: number; openedBy: string; seanceId: string; itemTitle: string };
    expect(report).toMatchObject({ openedBy: "admin", seanceId: "sess-abc", itemTitle: "Red Dragon" });
    await settle();
    expect(push.user).toHaveBeenCalledTimes(1);
    expect((await count("lucas")).mine).toBe(before.mine + 1);
    // Il ne réveille pas l'administrateur lui-même.
    expect((await count("louis")).admin).toBe(adminBefore);
    // Il est à lucas : dans sa liste, et il peut y répondre.
    const { GET: mine } = await import("@/app/api/reports/route");
    const list = (await (await mine(req("lucas"))).json()) as { reports: { id: number }[] };
    expect(list.reports.map((r) => r.id)).toContain(report.id);
    const { POST: comment } = await import("@/app/api/reports/[id]/messages/route");
    const form = new FormData();
    form.set("body", "Oui, l'image s'est figée.");
    expect((await comment(req("lucas", { form }), params(report.id))).status).toBe(201);
  });
});

describe("signalements — relus le 24/09/2026 au soir", () => {
  const tiny = (name: string) => new File([new Uint8Array([0, 1, 2, 3])], name, { type: "image/png" });

  it("répond par un code que l'écran traduit, pas par une phrase", async () => {
    const res = await create("lucas", AUDIO, { images: [new File(["<script>"], "page.html", { type: "text/html" })] });
    expect(res.body).toMatchObject({ code: "notImage" });
    expect((await create("lucas", { ...AUDIO, description: "" })).body).toMatchObject({ code: "incomplete" });
  });

  it("un brouillon se supprime, par son auteur seulement, et emporte ses images", async () => {
    const { body } = await create("sarah", { zone: "home", element: "homeResume" }, { draft: true, images: [tiny("a.png")] });
    const { DELETE } = await import("@/app/api/reports/[id]/route");
    expect((await DELETE(req("lucas"), params(body.id))).status).toBe(404);
    const { existsSync } = await import("node:fs");
    const dir = `${process.env.DATA_DIR}/reports/${body.id}`;
    expect(existsSync(dir)).toBe(true);
    expect((await DELETE(req("sarah"), params(body.id))).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    const { GET } = await import("@/app/api/reports/[id]/route");
    expect((await GET(req("sarah"), params(body.id))).status).toBe(404);
    // Un signalement envoyé, lui, ne se supprime pas.
    const sent = await create("sarah", AUDIO);
    expect((await DELETE(req("sarah"), params(sent.body.id))).status).toBe(409);
  });

  it("plafonne les images d'un fil, commentaires compris", async () => {
    const { MAX_IMAGES_PER_REPORT, MAX_IMAGES } = await import("@/lib/reportLimits");
    const { body } = await create("lucas", AUDIO);
    const { POST: comment } = await import("@/app/api/reports/[id]/messages/route");
    let last = 201;
    for (let sent = 0; sent <= MAX_IMAGES_PER_REPORT; sent += MAX_IMAGES) {
      const form = new FormData();
      for (let i = 0; i < MAX_IMAGES; i++) form.append("images", tiny(`c${sent + i}.png`));
      const res = await comment(req("lucas", { form }), params(body.id));
      last = res.status;
      if (res.status !== 201) {
        expect(await res.json()).toMatchObject({ code: "tooMany" });
        break;
      }
    }
    expect(last).toBe(400);
  });

  it("deux envois simultanés du même brouillon ne préviennent qu'une fois", async () => {
    const { body } = await create("sarah", { zone: "home", element: "homeResume" }, { draft: true });
    await settle();
    vi.clearAllMocks();
    const { PUT } = await import("@/app/api/reports/[id]/route");
    const sending = () => {
      const form = reportForm({ zone: "home", element: "homeResume", issue: "unexpected", description: "Deux fois." });
      form.set("send", "1");
      return PUT(req("sarah", { form }), params(body.id));
    };
    const results = await Promise.all([sending(), sending()]);
    await settle();
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(push.admins).toHaveBeenCalledTimes(1);
  });

  // Au-delà de 10 Mo par défaut, le proxy de Next ne garde que le début du corps : deux captures
  // d'iPhone rendaient le formulaire illisible.
  it("laisse passer au proxy tout ce que le téléphone peut envoyer", async () => {
    const { MAX_REQUEST_BYTES } = await import("@/lib/reportLimits");
    const { createRequire } = await import("node:module");
    const config = createRequire(`${process.cwd()}/`)("./next.config.js") as { experimental?: { proxyClientMaxBodySize?: string } };
    const raw = config.experimental?.proxyClientMaxBodySize ?? "10mb";
    const mb = Number(/^(\d+)mb$/i.exec(raw)?.[1]);
    expect(mb * 1024 * 1024).toBeGreaterThan(MAX_REQUEST_BYTES);
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
    // Un SVG est un document qui peut porter du script, et une page déguisée en image garde son extension.
    const svg = new File(["<svg onload='alert(1)'/>"], "capture.svg", { type: "image/svg+xml" });
    expect((await create("lucas", AUDIO, { images: [svg] })).status).toBe(400);
    const disguised = new File(["<script>alert(1)</script>"], "capture.html", { type: "image/png" });
    expect((await create("lucas", AUDIO, { images: [disguised] })).status).toBe(400);
  });

  // Le type servi venait du navigateur qui avait envoyé le fichier : une page HTML annoncée
  // « image/png » sous un nom en .png se serait ouverte comme page dans la session de l'administrateur.
  it("sert l'original sous le type de son extension, sans rien pouvoir exécuter", async () => {
    const lie = new File(["<html><script>alert(1)</script></html>"], "capture.png", { type: "text/html" });
    const { body } = await create("lucas", AUDIO, { images: [lie] });
    const id = (body.images as { id: number }[])[0].id;
    const { GET } = await import("@/app/api/reports/[id]/images/[imageId]/route");
    const res = await GET(req("louis", { url: `https://cine.example/api/reports/${body.id}/images/${id}?original=1` }), imageParams(body.id, id));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  // La route ne peut pas poser sa propre politique : la règle générale de next.config.js l'écrase.
  // C'est donc la configuration qui doit porter le bac à sable, après la règle générale.
  it("met les captures en bac à sable dans la configuration, après la règle générale", async () => {
    const { createRequire } = await import("node:module");
    const nextConfig = createRequire(`${process.cwd()}/`)("./next.config.js") as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> };
    const rules = await nextConfig.headers();
    const i = rules.findIndex((r) => r.source === "/api/reports/:id/images/:imageId");
    expect(i).toBeGreaterThan(rules.findIndex((r) => r.source === "/(.*)"));
    expect(rules[i].headers.find((h) => h.key === "Content-Security-Policy")?.value).toMatch(/^sandbox;/);
  });
});

// Rien ne bornait ni le nombre de signalements ni celui des brouillons : six images de 25 Mo à
// chaque création, et `data/` porte aussi la base et les journaux (26/09/2026).
describe("signalements — plafonds par compte (26/09/2026)", () => {
  it("refuse en 429, avec un code que l'écran traduit, au-delà de 20 brouillons ouverts", async () => {
    const { MAX_OPEN_DRAFTS } = await import("@/lib/reportLimits");
    for (let i = 0; i < MAX_OPEN_DRAFTS; i++) {
      expect((await create("noe", { zone: "home", element: "homeResume" }, { draft: true })).status).toBe(201);
    }
    const refused = await create("noe", { zone: "home", element: "homeResume" }, { draft: true });
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("quota");
    // Un envoi direct n'ajoute pas de brouillon : il passe tant que le plafond du jour le permet.
    expect((await create("noe", AUDIO)).status).toBe(201);
  });

  it("refuse en 429 au-delà de 30 créations sur 24 heures, brouillons compris", async () => {
    const { MAX_REPORTS_PER_DAY } = await import("@/lib/reportLimits");
    const { reportsDb } = await import("@/lib/db");
    let { created } = reportsDb.quotaCounts("id-noe", Date.now() - 24 * 3600_000);
    for (; created < MAX_REPORTS_PER_DAY; created++) expect((await create("noe", AUDIO)).status).toBe(201);
    const refused = await create("noe", AUDIO);
    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("quota");
    // L'administrateur n'a pas de plafond ; les autres comptes ne partagent pas celui de noe.
    expect((await create("sarah", AUDIO)).status).toBe(201);
  });

  it("n'en met pas à l'administrateur", async () => {
    const { reportQuota } = await import("@/lib/reports");
    expect(reportQuota({ userId: "id-noe", userName: "noe", admin: true }, true)).toBeNull();
    expect(reportQuota({ userId: "id-noe", userName: "noe", admin: false }, false)).not.toBeNull();
  });

  it("l'écran connaît le code", async () => {
    const { reportErrorText } = await import("@/components/reports/reportErrors");
    expect(reportErrorText({ code: "quota" }, (k) => k)).toBe("report.errors.quota");
  });
});

describe("signalements — images démesurées (26/09/2026)", () => {
  // 100 M pixels pour tout format laissaient un PNG uni de quelques kilo-octets se décoder en
  // centaines de mégaoctets, six fois par requête.
  it("ne décode pas un PNG de plus de 40 M pixels, mais garde l'original", async () => {
    const { default: sharp } = await import("sharp");
    const png = await sharp({ create: { width: 6500, height: 6500, channels: 3, background: "#000" } }).png({ compressionLevel: 1 }).toBuffer();
    const { status, body } = await create("sarah", AUDIO, { images: [new File([png], "immense.png", { type: "image/png" })] });
    expect(status).toBe(201);
    const images = body.images as { url: string | null; originalUrl: string }[];
    expect(images).toHaveLength(1);
    expect(images[0].url).toBeNull();
    expect(images[0].originalUrl).toContain("original=1");
  }, 30_000);

  it("garde 100 M pour le JPEG, décodé réduit, et 40 M pour le reste", async () => {
    const { inputPixelLimit } = await import("@/lib/reportImages");
    expect(inputPixelLimit("jpeg")).toBe(100_000_000);
    expect(inputPixelLimit("png")).toBe(40_000_000);
    expect(inputPixelLimit("webp")).toBe(40_000_000);
    expect(inputPixelLimit(undefined)).toBe(40_000_000);
    // Une capture 8K passe.
    expect(7680 * 4320).toBeLessThan(inputPixelLimit("png"));
  });
});
