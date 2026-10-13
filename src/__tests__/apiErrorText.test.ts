import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import type { NextRequest } from "next/server";
import { createT, type Locale } from "@/lib/i18n";
import { apiAction } from "@/lib/apiAction";
import { apiErrorText } from "@/lib/apiErrorText";
import { API_ERROR_CODES } from "@/lib/apiErrorCodes";
import { HttpError } from "@/lib/http";

/**
 * Les refus du serveur, dans la langue du compte (13/10/2026).
 *
 * Les routes écrivent leurs refus en français ; un compte en anglais voyait « Le nouveau mot de
 * passe est identique à l'actuel ». Chaque cas suit le vrai chemin : la route répond, `apiAction`
 * lève comme dans l'écran, `apiErrorText` dit ce que le toast affiche.
 */

vi.mock("@/lib/config", () => ({ config: { jellyseerr: { apiKey: "k" }, tmdb: { apiKey: "k" } } }));
vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));

const mockVerify = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerify(...a) }));

const jellyseerr = {
  getTvMedia: vi.fn(),
  createRequest: vi.fn(),
  getMe: vi.fn(),
  getUsers: vi.fn(),
  importFromJellyfin: vi.fn(),
};
vi.mock("@/lib/clients/jellyseerr", () => ({ jellyseerr }));

const jellyfin = { changePassword: vi.fn() };
vi.mock("@/lib/clients/jellyfin", () => ({ jellyfin }));

vi.mock("@/lib/clients/tmdb", () => ({
  tmdb: { isEnabled: () => false },
  createTmdbClient: () => ({ isEnabled: () => false }),
  TMDB_IMAGE_BASE: "https://image.tmdb.org/t/p",
}));

const watchlistDb = { get: vi.fn(), getAll: vi.fn(), upsert: vi.fn(), remove: vi.fn() };
vi.mock("@/lib/db", () => ({ watchlistDb, pendingRequestDb: { add: vi.fn() } }));

const dict = (l: Locale) => JSON.parse(readFileSync(`src/locales/${l}.json`, "utf8")) as Record<string, unknown>;
const fr = dict("fr");
const tFor = (l: Locale) => createT(dict(l), fr, l);
const tEn = tFor("en");

function jsonReq(body: unknown): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
    nextUrl: { searchParams: new URLSearchParams() },
    json: async () => body,
  } as unknown as NextRequest;
}

/** Ce que le toast d'un compte affiche quand `apiAction` reçoit cette réponse. */
async function shownFor(res: Response, locale: Locale): Promise<string> {
  vi.stubGlobal("fetch", vi.fn(async () => res));
  const caught = await apiAction("/api/x", { method: "POST", body: "{}" }).then(
    () => null,
    (e: unknown) => e
  );
  expect(caught).toBeInstanceOf(Error);
  return apiErrorText(caught, tFor(locale), locale);
}

beforeEach(async () => {
  vi.clearAllMocks();
  (await import("@/lib/jellyseerrIdentity")).resetJellyseerrIdentityCache();
  mockVerify.mockResolvedValue({ u: "anna", jfId: "jf-anna", jfUser: "anna", jfToken: "tok", role: "user", jsCookie: "s%3Aanna" });
  jellyseerr.getMe.mockResolvedValue({ id: 5 });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("un compte en anglais lit l'anglais", () => {
  it("mot de passe identique", async () => {
    const { POST } = await import("@/app/api/player/account/password/route");
    const res = await POST(jsonReq({ currentPassword: "abcdefgh", newPassword: "abcdefgh" }));
    expect(res.status).toBe(400);
    expect(await shownFor(res, "en")).toBe("The new password is the same as the current one.");
    expect(jellyfin.changePassword).not.toHaveBeenCalled();
  });

  it("mot de passe actuel refusé par Jellyfin", async () => {
    jellyfin.changePassword.mockRejectedValue(new HttpError("403 Forbidden: Invalid user or password entered.", 403));
    const { POST } = await import("@/app/api/player/account/password/route");
    const res = await POST(jsonReq({ currentPassword: "wrongpass", newPassword: "abcdefgh" }));
    expect(res.status).toBe(403);
    expect(await shownFor(res, "en")).toBe("Your current password is incorrect.");
  });

  it("demande refusée : déjà demandée", async () => {
    jellyseerr.createRequest.mockRejectedValue(
      new HttpError('409 Conflict: {"message":"Request for this media already exists."}', 409)
    );
    const { POST } = await import("@/app/api/player/requests/route");
    const res = await POST(jsonReq({ type: "movie", tmdbId: 603 }));
    expect(res.status).toBe(409);
    expect(await shownFor(res, "en")).toBe("This title has already been requested.");
  });

  it("demande refusée : quota atteint (route de la recherche)", async () => {
    jellyseerr.createRequest.mockRejectedValue(new HttpError('403 Forbidden: {"message":"Movie Quota exceeded."}', 403));
    const { POST } = await import("@/app/api/jellyseerr/requests/route");
    const res = await POST(jsonReq({ mediaType: "movie", mediaId: 603 }));
    expect(res.status).toBe(403);
    expect(await shownFor(res, "en")).toBe("You've reached your request limit. Try again later.");
  });

  it("demande impossible : compte pas encore reconnu", async () => {
    mockVerify.mockResolvedValue({ u: "sarah", jfId: "jf-sarah", jfUser: "sarah", role: "user" });
    jellyseerr.getUsers.mockResolvedValue({ results: [] });
    jellyseerr.importFromJellyfin.mockRejectedValue(new Error("500"));
    const { POST } = await import("@/app/api/player/requests/route");
    const res = await POST(jsonReq({ type: "movie", tmdbId: 603 }));
    expect(res.status).toBe(503);
    expect(await shownFor(res, "en")).toBe("Your account isn't ready for requests yet. Try again in a moment.");
  });

  it("Ma liste : retirer un titre qui n'y est plus", async () => {
    watchlistDb.get.mockReturnValue(undefined);
    const { DELETE } = await import("@/app/api/watchlist/route");
    const res = await DELETE(jsonReq({ tmdbId: 603, mediaType: "movie" }));
    expect(res.status).toBe(404);
    expect(await shownFor(res, "en")).toBe("This title isn't in your list.");
  });

  it("Ma liste : un ajout illisible", async () => {
    const { POST } = await import("@/app/api/watchlist/route");
    const res = await POST(jsonReq({ mediaType: "album", tmdbId: 1, title: "x" }));
    expect(res.status).toBe(400);
    expect(await shownFor(res, "en")).toBe("Invalid request.");
  });

  it("le journal et l'administration gardent la phrase française", async () => {
    const { POST } = await import("@/app/api/player/account/password/route");
    const res = await POST(jsonReq({ currentPassword: "abcdefgh", newPassword: "abcdefgh" }));
    expect(await res.json()).toEqual({ error: "Le nouveau mot de passe est identique à l'actuel", code: "same_password" });
  });
});

describe("un message sans code", () => {
  const french = () => new Response(JSON.stringify({ error: "Paramètres manquants côté serveur" }), { status: 400 });

  it.each(["en", "es", "de"] as const)("ne laisse passer aucun français en %s", async (locale) => {
    const shown = await shownFor(french(), locale);
    expect(shown).not.toContain("Paramètres");
    expect(shown).toBe(tFor(locale)("errors.generic"));
  });

  it("garde le repli précis de l'écran quand il y en a un", () => {
    expect(apiErrorText(new Error("Erreur Jellyfin"), tEn, "en", "Couldn't add it")).toBe("Couldn't add it");
  });

  it("reste cité tel quel à un compte en français, comme avant", async () => {
    expect(await shownFor(french(), "fr")).toBe("Paramètres manquants côté serveur");
  });

  it("une panne réseau du navigateur ne cite rien non plus", () => {
    expect(apiErrorText(new TypeError("Failed to fetch"), tEn, "en")).toBe("Something went wrong. Please try again.");
  });
});

describe("les codes", () => {
  it.each(["fr", "en", "es", "de"] as const)("ont tous leur texte en %s", (locale) => {
    const codes = (dict(locale).errors as { codes: Record<string, string> }).codes;
    for (const code of API_ERROR_CODES) expect(codes[code], code).toBeTruthy();
    expect(Object.keys(codes).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it("un 401 de Jellyseerr n'est pas un refus de la demande", async () => {
    const { withRequestRefusalCode } = await import("@/lib/requestRefusal");
    expect((withRequestRefusalCode(new HttpError("401", 401)) as HttpError).code).toBeUndefined();
    expect((withRequestRefusalCode(new HttpError("403 nope", 403)) as HttpError).code).toBe("request_refused");
  });
});
