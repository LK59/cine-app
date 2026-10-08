import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Les tags bloqués d'office pour un compte Jellyfin découvert (§56) : le premier passage ne fait
 * que noter les comptes présents, les suivants bloquent les nouveaux — jamais un administrateur,
 * jamais deux fois.
 */
const known = new Set<string>();
vi.mock("@/lib/db", () => ({
  knownAccountsDb: {
    isEmpty: () => known.size === 0,
    has: (id: string) => known.has(id),
    addAll: (ids: string[]) => ids.forEach((id) => known.add(id)),
  },
}));
vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "k" }, accounts: { newBlockedTags: "prive" } } }));
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/blockedTags", () => ({ forgetBlockedTags: vi.fn() }));

import { applyNewAccountTags, newAccountTags, withTags } from "@/lib/newAccountTags";

let users: { Id: string; Name: string; Policy: Record<string, unknown> }[] = [];
const posted: { url: string; body: { BlockedTags: string[] } }[] = [];
beforeEach(() => {
  known.clear();
  posted.length = 0;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posted.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, status: 204 };
    }
    return { ok: true, status: 200, json: async () => users };
  }));
});

describe("les tags des nouveaux comptes", () => {
  it("ne touche à rien au premier passage : les comptes présents sont seulement notés", async () => {
    users = [{ Id: "louis", Name: "louis", Policy: { BlockedTags: [] } }, { Id: "kab", Name: "kab", Policy: { BlockedTags: [] } }];
    expect((await applyNewAccountTags()).tagged).toEqual([]);
    expect(posted).toEqual([]);
    expect(known.has("kab")).toBe(true);
  });

  it("bloque un compte créé ensuite, une seule fois, et jamais un administrateur", async () => {
    users = [{ Id: "louis", Name: "louis", Policy: { BlockedTags: [] } }];
    await applyNewAccountTags();
    users.push({ Id: "0123456789abcdef0123456789abcdef", Name: "nouveau", Policy: { BlockedTags: ["lk"], EnableAllFolders: true } });
    users.push({ Id: "fedcba9876543210fedcba9876543210", Name: "admin2", Policy: { IsAdministrator: true, BlockedTags: [] } });
    expect((await applyNewAccountTags()).tagged).toEqual(["nouveau"]);
    expect(posted).toHaveLength(1);
    expect(posted[0].body.BlockedTags).toEqual(["lk", "prive"]);
    // Le reste de la politique est renvoyé tel quel.
    expect((posted[0].body as unknown as { EnableAllFolders: boolean }).EnableAllFolders).toBe(true);
    // Repassé : rien de plus — un blocage retiré ensuite à la main reste retiré.
    await applyNewAccountTags();
    expect(posted).toHaveLength(1);
  });

  it("lit le réglage en liste, et ignore un tag déjà posé quelle que soit la casse", () => {
    expect(newAccountTags(" prive, autre ,,prive")).toEqual(["prive", "autre"]);
    expect(withTags({ BlockedTags: ["PRIVE"] }, ["prive"])).toBeNull();
  });
});
