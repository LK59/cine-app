import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "fs";
import type { NextRequest } from "next/server";
import { jellyfinIdSegment } from "@/lib/jellyfinPath";
import { stripAccessToken } from "@/lib/stripAccessToken";

/**
 * Un identifiant venu du navigateur n'entre dans une URL Jellyfin que s'il en est un.
 *
 * 25/09/2026 : `/api/jellyfin/played` et `/api/jellyfin/favorite` ne vérifiaient qu'un `itemId`
 * non vide, et le client le concaténait dans `/Users/{id}/PlayedItems/{itemId}` — une écriture
 * signée avec la clé d'administration. `fetch` normalise les `..` et un `?` neutralise la fin du
 * chemin : `../../System/Shutdown?` y devenait `POST /System/Shutdown`, et `DELETE` (« non vu »)
 * visait `/Users/{id}` ou `/Items/{id}`, pour n'importe quel compte ordinaire.
 *
 * Deux remparts : chaque route refuse l'identifiant en 400 avant tout appel, et le client lui-même
 * refuse de construire l'URL (`jellyfinIdSegment`). Le second tient quand une route oublie le
 * premier — ce qui est exactement ce qui s'était passé.
 */

const TRAVERSAL = "../../System/Shutdown?";
const ITEM = "0123456789abcdef0123456789abcdef";
const USER = "fedcba9876543210fedcba9876543210";

describe("jellyfinIdSegment", () => {
  it("accepte les deux formes d'un identifiant Jellyfin", () => {
    expect(jellyfinIdSegment(ITEM)).toBe(ITEM);
    expect(jellyfinIdSegment("0123456789ABCDEF0123456789ABCDEF")).toBe("0123456789ABCDEF0123456789ABCDEF");
    expect(jellyfinIdSegment("01234567-89ab-cdef-0123-456789abcdef")).toBe("01234567-89ab-cdef-0123-456789abcdef");
  });

  it("refuse tout le reste", () => {
    for (const bad of [TRAVERSAL, "abc", "", `${ITEM}/..`, `${ITEM}?x`, "%2e%2e%2f", "0123456789abcdef0123456789abcde", undefined, null, 42]) {
      expect(() => jellyfinIdSegment(bad)).toThrow(/Identifiant Jellyfin invalide/);
    }
  });
});

describe("le client Jellyfin", () => {
  /**
   * Garde de source, à la manière de `decisions-partagees` : aucune URL du client ne concatène un
   * identifiant brut. Un nouvel appel écrit `${url}/Items/${itemId}` échoue ici, avant d'être la
   * prochaine traversée.
   */
  it("ne concatène aucun identifiant sans le faire passer par jellyfinIdSegment", () => {
    const source = readFileSync("src/lib/clients/jellyfin.ts", "utf8");
    const urls = source.match(/`\$\{url\}[^`]*`/g) ?? [];
    expect(urls.length).toBeGreaterThan(30);
    const raw = urls.filter((u) => /\$\{\s*[A-Za-z]*Id\s*\}/.test(u));
    expect(raw).toEqual([]);
  });

  it("refuse une traversée par une promesse rejetée, sans rien envoyer", async () => {
    vi.resetModules();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    // Une promesse rejetée et non une exception : les appelants écrivent `.catch(() => null)`, et
    // un `throw` synchrone passerait à travers.
    const calls = [
      () => jellyfin.markPlayed(USER, TRAVERSAL),
      () => jellyfin.markUnplayed(USER, TRAVERSAL),
      () => jellyfin.markFavorite(USER, TRAVERSAL),
      () => jellyfin.unmarkFavorite(USER, TRAVERSAL),
      () => jellyfin.savePositionAsAdmin(USER, TRAVERSAL, 0),
      () => jellyfin.resetPlaybackPosition(USER, TRAVERSAL),
      () => jellyfin.getItemNaming(USER, TRAVERSAL),
      () => jellyfin.getAllMovies(TRAVERSAL),
    ];
    for (const call of calls) {
      let promise: Promise<unknown> | undefined;
      expect(() => { promise = call(); }).not.toThrow();
      await expect(promise).rejects.toThrow(/Identifiant Jellyfin invalide/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

describe("les routes qui écrivent chez Jellyfin", () => {
  const mockJellyfin = {
    markPlayed: vi.fn(),
    markUnplayed: vi.fn(),
    markFavorite: vi.fn(),
    unmarkFavorite: vi.fn(),
    reportPlaybackStart: vi.fn(),
    reportPlaybackProgress: vi.fn(),
    reportPlaybackStopped: vi.fn(),
    savePositionAsAdmin: vi.fn(),
  };
  const mockVerify = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.doMock("@/lib/clients/jellyfin", () => ({ jellyfin: mockJellyfin }));
    vi.doMock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
    vi.doMock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));
    vi.doMock("@/lib/server-cache", () => ({ invalidateKey: vi.fn() }));
    vi.doMock("@/lib/config", () => ({ config: { player: { enabled: true }, jellyfin: { url: "http://jf.test", apiKey: "key" } } }));
    for (const fn of Object.values(mockJellyfin)) fn.mockReset();
    mockVerify.mockResolvedValue({ u: "mathis", role: "user", jfId: USER, jfToken: "tok" });
  });

  const req = (body: unknown) =>
    ({ cookies: { get: () => ({ value: "t" }) }, json: async () => body }) as unknown as NextRequest;
  const playback = { playSessionId: "s", mediaSourceId: "m", positionTicks: 1 };

  const routes: [string, string, Record<string, unknown>][] = [
    ["played", "@/app/api/jellyfin/played/route", { played: false }],
    ["favorite", "@/app/api/jellyfin/favorite/route", { favorite: false }],
    ["playback/playing", "@/app/api/jellyfin/playback/playing/route", playback],
    ["playback/progress", "@/app/api/jellyfin/playback/progress/route", playback],
    ["playback/stop", "@/app/api/jellyfin/playback/stop/route", playback],
  ];

  for (const [name, path, rest] of routes) {
    it(`${name} : 400 pour un itemId qui n'est pas un identifiant, sans appel`, async () => {
      const { POST } = (await import(/* @vite-ignore */ path)) as { POST: (r: NextRequest) => Promise<Response> };
      for (const itemId of [TRAVERSAL, "abc", 42]) {
        const res = await POST(req({ itemId, ...rest }));
        expect(res.status).toBe(400);
      }
      for (const fn of Object.values(mockJellyfin)) expect(fn).not.toHaveBeenCalled();
    });
  }

  it("played accepte toujours un vrai identifiant", async () => {
    mockJellyfin.markUnplayed.mockResolvedValue(undefined);
    const { POST } = await import("@/app/api/jellyfin/played/route");
    expect((await POST(req({ itemId: ITEM, played: false }))).status).toBe(200);
    expect(mockJellyfin.markUnplayed).toHaveBeenCalledWith(USER, ITEM);
  });
});

describe("stripAccessToken", () => {
  it("retire ApiKey et api_key où qu'ils soient dans la requête", () => {
    expect(stripAccessToken("?ApiKey=x&a=1")).toBe("?a=1");
    expect(stripAccessToken("?a=1&ApiKey=x")).toBe("?a=1");
    expect(stripAccessToken("?a=1&api_key=x&b=2")).toBe("?a=1&b=2");
    expect(stripAccessToken("?ApiKey=x")).toBe("");
    expect(stripAccessToken("?a=1&apikey=x&api_key=y")).toBe("?a=1");
  });

  it("ne touche ni à un paramètre voisin ni à une requête sans jeton", () => {
    expect(stripAccessToken("?MyApiKey=x&a=1")).toBe("?MyApiKey=x&a=1");
    expect(stripAccessToken("?DeviceId=x&PlaySessionId=p")).toBe("?DeviceId=x&PlaySessionId=p");
    expect(stripAccessToken("")).toBe("");
  });
});
