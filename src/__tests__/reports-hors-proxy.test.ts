import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { NextRequest } from "next/server";

// Une base et un dossier de données à ce fichier seul.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-reports-proxy-`);
});

vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: { getUsers: async () => [{ Id: "id-lucas", Name: "lucas" }], getItemRunTimeTicks: async () => 0 },
}));
vi.mock("@/lib/push", () => ({ sendPushToAdmins: async () => {}, sendPushToUser: async () => {} }));

const SESSIONS: Record<string, unknown> = {
  lucas: { u: "lucas", jfUser: "lucas", jfId: "id-lucas", role: "user", jti: "j1" },
};
vi.mock("@/lib/session", () => ({ verifySessionFull: async (token?: string) => (token ? SESSIONS[token] ?? null : null) }));

// A2 (audit du 29/09/2026) : `proxyClientMaxBodySize: "100mb"` faisait garder par Next jusqu'à
// 100 Mo du corps de *chaque* requête /api/* avant que le proxy ne décide quoi que ce soit — vingt
// POST anonymes de 95 Mo remplissaient les 2 Go du conteneur. Les signalements, seuls à avoir
// besoin de gros corps, sont sortis du proxy et portent eux-mêmes ses contrôles.

/**
 * Une requête dont le corps compte ses lectures : une route qui refuse doit le faire avant d'y
 * toucher, sans quoi le refus arrive, comme avant, une fois la mémoire prise.
 */
function req(method: string, url: string, opts: { who?: string; headers?: Record<string, string> } = {}) {
  const read = { count: 0 };
  const touch = async () => {
    read.count++;
    return new FormData();
  };
  const r = {
    method,
    cookies: { get: () => (opts.who ? { value: opts.who } : undefined) },
    headers: new Headers({ host: "cine.example", ...opts.headers }),
    nextUrl: new URL(`https://cine.example${url}`),
    url: `https://cine.example${url}`,
    formData: touch,
    json: touch,
    text: touch,
    arrayBuffer: touch,
    get body() {
      read.count++;
      return null;
    },
  } as unknown as NextRequest;
  return { r, read };
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const imageParams = (id: string, imageId: string) => ({ params: Promise.resolve({ id, imageId }) });

/** Chaque écriture des signalements, telle que le navigateur l'envoie. */
async function writes() {
  const root = await import("@/app/api/reports/route");
  const one = await import("@/app/api/reports/[id]/route");
  const messages = await import("@/app/api/reports/[id]/messages/route");
  const status = await import("@/app/api/reports/[id]/status/route");
  const images = await import("@/app/api/reports/[id]/images/[imageId]/route");
  return [
    { name: "POST /api/reports", run: (r: NextRequest) => root.POST(r), method: "POST", url: "/api/reports" },
    { name: "PUT /api/reports/1", run: (r: NextRequest) => one.PUT(r, params("1")), method: "PUT", url: "/api/reports/1" },
    { name: "DELETE /api/reports/1", run: (r: NextRequest) => one.DELETE(r, params("1")), method: "DELETE", url: "/api/reports/1" },
    { name: "POST messages", run: (r: NextRequest) => messages.POST(r, params("1")), method: "POST", url: "/api/reports/1/messages" },
    { name: "POST status", run: (r: NextRequest) => status.POST(r, params("1")), method: "POST", url: "/api/reports/1/status" },
    { name: "DELETE image", run: (r: NextRequest) => images.DELETE(r, imageParams("1", "1")), method: "DELETE", url: "/api/reports/1/images/1" },
  ];
}

describe("signalements hors du proxy — A2", () => {
  it("Next ne garde plus 100 Mo de chaque corps : la limite du proxy est celle par défaut", () => {
    const config = createRequire(`${process.cwd()}/`)("./next.config.js") as { experimental?: { proxyClientMaxBodySize?: string | number } };
    const raw = config.experimental?.proxyClientMaxBodySize;
    if (raw === undefined) return;
    const mb = typeof raw === "number" ? raw / 1024 / 1024 : Number(/^(\d+)mb$/i.exec(raw)?.[1]);
    expect(mb).toBeLessThanOrEqual(10);
  });

  it("le matcher du proxy n'attrape pas les signalements, et attrape toujours le reste de l'API", () => {
    const proxy = readFileSync("src/proxy.ts", "utf8");
    const matcher = new RegExp(`^${proxy.match(/"(\/\(\(\?![^"]+)"/)![1]}$`);
    for (const chemin of ["/api/reports", "/api/reports/12", "/api/reports/12/messages", "/api/reports/12/images/3", "/api/reports/unread"]) {
      expect(matcher.test(chemin), chemin).toBe(false);
    }
    for (const chemin of ["/", "/gestion", "/api/watchlist", "/api/auth/login", "/api/player/log"]) {
      expect(matcher.test(chemin), chemin).toBe(true);
    }
  });

  it("une écriture venue d'une autre page est refusée par la route elle-même, corps non lu", async () => {
    for (const w of await writes()) {
      for (const headers of [{ "sec-fetch-site": "same-site" }, { origin: "https://autre.example" }] as Record<string, string>[]) {
        const { r, read } = req(w.method, w.url, { who: "lucas", headers });
        const res = await w.run(r);
        expect(res.status, `${w.name} ${JSON.stringify(headers)}`).toBe(403);
        expect(read.count, w.name).toBe(0);
      }
    }
  });

  it("sans session, chaque route refuse sans lire le corps, avec l'en-tête de session expirée", async () => {
    for (const w of await writes()) {
      const { r, read } = req(w.method, w.url, { headers: { "sec-fetch-site": "same-origin", "content-length": String(95 * 1024 * 1024) } });
      const res = await w.run(r);
      expect(res.status, w.name).toBe(401);
      expect(res.headers.get("x-session-expired"), w.name).toBe("1");
      expect(read.count, w.name).toBe(0);
    }
  });

  it("un corps annoncé plus lourd que ce que le téléphone peut envoyer est refusé avant d'être lu", async () => {
    const { REPORT_BODY_LIMIT } = await import("@/lib/reportLimits");
    const { POST } = await import("@/app/api/reports/route");
    const { r, read } = req("POST", "/api/reports", { who: "lucas", headers: { "content-length": String(REPORT_BODY_LIMIT + 1) } });
    const res = await POST(r);
    expect(res.status).toBe(413);
    expect(read.count).toBe(0);
  });
});
