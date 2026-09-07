import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ SESSION_COOKIE: "cine_session" }));
const mockVerifySessionFull = vi.fn();
vi.mock("@/lib/session", () => ({ verifySessionFull: (...a: unknown[]) => mockVerifySessionFull(...a) }));
const mockUserData = vi.fn();
const mockUserConfig = vi.fn();
vi.mock("@/lib/clients/jellyfin", () => ({
  jellyfin: {
    getItemUserData: (...a: unknown[]) => mockUserData(...a),
    getUserConfiguration: (...a: unknown[]) => mockUserConfig(...a),
  },
}));

const validId = "c".repeat(32);

function fakeReq(): NextRequest {
  return {
    cookies: { get: (n: string) => (n === "cine_session" ? { value: "t" } : undefined) },
  } as unknown as NextRequest;
}

async function get(itemId = validId) {
  const { GET } = await import("@/app/api/jellyfin/playback-state/[itemId]/route");
  return GET(fakeReq(), { params: Promise.resolve({ itemId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", jfToken: "jt", id: 7 });
  mockUserData.mockResolvedValue({ UserData: { PlaybackPositionTicks: 0 } });
  mockUserConfig.mockResolvedValue({ Configuration: null });
});

/**
 * La route qui ne répond que de ce qui change.
 *
 * Ces trois premiers cas vivaient dans les tests de `/api/jellyfin/direct` : ils ont suivi les
 * deux champs qu'ils décrivent. Le fichier ne change jamais, le spectateur si — et les mélanger
 * gelait les préférences de langue jusqu'au rechargement de la page.
 */
describe("l'état du spectateur", () => {
  it("transmet les préférences de langue du compte", async () => {
    mockUserConfig.mockResolvedValue({
      Configuration: {
        AudioLanguagePreference: "fra",
        SubtitleLanguagePreference: "fra",
        SubtitleMode: "OnlyForced",
        PlayDefaultAudioTrack: false,
      },
    });
    const body = await (await get()).json();
    expect(body.preferences).toEqual({
      audioLanguage: "fra",
      subtitleLanguage: "fra",
      subtitleMode: "OnlyForced",
      playDefaultAudioTrack: false,
    });
  });

  it("ne demande pas les préférences d'un compte sans jeton Jellyfin", async () => {
    // Their settings are read with their own token; without one there is nobody to ask about.
    mockVerifySessionFull.mockResolvedValue({ jfId: "jf-1", id: 7 });
    const body = await (await get()).json();
    expect(mockUserConfig).not.toHaveBeenCalled();
    expect(body.preferences).toBeNull();
  });

  it("répond quand même quand le serveur ne dit rien des langues", async () => {
    // A server that will not answer about someone's languages is a reason to open the file on
    // its own defaults, not a reason to refuse to play it.
    mockUserConfig.mockRejectedValue(new Error("indisponible"));
    const body = await (await get()).json();
    expect(body.preferences).toBeNull();
    expect(body.resumeSeconds).toBe(0);
  });

  it("donne la position en secondes", async () => {
    mockUserData.mockResolvedValue({ UserData: { PlaybackPositionTicks: 22_852_863_837 } });
    const body = await (await get()).json();
    expect(body.resumeSeconds).toBeCloseTo(2285.2863837, 4);
  });

  // Le film s'ouvre à son début plutôt que de ne pas s'ouvrir : c'est le raisonnement que tient
  // déjà tout ce chemin quand Jellyfin ne répond pas.
  it("répond zéro quand Jellyfin ne dit rien de l'élément", async () => {
    mockUserData.mockRejectedValue(new Error("indisponible"));
    const body = await (await get()).json();
    expect(body.resumeSeconds).toBe(0);
  });

  // L'administrateur local n'a pas d'identité Jellyfin : il n'y a ni position ni préférences, et
  // c'est une réponse valable.
  it("répond sans position pour une session sans compte Jellyfin", async () => {
    mockVerifySessionFull.mockResolvedValue({ id: 7 });
    const body = await (await get()).json();
    expect(body).toEqual({ resumeSeconds: 0, preferences: null });
    expect(mockUserData).not.toHaveBeenCalled();
  });

  it("refuse un identifiant qui n'en est pas un", async () => {
    expect((await get("pas-un-id")).status).toBe(400);
    expect(mockVerifySessionFull).not.toHaveBeenCalled();
  });
});
