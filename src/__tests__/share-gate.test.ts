import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

/**
 * La porte des liens de partage (DECISIONS.md §112) : une session `share` n'atteint que la liste
 * fermée de `share/gate.ts`, et seulement pour son titre. Le test parcourt **toutes** les routes de
 * l'API, toutes leurs méthodes : une route ajoutée demain est refusée à un invité sans qu'on y pense,
 * et ce test le prouve.
 */

vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "cine_session",
  SESSION_MAX_AGE: 604800,
  shouldRefresh: () => false,
  refreshSessionToken: async () => "renouvelé",
  reissueShareSessionToken: async () => "réémis",
}));
vi.mock("@/lib/db", () => ({ sessionDb: { touch: vi.fn() } }));
const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const MOVIE = "a".repeat(32);
const SERIES = "b".repeat(32);
const EPISODE = "c".repeat(32);
const OTHER_EPISODE = "d".repeat(32);
const ELSEWHERE = "e".repeat(32);
const EXPIRES = Date.now() + 86_400_000;

const shares = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock("@/lib/share/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/share/store")>();
  return { ...real, sharesDb: { get: () => shares.current, jellyfinUserIds: () => new Set<string>() } };
});
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemBasic: async (_user: string, itemId: string) => {
      if (itemId === EPISODE) return { Type: "Episode", SeriesId: SERIES };
      if (itemId === OTHER_EPISODE) return { Type: "Episode", SeriesId: ELSEWHERE };
      return { Type: "Movie" };
    },
  },
}));

function share(kind: "movie" | "series") {
  return {
    id: "0123456789abcdef",
    code: "abcdefghjk",
    kind,
    itemId: kind === "movie" ? MOVIE : SERIES,
    radarrId: kind === "movie" ? 12 : null,
    sonarrId: kind === "series" ? 7 : null,
    expiresAt: EXPIRES,
    revokedAt: null,
    maxStreams: 3,
    jfUserId: "f".repeat(32),
    jfUserName: "partage-01234567",
    jfDeletedAt: null,
  };
}

function req(method: string, pathname: string): NextRequest {
  const url = new URL(`https://cine.example${pathname}`);
  return { nextUrl: url, url: url.toString(), method, headers: new Headers(), cookies: { get: () => ({ value: "t" }) } } as unknown as NextRequest;
}

beforeEach(async () => {
  vi.clearAllMocks();
  (await import("@/lib/share/scope")).__testing.reset();
  shares.current = share("movie");
  mockVerify.mockResolvedValue({ u: "partage-01234567", jfUser: "partage-01234567", role: "share", sh: "0123456789abcdef", jti: "j", exp: EXPIRES });
});

/** Chaque route de l'API et ses méthodes, avec une adresse d'exemple hors de tout titre partagé. */
function allApiRoutes(): { method: string; path: string; file: string }[] {
  const root = path.join(process.cwd(), "src/app/api");
  const out: { method: string; path: string; file: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === "route.ts") {
        const source = fs.readFileSync(full, "utf8");
        const methods = [...source.matchAll(/export\s+(?:async\s+function|const|function)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)].map((m) => m[1]);
        const rel = path.relative(root, path.dirname(full)).split(path.sep);
        const segments = rel
          .filter((s) => !/^\(.*\)$/.test(s))
          .map((s) => (s.startsWith("[...") ? "x/y" : s.startsWith("[") ? ELSEWHERE : s));
        for (const method of methods) out.push({ method, path: `/api/${segments.join("/")}`, file: path.relative(process.cwd(), full) });
      }
    }
  };
  walk(root);
  return out;
}

describe("toute l'API, pour une session de partage", () => {
  it("parcourt bien toutes les routes", () => {
    expect(allApiRoutes().length).toBeGreaterThan(150);
  });

  it("refuse tout ce qui n'est pas sur la liste, et tout ce qui sort du titre", async () => {
    const { proxy } = await import("@/proxy");
    const { shareRuleFor } = await import("@/lib/share/gate");
    const { isPublicPath } = await import("@/lib/publicPaths");
    const opened: string[] = [];
    for (const { method, path: p } of allApiRoutes()) {
      // Les signalements sont hors du proxy (`HORS_PROXY`) : leur refus est testé à part.
      if (p.startsWith("/api/reports")) continue;
      const status = (await proxy(req(method, p))).status;
      if (status !== 403) opened.push(`${method} ${p} → ${status}`);
    }
    // Ce qui passe avec un élément hors du titre : seulement les adresses publiques (l'entrée du lien,
    // la configuration publique…) et les entrées sans élément ou dont la route vérifie le corps.
    const unexpected = opened.filter((line) => {
      const [method, p] = line.split(" ");
      if (isPublicPath(p)) return false;
      const rule = shareRuleFor(method, p)?.rule;
      return !(rule && (rule.scope.kind === "none" || rule.scope.kind === "body"));
    });
    expect(unexpected).toEqual([]);
  });

  it("chaque route dont l'élément est dans le corps le vérifie elle-même", async () => {
    const { SHARE_RULES } = await import("@/lib/share/gate");
    const routes = allApiRoutes();
    for (const rule of SHARE_RULES.filter((r) => r.scope.kind === "body")) {
      const files = [...new Set(routes.filter((r) => rule.methods.includes(r.method) && rule.path.test(r.path)).map((r) => r.file))];
      expect(files.length).toBeGreaterThan(0);
      for (const file of files) expect(fs.readFileSync(file, "utf8"), file).toMatch(/shareRefusal\(/);
    }
  });
});

describe("dans le titre partagé", () => {
  it("un film : sa fiche, son flux, ses aperçus — et rien d'un autre", async () => {
    const { proxy } = await import("@/proxy");
    for (const p of [
      `/api/jellyfin/direct/${MOVIE}`,
      `/api/jellyfin/playback-state/${MOVIE}`,
      `/api/jellyfin/stream/${MOVIE}/stream.mkv`,
      `/api/jellyfin/stream/subtitle/${MOVIE}`,
      `/api/jellyfin/image?itemId=${MOVIE}`,
      `/api/jellyfin/trickplay/tile?itemId=${MOVIE}`,
      `/api/jellyfin/chapters?itemId=${MOVIE}`,
      `/api/player/item/${MOVIE}`,
      `/api/radarr/movies/12/info`,
    ]) {
      expect((await proxy(req("GET", p))).status, p).toBe(200);
    }
    for (const p of [
      `/api/jellyfin/direct/${ELSEWHERE}`,
      `/api/jellyfin/stream/${EPISODE}/stream.mkv`,
      `/api/jellyfin/image?itemId=${ELSEWHERE}`,
      `/api/radarr/movies/13/info`,
      `/api/sonarr/series/7/info`,
      `/api/cinema/series/${SERIES}/episodes`,
    ]) {
      expect((await proxy(req("GET", p))).status, p).toBe(403);
    }
  });

  it("une série : elle et ses épisodes, pas ceux d'une autre", async () => {
    shares.current = share("series");
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", `/api/cinema/series/${SERIES}/episodes`))).status).toBe(200);
    expect((await proxy(req("GET", `/api/jellyfin/direct/${EPISODE}`))).status).toBe(200);
    expect((await proxy(req("GET", `/api/sonarr/series/7/info`))).status).toBe(200);
    expect((await proxy(req("GET", `/api/jellyfin/direct/${OTHER_EPISODE}`))).status).toBe(403);
    expect((await proxy(req("GET", `/api/cinema/series/${ELSEWHERE}/episodes`))).status).toBe(403);
    expect((await proxy(req("GET", `/api/jellyfin/direct/${MOVIE}`))).status).toBe(403);
  });

  it("toute autre page ramène à la fiche du lien", async () => {
    const { proxy } = await import("@/proxy");
    for (const p of ["/", "/gestion", "/parametres", "/radarr", "/hors-ligne-x"]) {
      const res = await proxy(req("GET", p));
      expect(res.headers.get("location"), p).toBe("https://cine.example/partage/abcdefghjk");
    }
  });

  it("aucun téléchargement, aucune génération de sous-titres, même sur son titre", async () => {
    const { proxy } = await import("@/proxy");
    for (const [method, p] of [
      ["GET", `/api/player/download/${MOVIE}`],
      ["POST", "/api/offline/jobs"],
      ["GET", `/api/offline/details/${MOVIE}`],
      ["GET", `/api/offline/subtitles/${MOVIE}`],
      ["GET", `/api/subtitle-gen/options?itemId=${MOVIE}`],
      ["POST", "/api/subtitle-gen/jobs"],
      ["GET", "/api/player/cast"],
      ["GET", "/api/cinema/movies"],
      ["GET", "/api/search?q=a"],
      ["POST", "/api/player/requests"],
    ]) {
      expect((await proxy(req(method, p))).status, `${method} ${p}`).toBe(403);
    }
  });

  it("une session de compte du foyer ne passe jamais par cette porte", async () => {
    mockVerify.mockResolvedValue({ u: "mathis", role: "user", jti: "k", exp: EXPIRES });
    const { proxy } = await import("@/proxy");
    expect((await proxy(req("GET", "/api/cinema/movies"))).status).toBe(200);
  });
});
