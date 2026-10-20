// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SESSION_EXPIRED_HEADER, noteUnauthorized, resetSessionExpiredForTests } from "@/lib/sessionExpired";

function res(headers: Record<string, string>): Response {
  return { headers: new Headers(headers) } as Response;
}

let replace: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetSessionExpiredForTests();
  replace = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { pathname: "/", search: "", replace },
  });
});

describe("noteUnauthorized", () => {
  it("renvoie à la connexion, en gardant la place", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/gestion", search: "?onglet=disques", replace },
    });
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalledWith("/login?reason=expired&next=%2Fgestion%3Fonglet%3Ddisques"));
  });

  // ROBUSTESSE-3 (15/10/2026) : la fiche ouverte vit dans le fragment, et `next` n'emportait que
  // le chemin — on revenait sur l'accueil après la reconnexion, sans savoir pourquoi on en était parti.
  it("emporte la fiche ouverte (le fragment) et dit pourquoi (DECISIONS §101)", async () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/", search: "", hash: "#film=920&tab=movies", replace },
    });
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    const url = new URL(replace.mock.calls[0][0] as string, "https://cine.invalid");
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("reason")).toBe("expired");
    expect(url.searchParams.get("next")).toBe("/#film=920&tab=movies");
  });

  it("ignore un 401 qui ne vient pas de la session — un service amont, une clé d'API", () => {
    noteUnauthorized(res({}));
    expect(replace).not.toHaveBeenCalled();
  });

  it("ne redirige qu'une fois, quel que soit le nombre de requêtes en vol", async () => {
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("ne boucle pas depuis la page de connexion, qui appelle des routes protégées", () => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { pathname: "/login", search: "", replace },
    });
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    expect(replace).not.toHaveBeenCalled();
  });

  it("ne lève pas sur une réponse sans en-têtes, pour ne pas effacer le message du serveur", () => {
    expect(() => noteUnauthorized({} as Response)).not.toThrow();
    expect(replace).not.toHaveBeenCalled();
  });
});

/**
 * Une page publique ne part pas vers la connexion.
 *
 * La racine monte le lecteur partout, et il demande les préférences de l'utilisateur : sur une
 * page qui n'exige pas de session, ce 401 est la réponse normale. La garde n'excusait d'abord que
 * `/login`, et la page d'état — publique, et justement celle qu'on consulte quand on n'arrive pas
 * à se connecter — repartait donc aussitôt vers la connexion.
 */
describe("les pages publiques", () => {
  it.each(["/login", "/status", "/status/details"])("%s ne redirige pas", (pathname) => {
    const replace2 = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { pathname, search: "", replace: replace2 } });
    resetSessionExpiredForTests();
    noteUnauthorized({ headers: new Headers({ [SESSION_EXPIRED_HEADER]: "1" }) } as Response);
    expect(replace2).not.toHaveBeenCalled();
  });

  it("une page privée redirige toujours", async () => {
    const replace2 = vi.fn();
    Object.defineProperty(window, "location", { configurable: true, value: { pathname: "/gestion", search: "", replace: replace2 } });
    resetSessionExpiredForTests();
    noteUnauthorized({ headers: new Headers({ [SESSION_EXPIRED_HEADER]: "1" }) } as Response);
    await vi.waitFor(() => expect(replace2).toHaveBeenCalledOnce());
  });
});

/**
 * Une session qui disparaît sous la page efface ce que l'appareil garde du compte, comme le bouton.
 *
 * Revue de sécurité du 20/10/2026 : seul « Se déconnecter » nettoyait. Une session expirée (sept
 * jours) ou fermée depuis un autre appareil laissait, sur un iPad partagé, le catalogue, les
 * recherches et l'abonnement aux notifications du compte précédent à qui se connectait ensuite.
 * Les téléchargements hors ligne, eux, restent — et l'entrée qui les montre aussi : la question
 * n'est posée qu'à la déconnexion volontaire.
 */
describe("l'appareil oublie le compte avant de partir", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    delete (navigator as unknown as { serviceWorker?: unknown }).serviceWorker;
  });

  it("catalogue, recherches, notifications effacés ; entrée hors ligne gardée", async () => {
    const { fakeIndexedDb } = await import("./helpers/fakeIndexedDb");
    const cache = await import("@/lib/persistentCache");
    cache.resetPersistentCacheForTests();
    vi.stubGlobal("indexedDB", fakeIndexedDb());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    await cache.writeEntries([{ account: "louis", key: "/api/jellyfin/resume", savedAt: Date.now(), schema: cache.PERSISTED_CACHE_SCHEMA, data: { items: [] } }]);
    localStorage.setItem("cine.player.recentSearches", JSON.stringify(["dune"]));
    localStorage.setItem("cine-offline-entry", "louis");
    const unsubscribe = vi.fn().mockResolvedValue(true);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ endpoint: "https://push.example/x", unsubscribe }) } }) },
    });

    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled());

    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(await cache.readAccountCache("louis")).toEqual([]);
    expect(localStorage.getItem("cine.player.recentSearches")).toBeNull();
    expect(localStorage.getItem("cine-offline-entry")).toBe("louis");
    cache.resetPersistentCacheForTests();
    localStorage.clear();
  });

  it("un effacement qui ne finit pas ne retient pas la redirection plus d'une seconde", async () => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      // Un navigateur dont le worker ne répond jamais.
      value: { getRegistration: () => new Promise(() => {}) },
    });
    const started = Date.now();
    noteUnauthorized(res({ [SESSION_EXPIRED_HEADER]: "1" }));
    await vi.waitFor(() => expect(replace).toHaveBeenCalled(), { timeout: 3000 });
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
