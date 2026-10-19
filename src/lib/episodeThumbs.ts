/**
 * Les miniatures du menu « Épisodes » du lecteur, chargées d'avance et **gardées décodées** (19/10/2026).
 *
 * Sur iPhone, chaque ouverture du menu montait des `<img>` neuves : le premier coup, une requête par
 * épisode sur un lien d'itinérance ; ensuite, le cache HTTP, mais un décodage à refaire — la liste
 * apparaissait vide puis se remplissait, « à chaque fois ». Un `Image` tenu ici garde sa ressource
 * vivante dans le cache mémoire du navigateur : une `<img>` à la même adresse est peinte dès la
 * première image du menu.
 *
 * Une saison, à environ 15 Ko la miniature (300 px, mesuré le 19/10/2026) : quelques centaines de Ko
 * au plus, bornées par `MAX_HELD`. Une seule requête à la fois, la plus proche de l'épisode en cours
 * d'abord, comme les planches de prévisualisation.
 */

const MAX_HELD = 120;
const held = new Map<string, HTMLImageElement>();

/** Déjà chargée et gardée — pour les tests, et pour qui voudrait le savoir. */
export function thumbHeld(url: string): boolean {
  return held.has(url);
}

/** Pour les tests. */
export function forgetHeldThumbs(): void {
  held.clear();
}

function keep(url: string, img: HTMLImageElement): void {
  held.delete(url);
  held.set(url, img);
  while (held.size > MAX_HELD) held.delete(held.keys().next().value!);
}

/**
 * Charger ces miniatures, dans cet ordre, une à la fois. `cancelled` est relu entre deux : un film
 * fermé ou un autre épisode arrête la file. Une miniature échouée passe son tour — le menu la
 * redemandera lui-même.
 */
export function warmThumbs(urls: string[], cancelled: () => boolean): void {
  const queue = urls.filter((url, i) => urls.indexOf(url) === i);
  const next = () => {
    if (cancelled()) return;
    const url = queue.shift();
    if (url === undefined) return;
    const known = held.get(url);
    if (known) {
      keep(url, known);
      next();
      return;
    }
    const img = new Image();
    img.decoding = "async";
    // Le film d'abord : le navigateur range cette requête derrière les siennes.
    (img as HTMLImageElement & { fetchPriority?: string }).fetchPriority = "low";
    img.onload = () => {
      keep(url, img);
      // Décodée d'avance aussi : c'est ce qui manquait à l'ouverture du menu, pas les octets.
      void img.decode().catch(() => {}).finally(next);
    };
    img.onerror = () => next();
    img.src = url;
  };
  next();
}

/** L'ordre de chargement : l'épisode en cours, puis ses voisins en s'éloignant, celui d'avant d'abord. */
export function nearestFirst<T>(items: T[], currentIndex: number): T[] {
  if (currentIndex < 0) return [...items];
  const out: T[] = [];
  for (let d = 0; out.length < items.length; d++) {
    if (d === 0) out.push(items[currentIndex]);
    else {
      if (currentIndex - d >= 0) out.push(items[currentIndex - d]);
      if (currentIndex + d < items.length) out.push(items[currentIndex + d]);
    }
  }
  return out;
}
