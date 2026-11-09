import { xray, xrayConfigured } from "@/lib/clients/xray";
import { logError } from "@/lib/logger";
import type { SpeakerSegment } from "@/lib/ask/voices";
import { analysisTarget, castOf, type XrayPerson } from "./cast";
import { keepsAnalysis } from "./rebind";

/**
 * « Qui parle » pour « Jusqu'ici » et les questions (10.30, DECISIONS.md §138–§139) : les segments de parole
 * du service, chaque voix nommée jointe à la distribution de l'élément et écrite comme « À l'écran » l'écrit
 * (le personnage, sinon l'acteur — `sofarScenes`).
 *
 * **Seulement une analyse complète** (consigne du propriétaire, 09/11/2026) : pendant l'analyse, les noms
 * peuvent encore changer d'un tronçon à l'autre — rien n'est rendu (`null`), et les répliques partent sans
 * nom, comme avant. De même : option coupée, rien d'analysé, service d'avant 10.30, service injoignable, ou
 * résultat d'une autre version du fichier (sauf durée égale, la règle des scènes). Ne lève jamais.
 *
 * La porte (option ouverte au compte, droit de voir l'élément, lien de partage) est celle de l'appelant : les
 * routes des questions et de « Jusqu'ici » l'ont déjà passée — un lien de partage n'a aucune fonction d'IA.
 */
export async function speakerSegments(itemId: string): Promise<SpeakerSegment[] | null> {
  if (!xrayConfigured()) return null;
  const id = itemId.toLowerCase();
  try {
    const [voices, target] = await Promise.all([xray.voices(id), analysisTarget(id).catch(() => null)]);
    if (!voices || voices.complete !== true || !Array.isArray(voices.segments)) return null;
    if (target && voices.etag && voices.etag !== target.etag) {
      const kept = keepsAnalysis(id, { etag: voices.etag, status: "done", analyzedUntil: Number(voices.analyzedUntil) || 0, durationS: null }, target.durationS, true);
      if (!kept) return null;
    }
    const cast = target?.tmdb ? await castOf(target.tmdb).catch(() => [] as XrayPerson[]) : [];
    const byId = new Map(cast.map((p) => [p.personId, p]));
    return voices.segments
      .filter((s) => Number.isFinite(s?.start) && Number.isFinite(s?.end) && s.end > s.start)
      .map((s) => {
        const known = typeof s.personId === "number" ? byId.get(s.personId) : undefined;
        // Un visage nommé ailleurs dans la série mais absent de cette distribution : sans nom.
        const name = known ? known.character || known.name || null : null;
        return {
          start: s.start,
          end: s.end,
          voiceId: s.voiceId,
          name: s.conflict ? null : name,
          confidence: Number(s.confidence) || 0,
          ...(s.conflict ? { conflict: true } : {}),
        };
      });
  } catch (error) {
    logError("xray/voices", error, { itemId: id });
    return null;
  }
}
