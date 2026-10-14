// Les tags bloqués pendant une panne de Jellyfin (DECISIONS.md §92, §54) : la dernière réponse
// connue — mémoire, puis disque après un redémarrage —, et sinon *tout titre étiqueté caché*. Avant,
// un compte jamais vu recevait « aucun blocage », donc les titres réservés.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jellyfin.test:8096", apiKey: "k" } } }));
vi.mock("@/lib/server-cache", () => ({ cachedJellyfinMoviesAdmin: async () => [], cachedJellyfinSeriesAdmin: async () => [] }));
vi.mock("@/lib/sonarrLink", () => ({ catalogueLinks: async () => new Map() }));
vi.mock("@/lib/session", () => ({ verifySessionFull: async () => null }));

import { blockedTagsOf, carriesBlockedTag, forgetBlockedTags, UNKNOWN_BLOCKED_TAGS } from "@/lib/blockedTags";

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
  it("jamais vu, Jellyfin injoignable : inconnus — et tout titre étiqueté est tenu pour caché", async () => {
    fetchMock.mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    const tags = await blockedTagsOf(jfIdFor("new"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tags).toBe(UNKNOWN_BLOCKED_TAGS);
    expect(carriesBlockedTag(["Prive"], tags)).toBe(true);
    // Un titre sans tag ne peut être bloqué par aucun.
    expect(carriesBlockedTag([], tags)).toBe(false);
    expect(carriesBlockedTag(undefined, tags)).toBe(false);
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
    expect(await blockedTagsOf(jfIdFor("five"))).toBe(UNKNOWN_BLOCKED_TAGS);
  });
});
