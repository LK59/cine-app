import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DIRECT_INFO_FRESH_MS, directInfoForOpening, fetchDirectInfo, forgetDirectInfo } from "@/lib/directInfo";
import { directInfoKey } from "@/lib/playbackPrefetch";

/**
 * La description d'un fichier demandée d'avance ne sert jamais au-delà de cinq minutes.
 *
 * 30/09/2026, Android de Lucas : *Ted Lasso* S04E09 gardé sur l'appareil vers 07:02 (1080p),
 * remplacé par une 4K vers 07:20, ouvert à 07:32 sur la description de 07:02 — gardée par `preload`
 * de SWR jusqu'à ce que le lecteur la prenne. Elle s'accordait avec les octets de l'appareil, qui
 * ont donc été servis : l'ancien fichier.
 */

let version = "etag-1080p";
const fetchMock = vi.fn(async (_url: string) => ({ ok: true, json: async () => ({ streamUrl: "/s.mkv", sizeBytes: 1, fileVersion: version }) }));
const calls = () => fetchMock.mock.calls.length;

beforeEach(() => {
  forgetDirectInfo();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  version = "etag-1080p";
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("la description d'un fichier", () => {
  it("demandée pour le cache de reprise, n'est plus celle que le lecteur ouvre une demi-heure plus tard", async () => {
    await fetchDirectInfo("ted-lasso");
    version = "etag-4k";
    vi.setSystemTime(Date.now() + 30 * 60_000);
    expect((await directInfoForOpening("ted-lasso")).fileVersion).toBe("etag-4k");
    expect(calls()).toBe(2);
  });

  it("demandée par la fiche, sert l'ouverture qui suit sans reposer la question", async () => {
    const asked = fetchDirectInfo("film");
    // Lire pendant que la demande est en vol : la même, pas une seconde.
    await Promise.all([asked, directInfoForOpening("film")]);
    vi.setSystemTime(Date.now() + DIRECT_INFO_FRESH_MS - 1);
    await directInfoForOpening("film");
    expect(calls()).toBe(1);
    expect(fetchMock.mock.calls[0][0]).toBe(directInfoKey("film"));
  });

  it("n'est plus reprise passé cinq minutes", async () => {
    await fetchDirectInfo("film");
    vi.setSystemTime(Date.now() + DIRECT_INFO_FRESH_MS);
    await fetchDirectInfo("film");
    expect(calls()).toBe(2);
  });

  it("n'est jamais gardée après un échec, et l'ouverture repose la question une fois", async () => {
    fetchMock.mockImplementationOnce(async () => {
      throw new TypeError("Load failed");
    });
    const asked = fetchDirectInfo("coupure");
    const opening = directInfoForOpening("coupure");
    await expect(asked).rejects.toThrow("Load failed");
    expect((await opening).fileVersion).toBe("etag-1080p");
    expect(calls()).toBe(2);
  });

  it("est oubliée à la déconnexion", async () => {
    await fetchDirectInfo("film");
    forgetDirectInfo();
    await fetchDirectInfo("film");
    expect(calls()).toBe(2);
  });
});

/**
 * Pas de réseau à l'ouverture : une coupure, pas un fichier refusé.
 *
 * 07/10/2026, Mac de kab : la description préchargée n'est jamais arrivée, et le lecteur, la
 * croyant refusée, passait la main au lecteur serveur — qui avait besoin du même réseau.
 */
describe("une description perdue faute de réseau", () => {
  it("se dit coupure réseau, et n'est pas gardée pour l'essai suivant", async () => {
    const { isNetworkFailure } = await import("@/lib/webcodecs/byteSource");
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const failure = await directInfoForOpening("peaky").catch((e: unknown) => e);
    expect(isNetworkFailure(failure)).toBe(true);
    // Le réseau revenu, la question repart au serveur.
    expect((await directInfoForOpening("peaky")).streamUrl).toBe("/s.mkv");
  });

  it("une réponse du serveur en erreur reste une erreur du serveur", async () => {
    const { isNetworkFailure } = await import("@/lib/webcodecs/byteSource");
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({ error: "absent" }) } as never);
    const failure = await fetchDirectInfo("absent").catch((e: unknown) => e);
    expect(isNetworkFailure(failure)).toBe(false);
  });
});
