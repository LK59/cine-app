import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { NextRequest } from "next/server";

/**
 * Le Stream Deck (27/10/2026) : un jeton à lui, qui n'ouvre que les lectures en cours et leurs
 * affiches ; et ce que la touche d'une lecture dit d'elle — le lecteur serveur n'y est jamais un souci.
 */

const getSessions = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin: { getSessions: (...a: unknown[]) => getSessions(...a) } }));
const readRecords = vi.fn();
vi.mock("@/lib/activity/logReader", () => ({ readRecords: (...a: unknown[]) => readRecords(...a) }));
const buildSeances = vi.fn();
vi.mock("@/lib/activity/seances", () => ({ buildSeances: (...a: unknown[]) => buildSeances(...a) }));

import { createStreamDeckToken, listStreamDeckTokens, revokeStreamDeckToken, verifyStreamDeckToken, MAX_TOKENS } from "@/lib/streamdeck/tokens";
import { toPlay, type LiveSession } from "@/lib/streamdeck/plays";
import { getDb } from "@/lib/db";
import type { Seance } from "@/lib/activity/seances";

const NOW = Date.parse("2026-10-27T20:00:00Z");

beforeEach(() => {
  getDb().prepare("DELETE FROM streamdeck_tokens").run();
  getSessions.mockReset();
  readRecords.mockReturnValue([]);
  buildSeances.mockReturnValue([]);
});

describe("jetons du Stream Deck", () => {
  it("montré une fois, gardé en empreinte, reconnu, puis révoqué", () => {
    const created = createStreamDeckToken("PC du bureau", "louis", NOW)!;
    expect(created.token).toMatch(/^ltn_sd_[A-Za-z0-9_-]{43}$/);
    const stored = getDb().prepare("SELECT hash FROM streamdeck_tokens").get() as { hash: string };
    expect(stored.hash).not.toContain(created.token);
    expect(verifyStreamDeckToken(`Bearer ${created.token}`, NOW)).toBe(created.id);
    expect(listStreamDeckTokens()).toEqual([{ id: created.id, name: "PC du bureau", createdBy: "louis", createdAt: NOW, lastUsedAt: NOW }]);
    expect(revokeStreamDeckToken(created.id)).toBe(true);
    expect(verifyStreamDeckToken(`Bearer ${created.token}`, NOW)).toBeNull();
  });

  it("refuse l'absent, le malformé et l'inconnu", () => {
    createStreamDeckToken("PC", "louis", NOW);
    for (const header of [null, "", "Bearer", "Basic abc", "Bearer ltn_sd_inconnu", "Bearer autre_chose", `Bearer ltn_sd_${"a".repeat(300)}`]) {
      expect(verifyStreamDeckToken(header, NOW)).toBeNull();
    }
  });

  it("le dernier usage n'est réécrit qu'une fois par minute", () => {
    const { token } = createStreamDeckToken("PC", "louis", NOW)!;
    verifyStreamDeckToken(`Bearer ${token}`, NOW);
    verifyStreamDeckToken(`Bearer ${token}`, NOW + 30_000);
    expect(listStreamDeckTokens()[0].lastUsedAt).toBe(NOW);
    verifyStreamDeckToken(`Bearer ${token}`, NOW + 61_000);
    expect(listStreamDeckTokens()[0].lastUsedAt).toBe(NOW + 61_000);
  });

  it(`au plus ${MAX_TOKENS}`, () => {
    for (let i = 0; i < MAX_TOKENS; i++) expect(createStreamDeckToken(`PC ${i}`, "louis", NOW)).not.toBeNull();
    expect(createStreamDeckToken("de trop", "louis", NOW)).toBeNull();
  });
});

describe("routes /api/streamdeck", () => {
  const req = (url: string, auth?: string) =>
    ({ nextUrl: new URL(url), headers: new Headers(auth ? { authorization: auth } : {}), signal: new AbortController().signal }) as unknown as NextRequest;

  it("401 sans jeton, sans rien demander à Jellyfin", async () => {
    const { GET } = await import("@/app/api/streamdeck/plays/route");
    expect((await GET(req("https://l.example/api/streamdeck/plays"))).status).toBe(401);
    expect((await GET(req("https://l.example/api/streamdeck/plays", "Bearer ltn_sd_faux"))).status).toBe(401);
    expect(getSessions).not.toHaveBeenCalled();
  });

  it("200 avec le jeton : les lectures en cours", async () => {
    const { token } = createStreamDeckToken("PC", "louis")!;
    getSessions.mockResolvedValue([session({ UserName: "nath" })]);
    const { GET } = await import("@/app/api/streamdeck/plays/route");
    const res = await GET(req("https://l.example/api/streamdeck/plays", `Bearer ${token}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ count: 1, plays: [{ user: "nath", title: "Solidarité masculine" }] });
  });

  it("l'affiche seulement d'un titre qui joue", async () => {
    const { token } = createStreamDeckToken("PC", "louis")!;
    getSessions.mockResolvedValue([]);
    const { GET } = await import("@/app/api/streamdeck/image/route");
    const res = await GET(req(`https://l.example/api/streamdeck/image?itemId=${"b".repeat(32)}`, `Bearer ${token}`));
    expect(res.status).toBe(404);
  });

  it("chaque route du dossier vérifie le jeton — le dossier est public au proxy", () => {
    const dir = path.join(process.cwd(), "src/app/api/streamdeck");
    const routes = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith("route.ts"));
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const route of routes) expect(fs.readFileSync(path.join(dir, route), "utf8")).toMatch(/verifyStreamDeckToken\(req\.headers\.get\("authorization"\)\)/);
  });
});

function session(over: Partial<LiveSession> = {}): LiveSession {
  return {
    Id: "s1",
    UserName: "louis",
    Client: "Laterna",
    DeviceName: "iPhone",
    LastPlaybackCheckIn: new Date(Date.now() - 10_000).toISOString(),
    NowPlayingItem: {
      Id: "a".repeat(32),
      Name: "Solidarité masculine",
      Type: "Episode",
      SeriesName: "Ted Lasso",
      SeriesId: "c".repeat(32),
      IndexNumber: 8,
      ParentIndexNumber: 1,
      RunTimeTicks: 1800 * 1e7,
      MediaStreams: [
        { Type: "Video", Index: 0, Codec: "hevc", Width: 3840, VideoRangeType: "DOVIWithHDR10" },
        { Type: "Audio", Index: 1, DisplayTitle: "Français - E-AC3 - 5.1" },
        { Type: "Subtitle", Index: 4, DisplayTitle: "Français (forcés)" },
      ],
    },
    PlayState: { PositionTicks: 600 * 1e7, IsPaused: false, PlayMethod: "DirectStream", AudioStreamIndex: 1, SubtitleStreamIndex: 4 },
    ...over,
  } as LiveSession;
}

function seance(over: Partial<Seance> = {}): Seance {
  return { user: "louis", itemId: "a".repeat(32), start: NOW - 600_000, player: "natif", video: "hevc 3840x1600 10bit", range: "DOVIWithHDR10", onTv: false, stalls: 0, errors: 0, rebuilds: 0, incidents: [], ...over } as Seance;
}

describe("une lecture vue du Stream Deck", () => {
  it("décrit l'épisode, la position, les pistes et l'image", () => {
    const play = toPlay(session(), [seance()], NOW);
    expect(play).toMatchObject({
      user: "louis",
      series: "Ted Lasso",
      code: "S01E08",
      imageItemId: "c".repeat(32),
      positionS: 600,
      durationS: 1800,
      path: "appareil",
      video: "HEVC 4K · Dolby Vision",
      audio: "Français - E-AC3 - 5.1",
      subtitle: "Français (forcés)",
      state: "ok",
    });
  });

  it("le lecteur serveur est un chemin, pas un souci", () => {
    const play = toPlay(session(), [seance({ player: "serveur", incidents: [{ kind: "fallback", t: NOW - 5_000, reason: "Aucun chemin…" }] })], NOW);
    expect(play.path).toBe("serveur");
    expect(play.state).toBe("ok");
    expect(play.incidents).toMatchObject({ waits: 0, errors: 0, rebuilds: 0, last: null });
  });

  it("une attente récente allume le souci ; ancienne, plus", () => {
    const stall = (t: number) => seance({ stalls: 1, incidents: [{ kind: "stall", t, reason: "612 s" }] });
    expect(toPlay(session(), [stall(NOW - 30_000)], NOW).state).toBe("souci");
    expect(toPlay(session(), [stall(NOW - 10 * 60_000)], NOW).state).toBe("ok");
    expect(toPlay(session(), [stall(NOW - 10 * 60_000)], NOW).incidents.waits).toBe(1);
  });

  it("une autre application (la télé du salon) passe par Jellyfin, sans séance", () => {
    const play = toPlay(session({ Client: "Jellyfin Web", NowPlayingItem: { ...session().NowPlayingItem!, SeriesName: undefined, IndexNumber: undefined } }), [seance({ stalls: 3, incidents: [{ kind: "stall", t: NOW, reason: "1 s" }] })], NOW);
    expect(play).toMatchObject({ path: "jellyfin", code: null, imageItemId: "a".repeat(32), state: "ok" });
  });

  it("en pause", () => {
    expect(toPlay(session({ PlayState: { ...session().PlayState, IsPaused: true } }), [], NOW).state).toBe("pause");
  });
});
