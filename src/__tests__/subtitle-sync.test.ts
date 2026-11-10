import { describe, it, expect } from "vitest";
import {
  cueLookupTime,
  isNeutralSync,
  rewriteVttTimes,
  startingOffset,
  subSyncFromTracks,
  subSyncLogField,
  subtitleTrackKey,
} from "@/lib/subtitleSync";
import { syncForChoice } from "@/components/playerNative/useNativeSubtitleLanes";
import { parseScope, parseAction, parseScanScope } from "@/lib/subtitleSync/scope";
import { fmtDrift, fmtOffset } from "@/components/settings/SubtitleSyncCard";

/**
 * « Synchro des sous-titres » (DECISIONS.md §141), ce qui est pur : la recherche de ligne du lecteur natif —
 * à l'échelle 1, **le calcul d'avant au bit près** (les empreintes du lecteur en dépendent) —, la réécriture du
 * WebVTT pour le lecteur serveur et les téléchargements, la clé des pistes, la ligne du journal, les portées.
 */

describe("cueLookupTime", () => {
  it("à l'échelle 1 refait exactement les calculs d'avant, bit pour bit", () => {
    // Des valeurs au hasard, mais reproductibles : un générateur congruentiel.
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 20_000; i++) {
      const p = rnd() * 9000;
      const fileDelay = rnd() < 0.5 ? 0 : rnd() * 3 - 1;
      const offset = Math.round((rnd() * 20 - 10) * 10) / 10;
      // Fichier à côté du film : `textAt(at − fileDelay)` avec `at = p − offset`.
      expect(cueLookupTime(p, fileDelay, offset, 1, true)).toBe(p - offset - fileDelay);
      // Piste du conteneur : `fromContainer(at)`.
      expect(cueLookupTime(p, fileDelay, offset, 1, false)).toBe(p - offset);
    }
  });

  it("applique le modèle t_parole = a + s·t_sous-titre sur l'horloge du fichier", () => {
    const s = 25 / (24000 / 1001);
    // Une réplique datée 1000 s dans le sous-titre tombe à 2,5 + s·1000 dans le fichier.
    const fileTime = 2.5 + s * 1000;
    expect(cueLookupTime(fileTime, 0, 2.5, s, true)).toBeCloseTo(1000, 9);
    // Avec un écart d'horloge : le lecteur est en avance de 0,4 s sur le fichier.
    expect(cueLookupTime(fileTime + 0.4, 0.4, 2.5, s, true)).toBeCloseTo(1000, 9);
    // Une piste du conteneur est datée sur l'horloge du lecteur : `fileDelay + …`.
    expect(cueLookupTime(fileTime + 0.4, 0.4, 2.5, s, false)).toBeCloseTo(1000.4, 9);
  });

  it("une échelle illisible vaut 1", () => {
    expect(cueLookupTime(100, 0, 2, 0, true)).toBe(98);
    expect(cueLookupTime(100, 0, 2, Number.NaN, false)).toBe(98);
  });
});

describe("la correction de départ", () => {
  it("part de zéro sans correction, et de la correction au centième sinon", () => {
    expect(startingOffset(null)).toBe(0);
    expect(startingOffset({ offset: 0, scale: 1 })).toBe(0);
    expect(startingOffset({ offset: 2.4567, scale: 1 })).toBe(2.46);
    expect(isNeutralSync({ offset: 0, scale: 1 })).toBe(true);
    expect(isNeutralSync({ offset: 0, scale: 1.001 })).toBe(false);
    expect(isNeutralSync({ offset: Number.NaN, scale: 1 })).toBe(true);
  });

  it("retrouve la correction d'une piste du conteneur par son rang, d'un fichier à côté par son index", () => {
    const held = { byIndex: { "3": { offset: 2, scale: 1 }, "7": { offset: -1, scale: 25 / 24 } }, embedded: [2, 3] };
    const fileTracks = [
      { number: 5, codecId: "S_TEXT/UTF8", language: "fre", name: null, isDefault: false, isForced: false },
      { number: 6, codecId: "S_TEXT/UTF8", language: "eng", name: null, isDefault: false, isForced: false },
    ];
    const sources = [{ id: -8, url: "/api/jellyfin/stream/subtitle/x?mediaSourceId=y&index=7" }];
    let asked = 0;
    const tracks = () => {
      asked++;
      return fileTracks;
    };
    expect(syncForChoice(6, held, tracks, sources)).toEqual({ offset: 2, scale: 1 });
    expect(syncForChoice(5, held, tracks, sources)).toBeNull();
    expect(syncForChoice(-8, held, tracks, sources)).toEqual({ offset: -1, scale: 25 / 24 });
    expect(syncForChoice(null, held, tracks, sources)).toBeNull();
    // Sans correction pour ce fichier : les pistes ne sont même pas lues.
    asked = 0;
    expect(syncForChoice(6, null, tracks, sources)).toBeNull();
    expect(asked).toBe(0);
  });
});

describe("rewriteVttTimes", () => {
  const vtt = "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.500 line:90%\nBonjour\n\n00:59.5 --> 01:00.250\nLà\n";

  it("porte chaque temps en a + s·t, garde tout le reste", () => {
    const out = rewriteVttTimes(vtt, { offset: 2, scale: 1 });
    expect(out).toBe("WEBVTT\n\n1\n00:00:03.000 --> 00:00:04.500 line:90%\nBonjour\n\n00:01:01.500 --> 00:01:02.250\nLà\n");
    const drift = rewriteVttTimes("00:16:40.000 --> 00:16:41.000\nX", { offset: 0, scale: 25 / 24 });
    expect(drift).toBe("00:17:21.667 --> 00:17:22.708\nX");
  });

  it("ramène à zéro ce qui tomberait avant, et laisse un fichier intact sans correction", () => {
    expect(rewriteVttTimes("00:00:01.000 --> 00:00:02.000\nX", { offset: -5, scale: 1 })).toBe("00:00:00.000 --> 00:00:00.000\nX");
    expect(rewriteVttTimes(vtt, { offset: 0, scale: 1 })).toBe(vtt);
  });
});

describe("clés, journal, portées", () => {
  it("nomme une piste du conteneur par son index, un fichier à côté par son chemin", () => {
    expect(subtitleTrackKey({ Index: 4 })).toBe("emb:4");
    expect(subtitleTrackKey({ Index: 9, IsExternal: true, Path: "/media/movies/X/X.fr.srt" })).toBe("ext:/media/movies/X/X.fr.srt");
    expect(subtitleTrackKey({ Index: 9, IsExternal: true })).toBeNull();
  });

  it("écrit `subSync` seulement quand une correction est appliquée", () => {
    expect(subSyncLogField(undefined)).toEqual({});
    expect(subSyncLogField({ "3": { offset: 0, scale: 1 } })).toEqual({});
    expect(subSyncLogField({ "3": { offset: 2.444, scale: 1 }, "7": { offset: -1.2, scale: 25 / 24, label: "25→24" } })).toEqual({
      subSync: "3:+2.44s, 7:-1.2s×25→24",
    });
    expect(subSyncFromTracks([{ index: 2 }, { index: 3, sync: { offset: 1, scale: 1 } }])).toEqual({ subSync: "3:+1s" });
    expect(subSyncFromTracks(undefined)).toEqual({});
  });

  it("lit les portées et refuse le reste", () => {
    const id = "a".repeat(32);
    expect(parseScope({ scope: "item", itemId: id }, false)).toEqual({ scope: "item", itemId: id });
    expect(parseScope({ scope: "season", seriesId: id, season: 2 }, false)).toEqual({ scope: "season", seriesId: id, season: 2 });
    expect(parseScope({ scope: "season", seriesId: id, season: "2" }, false)).toBeNull();
    expect(parseScope({ scope: "movies", itemIds: [id] }, false)).toEqual({ scope: "movies", itemIds: [id] });
    expect(parseScope({ scope: "movies", itemIds: ["../etc"] }, false)).toBeNull();
    expect(parseScope({ scope: "track", itemId: id, trackKey: "emb:3" }, true)).toEqual({ scope: "track", itemId: id, trackKey: "emb:3" });
    expect(parseScope({ scope: "track", itemId: id, trackKey: "emb:3" }, false)).toBeNull();
    expect(parseScope({ scope: "track", itemId: id, trackKey: "rm -rf" }, true)).toBeNull();
    expect(parseScanScope({ scope: "track", itemId: id, trackKey: "emb:3" })).toBeNull();
    expect(parseAction("apply")).toBe("apply");
    expect(parseAction("delete")).toBeNull();
  });

  it("affiche un décalage signé et une dérive par son nom", () => {
    expect(fmtOffset(null)).toBe("—");
    expect(fmtOffset(0)).toMatch(/^0[.,]00 s$/);
    expect(fmtOffset(-2.444)).toMatch(/^−2[.,]44 s$/);
    expect(fmtDrift(1, "1")).toBeNull();
    expect(fmtDrift(25 / 24, "25→24")).toBe("25→24");
    expect(fmtDrift(1.0005, null)).toBe("500 ppm");
  });
});
