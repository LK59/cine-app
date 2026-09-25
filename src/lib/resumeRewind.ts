/**
 * Reprendre quelques secondes avant : se remettre dans la scène après s'en être éloigné.
 *
 * Deux moments, une seule règle. À l'ouverture d'un titre qu'on n'a pas joué depuis un moment sur
 * cet appareil — le lendemain, ou après l'avoir commencé sur la télé —, et à la reprise après une
 * longue pause, la lecture repart cinq secondes plus tôt. Pas pour un relais entre lecteurs, une
 * reconstruction ou un retour d'arrière-plan, qui arrivent quelques secondes après la dernière
 * image : ce n'est pas s'être éloigné. Pas dans les trente premières secondes ni dans les trente
 * dernières, où reculer n'apporte rien ou ramène avant une fin déjà vue.
 *
 * « Joué récemment » est retenu par appareil, dans le stockage local : c'est ce que cet appareil a
 * montré qui compte, et une valeur perdue — navigation privée, stockage vidé — vaut « éloigné »,
 * c'est-à-dire cinq secondes de plus, jamais une scène manquée.
 */

export const RESUME_REWIND_SECONDS = 5;
/** Au-delà de cette absence, on s'est éloigné. */
export const AWAY_MS = 10 * 60_000;
/** Ni dans les premières secondes, ni dans les dernières. */
const EDGE_SECONDS = 30;

const STORAGE_KEY = "cine:last-watched";
/** Les titres retenus, les plus récents : assez pour une semaine de séries, borné pour toujours. */
const MAX_REMEMBERED = 50;

function readAll(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Ce titre vient d'être joué sur cet appareil. À appeler pendant la lecture, pas à chaque image. */
export function noteWatching(itemId: string, now = Date.now()): void {
  try {
    const all = readAll();
    all[itemId] = now;
    const kept = Object.entries(all)
      .filter(([, at]) => typeof at === "number" && Number.isFinite(at))
      .sort(([, a], [, b]) => b - a)
      .slice(0, MAX_REMEMBERED);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Stockage indisponible : la prochaine ouverture reculera, rien de plus.
  }
}

/** Si ce titre n'a pas été joué sur cet appareil depuis plus de dix minutes. */
export function awayFrom(itemId: string, now = Date.now()): boolean {
  const at = readAll()[itemId];
  return !(typeof at === "number" && now - at < AWAY_MS);
}

/** La position de reprise, reculée si elle est assez loin des deux bords. */
export function rewound(position: number, duration?: number | null): number {
  if (!(position > EDGE_SECONDS)) return position;
  if (duration && duration > 0 && position > duration - EDGE_SECONDS) return position;
  return position - RESUME_REWIND_SECONDS;
}

/**
 * Où s'ouvre une reprise : la position, reculée si le titre a été quitté il y a assez longtemps.
 * Une seule fonction pour le lecteur qui s'ouvre et pour la reprise instantanée qui garde, en
 * arrière-plan, les octets de cette ouverture-là : deux calculs dériveraient, et les octets gardés
 * ne seraient plus ceux que le lecteur lit.
 */
export function openingPosition(itemId: string, positionSeconds: number, runtimeSeconds?: number | null): number {
  if (!(positionSeconds > 0)) return 0;
  return awayFrom(itemId) ? rewound(positionSeconds, runtimeSeconds) : positionSeconds;
}
