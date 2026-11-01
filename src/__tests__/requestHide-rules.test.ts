import { describe, expect, it } from "vitest";
import { autoChanges, buildView, hiddenKeys, nameSet, retag, summarize, titleKey, type HideRequest, type LibraryTitle } from "@/lib/requestHide/rules";
import type { RequestHideRow } from "@/lib/db";

const req = (key: string, requester: string, kept: boolean, createdAt = 1000): HideRequest => ({ key, requester, kept, createdAt });
const row = (key: string, state: "hidden" | "shown", source: "auto" | "manual"): RequestHideRow => ({ key, state, source, title: null, decidedAt: 1 });
const title = (key: string, tagged = false): LibraryTitle => ({ key, jfId: key.replace(/\D/g, ""), kind: "movie", name: key, year: 2020, imageTag: null, tagged });

describe("masquage des demandes — règles", () => {
  it("forme les clés, une série sans TMDB garde son TVDB", () => {
    expect(titleKey("movie", 603)).toBe("movie:603");
    expect(titleKey("series", "1399")).toBe("series:1399");
    expect(titleKey("series", null, 81189)).toBe("series-tvdb:81189");
    expect(titleKey("movie", 0)).toBeNull();
  });

  it("lit la liste des comptes gardés sans casse ni espaces", () => {
    expect([...nameSet(" Olivier, louis ,\nCharlotte,tv,")]).toEqual(["olivier", "louis", "charlotte", "tv"]);
  });

  it("un titre demandé par un compte gardé et un autre reste visible ; seul l'autre le rend candidat", () => {
    const s = summarize([req("movie:1", "lucas", false), req("movie:1", "louis", true), req("movie:2", "lucas", false), req("movie:2", "mathis", false)]);
    expect(s.get("movie:1")?.kept).toBe(true);
    expect(s.get("movie:2")).toMatchObject({ kept: false, requesters: ["lucas", "mathis"] });
    const view = buildView([title("movie:1"), title("movie:2"), title("movie:3")], s, []);
    expect(view.map((v) => v.status)).toEqual(["kept", "candidate", "free"]);
  });

  it("le passé reste visible : l'automatique ne masque que ce qui est demandé après son allumage", () => {
    const s = summarize([req("movie:1", "lucas", false, 500), req("movie:2", "lucas", false, 2000), req("movie:3", "louis", true, 2000)]);
    expect(autoChanges(s, [], null)).toEqual({ hide: [], drop: [] });
    expect(autoChanges(s, [], 1000)).toEqual({ hide: ["movie:2"], drop: [] });
  });

  it("une décision à la main l'emporte : un titre rendu visible n'est pas re-masqué", () => {
    const s = summarize([req("movie:2", "lucas", false, 2000)]);
    expect(autoChanges(s, [row("movie:2", "shown", "manual")], 1000).hide).toEqual([]);
  });

  it("un masquage automatique tombe si un compte gardé demande le titre ; un masquage à la main reste", () => {
    const s = summarize([req("movie:1", "lucas", false), req("movie:1", "louis", true), req("movie:2", "lucas", false), req("movie:2", "olivier", true)]);
    expect(autoChanges(s, [row("movie:1", "hidden", "auto"), row("movie:2", "hidden", "manual")], 1).drop).toEqual(["movie:1"]);
  });

  it("dit si Jellyfin a suivi la décision", () => {
    const rows = [row("movie:1", "hidden", "manual"), row("movie:2", "shown", "manual")];
    const view = buildView([title("movie:1", false), title("movie:2", true), title("movie:3", false)], summarize([]), rows);
    expect(view.map((v) => v.applied)).toEqual([false, false, true]);
    expect([...hiddenKeys(rows)]).toEqual(["movie:1"]);
  });

  it("pose et retire le tag sans toucher aux autres, casse ignorée", () => {
    expect(retag(["magic", "lucas"], "masque-demandes", true)).toEqual(["magic", "lucas", "masque-demandes"]);
    expect(retag(["magic", "Masque-Demandes"], "masque-demandes", true)).toBeNull();
    expect(retag(["magic", "Masque-Demandes"], "masque-demandes", false)).toEqual(["magic"]);
    expect(retag(null, "masque-demandes", false)).toBeNull();
  });
});
