import { describe, it, expect, beforeEach, vi } from "vitest";

// Sa propre base : ce fichier vide `subtitle_sync` à chaque test (voir news-page-105.test.ts).
await vi.hoisted(async () => {
  const fsp = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env.DATA_DIR = fsp.mkdtempSync(p.join(os.tmpdir(), "laterna-subsync-"));
});

import { getDb } from "@/lib/db";
import { appliedFor, decide, passSummary, recordJob, recordMeasurement, rowsForItems, subtitleSyncByIndex, finishJob, pendingJobs } from "@/lib/subtitleSync/store";
import type { XraySubsyncTrack } from "@/lib/clients/xray";

/**
 * Ce que `cine.db` retient de la synchro des sous-titres (DECISIONS.md §141) : une décision ne survit qu'à la
 * même mesure du même fichier ; une correction n'est lue que pour la version actuelle du fichier ; une saison ou
 * une série ne recale que des mesures fiables d'un décalage ou d'une dérive ; jamais une mesure périmée.
 */

const ITEM = "a".repeat(32);
const meta = { itemKind: "Episode" as const, itemTitle: "Show S01E01", seriesId: "c".repeat(32), seriesTitle: "Show", season: 1, episode: 1 };

function track(over: Partial<XraySubsyncTrack> = {}): XraySubsyncTrack {
  return {
    trackKey: "emb:3",
    kind: "embedded",
    streamIndex: 3,
    path: null,
    codec: "subrip",
    language: "fre",
    title: null,
    forced: false,
    hi: false,
    offset: 2.5,
    scale: 1,
    scaleLabel: "1",
    z: 8,
    madMs: 20,
    windows: 12,
    inliers: 1,
    cover: 0.8,
    maxErrorS: 2.5,
    reliable: true,
    confidence: "high",
    verdict: "décalé",
    ...over,
  };
}

const etagOf = (map: Record<string, string>) => (id: string) => map[id];

beforeEach(() => {
  getDb().prepare("DELETE FROM subtitle_sync").run();
  getDb().prepare("DELETE FROM subtitle_sync_jobs").run();
});

describe("les mesures et les décisions", () => {
  it("rien n'est appliqué d'office ; « Recaler » applique, pour ce fichier seulement", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track(), track({ trackKey: "ext:/m/x.en.srt", kind: "external", streamIndex: null, offset: 0.1, verdict: "ok", maxErrorS: 0.1 })]);
    expect(appliedFor(ITEM, "v1").size).toBe(0);
    const n = decide(rowsForItems([ITEM]), "apply", "admin", { strict: true, currentEtag: etagOf({ [ITEM]: "v1" }) });
    // Seule la mesure fiable d'un décalage est recalée : la piste « ok » ne l'est pas.
    expect(n).toBe(1);
    const applied = appliedFor(ITEM, "v1");
    expect([...applied.keys()]).toEqual(["emb:3"]);
    expect(applied.get("emb:3")).toMatchObject({ offset: 2.5, scale: 1 });
    // Une autre version du fichier : la correction est périmée, jamais lue.
    expect(appliedFor(ITEM, "v2").size).toBe(0);
    expect(appliedFor(ITEM, null).size).toBe(0);
  });

  it("une portée large ne recale pas une mesure incertaine, une piste seule si", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track({ reliable: false, confidence: "medium", verdict: "incertain" })]);
    expect(decide(rowsForItems([ITEM]), "apply", "admin", { strict: true, currentEtag: () => "v1" })).toBe(0);
    expect(decide(rowsForItems([ITEM]), "apply", "admin", { strict: false, currentEtag: () => "v1" })).toBe(1);
  });

  it("ne recale jamais une mesure périmée ou dont la version est inconnue", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track()]);
    expect(decide(rowsForItems([ITEM]), "apply", "admin", { strict: false, currentEtag: () => "v2" })).toBe(0);
    expect(decide(rowsForItems([ITEM]), "apply", "admin", { strict: false, currentEtag: () => null })).toBe(0);
    expect(rowsForItems([ITEM])[0].status).toBe("measured");
  });

  it("une décision survit à la même mesure, pas à une autre", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track()]);
    decide(rowsForItems([ITEM]), "apply", "louis", { strict: true, currentEtag: () => "v1" });
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track()]);
    expect(rowsForItems([ITEM])[0]).toMatchObject({ status: "applied", decided_by: "louis" });
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track({ offset: 3.1 })]);
    expect(rowsForItems([ITEM])[0]).toMatchObject({ status: "measured", decided_by: null });
    decide(rowsForItems([ITEM]), "reject", "louis", { strict: true, currentEtag: () => "v1" });
    expect(rowsForItems([ITEM])[0].status).toBe("rejected");
    // Un autre fichier : redécidé.
    recordMeasurement(ITEM, "v2", meta, "voix", 1, [track({ offset: 3.1 })]);
    expect(rowsForItems([ITEM])[0].status).toBe("measured");
    decide(rowsForItems([ITEM]), "reset", "louis", { strict: true, currentEtag: () => "v2" });
    expect(rowsForItems([ITEM])[0].status).toBe("measured");
  });

  it("une piste que la nouvelle mesure ne connaît plus est effacée", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track(), track({ trackKey: "emb:4" })]);
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track()]);
    expect(rowsForItems([ITEM]).map((r) => r.track_key)).toEqual(["emb:3"]);
  });

  it("ramène la clé à l'index Jellyfin que les lecteurs connaissent", () => {
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [
      track(),
      track({ trackKey: "ext:/m/x.fr.srt", kind: "external", streamIndex: null, offset: -1, scale: 25 / 24, scaleLabel: "25→24", verdict: "dérive" }),
    ]);
    decide(rowsForItems([ITEM]), "apply", "admin", { strict: true, currentEtag: () => "v1" });
    const streams = [
      { Type: "Subtitle", Index: 3 },
      { Type: "Subtitle", Index: 9, IsExternal: true, Path: "/m/x.fr.srt" },
      { Type: "Audio", Index: 1 },
    ];
    const byIndex = subtitleSyncByIndex(ITEM, "v1", streams);
    expect(byIndex?.["3"]).toMatchObject({ offset: 2.5, scale: 1 });
    expect(byIndex?.["9"]).toMatchObject({ offset: -1, scale: 25 / 24, label: "25→24" });
    expect(subtitleSyncByIndex(ITEM, "v2", streams)).toBeUndefined();
    expect(subtitleSyncByIndex("b".repeat(32), "v1", streams)).toBeUndefined();
  });
});

describe("les mesures demandées", () => {
  it("une passe se résume une fois toutes ses mesures revenues", () => {
    recordJob(ITEM, "v1", "p1", "admin", meta);
    recordJob("b".repeat(32), "v1", "p1", "admin", meta);
    expect(pendingJobs()).toHaveLength(2);
    expect(passSummary("p1")).toBeNull();
    recordMeasurement(ITEM, "v1", meta, "voix", 1, [track()]);
    finishJob(ITEM);
    finishJob("b".repeat(32));
    expect(passSummary("p1")).toEqual({ items: 2, failed: 0, tracks: 1, byVerdict: { "décalé": 1 } });
  });
});
