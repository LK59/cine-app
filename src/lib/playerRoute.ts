import { castingNow, chromecastNow, lighterNow, type StableTakeover } from "@/lib/useStableFallback";

/**
 * Le lecteur qu'une lecture en ligne monte : natif, télécommande Chromecast, lecteur serveur — ou, derrière
 * l'option d'appareil de l'administrateur, Lumen serveur (`"lumen"`, DECISIONS.md §180).
 */
export type PlayerRoute = "native" | "chromecast" | "server" | "lumen";

/** Ce que l'aiguillage lit de la séance — un sous-ensemble de `PlaybackSession`. */
interface RoutedSession {
  itemId: string;
  reloadedOnServer?: string;
  lighter?: unknown;
  bench?: string;
}

/**
 * L'aiguillage de `PlayerHost`, sorti tel quel du composant le 22/10/2026 (aucune règle changée) :
 * quel lecteur monte pour cette séance. Un fichier téléchargé et l'attente de la configuration
 * publique sont tranchés avant, par le composant.
 */
export function choosePlayer(
  session: RoutedSession,
  ctx: {
    /** L'installation a-t-elle un lecteur serveur (`usePlayerServerFallback`, connu à ce stade). */
    serverFallback: boolean;
    /** Les titres déjà confiés au lecteur serveur (`useStableFallback`). */
    handedOver: string[];
    /** Le relais reporté sur cette lecture (`castCarriedTo`). */
    carried: StableTakeover | null;
    takeover: StableTakeover | null | undefined;
    /**
     * Lumen serveur est-il permis pour cette séance (`lumenWanted`, `lumenServerChoice.ts`) : l'option de
     * l'appareil, WebKit et son HLS natif, une page sans MediaSource, un titre jamais rendu au lecteur
     * actuel. Calculé par `PlayerHost`, jamais ici : cette fonction reste pure. **Lu seulement s'il est
     * vrai**, et seulement là où la route serait `"native"` — un relais, une diffusion, une version
     * allégée, une page rechargée sur le lecteur serveur passent avant, comme avant. Absent ou faux :
     * exactement l'aiguillage d'avant.
     */
    lumen?: boolean;
  }
): PlayerRoute {
  const { serverFallback, handedOver, carried, takeover } = ctx;
  // Une page rechargée par le lecteur serveur (piste WebKit, escalade de l'échelle audio) revient
  // à lui : le rechargement a effacé le relais qui l'avait choisi — voir `reloadedOnServer`.
  const reloadedOnServer = session.reloadedOnServer === session.itemId;
  // La version allégée (§78) : une bascule de cette lecture (`lighterNow`), ou héritée d'une séance
  // allégée arrêtée il y a moins de deux minutes (`session.lighter`, posé à l'ouverture en
  // « Automatique » seulement). Jamais pour le banc d'essai : il mesure le lecteur natif.
  const lighter = lighterNow(takeover, session) || (session.lighter !== undefined && !session.bench);
  // Sans lecteur serveur, il n'y a pas d'aiguillage : le repli automatique désignerait un lecteur
  // qui n'existe pas sur cette installation. Un fichier que le navigateur ne sait pas porter finit
  // sur une erreur de lecture, pas sur un transcodage — c'est tout l'objet du réglage.
  const useNative =
    !serverFallback ||
    (!handedOver.includes(session.itemId) && !carried && !castingNow(takeover, session) && !reloadedOnServer && !lighter);
  if (useNative) return ctx.lumen === true ? "lumen" : "native";
  // Vers un Chromecast, le relais n'est pas un lecteur mais une télécommande : le récepteur lit lui-même
  // le flux que Jellyfin lui prépare (DECISIONS.md §64).
  if (chromecastNow(takeover, carried, session)) return "chromecast";
  return "server";
}
