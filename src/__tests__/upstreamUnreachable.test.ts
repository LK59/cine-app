import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchJson, UpstreamUnreachableError, UPSTREAM_UNREACHABLE } from "@/lib/http";
import { withErrorHandling } from "@/lib/api-helpers";
import { isUpstreamUnreachable, withCode } from "@/lib/upstreamError";

vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));

afterEach(() => vi.unstubAllGlobals());

/**
 * Un service absent se dit autrement qu'un service qui répond de travers.
 *
 * Observé pendant une sauvegarde de Jellyfin : l'appel échouait sur une résolution de nom, `fetch`
 * levait un `TypeError: fetch failed`, et c'est ce texte-là que le spectateur recevait. L'interface
 * répondait — les catalogues sont en cache — et lancer un film ne faisait rien de compréhensible.
 */
describe("un amont injoignable", () => {
  it("devient une panne nommée plutôt qu'un « fetch failed »", async () => {
    vi.stubGlobal("fetch", async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    });
    const error = (await fetchJson("http://jellyfin.local:8096/System/Info").catch((e) => e)) as UpstreamUnreachableError;
    expect(error).toBeInstanceOf(UpstreamUnreachableError);
    expect(error.detail).toBe("ECONNREFUSED");
  });

  it("ne cite que l'hôte, jamais l'adresse entière", async () => {
    // Certaines adresses portent une clé d'API dans leur requête, et un message d'erreur voyage
    // jusqu'à l'écran et jusqu'au journal.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = (await fetchJson("https://api.example.com/3/movie/1?api_key=SECRET").catch((e) => e)) as UpstreamUnreachableError;
    expect(error.message).toContain("api.example.com");
    expect(error.message).not.toContain("SECRET");
  });

  it("dit le délai dépassé quand c'est nous qui avons renoncé", async () => {
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const error = (await fetchJson("http://jellyfin.local:8096/x", {}, 20).catch((e) => e)) as UpstreamUnreachableError;
    expect(error).toBeInstanceOf(UpstreamUnreachableError);
    expect(error.detail).toBe("délai dépassé");
  });

  it("laisse passer l'annulation de l'appelant, qui n'est pas une panne", async () => {
    const caller = new AbortController();
    vi.stubGlobal("fetch", (_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = fetchJson("http://jellyfin.local:8096/x", {}, 5000, caller.signal).catch((e) => e);
    caller.abort();
    expect(await pending).not.toBeInstanceOf(UpstreamUnreachableError);
  });

  it("arrive à l'écran avec un code, pas seulement une phrase", async () => {
    const res = await withErrorHandling(async () => {
      throw new UpstreamUnreachableError("jellyfin.local ne répond pas (ECONNREFUSED)", "ECONNREFUSED");
    });
    // Le statut ne bouge pas — 502 dit déjà « la faute est en amont » — mais il ne distingue pas
    // un service absent d'un service qui répond de travers. Le code, lui, se compare.
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe(UPSTREAM_UNREACHABLE);
  });

  it("n'ajoute pas ce code à une erreur qui n'en est pas une", async () => {
    const res = await withErrorHandling(async () => {
      throw new Error("quelque chose d'autre");
    });
    expect((await res.json()).code).toBeUndefined();
  });

  it("se reconnaît côté écran par le code et non par le texte", () => {
    // Une phrase se traduit et se réécrit ; un code se compare.
    expect(isUpstreamUnreachable(withCode(new Error("peu importe"), UPSTREAM_UNREACHABLE))).toBe(true);
    expect(isUpstreamUnreachable(new Error("jellyfin ne répond pas"))).toBe(false);
  });
});

/**
 * Les deux lecteurs disent la même chose de la même panne.
 *
 * Ils ont chacun leur chemin d'erreur — l'un lit une réponse SWR, l'autre une réponse `fetch` —
 * et c'est exactement le genre de décision qui dérive : corrigée d'un côté, oubliée de l'autre.
 */
describe("la même phrase des deux côtés", () => {
  it("la phrase est écrite à un seul endroit", async () => {
    const { readFileSync } = await import("fs");
    // Le lecteur natif y arrive par `errorMessage`, le stable en lisant le code de la réponse :
    // deux chemins, une seule phrase, et le jour où elle change elle change une fois.
    expect(readFileSync("src/lib/upstreamError.ts", "utf8")).toContain('t("player.libraryUnreachable")');
    expect(readFileSync("src/components/PlayerHost.tsx", "utf8")).toContain('t("player.libraryUnreachable")');
  });

  it("le lecteur natif ne passe pas la main quand c'est le serveur qui manque", async () => {
    const { readFileSync } = await import("fs");
    // Le lecteur stable a besoin du même Jellyfin : lui céder la place refait la même attente
    // avant d'afficher le même échec.
    expect(readFileSync("src/components/ExperimentalPlayerHost.tsx", "utf8")).toMatch(
      /if \(!isUpstreamUnreachable\(infoError\)\) \{\s*\n\s*fallToStable\(/
    );
  });
});

/**
 * Le catalogue aussi, et pas seulement le lecteur.
 *
 * Les routes du cinéma répondent par `cachedJson` — étiquette et compression — donc elles ne
 * passaient pas par `withErrorHandling` et n'avaient aucune gestion d'erreur du tout. Observé
 * pendant la migration de Jellyfin : la gestion encaissait la panne service par service et restait
 * lisible, le cinéma tombait en entier sur un « Erreur 500 » nu.
 */
describe("les écrans disent la même chose que le lecteur", () => {
  it.each([
    "src/app/api/cinema/movies/route.ts",
    "src/app/api/cinema/series/route.ts",
  ])("%s ne laisse pas une panne amont sortir en 500", async (file) => {
    const { readFileSync } = await import("fs");
    expect(readFileSync(file, "utf8")).toContain("upstreamFailure(err,");
  });

  it.each([
    "src/components/cinema/CinemaClient.tsx",
    "src/components/cinema/mobile/CinemaMobileClient.tsx",
    "src/components/ExperimentalPlayerHost.tsx",
  ])("%s passe par la phrase partagée plutôt que par la sienne", async (file) => {
    const { readFileSync } = await import("fs");
    expect(readFileSync(file, "utf8")).toMatch(/errorMessage\(\w+, t,/);
  });
});
