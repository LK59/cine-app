import type { NewsPageRow, NewsStateRow } from "./store";

/**
 * Ce que l'administrateur lit des Nouveautés, compte par compte (DECISIONS.md §73).
 *
 * « Pas lu » : une fenêtre restée moins de `NOT_READ_MS` à l'écran — le temps de toucher OK sans
 * avoir rien lu. Les mesures viennent du dernier affichage de chacun (`news_state`) ; le détail,
 * affichage par affichage, est dans le journal des ouvertures (`kind: "nouveautés"`).
 */
export const NOT_READ_MS = 2000;

export interface NewsAccountRow {
  name: string;
  /** La version de la dernière page vue, `null` si aucune. */
  seenVersion: string | null;
  /** Il reste au moins une page à voir : la fenêtre s'ouvrira à son prochain passage. */
  pending: boolean;
  /** Jamais passé depuis l'arrivée des Nouveautés (aucune ligne). */
  unknown: boolean;
  shownAt: number | null;
  shownMs: number | null;
  closedBy: string | null;
  scrolled: boolean | null;
  auto: boolean | null;
  seeMore: boolean;
  pageAt: number | null;
  pageMs: number | null;
  pageSection: string | null;
  rearmedAt: number | null;
}

export interface NewsSynthesis {
  /** La dernière page publiée, si elle existe. */
  latest: { id: number; version: string } | null;
  accounts: number;
  /** Comptes dont le dernier affichage contenait la dernière page. */
  seen: number;
  medianShownMs: number | null;
  /** Parts sur `seen`, entre 0 et 1, `null` sans affichage mesuré. */
  notReadShare: number | null;
  seeMoreShare: number | null;
  pageViews: number;
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export function newsAccounts(names: string[], states: Map<string, NewsStateRow>, published: NewsPageRow[]): NewsAccountRow[] {
  const latestSeq = published.reduce((m, p) => Math.max(m, p.seq ?? 0), 0);
  const versionAt = (seq: number) => published.find((p) => p.seq === seq)?.version ?? null;
  const all = [...new Set([...names, ...states.keys()])].sort((a, b) => a.localeCompare(b));
  return all.map((name) => {
    const s = states.get(name);
    if (!s) {
      return {
        name,
        seenVersion: null,
        pending: latestSeq > 0,
        unknown: true,
        shownAt: null,
        shownMs: null,
        closedBy: null,
        scrolled: null,
        auto: null,
        seeMore: false,
        pageAt: null,
        pageMs: null,
        pageSection: null,
        rearmedAt: null,
      };
    }
    // La dernière page *vue* : la plus haute publiée sous son numéro.
    const seenSeq = published.filter((p) => (p.seq ?? 0) <= s.seenSeq).reduce((m, p) => Math.max(m, p.seq ?? 0), 0);
    return {
      name,
      seenVersion: seenSeq > 0 ? versionAt(seenSeq) : null,
      pending: s.seenSeq < latestSeq,
      unknown: false,
      shownAt: s.shownAt,
      shownMs: s.shownMs,
      closedBy: s.closedBy,
      scrolled: s.scrolled,
      auto: s.auto,
      seeMore: s.seeMoreAt !== null,
      pageAt: s.pageAt,
      pageMs: s.pageMs,
      pageSection: s.pageSection,
      rearmedAt: s.rearmedAt,
    };
  });
}

export function newsSynthesis(names: string[], states: Map<string, NewsStateRow>, published: NewsPageRow[]): NewsSynthesis {
  const latest = published.reduce<NewsPageRow | null>((best, p) => (best === null || (p.seq ?? 0) > (best.seq ?? 0) ? p : best), null);
  const total = new Set([...names, ...states.keys()]).size;
  if (!latest) return { latest: null, accounts: total, seen: 0, medianShownMs: null, notReadShare: null, seeMoreShare: null, pageViews: 0 };
  const sawLatest = [...states.values()].filter((s) => s.shownIds.includes(latest.id) && (s.seenSeq ?? 0) >= (latest.seq ?? 0));
  const measured = sawLatest.map((s) => s.shownMs).filter((n): n is number => n !== null);
  return {
    latest: { id: latest.id, version: latest.version },
    accounts: total,
    seen: sawLatest.length,
    medianShownMs: median(measured),
    notReadShare: measured.length ? measured.filter((ms) => ms < NOT_READ_MS).length / measured.length : null,
    seeMoreShare: sawLatest.length ? sawLatest.filter((s) => s.seeMoreAt !== null).length / sawLatest.length : null,
    pageViews: [...states.values()].filter((s) => s.pageAt !== null).length,
  };
}
