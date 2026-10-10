/**
 * Les visuels des fiches que la bannière d'accueil du téléphone peut ouvrir, décodés d'avance.
 *
 * Ouverte depuis la bannière, une fiche dont le visuel n'est pas encore là garde l'affiche qui a
 * volé comme bannière de remplacement (`posterOnly`, 1ee79b1), et le vrai visuel arrivait ensuite
 * d'un coup — « changement brutal, perturbant » (Louis, iPhone, 10/10/2026). Le relais se fait
 * désormais en fondu (`useSheetMorph`), mais le mieux est qu'il n'ait pas lieu : le titre affiché et
 * ses deux voisins sont demandés à l'avance, avec l'adresse exacte que la fiche demandera.
 *
 * Seulement l'interface au repos (`whenUiQuiet`) — jamais au milieu d'un geste —, jamais pendant un
 * film (l'appelant le dit), jamais sur une connexion qui demande l'économie de données. Rien n'est
 * téléchargé au moment d'ouvrir : c'est tout l'intérêt.
 */
import { whenUiQuiet } from "@/lib/uiQuiet";

/** Déjà demandés dans cette page : une adresse n'est jamais redemandée. Bornée, l'ordre d'insertion fait le reste. */
const asked = new Set<string>();
const MAX_REMEMBERED = 60;

function saveData(): boolean {
  if (typeof navigator === "undefined") return false;
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function decodeOne(url: string): void {
  const img = new Image();
  img.decoding = "async";
  // `fetchPriority` n'existe pas partout : posé comme attribut, ignoré là où il est inconnu.
  img.setAttribute("fetchpriority", "low");
  img.src = url;
  img.decode?.().catch(() => {});
}

/**
 * Demande ces visuels quand l'interface est au repos. `signal` annule une demande devenue inutile (le
 * titre affiché a changé) ; `blocked` est relu juste avant de télécharger (un film a pu démarrer).
 */
export async function prefetchSheetBanners(
  urls: readonly (string | null | undefined)[],
  blocked: () => boolean,
  signal?: AbortSignal
): Promise<void> {
  const wanted = urls.filter((u): u is string => typeof u === "string" && u.length > 0 && !asked.has(u));
  if (wanted.length === 0 || saveData()) return;
  await whenUiQuiet(signal);
  if (signal?.aborted || blocked() || saveData()) return;
  for (const url of wanted) {
    if (asked.has(url)) continue;
    asked.add(url);
    if (asked.size > MAX_REMEMBERED) asked.delete(asked.values().next().value as string);
    decodeOne(url);
  }
}

/** Pour les tests. */
export const prefetchBannersForTests = {
  reset(): void {
    asked.clear();
  },
};
