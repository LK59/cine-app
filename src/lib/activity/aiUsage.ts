// Qui se sert des acteurs à l'écran, des questions et de « Jusqu'ici » (11/11/2026, DECISIONS.md §138, §139) —
// une tuile d'Activité, à l'ouverture de ces fonctions à tous les comptes.
//
// **Rien de neuf n'est écrit pour elle** : elle relit ce que les journaux portent déjà — le bilan `stop` du
// lecteur (`xray: "s3 t2 p2"`, `xrayUsage.ts` : scènes où la rangée a paru, touchers, personnes touchées) et
// les lignes `question` / `jusquici` de `recherche.log`. Les deux passent par le lecteur des journaux
// (`readRecords`), qui garde chaque génération en mémoire et ne relit que la suite d'un fichier qui a grandi.
//
// Une séance compte une fois : le bilan d'une page tuée par iOS est renvoyé plus tard (`why: "lost"`), et la
// lecture de la semaine garde la dernière ligne par `session`, comme le reste d'Activité.

import type { LogRecord } from "@/lib/activity/logReader";

export interface AiUsageStats {
  /** Séances où les acteurs à l'écran étaient proposés (le bilan porte `xray`). */
  xraySeances: number;
  /** … dont celles où au moins un acteur a été touché. */
  xrayTapSeances: number;
  /** Touchers d'un acteur, en tout. */
  xrayTaps: number;
  /** Comptes qui ont touché au moins un acteur. */
  xrayAccounts: number;
  /** Questions posées (fiche et lecteur), et les comptes qui en ont posé. */
  questions: number;
  questionAccounts: number;
  /** « Jusqu'ici » demandés ; ceux restés sans rien à dire (`vide`) ; les comptes. */
  sofar: number;
  sofarEmpty: number;
  sofarAccounts: number;
  /** Échecs des deux (erreur, indisponible) — ni une limite ni un rejet du filtre. */
  failures: number;
}

const USAGE = /^s(\d{1,4}) t(\d{1,4}) p(\d{1,3})$/;

const userOf = (r: LogRecord) => String(r.user ?? "").toLowerCase();

/** Les compteurs, sur les lignes déjà lues depuis `since` (le bilan du lecteur et `recherche.log`). */
export function aiUsageStats(player: readonly LogRecord[], search: readonly LogRecord[], since: number): AiUsageStats {
  const lastBySession = new Map<string, LogRecord>();
  const out: AiUsageStats = {
    xraySeances: 0,
    xrayTapSeances: 0,
    xrayTaps: 0,
    xrayAccounts: 0,
    questions: 0,
    questionAccounts: 0,
    sofar: 0,
    sofarEmpty: 0,
    sofarAccounts: 0,
    failures: 0,
  };
  const tapAccounts = new Set<string>();
  const count = (r: LogRecord) => {
    const m = typeof r.xray === "string" ? USAGE.exec(r.xray) : null;
    if (!m) return;
    const taps = Number(m[2]);
    out.xraySeances += 1;
    if (taps > 0) {
      out.xrayTapSeances += 1;
      out.xrayTaps += taps;
      tapAccounts.add(userOf(r));
    }
  };
  for (const r of player) {
    if (r._t < since || r.kind !== "stop" || typeof r.xray !== "string") continue;
    if (typeof r.session === "string" && r.session) lastBySession.set(r.session, r);
    else count(r);
  }
  for (const r of lastBySession.values()) count(r);
  out.xrayAccounts = tapAccounts.size;

  const askAccounts = new Set<string>();
  const sofarAccounts = new Set<string>();
  for (const r of search) {
    if (r._t < since) continue;
    if (r.kind === "question") {
      if (r.status === "erreur" || r.status === "indisponible") out.failures += 1;
      if (r.status === "abandon") continue;
      out.questions += 1;
      askAccounts.add(userOf(r));
    } else if (r.kind === "jusquici") {
      if (r.status === "erreur" || r.status === "indisponible") out.failures += 1;
      out.sofar += 1;
      if (r.status === "vide") out.sofarEmpty += 1;
      sofarAccounts.add(userOf(r));
    }
  }
  out.questionAccounts = askAccounts.size;
  out.sofarAccounts = sofarAccounts.size;
  return out;
}

/** Rien à montrer : aucune séance avec l'option, aucune question, aucun « Jusqu'ici ». */
export function aiUsageEmpty(s: AiUsageStats): boolean {
  return s.xraySeances === 0 && s.questions === 0 && s.sofar === 0;
}
