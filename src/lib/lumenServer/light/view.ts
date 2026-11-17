// La vue « version allégée » d'un index (comme `withConversion` et `withDialogue` pour le son) : l'index lui-même,
// plus ses échelons (`light`) quand l'option est ouverte à ce compte et que l'encodeur est là. Rien d'autre ne change
// — ni la version de l'adresse, ni une liste, ni un segment de la vidéo d'origine : un échelon n'ajoute que ses
// propres noms (`l1x{cid}`), et la liste maître ne les annonce que si la vue en porte.

import type { SessionPayload } from "@/lib/auth";
import { config } from "@/lib/config";
import { audienceAllows } from "@/lib/featureAudience";
import type { LumenIndex, LumenLightRung } from "../format";
import { detectLightEncoder } from "./encoder";
import { lightRungs, type EncoderFacts } from "./rungs";

/**
 * Ce qu'il faut pour servir la version allégée à cette requête, ou null : l'option (`LUMEN_LIGHT`, une audience)
 * n'est pas ouverte à ce compte, c'est un lien de partage, ou l'encodeur n'est pas là (`detectLightEncoder`, faite une
 * fois). Null : Lumen serveur se comporte exactement comme sans la version allégée.
 */
export async function lumenLightContext(session: Pick<SessionPayload, "role"> | null | undefined): Promise<EncoderFacts | null> {
  if (!session || session.role === "share" || !audienceAllows(config.lumen.light, session)) return null;
  const detection = await detectLightEncoder();
  return detection.available ? { version: detection.version, driver: detection.driver } : null;
}

/** L'index avec ses échelons, ou l'index lui-même (pas de contexte, ou une source qui ne les justifie pas). */
export function withLight(index: LumenIndex, context: EncoderFacts | null): LumenIndex {
  if (!context) return index;
  const light = lightRungs(index, context);
  return light.length > 0 ? { ...index, light } : index;
}

/** L'échelon que désigne un nom, sous l'identité actuelle seulement — une autre (autre encodeur) ne désigne rien. */
export function lightRungOf(index: LumenIndex, rung: 1 | 2, cid: string): LumenLightRung | null {
  return index.light?.find((r) => r.rung === rung && r.cid === cid) ?? null;
}
