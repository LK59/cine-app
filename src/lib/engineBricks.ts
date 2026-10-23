/**
 * Les briques de Lumen, le moteur de lecture du navigateur — **des libellés d'affichage, rien d'autre**.
 *
 * Le panneau technique du lecteur et l'Activité rangent sous ces noms ce que le lecteur dit déjà de
 * lui-même. Aucun champ du journal, aucune clé, aucun fichier ni aucune variable ne porte ces noms :
 * les lignes de `player.log` restent ce qu'elles étaient, et un lecteur du journal n'a rien à
 * apprendre. Ce module ne fait que dire sous quelle brique s'affiche chaque information.
 *
 * Ce que chacune recouvre dans le code (à titre d'orientation, pas de frontière exacte) :
 *  - PlaybackCore — l'orchestration : `RemuxPlayback`, `ExperimentalPlayerHost`, sauts, pauses, reprises ;
 *  - MuxCore — remux et conteneurs : `mediaFile.ts`, `remuxer.ts`, l'index du fichier ;
 *  - AudioCore — décodage audio : `softwareAudio.ts`, les modules WebAssembly TrueHD et AAC, le ré-encodage ;
 *  - BufferCore — les tampons : `mseSource.ts`, `bufferBudget.ts`, `MemoryReserve` ;
 *  - StreamCore — réseau et lecture des octets : `HttpByteSource`, le cache de reprise, la mesure du lien ;
 *  - CodecBridge — compatibilité des codecs : les sondes du navigateur (`capabilities.ts`), le décodage matériel ;
 *  - PlaybackBridge — le repli de lecture : le lecteur serveur (`PlayerHost`, transcodage Jellyfin).
 */
export const ENGINE_BRICKS = ["PlaybackCore", "MuxCore", "AudioCore", "BufferCore", "StreamCore", "CodecBridge", "PlaybackBridge"] as const;

export type EngineBrick = (typeof ENGINE_BRICKS)[number];

/** La clé i18n du rôle d'une brique (« orchestration », « gestion des tampons »…). */
export function brickRoleKey(brick: EngineBrick): string {
  return `player.info.engineRoles.${brick}`;
}

/**
 * Les lignes de diagnostic du lecteur natif (`RemuxPlayback.diagnostics`, `MseSource.debug`,
 * `PlaybackGuard.debug`), par brique. Leurs intitulés sont ceux que le code écrit déjà — en français,
 * tels quels — et ne changent pas : c'est leur rangement qui change. Une ligne absente d'ici (une
 * nouvelle, un jour) reste sous StreamCore, dans « Le flux », comme toutes les lignes avant elle.
 */
const DIAGNOSTIC_BRICKS: Readonly<Record<string, EngineBrick>> = {
  Chemin: "PlaybackCore",
  Moteur: "PlaybackCore",
  "Lecture en cours": "PlaybackCore",
  "En cours de saut": "PlaybackCore",
  "Sauts servis": "PlaybackCore",
  "Dernière pause": "PlaybackCore",
  "Dernière reprise": "PlaybackCore",
  "Délai du bouton lecture": "PlaybackCore",
  "Sous-titres en mémoire": "PlaybackCore",
  Attente: "PlaybackCore",
  Index: "MuxCore",
  "Images recalées": "MuxCore",
  Audio: "AudioCore",
  "Traitement audio": "AudioCore",
  "Décalage de présentation": "AudioCore",
  "Tampon vidéo": "BufferCore",
  "Avance sur la tête": "BufferCore",
  "Lisible par l'élément": "BufferCore",
  MediaSource: "BufferCore",
  Décodage: "CodecBridge",
  Vidéo: "CodecBridge",
  "Couleurs de l'image": "CodecBridge",
  "Images perdues": "CodecBridge",
};

/** La brique sous laquelle s'affiche une ligne de diagnostic ; StreamCore pour une ligne inconnue. */
export function brickOfDiagnostic(label: string): EngineBrick {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_BRICKS, label) ? DIAGNOSTIC_BRICKS[label] : "StreamCore";
}
