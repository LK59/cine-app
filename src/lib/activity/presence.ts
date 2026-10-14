// Qui a l'application ouverte, et qui regarde quelque chose — en direct, pour l'administrateur.
//
// Un signal par minute et par onglet ouvert (`PresencePinger`) — pendant un film, le battement de
// lecture (`recordPlaybackBeat`) —, plus un au passage en arrière-plan et au retour : de quoi dire « dans l'application », « en lecture » ou « absent » à la minute
// près, sans rien mesurer d'autre. Gardé en mémoire seulement : un redémarrage efface tout, et la
// minute suivante le reconstruit — rien ici ne mérite d'être écrit sur le disque.

/** Un onglet muet depuis plus longtemps que ça est parti : deux signaux manqués, et un peu de marge. */
export const PRESENCE_TTL_MS = 150_000;
/** La cadence des signaux, côté navigateur. */
export const PRESENCE_EVERY_MS = 60_000;

export type PresenceState = "playing" | "app" | "away";

interface Beat {
  /** Le compte, tel qu'il se connecte (`jfUser`, ou le nom local). */
  user: string;
  jfId: string | null;
  at: number;
  visible: boolean;
  playing: { itemId: string; title: string } | null;
  device: string | null;
}

/**
 * Un signal par session (`jti`) : une personne a souvent deux appareils ouverts.
 *
 * Partagé par les copies du module (14/10/2026) : les routes l'écrivent, et l'indexation des
 * répliques, démarrée par `instrumentation.ts` dans sa propre copie, le lit (`anyPlaybackBeat`) —
 * elle lisait une table toujours vide.
 */
const BEATS_KEY = Symbol.for("cine.presence.beats");
const shared = globalThis as typeof globalThis & { [BEATS_KEY]?: Map<string, Beat> };
const beats: Map<string, Beat> = (shared[BEATS_KEY] ??= new Map<string, Beat>());

export function recordBeat(jti: string, beat: Beat): void {
  beats.set(jti, beat);
  // Borné par le nombre de sessions ; ce qui s'est tu depuis une heure ne dit plus rien.
  if (beats.size > 200) {
    for (const [key, b] of beats) if (beat.at - b.at > 60 * 60 * 1000) beats.delete(key);
  }
}

/**
 * Le battement de lecture tient lieu de signal de présence (13/10/2026) : la route de progression
 * l'enregistre comme `/api/presence`, et `PresencePinger` se tait pendant le film tant que ce
 * battement passe (`progressBeat.ts`) — 73 signaux par heure de film au relevé du 13/10, pour
 * dire ce que le battement disait déjà. Il ne connaît pas le titre : celui du signal précédent
 * pour le même film est gardé (le pinger en envoie un, titre compris, à l'ouverture du film).
 */
export function recordPlaybackBeat(jti: string, beat: Omit<Beat, "playing"> & { itemId: string }): void {
  const { itemId, ...rest } = beat;
  const previous = beats.get(jti)?.playing;
  recordBeat(jti, { ...rest, playing: { itemId, title: previous?.itemId === itemId ? previous.title : "" } });
}

/** La session vient d'être fermée : elle n'est plus dans l'application. */
export function forgetBeat(jti: string): void {
  beats.delete(jti);
}

export interface Presence {
  state: PresenceState;
  /** Le dernier signal reçu, tous appareils confondus — « vu il y a 3 min ». */
  lastSeen: number | null;
  playing: { itemId: string; title: string } | null;
  /** Les appareils qui parlent en ce moment. */
  devices: string[];
}

/**
 * Où en est ce compte. Le plus « présent » de ses appareils l'emporte : un film sur la télé et
 * l'application en arrière-plan sur le téléphone, c'est « en lecture ».
 */
export function presenceOf(user: string, now = Date.now()): Presence {
  const key = user.toLowerCase();
  let state: PresenceState = "away";
  let lastSeen: number | null = null;
  let playing: Presence["playing"] = null;
  const devices = new Set<string>();
  for (const beat of beats.values()) {
    if (beat.user.toLowerCase() !== key) continue;
    lastSeen = Math.max(lastSeen ?? 0, beat.at);
    if (now - beat.at > PRESENCE_TTL_MS) continue;
    // Un onglet caché qui joue encore (le son continue, le mini-lecteur) compte comme une lecture ;
    // caché sans rien jouer, la personne n'est plus devant.
    if (beat.playing) {
      state = "playing";
      playing = beat.playing;
    } else if (beat.visible && state !== "playing") {
      state = "app";
    }
    if (beat.device && (beat.visible || beat.playing)) devices.add(beat.device);
  }
  return { state, lastSeen, playing, devices: [...devices] };
}

/**
 * Un film joue-t-il quelque part, tous comptes confondus ? — un battement de lecture vivant. Lu par
 * l'indexation des répliques, qui se met en pause pendant qu'on regarde (DECISIONS.md §88).
 */
export function anyPlaybackBeat(now = Date.now()): boolean {
  for (const beat of beats.values()) if (beat.playing && now - beat.at <= PRESENCE_TTL_MS) return true;
  return false;
}

export const __testing = { reset: () => beats.clear() };
