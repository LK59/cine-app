import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import {
  LUMEN_PATH,
  LUMEN_PLAYER,
  lumenAudioFields,
  lumenContext,
  lumenFallbackFields,
  lumenRebuildFields,
  lumenSeekFields,
  lumenStallFields,
  lumenStartFields,
} from "@/components/player/lumen/lumenLog";
import { serverFailureFields, serverStartFields, serverStopFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { buildSeances } from "@/lib/activity/seances";
import { failuresOf } from "@/lib/activity/diagnosis";
import type { LogRecord } from "@/lib/activity/logReader";

/**
 * Le journal de Lumen serveur (DECISIONS.md §180) : les mêmes lignes que les deux autres lecteurs sous
 * `player: "lumen-serveur"`, `path: "remux-serveur"` ; les lignes du lecteur serveur strictement inchangées ; la
 * route du journal qui joint le relevé du serveur (`srv.*`) ; la page d'activité qui reconnaît le lecteur.
 */
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockLog = vi.fn();
vi.mock("@/lib/playerLog", () => ({
  logPlaybackEvent: (...a: unknown[]) => mockLog(...a),
  isPlayerEventKind: (v: unknown) => ["start", "fallback", "rebuild", "error", "stop", "stall", "seek", "audio"].includes(v as string),
}));
vi.mock("@/lib/config", () => ({ config: { get player() { return { enabled: true }; } } }));
const stats = vi.fn<(s: string, user: string) => Record<string, number | string>>(() => ({}));
vi.mock("@/lib/lumenServer/playbackStats", () => ({
  isPlaybackId: (v: unknown) => typeof v === "string" && /^[A-Za-z0-9_-]{4,64}$/.test(v),
  lumenPlaybackFields: (s: string, user: string) => stats(s, user),
}));

const BASE: ServerPlayerContext = { itemId: "item-1", title: "Ghosted", cast: false, session: "abcd1234", agent: "iPhone" };
const CTX = lumenContext(BASE);

describe("les lignes de Lumen serveur", () => {
  it("le lecteur et le chemin, à la place de « serveur », sur chaque ligne", () => {
    const start = lumenStartFields(CTX, { why: "open", at: 600, audioTrack: 2, audioStreamIndex: 1, lumenSession: "abcd1234", version: "2-aaaaaaaaaaaa", fragment: true, negotiateMs: 120.4 });
    expect(start).toMatchObject({ player: LUMEN_PLAYER, path: LUMEN_PATH, why: "open", hls: "natif", at: 600, audioTrack: 2, audioStreamIndex: 1, resumeBy: "fragment", lumenSession: "abcd1234", negotiateMs: 120, openedFrom: "serveur" });
    expect(start.reason).toBe("remultiplexé par le serveur");
    expect(lumenSeekFields(CTX, { from: 10, to: 600, buffered: false, ranges: "", tookMs: 612, arrived: true }, "abcd1234")).toMatchObject({ player: LUMEN_PLAYER, path: LUMEN_PATH, from: 10, to: 600, tookMs: 612, arrived: true });
    expect(lumenAudioFields(CTX, { from: 2, to: 3, fromTrack: "Français", toTrack: "Anglais", via: "audioTracks", applied: true, tookMs: 1700, at: 50 }, "abcd1234")).toMatchObject({ via: "audioTracks", applied: true, processing: "copié tel quel" });
    expect(lumenAudioFields(CTX, { from: 2, to: 4, fromTrack: "Français", toTrack: "Anglais", via: "réouverture", applied: true, tookMs: 900, at: 50, processing: "converti (A_DTS → E-AC-3 5.1)", first: "audioTracks sans effet en 2 s", pictureMs: 640.4, frozen: true }, "abcd1234")).toMatchObject({ via: "réouverture", processing: "converti (A_DTS → E-AC-3 5.1)", first: "audioTracks sans effet en 2 s", pictureMs: 640, frozen: true });
    expect(lumenStallFields(CTX, { position: 61.27, stalledMs: 5000, readyState: 2, networkState: 2, seeking: false, videoBuffered: "0-61", lead: 0, onLine: true }, "abcd1234", {})).toMatchObject({ position: 61.3, stalledMs: 5000, lead: 0 });
  });

  it("un repli prévu se dit `planned`, et vers qui", () => {
    const line = lumenFallbackFields(CTX, { to: "natif", planned: true, reason: "remux serveur : son-codec", watched: 0 }, "abcd1234", {});
    expect(line).toMatchObject({ player: LUMEN_PLAYER, to: "natif", planned: true, reason: "remux serveur : son-codec", watched: 0 });
  });

  it("une réouverture dit la version d'avant et d'après quand elle a changé (un déploiement)", () => {
    expect(lumenRebuildFields(CTX, { reason: "version changée", at: 1200.4, fromVersion: "2-a", toVersion: "3-b" }, "abcd1234", {})).toMatchObject({ reason: "remux serveur : version changée", at: 1200, fromVersion: "2-a", toVersion: "3-b" });
    expect(lumenRebuildFields(CTX, { reason: "erreur", at: 5, fromVersion: "2-a", toVersion: "2-a" }, "abcd1234", {})).toMatchObject({ version: "2-a" });
  });

  it("le lecteur serveur, sans `player` ni `path` dans son contexte, écrit exactement ses lignes d'avant", () => {
    const stream = { directPlay: false, nativeHls: true, resumeAt: 0, audioStreamIndex: undefined };
    expect(Object.keys(serverStartFields(BASE, stream, { why: "open" }))).toEqual(["itemId", "title", "player", "cast", "session", "agent", "why", "path", "reason", "hls", "at"]);
    expect(serverStartFields(BASE, stream)).toMatchObject({ player: "serveur", path: "serveur" });
    expect(serverFailureFields(BASE, "x")).toMatchObject({ player: "serveur", path: "serveur" });
    expect(serverStopFields(BASE, "close", 1, 1)).toMatchObject({ player: "serveur", path: "serveur" });
  });
});

describe("la route du journal joint le relevé du serveur", () => {
  const post = async (body: unknown) => {
    const { POST } = await import("@/app/api/player/log/route");
    return POST({ cookies: { get: () => ({ value: "t" }) }, json: async () => body } as unknown as NextRequest);
  };
  beforeEach(() => {
    vi.clearAllMocks();
    mockVerifySessionFull.mockResolvedValue({ u: "louis", jfId: "jf-1", role: "admin" });
    stats.mockReturnValue({ "srv.segV": 12, "srv.busy": 1 });
  });

  it("`stop`, `stall`, `error`, `fallback`, `rebuild` de Lumen serveur, avec le compte de la session", async () => {
    for (const kind of ["stop", "stall", "error", "fallback", "rebuild"]) {
      await post({ kind, fields: { player: "lumen-serveur", lumenSession: "abcd1234", at: 3 } });
      expect(mockLog).toHaveBeenLastCalledWith("louis", kind, expect.objectContaining({ "srv.segV": 12, "srv.busy": 1, at: 3 }));
    }
    expect(stats).toHaveBeenCalledWith("abcd1234", "louis");
  });

  it("ni les autres lignes, ni les autres lecteurs, ni un champ déjà présent écrasé", async () => {
    await post({ kind: "seek", fields: { player: "lumen-serveur", lumenSession: "abcd1234" } });
    expect(mockLog.mock.calls[0][2]).not.toHaveProperty("srv.segV");
    await post({ kind: "stop", fields: { player: "serveur", lumenSession: "abcd1234" } });
    expect(mockLog.mock.calls[1][2]).not.toHaveProperty("srv.segV");
    await post({ kind: "stop", fields: { player: "lumen-serveur", lumenSession: "abcd1234", "srv.segV": 99 } });
    expect(mockLog.mock.calls[2][2]["srv.segV"]).toBe(99);
  });

  it("un relevé qui lève ne coûte pas la ligne", async () => {
    stats.mockImplementation(() => {
      throw new Error("x");
    });
    expect((await post({ kind: "stop", fields: { player: "lumen-serveur", lumenSession: "abcd1234" } })).status).toBe(200);
    expect(mockLog).toHaveBeenCalledTimes(1);
  });
});

describe("la page d'activité reconnaît Lumen serveur", () => {
  const t0 = 1_790_000_000_000;
  const base = { user: "louis", itemId: "g", title: "Ghosted", agent: "iPhone", session: "abcd1234", player: "lumen-serveur", path: "remux-serveur", _file: "player.log" };

  it("une séance de Lumen serveur, ses sauts et pistes comptés par ses lignes", () => {
    const lines = [
      { ...base, kind: "start", why: "open", at: 0, _t: t0, _line: 1 },
      { ...base, kind: "seek", from: 0, to: 600, tookMs: 600, _t: t0 + 10_000, _line: 2 },
      { ...base, kind: "audio", from: 2, to: 3, _t: t0 + 20_000, _line: 3 },
      { ...base, kind: "stop", why: "close", at: 700, watched: 100, seeks: 1, audioSwitches: 1, _t: t0 + 120_000, _line: 4 },
    ] as unknown as LogRecord[];
    const [s] = buildSeances(lines);
    expect(s.player).toBe("lumen-serveur");
    // Le bilan n'est pas ajouté aux lignes : un saut, une piste, pas deux.
    expect(s.seeks).toBe(1);
    expect(s.audioSwitches).toBe(1);
  });

  it("un déclin prévu vers le lecteur actuel n'est pas un échec", () => {
    const lines = [
      { ...base, kind: "start", why: "open", at: 0, _t: t0, _line: 1 },
      { ...base, kind: "fallback", to: "natif", planned: true, reason: "remux serveur : son-codec", watched: 0, _t: t0 + 500, _line: 2 },
    ] as unknown as LogRecord[];
    const [s] = buildSeances(lines);
    expect(s.planned).toBe(1);
    expect(s.fallbacks).toBe(0);
    expect(failuresOf(s)).toBe(0);
  });

  it("une relance (`retry`) est nommée comme celles du lecteur serveur", () => {
    const lines = [
      { ...base, kind: "start", why: "open", at: 0, _t: t0, _line: 1 },
      { ...base, kind: "start", why: "retry", at: 0, _t: t0 + 2000, _line: 2 },
    ] as unknown as LogRecord[];
    expect(buildSeances(lines)[0].restarts.map((r) => r.why)).toEqual(["retry"]);
  });
});
