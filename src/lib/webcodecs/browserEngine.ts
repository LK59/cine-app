import { isWebKitEngine } from "@/lib/webkitEngine";

/**
 * Les questions posées à l'agent utilisateur par le moteur du lecteur, réunies ici.
 *
 * Elles vivaient dans quatre fichiers (`bufferBudget`, `remuxer`, `audioTranscode`, `aacConfig`),
 * dont deux importés pour cette seule raison par du code qui n'avait rien à voir avec eux — et deux
 * copies de la même question peuvent diverger sans que personne le voie. Elles sont rassemblées
 * **chacune avec son texte exact** : aucune n'a été fusionnée avec sa voisine, parce que leurs écarts
 * sont des réponses à des questions différentes, et en changer un est un changement de comportement.
 *
 * - `geckoVersion` reconnaît Firefox au jeton `Gecko/`, `geckoEngine` au jeton `Firefox/` et exclut
 *   Chromium en plus : deux lectures de « est-ce Firefox ? », gardées telles qu'elles décident
 *   (plafond des tampons d'un côté, Opus 5.1 de l'autre).
 * - `appleAudioToolbox` répond « système Apple », pas « WebKit » : Chrome sur Mac encode aussi par
 *   AudioToolbox. `appleWebKit` est la même expression *et* WebKit : le décodeur, lui, dépend du
 *   moteur.
 *
 * Les anciens modules les réexportent : aucun appelant n'a changé. La référence, `isWebKitEngine`,
 * reste dans `src/lib/webkitEngine.ts`.
 */

/** Firefox et ses dérivés, avec leur version — jamais sur iOS, où Firefox est WebKit. */
export function geckoVersion(userAgent: string): number | null {
  if (isWebKitEngine(userAgent) || !/Gecko\/\d/.test(userAgent)) return null;
  const match = /Firefox\/(\d+)/.exec(userAgent);
  return match ? Number(match[1]) : null;
}

/** Chromium sous un nom ou un autre — Chrome, Edge, Opera, Brave, Samsung Internet. Jamais sur iOS, où tout est WebKit. */
export function isChromiumEngine(userAgent: string): boolean {
  return !isWebKitEngine(userAgent) && /Chrom(e|ium)\/\d/.test(userAgent);
}

/** Firefox (Gecko) — ni Chromium ni WebKit : Firefox sur iOS est un WebKit et n'en est pas. */
export function geckoEngine(): boolean {
  const agent = typeof navigator === "undefined" ? "" : (navigator.userAgent ?? "");
  return /Firefox\/\d/.test(agent) && !isWebKitEngine(agent) && !/Chrom(e|ium)\/\d/.test(agent);
}

/**
 * Si une piste Opus peut être proposée telle quelle à ce navigateur (DECISIONS.md §66) — le reste de
 * la question (`containerAccepts`) est posé au navigateur, comme pour le FLAC ou l'AC-3.
 *
 * Jamais sur WebKit, et c'est une précaution, pas une capacité : Safari refusait l'Opus dans
 * MediaSource quand les 608 pistes Opus d'ici ont été recensées (21/09/2026), et rien n'a mesuré
 * depuis ce qu'un Safari qui répondrait « oui » ferait d'une entrée `Opus` copiée. Un iPhone garde
 * donc exactement son chemin d'avant — mono et stéréo décodés puis ré-encodés en AAC, multicanal au
 * lecteur serveur — tant que personne ne l'a prouvé sur un vrai appareil. Sans agent connu (Node),
 * même prudence.
 */
export function opusCopyConsidered(): boolean {
  const agent = typeof navigator === "undefined" ? "" : (navigator.userAgent ?? "");
  return agent !== "" && !isWebKitEngine(agent);
}

/**
 * L'AAC sera-t-il encodé par AudioToolbox, l'encodeur d'Apple ? Oui sur tout système Apple, quel
 * que soit le navigateur : Safari, tout navigateur iOS (WebKit), Chrome sur macOS. iPadOS se
 * présente comme un Mac, ce qui tombe juste. Une question de système et non de moteur : c'est
 * l'encodeur de la plateforme qui décide, et Chrome sur Mac utilise le même.
 */
export function appleAudioToolbox(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent ?? "";
  return /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(agent) && !/Android/.test(agent);
}

/**
 * Un système Apple *et* le moteur WebKit (Safari, tout navigateur iOS) : là, l'AAC est décodé par
 * AudioToolbox — voir `decodedOrderMeasuredHere` (`aacConfig.ts`). Chrome sur Mac n'en est pas.
 */
export function appleWebKit(): boolean {
  if (typeof navigator === "undefined") return false;
  const agent = navigator.userAgent ?? "";
  const apple = /iPhone|iPad|iPod|Macintosh|Mac OS X/.test(agent) && !/Android/.test(agent);
  return apple && isWebKitEngine(agent);
}
