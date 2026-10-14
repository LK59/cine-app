"use client";

import { overlayCss, subtitleRowStyle, SUBTITLE_LAYER_STYLE, type ChromeEdges, type SubtitleStyle } from "@/lib/subtitleStyle";
import { primaryDualCss, secondOverlayCss } from "@/lib/dualSubtitles";
import { subtitlePlacement } from "@/lib/webcodecs/subtitleMarkup";

/**
 * Les lignes qu'un lecteur dessine lui-même sous l'image — le principal, et en mode « deux
 * sous-titres » (DECISIONS.md §87) le second juste au-dessus.
 *
 * Un seul sous-titre : exactement le calque d'avant (§72) — même arbre, mêmes styles. Deux : une
 * rangée posée au même endroit, dont le **dernier** enfant est le principal. La rangée est ancrée par
 * son bas (`subtitleRowStyle`) et grandit vers le haut : le principal ne bouge donc jamais, quoi que
 * fasse le second, et le second se pose au-dessus de ce que le principal occupe. Sans réplique du
 * principal à cet instant, une ligne vide de sa hauteur tient sa place : sinon le second tomberait à
 * la ligne du bas, puis remonterait d'un cran à la réplique suivante du principal.
 */
export function SubtitleLayer({
  primary,
  primaryNotice = false,
  second = null,
  secondNotice = false,
  dual = false,
  style,
  chromeEdges,
}: {
  primary: string | null;
  /** La ligne du principal est un message d'état de génération (§70), pas une réplique. */
  primaryNotice?: boolean;
  second?: string | null;
  secondNotice?: boolean;
  /** Un second sous-titre est choisi — même sans réplique à cet instant. */
  dual?: boolean;
  style: SubtitleStyle;
  chromeEdges: ChromeEdges | null;
}) {
  if (!dual) {
    if (!primary) return null;
    const placed = subtitlePlacement(primary);
    return (
      // En haut quand le fichier le demande (`{\an8}`) : un sous-titre forcé qui traduit un texte
      // à l'image ne doit pas le cacher. Voir `subtitlePlacement`.
      // Le calque couvre tout l'écran du lecteur et en est un conteneur de taille : la taille du
      // texte et sa hauteur de repos se mesurent à lui (`cqh`/`cqw`), et la rangée ne s'écarte que
      // des commandes réellement affichées (`subtitleRowStyle`, 12/10/2026 — elle était à 96 px
      // fixes du bas, un quart d'un téléphone en paysage, commandes cachées ou non).
      <div className="pointer-events-none absolute inset-0 z-10" style={SUBTITLE_LAYER_STYLE}>
        <div className="subtitle-lift absolute inset-x-0 flex justify-center px-8" style={subtitleRowStyle(placed.top, chromeEdges)}>
          <p
            // Un message d'état de génération (« Préparation des sous-titres… ») : même place, même
            // style qu'une réplique, marqué pour qui le cherche — jamais mêlé à une vraie ligne.
            data-subtitle-notice={primaryNotice ? "" : undefined}
            // Le sens d'écriture vient du texte : une réplique arabe ou hébraïque (pistes du
            // conteneur, ou générées depuis le 12/10/2026) mettrait sinon sa ponctuation finale du
            // mauvais côté, la page étant écrite de gauche à droite.
            dir="auto"
            // Ni taille ni couleur écrites ici : ce lecteur dessine ses lignes lui-même, et il
            // ignorait donc les réglages de sous-titres, qui ne touchaient que les pistes natives.
            // Un réglage qui marche un film sur deux n'est pas un réglage — voir `subtitleStyle`.
            className="max-w-4xl whitespace-pre-line text-center font-display font-medium leading-snug"
            style={overlayCss(style)}
          >
            {placed.text}
          </p>
        </div>
      </div>
    );
  }

  if (!primary && !second) return null;
  const main = primary ? subtitlePlacement(primary) : null;
  const other = second ? subtitlePlacement(second) : null;
  const mainCss = primaryDualCss(style);
  const otherCss = secondOverlayCss(style);
  // Deux lignes au plus chacune sur un téléphone en portrait (`.subtitle-dual-text`) : à deux, elles
  // couvraient sinon un tiers de l'image.
  const lineClass = "subtitle-dual-text max-w-4xl whitespace-pre-line text-center font-display font-medium leading-snug";
  const mainLine = main && (
    <p data-subtitle-primary="" data-subtitle-notice={primaryNotice ? "" : undefined} dir="auto" className={lineClass} style={mainCss}>
      {main.text}
    </p>
  );
  const otherLine = other && (
    <p
      data-subtitle-second=""
      data-subtitle-notice={secondNotice ? "" : undefined}
      dir="auto"
      // Un souffle entre les deux, à l'échelle du texte : collés, ils se lisaient comme une seule réplique.
      className={`${lineClass} mb-[0.3em]`}
      style={otherCss}
    >
      {other.text}
    </p>
  );
  const topLines = [other?.top ? otherLine : null, main?.top ? mainLine : null].filter(Boolean);
  const bottomHasLine = (other && !other.top) || (main && !main.top);
  return (
    <div className="pointer-events-none absolute inset-0 z-10" style={SUBTITLE_LAYER_STYLE}>
      {topLines.length > 0 && (
        <div className="subtitle-lift subtitle-dual absolute inset-x-0 flex flex-col items-center px-8" style={subtitleRowStyle(true, chromeEdges)}>
          {topLines}
        </div>
      )}
      {bottomHasLine && (
        <div
          data-subtitle-row="bottom"
          className="subtitle-lift subtitle-dual absolute inset-x-0 flex flex-col items-center px-8"
          style={subtitleRowStyle(false, chromeEdges)}
        >
          {other && !other.top && otherLine}
          {main && !main.top ? (
            mainLine
          ) : (
            // La place du principal, gardée vide : une ligne de sa taille (`leading-snug`, 1,375), plus
            // le rembourrage de la boîte quand il y en a une.
            <div
              aria-hidden
              data-subtitle-primary-space=""
              style={{ fontSize: mainCss.fontSize, height: style.background === "box" ? "1.675em" : "1.375em" }}
            />
          )}
        </div>
      )}
    </div>
  );
}
