import { describe, expect, it } from "vitest";
import { carriesBlockedTag, withoutHidden } from "@/lib/blockedTags";

// Un titre réservé à certains comptes n'existe pas pour les autres (DECISIONS.md §54) : le
// catalogue retire ce que les tags bloqués d'un compte lui cachent, avec la règle de Jellyfin.
describe("carriesBlockedTag — la comparaison de Jellyfin", () => {
  it("ignore la casse, et rien d'autre", () => {
    expect(carriesBlockedTag(["one-man show", "Prive"], ["prive"])).toBe(true);
    expect(carriesBlockedTag(["prive"], ["lk "])).toBe(false);
    expect(carriesBlockedTag(["privé"], ["prive"])).toBe(false);
  });
  it("rien de bloqué, ou un élément sans tag : rien de caché", () => {
    expect(carriesBlockedTag(["prive"], [])).toBe(false);
    expect(carriesBlockedTag(undefined, ["prive"])).toBe(false);
  });
});

describe("withoutHidden — le titre disparaît partout", () => {
  const wire = {
    items: [{ id: 1 }, { id: 2 }, { id: 3 }],
    rows: { Comedy: [1, 2], Drama: [2] },
    genres: ["Comedy", "Drama"],
    spotlight: [2, 3],
    recentlyAdded: [2, 1],
    top10: [3, 2, 1],
    top10Theme: null,
  };
  it("des titres, des rangées, de la sélection, des ajouts, du classement — et le genre vidé", () => {
    const out = withoutHidden(wire, new Set([2]), (i) => i.id);
    expect(out.items.map((i) => i.id)).toEqual([1, 3]);
    expect(out.rows).toEqual({ Comedy: [1] });
    expect(out.genres).toEqual(["Comedy"]);
    expect(out.spotlight).toEqual([3]);
    expect(out.recentlyAdded).toEqual([1]);
    expect(out.top10).toEqual([3, 1]);
    expect(out.top10Theme).toBeNull();
  });
  it("rien à cacher : la même charge utile", () => {
    expect(withoutHidden(wire, new Set(), (i) => i.id)).toBe(wire);
  });
});
