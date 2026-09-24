// Le fichier ou l'appareil ? Le diagnostic qu'on faisait à la main pour chaque titre qui échoue.
//
// Né de Love Story (23/09/2026) : des écrans noirs sur un iPhone 12, et la question de savoir si
// c'était le fichier. La réponse est venue en croisant les séances — le même épisode passait sans
// accroc sur les autres appareils, et nos octets étaient identiques des deux côtés. Ce module fait
// ce croisement pour chaque titre qui a échoué : qui l'a ouvert, sur quoi, et avec quel succès.
//
// Un « spectateur » est une personne sur un type d'appareil (« charlotte · iPhone · Safari ») : le
// journal ne distingue pas deux iPhone d'un même compte, et un compte sur deux appareils en fait
// deux témoins. Seuls comptent les échecs — erreurs, replis, blocages, reconstructions hors retour
// d'arrière-plan. Un saut lent tient au réseau, pas au fichier ni au décodeur : il n'entre pas ici.

import type { Seance } from "@/lib/activity/seances";

export function failuresOf(s: Seance): number {
  return s.errors + s.fallbacks + s.stalls + s.rebuilds;
}

export interface Viewer {
  user: string;
  device: string;
  seances: number;
  failed: number;
  /** Les séances en échec de ce spectateur sur ce titre, les plus récentes d'abord. */
  failedSeances: string[];
  /** Ce même spectateur sur les autres titres de la période : dit si l'appareil peine partout. */
  elsewhere: { seances: number; failed: number };
}

export type Verdict =
  /** Il a échoué au moins une fois chez chacun de ses spectateurs (deux au moins) : le fichier. */
  | { kind: "file" }
  /** Il échoue chez un seul, et passe chez d'autres : cet appareil-là. */
  | { kind: "device"; user: string; device: string; everywhere: boolean }
  /** Il échoue sur un même type d'appareil, chez plusieurs personnes, et passe ailleurs. */
  | { kind: "platform"; device: string }
  /** Il échoue chez plusieurs et passe chez d'autres, sans point commun : ni l'un ni l'autre franchement. */
  | { kind: "mixed" }
  /** Un seul spectateur l'a ouvert : rien à croiser encore. */
  | { kind: "alone"; user: string; device: string };

export interface TitleDiagnosis {
  key: string;
  itemId: string | null;
  title: string;
  seances: number;
  failed: number;
  failures: number;
  lastFailure: number;
  /** Les motifs les plus fréquents, de quoi nommer le souci sans ouvrir une séance. */
  reasons: { reason: string; count: number }[];
  viewers: Viewer[];
  verdict: Verdict;
}

/** Une part d'échec au-delà de laquelle un appareil « peine partout » plutôt que sur ce titre. */
const EVERYWHERE_SHARE = 0.3;

function viewerKey(s: Seance): string {
  return `${s.user}|${s.device ?? "?"}`;
}

function verdictOf(viewers: Viewer[]): Verdict {
  const failing = viewers.filter((v) => v.failed > 0);
  const clean = viewers.filter((v) => v.failed === 0);
  if (failing.length === 1) {
    const v = failing[0];
    if (clean.length === 0) return { kind: "alone", user: v.user, device: v.device };
    const everywhere = v.elsewhere.seances >= 3 && v.elsewhere.failed / v.elsewhere.seances >= EVERYWHERE_SHARE;
    return { kind: "device", user: v.user, device: v.device, everywhere };
  }
  if (clean.length === 0) return { kind: "file" };
  const devices = new Set(failing.map((v) => v.device));
  if (devices.size === 1) {
    const [device] = devices;
    if (!clean.some((v) => v.device === device)) return { kind: "platform", device };
  }
  return { kind: "mixed" };
}

/**
 * Les titres qui ont échoué sur la période, chacun avec son verdict. `seances` est tout ce qu'on a
 * lu de la période — les séances réussies comptent autant que les autres : ce sont elles qui
 * innocentent un fichier ou un appareil.
 */
export function diagnoseTitles(seances: Seance[], limit = 12): TitleDiagnosis[] {
  // Ce que chaque spectateur a vécu sur l'ensemble de la période, titre par titre.
  const perViewer = new Map<string, Map<string, { seances: number; failed: number }>>();
  const byTitle = new Map<string, Seance[]>();
  for (const s of seances) {
    const title = s.itemId ?? s.title;
    const list = byTitle.get(title);
    if (list) list.push(s);
    else byTitle.set(title, [s]);
    const vk = viewerKey(s);
    const titles = perViewer.get(vk) ?? new Map<string, { seances: number; failed: number }>();
    perViewer.set(vk, titles);
    const n = titles.get(title) ?? { seances: 0, failed: 0 };
    n.seances += 1;
    if (failuresOf(s) > 0) n.failed += 1;
    titles.set(title, n);
  }

  const out: TitleDiagnosis[] = [];
  for (const [key, list] of byTitle) {
    const failedList = list.filter((s) => failuresOf(s) > 0);
    if (!failedList.length) continue;
    const viewers = new Map<string, Viewer>();
    for (const s of list) {
      const vk = viewerKey(s);
      let v = viewers.get(vk);
      if (!v) {
        let elsewhere = { seances: 0, failed: 0 };
        for (const [other, n] of perViewer.get(vk) ?? []) {
          if (other !== key) elsewhere = { seances: elsewhere.seances + n.seances, failed: elsewhere.failed + n.failed };
        }
        v = { user: s.user, device: s.device ?? "?", seances: 0, failed: 0, failedSeances: [], elsewhere };
        viewers.set(vk, v);
      }
      v.seances += 1;
      if (failuresOf(s) > 0) {
        v.failed += 1;
        v.failedSeances.push(s.id);
      }
    }
    const reasons = new Map<string, number>();
    for (const s of failedList) {
      for (const i of s.incidents) {
        // Le début du motif : assez pour regrouper, sans les nombres qui changent d'une fois à l'autre.
        const reason = `${i.kind}: ${i.reason.replace(/\d+(\.\d+)?/g, "#").slice(0, 70)}`;
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      }
    }
    const sortedViewers = [...viewers.values()].sort((a, b) => b.failed - a.failed || b.seances - a.seances);
    for (const v of sortedViewers) v.failedSeances.reverse();
    out.push({
      key,
      itemId: list[0].itemId,
      title: list[0].title,
      seances: list.length,
      failed: failedList.length,
      failures: failedList.reduce((n, s) => n + failuresOf(s), 0),
      lastFailure: Math.max(...failedList.map((s) => s.start)),
      reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3),
      viewers: sortedViewers,
      verdict: verdictOf(sortedViewers),
    });
  }
  // Les titres qui échouent chez le plus de monde d'abord : c'est là qu'un fichier est en cause.
  return out
    .sort(
      (a, b) =>
        b.viewers.filter((v) => v.failed).length - a.viewers.filter((v) => v.failed).length ||
        b.failed - a.failed ||
        b.lastFailure - a.lastFailure
    )
    .slice(0, limit);
}
