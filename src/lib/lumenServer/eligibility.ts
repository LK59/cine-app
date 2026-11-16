// Lumen serveur peut-il servir ce fichier, avec cette piste audio ? Une seule fonction le dit.
//
// L'étape 4 l'appelle avant de proposer le chemin ; un refus laisse le lecteur actuel (Lumen dans la
// page) prendre le fichier, et sa raison va au journal. Les raisons sont des chaînes stables
// (`LumenRefusalReason`) : la page d'activité les regroupera comme elle regroupe les refus du
// remuxeur, donc on n'en change pas le texte. Le détail, lui, est libre.
//
// Rien n'est décidé ici qui ne l'ait été à la construction de l'index (`lumenIndex.ts`) : cette
// fonction ne fait que choisir, entre le refus du fichier et celui de la piste demandée, lequel dire.

import type { LumenIndex, LumenRefusal } from "./format";

/**
 * La piste qu'ouvrirait la liste quand la page n'en demande pas : celle que le fichier marque, sinon la
 * première. Ici et non dans `service.ts` : le banc du recensement (`lumen-census-bench.spec.ts`) juge
 * l'éligibilité exactement comme la route, sans tirer Next et la base dans Node nu.
 */
export function defaultAudioTrack(index: LumenIndex): number | null {
  return (index.audio.find((a) => a.isDefault) ?? index.audio[0])?.number ?? null;
}

export type LumenEligibility = { ok: true } | ({ ok: false } & LumenRefusal);

/**
 * @param audioTrack La piste audio que le spectateur ouvrirait (son numéro dans le fichier), ou null
 *   pour un fichier sans son. Une piste refusée refuse le fichier : la liste maître ne la contiendrait
 *   pas, et ouvrir une autre langue que celle demandée n'est pas une option (DECISIONS §3).
 */
export function lumenEligibility(index: LumenIndex, audioTrack: number | null): LumenEligibility {
  if (index.refusal) return { ok: false, ...index.refusal };
  if (!index.video || index.segments.length === 0) return { ok: false, reason: "pas-de-video" };
  if (audioTrack === null) return { ok: true };
  const track = index.audio.find((a) => a.number === audioTrack);
  if (!track) return { ok: false, reason: "piste-inconnue", detail: `piste ${audioTrack}` };
  if (track.refusal) return { ok: false, ...track.refusal };
  return { ok: true };
}
