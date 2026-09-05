"use client";

import { TONE_CURVES, type ToneLevel } from "@/lib/hdrToSdr";

export const HDR_TONE_FILTER_ID = "cine-hdr-to-sdr";

/**
 * La définition du filtre, posée dans le document pour que la vidéo puisse s'y référer.
 *
 * Un filtre SVG plutôt que les raccourcis CSS (`contrast()`, `brightness()`) : ceux-ci n'offrent
 * qu'un gain et un décalage linéaires, là où le défaut à corriger est une courbe. `feFuncX
 * type="gamma"` en est une vraie, appliquée canal par canal, et le compositeur l'exécute sur le
 * GPU comme n'importe quelle autre propriété de composition.
 *
 * `color-interpolation-filters="sRGB"` est explicite et compte : la valeur par défaut du SVG est
 * `linearRGB`, qui linéarise l'image avant le filtre et la ré-encode après — soit exactement la
 * courbe qu'on cherche à corriger, appliquée deux fois de plus.
 */
export function HdrToneFilter({ level }: { level: Exclude<ToneLevel, "off"> }) {
  const { exponent, amplitude, saturation } = TONE_CURVES[level];
  return (
    <svg aria-hidden className="pointer-events-none absolute h-0 w-0" focusable="false">
      <defs>
        <filter id={HDR_TONE_FILTER_ID} colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" exponent={exponent} amplitude={amplitude} offset={0} />
            <feFuncG type="gamma" exponent={exponent} amplitude={amplitude} offset={0} />
            <feFuncB type="gamma" exponent={exponent} amplitude={amplitude} offset={0} />
          </feComponentTransfer>
          <feColorMatrix type="saturate" values={String(saturation)} />
        </filter>
      </defs>
    </svg>
  );
}
