// Les tags bloqués pendant une panne de Jellyfin (DECISIONS.md §92, §54) : la dernière réponse
// connue — mémoire, puis disque après un redémarrage —, et sinon les tags posés d'office aux nouveaux
// comptes (`NEW_ACCOUNT_BLOCKED_TAGS`) : jamais « tout titre étiqueté », qui vidait le catalogue
// (les mots-clés de TMDB sont des tags), ni « aucun » quand l'installation en déclare.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const settings = vi.hoisted(() => ({ newBlockedTags: "Prive, lk " }));
vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jellyfin.test:8096", apiKey: "k" }, accounts: settings } }));
vi.mock("@/lib/server-cache", () => ({ cachedJellyfinMoviesAdmin: async () => [], cachedJellyfinSeriesAdmin: async () => [] }));
vi.mock("@/lib/sonarrLink", () => ({ catalogueLinks: async () => new Map() }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => null }));

import { blockedTagsOf, carriesBlockedTag, forgetBlockedTags } from "@/lib/blockedTags";

const fetchMock = vi.fn();
/** Un identifiant Jellyfin valide (32 hexadécimaux), neuf à chaque test : la base est commune au fichier. */
const jfIdFor = (label: string) => (label + String(n)).split("").map((c) => c.charCodeAt(0).toString(16)).join("").padEnd(32, "0").slice(0, 32);
let n = 0;
beforeEach(() => {
  n += 1;
  forgetBlockedTags();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const user = (tags: string[]) => new Response(JSON.stringify({ Policy: { BlockedTags: tags } }), { status: 200, headers: { "content-type": "application/json" } });

describe("blockedTagsOf pendant une panne", () => {
  it("jamais vu, Jellyfin injoignable : les tags posés d'office aux nouveaux comptes, pas « tout titre étiqueté »", async () => {
    settings.newBlockedTags = "Prive, lk ";
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    const tags = await blockedTagsOf(jfIdFor("new"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tags).toEqual(["prive", "lk"]);
    expect(carriesBlockedTag(["Prive"], tags)).toBe(true);
    // Un mot-clé de TMDB n'est pas un blocage : le catalogue reste.
    expect(carriesBlockedTag(["based on novel or book", "murder"], tags)).toBe(false);
    expect(carriesBlockedTag([], tags)).toBe(false);
    expect(carriesBlockedTag(undefined, tags)).toBe(false);
  });

  it("sans tags d'office déclarés : aucun blocage supposé", async () => {
    settings.newBlockedTags = "";
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await blockedTagsOf(jfIdFor("none"))).toEqual([]);
    settings.newBlockedTags = "Prive, lk ";
  });

  it("déjà lu une fois, puis redémarrage pendant la panne : la copie sur disque", async () => {
    const id = jfIdFor("known");
    fetchMock.mockResolvedValueOnce(user(["Prive"]));
    expect(await blockedTagsOf(id)).toEqual(["prive"]);
    forgetBlockedTags(); // la mémoire d'un processus neuf
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    expect(await blockedTagsOf(id, Date.now() + 10 * 60_000)).toEqual(["prive"]);
  });

  it("un Jellyfin qui répond 500 ne vaut pas « aucun blocage »", async () => {
    fetchMock.mockResolvedValue(new Response("oops", { status: 500 }));
    expect(await blockedTagsOf(jfIdFor("five"))).toEqual(["prive", "lk"]);
  });
});
