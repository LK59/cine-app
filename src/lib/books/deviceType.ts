/**
 * Le type d'appareil des réglages du lecteur de livres (DECISIONS.md §129) : `telephone`, `tablette` ou
 * `ordinateur`. Les réglages sont gardés par compte **et** par type : on ne lit pas de la même façon sur
 * un téléphone le soir et sur un grand écran, mais deux téléphones du même compte lisent pareil.
 *
 * Une seule règle, lue ici et nulle part ailleurs : un appareil qu'on touche (`hover: none` et
 * `pointer: coarse`, le pointeur que lit déjà `useIsTouch`) est un téléphone ou une tablette selon le
 * petit côté de **son écran** (600 px, le seuil de `canChooseInterface`) ; tout le reste est un
 * ordinateur, une Fire TV comprise (la télécommande, aux flèches, se lit comme un clavier).
 *
 * L'écran et non la fenêtre, exprès : `useIsMobile` et `useIsTablet` suivent la largeur de la fenêtre,
 * pour la mise en page — une fenêtre d'ordinateur réduite y devient « téléphone », un téléphone couché y
 * change de côté. Le type d'un appareil ne doit pas changer quand on tourne l'écran ou qu'on rétrécit
 * la fenêtre : les réglages sauteraient d'un profil à l'autre au milieu d'une page.
 */

import { isFireTv } from "@/lib/fireTv";

export type ReaderDeviceType = "telephone" | "tablette" | "ordinateur";

export const READER_DEVICE_TYPES: readonly ReaderDeviceType[] = ["telephone", "tablette", "ordinateur"];

/** Le petit côté de l'écran, en points CSS, à partir duquel un appareil tactile est une tablette. */
export const TABLET_SHORT_SIDE = 600;

export function isReaderDeviceType(value: unknown): value is ReaderDeviceType {
  return typeof value === "string" && (READER_DEVICE_TYPES as readonly string[]).includes(value);
}

/** La règle, sans le navigateur : ce que l'appareil dit de son pointeur et de son écran. */
export function deviceTypeOf(facts: { touch: boolean; shortSide: number; fireTv?: boolean }): ReaderDeviceType {
  if (!facts.touch || facts.fireTv) return "ordinateur";
  return facts.shortSide >= TABLET_SHORT_SIDE ? "tablette" : "telephone";
}

/** Le type de cet appareil ; `ordinateur` quand le navigateur ne dit rien (rendu serveur, test sans écran). */
export function currentReaderDeviceType(): ReaderDeviceType {
  try {
    const touch = window.matchMedia("(hover: none) and (pointer: coarse)").matches;
    const shortSide = Math.min(window.screen.width, window.screen.height);
    // Une Fire TV est un ordinateur ici, comme pour l'interface (`useIsMobile`) : la même détection.
    return deviceTypeOf({ touch, shortSide, fireTv: isFireTv() });
  } catch {
    return "ordinateur";
  }
}
