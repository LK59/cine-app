// Qui a l'application ouverte, et qui regarde quelque chose — en direct, pour l'administrateur.
//
// Un signal par minute et par onglet ouvert (`PresencePinger`), plus un au passage en arrière-plan
// et au retour : de quoi dire « dans l'application », « en lecture » ou « absent » à la minute
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

/** Un signal par session (`jti`) : une personne a souvent deux appareils ouverts. */
const beats = new Map<string, Beat>();

export function recordBeat(jti: string, beat: Beat): void {
  beats.set(jti, beat);
  // Borné par le nombre de sessions ; ce qui s'est tu depuis une heure ne dit plus rien.
  if (beats.size > 200) {
    for (const [key, b] of beats) if (beat.at - b.at > 60 * 60 * 1000) beats.delete(key);
  }
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

export const __testing = { reset: () => beats.clear() };
