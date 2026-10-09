// Un logo se lit-il sur nos fonds sombres ? (09/10/2026)
//
// Les logos de TMDB sont des images transparentes faites pour être posées sur une affiche. La plupart
// sont blancs ou colorés ; quelques-uns sont noirs. Posé sur la fiche, la bannière ou le lecteur —
// tous sombres —, un logo noir est invisible : « The End of the F***ing World » avait deux logos
// français identiques, l'un noir, l'autre blanc, à égalité de votes, et le noir l'emportait. L'ombre
// portée de `CinemaLogo` est noire elle aussi : elle détache un logo clair d'un fond clair, elle ne
// sauve pas un logo noir.
//
// On mesure donc la luminosité du logo, une fois par image (gardée quatre semaines, sous les trente
// jours après lesquels le ménage de `kv_cache` l'effacerait : une image de TMDB ne change jamais sous
// la même adresse, la mesure n'est refaite que pour ne pas disparaître). Une mesure impossible — TMDB injoignable, image illisible —
// vaut « on ne sait pas », et un logo dont on ne sait rien n'est jamais écarté : une panne passagère
// ne doit pas faire disparaître des logos.

import { TMDB_IMAGE_BASE } from "@/lib/clients/tmdb";
import { withPersistentCache } from "@/lib/server-cache";

const MEASURE_TTL_MS = 28 * 24 * 3600_000;
const FETCH_TIMEOUT_MS = 5000;

/**
 * Sous ce seuil, le logo est jugé illisible sur fond sombre.
 *
 * On regarde le 90e centile de la luminance relative des pixels opaques — la partie la plus claire du
 * logo —, et non la moyenne : un logo noir cerné de blanc se lit très bien grâce à son contour, alors
 * que sa moyenne est sombre. 0,05 correspond à un gris d'environ rgb(63, 63, 63) ; sur nos fonds
 * (proches de rgb(10, 10, 10)), c'est un contraste d'environ 1,9 : en dessous, on ne lit plus. Les
 * logos rouges, qu'on pourrait croire sombres, sont loin au-dessus (un rouge rgb(200, 0, 0) vaut
 * 0,12, soit un contraste de 3,2).
 */
export const DARK_LUMINANCE = 0.05;

/** La luminance relative d'une composante sRGB (WCAG). */
function linear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Le 90e centile de la luminance des pixels opaques d'une image RGBA brute, ou `null` si aucun ne l'est. */
export function brightLuminance(rgba: Uint8Array | Buffer): number | null {
  const values: number[] = [];
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 128) continue;
    values.push(0.2126 * linear(rgba[i]) + 0.7152 * linear(rgba[i + 1]) + 0.0722 * linear(rgba[i + 2]));
  }
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.9))];
}

async function measure(filePath: string): Promise<number | null> {
  // `w92` : une vignette suffit pour une couleur, et ce sont quelques kilo-octets.
  const res = await fetch(`${TMDB_IMAGE_BASE}/w92${filePath}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`logo ${filePath} : HTTP ${res.status}`);
  const { default: sharp } = await import("sharp");
  const { data } = await sharp(Buffer.from(await res.arrayBuffer()), { failOn: "none" }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return brightLuminance(data);
}

/**
 * Le logo (son `file_path` chez TMDB) est-il trop sombre pour nos fonds ? `null` : on ne sait pas —
 * à traiter comme lisible.
 */
export async function logoIsDark(filePath: string): Promise<boolean | null> {
  try {
    const { luminance } = await withPersistentCache(`tmdb:logo-luma:v1:${filePath}`, MEASURE_TTL_MS, async () => ({
      luminance: await measure(filePath),
    }));
    return luminance === null ? null : luminance < DARK_LUMINANCE;
  } catch {
    return null;
  }
}
