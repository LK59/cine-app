import path from "node:path";
import { LOG_DIR, appendJsonLine, logGenerations } from "@/lib/logFile";

/**
 * What actually happened during playback, for everybody, written to a file.
 *
 * The player steps aside to the stable one without asking and without saying so — which is the
 * right thing for whoever is watching and the wrong thing for whoever maintains it: on a server
 * with eighteen accounts, a path that fails silently fails invisibly, and the only person who
 * would ever notice is the one who happens to open the technical panel. This is the record that
 * makes it noticeable.
 *
 * A file rather than a table: it is read by a human with `tail` and `grep`, it is append-only,
 * and it must survive the database being rebuilt. One JSON object per line, the same shape the
 * rest of the app already logs in.
 */

/**
 * Deux fichiers : les spectateurs d'un côté, le banc d'essai de l'autre.
 *
 * Une ligne portant `bench` (posé par l'hôte natif quand la séance est un banc) part dans
 * `bench-player.log`. Mêlées au reste, ces lignes faisaient deux torts : une série complète —
 * des centaines de sauts à 4 000 caractères de trace — faisait tourner `player.log` et emportait
 * l'historique des vrais spectateurs de la veille ; et le plan du banc, qui choisit ses films dans
 * ce journal, comptait les sauts lents et les blocages *que le banc avait lui-même provoqués*.
 *
 * Même forme, même nettoyage : seul le fichier change, et `jq` lit l'un comme l'autre.
 *
 * Des chemins calculés à l'appel, et non au chargement : les tests pointent `LOG_DIR` ailleurs.
 */
const playerLogFile = () => path.join(LOG_DIR, "player.log");
const benchPlayerLogFile = () => path.join(LOG_DIR, "bench-player.log");

/**
 * Cinq générations pour les spectateurs (≈ 30 Mo au plus) : l'historique de plusieurs jours est ce
 * qu'on vient y chercher. Deux pour le banc, dont seule la dernière série intéresse.
 */
const PLAYER_LOG_KEEP = 5;
const BENCH_PLAYER_LOG_KEEP = 2;

/** `player.log` et ses archives, du plus ancien au plus récent — les spectateurs seulement. */
export function playerLogFiles(): string[] {
  return logGenerations(playerLogFile(), PLAYER_LOG_KEEP);
}

/** `bench-player.log` et ses archives, du plus ancien au plus récent. */
export function benchPlayerLogFiles(): string[] {
  return logGenerations(benchPlayerLogFile(), BENCH_PLAYER_LOG_KEEP);
}

/** What the browser is allowed to report. Anything else is dropped rather than written. */
const KINDS = new Set(["start", "fallback", "network", "rebuild", "error", "stop", "audio", "seek", "stall"]);

/**
 * `audio` est arrivé le 20/09/2026, et pour une raison qui vaut d'être dite : le changement de
 * piste est l'un des trois gestes dont on se demandait s'il était lent, et **le seul sur lequel
 * on n'avait aucun chiffre** — il n'écrivait rien nulle part. Les lignes `rebuild`, qu'on avait
 * d'abord prises pour lui, sont des reprises après coupure réseau.
 *
 * Il ne change rien au comportement du lecteur : il le raconte.
 */
/**
 * `seek` (22/09/2026) : chaque saut demandé depuis les commandes, avec sa durée jusqu'à l'arrivée
 * et le fait qu'il tombait ou non dans ce qui était déjà chargé — des sauts jugés lents sur un
 * réseau d'entreprise n'avaient aucun chiffre pour dire si c'était le réseau ou le lecteur.
 *
 * `stall` (22/09/2026) : une horloge qui ne couvre pas une seconde en cinq alors que l'élément dit
 * jouer — une fois par blocage. Un saut arrière posé juste avant une image clé a laissé un film
 * figé dix-neuf secondes sous un indicateur de chargement, et le journal n'en gardait que la ligne
 * `seek` d'avant : ni les tampons, ni les reprises tentées, ni la trace. Voir `MseSource.watchForStall`.
 */
export type PlayerEventKind = "start" | "fallback" | "network" | "rebuild" | "error" | "stop" | "audio" | "seek" | "stall";

export function isPlayerEventKind(value: unknown): value is PlayerEventKind {
  return typeof value === "string" && KINDS.has(value);
}

/**
 * Trims a value from the browser down to something safe to write.
 *
 * Everything here is chosen by the client, so it is the client that decides how much disk this
 * costs. Strings are cut, numbers must be numbers, and nothing nested is accepted at all.
 */
function clean(fields: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  let kept = 0;
  const keep = (key: string, value: unknown): void => {
    // 28 : le banc d'essai ajoute `bench` en tête des lignes, et une ligne `stall` en portait déjà
    // 24 — la dernière, `steps`, la plus précieuse, serait tombée.
    if (kept >= 28 || key.length > 40) return;
    if (typeof value === "number" && Number.isFinite(value)) out[key] = Math.round(value * 1000) / 1000;
    else if (typeof value === "boolean") out[key] = value;
    // `steps` is the one long field: the device's own timeline of a track change, which is the
    // whole point of the line it rides on. Still bounded — by eight times the rest, not by trust.
    else if (typeof value === "string" && value) out[key] = value.slice(0, key === "steps" ? 4000 : 500);
    else return;
    kept += 1;
  };
  for (const [key, value] of Object.entries(fields)) {
    /**
     * Un objet est aplati d'un niveau (`audioSync.sourceMs`), jamais davantage.
     *
     * Il était jeté sans un mot : la mesure de l'accord du son et de l'image (`audioSync`,
     * `frames`) et le relais d'un repli (`takeover` — position et piste) partaient du navigateur
     * et n'arrivaient jamais au journal (relevé le 22/09/2026 sur les premières séances qui
     * devaient les porter). Un seul niveau, et le même plafond de champs que le reste.
     */
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [sub, inner] of Object.entries(value as Record<string, unknown>)) keep(`${key}.${sub}`, inner);
    } else keep(key, value);
  }
  return out;
}

/**
 * Appends one event. Never throws: a player must not fail because a log could not be written.
 *
 * `user` comes from the session on the server, never from the request body — otherwise the one
 * field that says who this was about would be the one field anybody could forge.
 */
export function logPlaybackEvent(
  user: string,
  kind: PlayerEventKind,
  fields: Record<string, unknown>
): void {
  // Tout `bench` non vide suffit : c'est l'identifiant de série, mais la question posée ici est
  // seulement « est-ce un banc », et une ligne de banc égarée chez les spectateurs coûte plus
  // cher que l'inverse.
  const bench = Boolean(fields.bench);
  appendJsonLine(
    bench ? benchPlayerLogFile() : playerLogFile(),
    {
      timestamp: new Date().toISOString(),
      kind,
      user,
      ...clean(fields),
    },
    { keep: bench ? BENCH_PLAYER_LOG_KEEP : PLAYER_LOG_KEEP }
  );
}

