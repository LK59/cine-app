import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { describeLumenServerPlayback, formatOfVersion } from "@/lib/lumenPanel";

// Le panneau technique de Lumen serveur (§189) : chaque libellé dans les quatre langues, et ce qu'il dit d'une lecture.
const LANGS = ["fr", "en", "es", "de"] as const;
const dict = (lang: string) => JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8")) as { player: { info: Record<string, unknown> } };

function translator(lang: string) {
  const d = dict(lang);
  return (key: string, vars: Record<string, string | number> = {}) => {
    const value = key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], d);
    if (typeof value !== "string") throw new Error(`${lang} : clé absente ${key}`);
    return value.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`));
  };
}

const INPUT = {
  video: { codec: "hevc", width: 3840, height: 2160, rangeType: "DOVI" },
  container: "mkv",
  audio: { label: "Anglais — 5.1", codec: "A_DTS", processing: "converti (A_DTS → E-AC-3 5.1)", repairs: [] },
  version: "5-0123456789ab",
  cut: "cra",
  segments: 812,
  targetS: 9,
  resumeBy: "fragment",
  lumenSession: "abcd1234",
  received: { video: 12, audio: 12, mbps: 48.2 },
  server: { "srv.segV": 12, "srv.segA": 12, "srv.MB": 210.4, "srv.buildMs": 960, "srv.buildMaxMs": 180, "srv.waitMaxMs": 30, "srv.convSeg": 12, "srv.convBuilt": 3, "srv.convRam": 9, "srv.convDisk": 0 },
  events: ["Réouverture à 12:04 : version changée"],
  airplay: true,
};

describe("le panneau de Lumen serveur", () => {
  it.each(LANGS)("%s : chaque libellé existe, et le chemin, le format, la découpe, la livraison, le reçu, le relevé, les incidents sont dits", (lang) => {
    const panel = describeLumenServerPlayback(INPUT, translator(lang));
    const t = translator(lang);
    expect(panel.headline.name).toBe(t("player.info.lumen.name"));
    const rows = panel.sections.flatMap((s) => s.rows.map((r) => r.value));
    expect(rows).toContain("5");
    expect(rows).toContain("cra");
    expect(rows).toContain("converti (A_DTS → E-AC-3 5.1)");
    expect(rows).toContain("48.2 Mbit/s");
    expect(rows.some((v) => v.includes("812"))).toBe(true);
    expect(panel.notes).toContain("Réouverture à 12:04 : version changée");
    // Construction moyenne : 960 ms pour 24 segments construits.
    expect(rows).toContain(t("player.info.lumen.buildValue", { avg: 40, max: 180 }));
  });

  it("le format de l'adresse, essai compris", () => {
    expect(formatOfVersion("5-0123456789ab")).toBe("5");
    expect(formatOfVersion("5i1-0123456789ab")).toBe("5i1");
  });

  it("sans relevé ni réception : les sections vides n'apparaissent pas", () => {
    const panel = describeLumenServerPlayback({ ...INPUT, received: null, server: null, events: [] }, translator("fr"));
    expect(panel.sections.map((s) => s.title)).not.toContain(translator("fr")("player.info.lumen.sectionServer"));
  });
});
