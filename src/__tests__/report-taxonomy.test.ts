import { describe, it, expect } from "vitest";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";
import { ISSUE_SETS, OTHER, REPORT_ZONES, checkReportPath, issueSetFor, type ReportNode } from "@/lib/reportTaxonomy";
import { decodeView, encodeView } from "@/components/activity/nav";
import { decodeReportView } from "@/components/player/PlayerReportPanel";

const DICTS: Record<string, unknown> = { fr, en, es, de };

function lookup(dict: unknown, key: string): unknown {
  return key.split(".").reduce<unknown>((node, part) => (node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined), dict);
}

function walk(nodes: readonly ReportNode[], out: ReportNode[] = []): ReportNode[] {
  for (const n of nodes) {
    out.push(n);
    if (n.children) walk(n.children, out);
  }
  return out;
}

describe("taxonomie des signalements", () => {
  // Un identifiant sans libellé s'afficherait comme sa clé brute dans l'assistant, et seulement
  // dans la langue oubliée — invisible pour qui teste en français.
  it("chaque zone, élément et type de souci a son libellé dans les quatre langues", () => {
    const keys = [
      ...REPORT_ZONES.map((z) => `report.zones.${z.id}`),
      ...walk(REPORT_ZONES)
        .filter((n) => !REPORT_ZONES.includes(n))
        .map((n) => `report.nodes.${n.id}`),
      ...Object.entries(ISSUE_SETS).flatMap(([set, ids]) => ids.map((id) => `report.issues.${set}.${id}`)),
    ];
    for (const [lang, dict] of Object.entries(DICTS)) {
      const missing = keys.filter((k) => typeof lookup(dict, k) !== "string");
      expect([lang, missing]).toEqual([lang, []]);
    }
  });

  it("les identifiants sont uniques, et aucun ne s'appelle « other »", () => {
    const ids = walk(REPORT_ZONES).filter((n) => !REPORT_ZONES.includes(n)).map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(OTHER);
  });

  it("une zone mène toujours quelque part : un type de souci, ou une suggestion", () => {
    for (const zone of REPORT_ZONES) {
      if (zone.suggestion || zone.id === OTHER) continue;
      for (const child of zone.children ?? [zone]) expect([zone.id, child.id, issueSetFor(zone, child.id === zone.id ? null : child.id)]).not.toContainEqual(null);
    }
  });

  it("vérifie un chemin complet et refuse un élément d'une autre zone", () => {
    expect(checkReportPath({ zone: "player", element: "playerAudio", issue: "none" })).toBeNull();
    expect(checkReportPath({ zone: "home", element: "playerAudio", issue: "none" })).not.toBeNull();
  });
});

describe("adresses des signalements", () => {
  it("l'activité ouvre un signalement par son numéro, et rien d'autre", () => {
    expect(decodeView(encodeView({ kind: "report", id: 42 }))).toEqual({ kind: "report", id: 42 });
    expect(decodeView("signalement:abc")).toEqual({ kind: "overview" });
  });

  it("le panneau distingue l'assistant, la liste, un brouillon et un ticket", () => {
    expect(decodeReportView("nouveau")).toEqual({ kind: "new", fromList: false });
    // Ouvert depuis la liste : l'assistant y reviendra au lieu d'empiler une seconde liste.
    expect(decodeReportView("nouveau:liste")).toEqual({ kind: "new", fromList: true });
    expect(decodeReportView("liste")).toEqual({ kind: "list" });
    expect(decodeReportView("brouillon:7")).toEqual({ kind: "draft", id: 7 });
    expect(decodeReportView("7")).toEqual({ kind: "thread", id: 7 });
    expect(decodeReportView("n'importe quoi")).toEqual({ kind: "list" });
  });
});
