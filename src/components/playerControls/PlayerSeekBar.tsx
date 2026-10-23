"use client";

/**
 * La barre de progression du lecteur et ses deux temps : survol et glisser à la souris, glisser
 * relatif au doigt (§108), la vignette d'aperçu et son chapitre, le chargé, la part téléchargée.
 * Sortie de `PlayerControls` telle quelle ; `seekingRef`, la position et les sauts restent chez lui.
 */

import { useEffect, useRef, useState, type RefObject } from "react";
import { useT } from "@/components/TranslationProvider";
import { formatTime } from "@/lib/playerClock";
import type { TrickplayInfo } from "@/lib/trickplayTile";

/**
 * La fenêtre, après un doigt levé, pendant laquelle un événement souris n'en est que l'écho.
 * Les navigateurs rejouent la souris dans la foulée du touchend ; 800 ms laissent la marge d'un
 * téléphone chargé sans jamais avaler un vrai clic, qu'une souris ne donne pas une demi-seconde
 * après un doigt.
 */
const TOUCH_ECHO_MS = 800;
/** En dessous, un déplacement du doigt est son tremblement, pas un geste — voir `lastTouchXRef`. */
const TOUCH_JITTER_PX = 1;
/**
 * Ce qu'un doigt peut bouger en touchant la barre sans la faire glisser. En deçà, c'est un toucher,
 * et un toucher ne déplace rien (19/10/2026, voir `touchStartRef`) ; au-delà, tout le déplacement
 * compte, ces premiers pixels compris.
 */
const TOUCH_SLOP_PX = 6;

/** Le temps restant, signé « − » (U+2212) tant qu'il en reste. */
function remainingLabel(duration: number, currentTime: number): string {
  const left = Math.max(0, duration - currentTime);
  // Moins d'une seconde s'écrit « 0:00 » : sans signe, pas « −0:00 ».
  return left >= 1 ? `\u2212${formatTime(left)}` : formatTime(0);
}

export function PlayerSeekBar({
  videoRef,
  seekingRef,
  suspendedRef,
  currentTime,
  duration,
  bufferedEnd,
  downloadedFraction,
  chapters,
  trickplay,
  trickplayTileAt,
  previewSeek,
  commitSeek,
  skip,
  showControls,
  holdControls,
  windowExitHides,
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  seekingRef: RefObject<boolean>;
  suspendedRef: RefObject<boolean>;
  currentTime: number;
  duration: number;
  bufferedEnd: number;
  downloadedFraction?: number;
  chapters: { start: number; name: string | null }[];
  trickplay: TrickplayInfo | null;
  trickplayTileAt: (time: number) => { url: string; bgX: number; bgY: number } | null;
  previewSeek: (value: number) => void;
  commitSeek: (value: number) => void;
  skip: (deltaSeconds: number) => void;
  showControls: (delayMs?: number) => void;
  holdControls: () => void;
  windowExitHides: () => boolean;
}) {
  const t = useT();
  /**
   * Un glisser à la souris est en cours : la position vient du curseur, jamais de l'input.
   *
   * L'input natif ramène le pixel à une valeur en retirant la demi-pastille à chaque bout ; la
   * vignette, elle, compte sur toute la largeur. Les deux disaient deux temps différents pour
   * le même pixel, et c'est celui de l'input qu'on validait : « je vise 6:54, il me met à
   * 6:48 », systématiquement, sur Chrome et Firefox.
   */
  const mouseDragRef = useRef(false);
  /**
   * Un doigt glisse sur la barre : même règle que la souris, la position vient du doigt.
   *
   * Sur iOS, un doigt posé sur la pastille (invisible, mais toujours là) fait aussi glisser
   * l'input natif — en relatif, depuis la pastille et non depuis le doigt. Les deux écrivaient
   * tour à tour une position différente, et chaque rendu remettait la valeur de l'input, ce qui
   * relançait son propre glisser : la barre et la vignette sautaient, saccadaient et tremblaient
   * sous un doigt immobile (signalé sur iPhone le 23/09/2026).
   */
  const touchDragRef = useRef(false);
  /**
   * Au doigt, la barre glisse en relatif (19/10/2026, DECISIONS.md §108), comme l'app TV d'Apple et
   * Photos : poser le doigt n'importe où ne déplace rien, glisser déplace la tête de lecture d'autant
   * que le doigt, depuis là où elle était. `x` et `time` : le point de départ ; `target` : la position
   * visée, nulle tant que le doigt n'a pas dépassé `TOUCH_SLOP_PX` — un toucher bref ne saute pas.
   * Le doigt cache la barre : sauter sous lui faisait perdre sa place à qui voulait reculer d'un peu.
   */
  const touchStartRef = useRef<{ x: number; time: number; target: number | null } | null>(null);
  /**
   * Ce qui a saisi l'input en dernier — `pointerType` de son pointerdown, ou « keyboard ».
   *
   * L'input natif pose sa valeur au point touché, avant que le doigt ait glissé d'un pixel : au
   * pointerdown sur Chromium, sur la souris que le navigateur rejoue après le touchend sur iOS. Son
   * `change` passait par `previewSeek`, et la partie lue allait un instant jusqu'au doigt puis revenait
   * (8.70.0, iPhone, 19/10/2026). Au toucher, la valeur affichée ne vient que de la position relative
   * (§108) : l'input est ignoré tant que la dernière saisie est un doigt — la souris rejouée ne
   * produit pas de pointerdown, elle ne le fait donc pas oublier.
   */
  const inputPointerRef = useRef<string | null>(null);
  /** Le dernier point du doigt pris en compte — voir `TOUCH_JITTER_PX`. */
  const lastTouchXRef = useRef<number | null>(null);
  /**
   * L'instant du dernier doigt levé de la barre — pour reconnaître la souris que le navigateur
   * rejoue ensuite.
   *
   * Après un touchend sans preventDefault, le navigateur envoie au même point mousemove,
   * mousedown puis mouseup « de compatibilité ». Le conteneur avait déjà validé le saut au
   * touchend, et l'onMouseUp de l'input le validait une seconde fois : deux demandes de saut,
   * currentTime écrit deux fois — le premier saut recommencé — et une ligne « superseded »
   * fantôme dans le journal. Pas de preventDefault au touchend : il supprimerait aussi le clic
   * que le reste de la barre du bas écoute (voir son onClickCapture).
   */
  const lastTouchEndRef = useRef(-Infinity);
  /** Les événements souris qui suivent un toucher de près ne sont que son écho. */
  const isTouchEcho = () => performance.now() - lastTouchEndRef.current < TOUCH_ECHO_MS;

  const [viewportWidth, setViewportWidth] = useState(() => (typeof window === "undefined" ? 0 : window.innerWidth));
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const seekBarRef = useRef<HTMLDivElement>(null);
  const [previewTime, setPreviewTime] = useState<number | null>(null);
  /** The bar is under a finger or a pointer — the one state that thickens it. */
  const scrubbing = previewTime !== null;

  const [previewFraction, setPreviewFraction] = useState(0);

  // La souris : survol (la vignette) et glissement (la barre suit le curseur). Le doigt, lui, glisse en
  // relatif depuis le 19/10/2026 (§108) et passe par `showPreviewAt`. Plain function, not
  // useCallback: nothing needs its referential identity to stay stable, and the extra state/hooks
  // added alongside chapters/PiP/speed tripped the React Compiler's own memoization-preservation
  // check on the manually memoized version.
  /** Le temps sous ce pixel, sur toute la largeur de la barre — ce que la vignette annonce. */
  function fractionAt(clientX: number): number | null {
    const bar = seekBarRef.current;
    if (!bar || !duration) return null;
    const rect = bar.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : null;
  }

  /** La vignette et la barre à un instant donné — le glissement relatif au doigt (§108). */
  function showPreviewAt(time: number, follow: boolean) {
    if (!duration) return;
    const clamped = Math.min(duration, Math.max(0, time));
    setPreviewFraction(clamped / duration);
    setPreviewTime(clamped);
    if (follow) previewSeek(clamped);
  }

  function updatePreview(clientX: number) {
    const fraction = fractionAt(clientX);
    if (fraction === null) return;
    setPreviewFraction(fraction);
    setPreviewTime(fraction * duration);
    // The bar follows the cursor while dragging — the same call the input makes, from the one
    // place that knows where the pointer is.
    //
    // Only while actually dragging. A pointer merely passing over the bar previews what is
    // there; moving the playhead under it would be the bar chasing the mouse.
    if (seekingRef.current) previewSeek(fraction * duration);
  }

  // Jellyfin's own trickplay resolution (already the smallest one it generates — see
  // trickplay/info's own comment) is still a fixed size that doesn't know about the viewport —
  // on a small phone (iPhone mini reported live) it could cover close to the whole screen width.
  // Scaled down to fit a fraction of the actual screen instead, capped at 1x so it's never
  // upscaled past its native resolution (would just look blurry).
  //
  // La largeur de l'écran est tenue à jour au redimensionnement, jamais lue pendant le rendu : lire
  // `window.innerWidth` force une mise en page synchrone quand la page a changé depuis la dernière
  // image — à chaque rendu, donc à chaque seconde affichée et à chaque appui. Au banc du 02/10/2026,
  // en paysage iPhone émulé : 14 mises en page forcées pour 16 appuis, toutes venues d'ici.
  const previewScale = trickplay && viewportWidth > 0 ? Math.min(1, (viewportWidth * 0.35) / trickplay.width) : 1;
  const previewDisplayWidth = trickplay ? Math.round(trickplay.width * previewScale) : 160;
  const previewDisplayHeight = trickplay ? Math.round(trickplay.height * previewScale) : 90;

  const previewTile = previewTime !== null ? trickplayTileAt(previewTime) : null;

  // Which chapter (if any) `time` currently falls inside — the last chapter whose start is
  // <= time. Shared by the scrub preview's discreet chapter label and could also back the
  // menu's "current chapter" highlight, but that one's own inline check is left untouched to
  // keep this change scoped to what was asked.
  function chapterIndexAt(time: number): number {
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if (time >= chapters[i].start) idx = i;
      else break;
    }
    return idx;
  }

  /* Le temps écoulé à gauche, ce qui reste à droite — sans signe moins, toujours, en pause
     comme en lecture. Il n'y a plus de bascule : les deux sont là. */
  return (
    <div className="player-fade flex items-center gap-3">
    <span data-player-elapsed className="player-time shrink-0 text-left">{formatTime(currentTime)}</span>
    <div
      ref={seekBarRef}
      className="relative min-w-0 flex-1 select-none"
      // Posé et retiré par le composant, qui sait exactement quand la barre est sous un
      // doigt ou un curseur — c'est déjà ce qui décide d'afficher la vignette. Laisser
      // faire `:hover` voulait dire la laisser épaissie longtemps après le doigt parti,
      // WebKit gardant l'état de survol jusqu'à ce qu'on touche ailleurs.
      data-scrub={previewTime !== null ? "" : undefined}
      style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
      // Same treatment as the top-bar buttons (see showControls' comment) but stronger:
      // holdControls() suspends auto-hide entirely for as long as the pointer is anywhere
      // on the bar — hovering to preview a thumbnail, or dragging — rather than merely
      // extending the timer, since a 10s cap could still expire mid-read on a long scrub.
      // The normal countdown only resumes once the pointer actually leaves or is released.
      onMouseEnter={() => {
        if (!isTouchEcho()) holdControls();
      }}
      onMouseMove={(e) => {
        // Rejoué au point du doigt, il rallumait la vignette que le touchend venait
        // d'éteindre — et plus aucun mouseup ne l'éteint, voir lastTouchEndRef.
        if (isTouchEcho()) return;
        holdControls();
        updatePreview(e.clientX);
      }}
      onMouseLeave={(e) => {
        setPreviewTime(null);
        // Sortie de la fenêtre par la barre : le `pointerout` vient de les cacher, rien à rappeler.
        // Hors de la page, React donne la fenêtre — ou rien — pour destination, jamais un nœud.
        if (!(e.relatedTarget instanceof Node) && windowExitHides()) return;
        if (!seekingRef.current) showControls(5000);
      }}
      // Au doigt, en relatif (§108) : le toucher montre la vignette là où en est le film, sans
      // rien déplacer ; le glissement déplace la tête d'autant que le doigt, depuis là.
      onTouchStart={(e) => {
        touchDragRef.current = true;
        inputPointerRef.current = "touch";
        const x = e.touches[0].clientX;
        lastTouchXRef.current = x;
        touchStartRef.current = { x, time: currentTime, target: null };
        // Le tic de la position se tait pendant le geste, d'où qu'il parte sur la barre :
        // sans cela il remettrait la barre sous la tête pendant que le doigt glisse.
        seekingRef.current = true;
        holdControls();
        showPreviewAt(currentTime, false);
      }}
      onTouchMove={(e) => {
        holdControls();
        const start = touchStartRef.current;
        const width = seekBarRef.current?.getBoundingClientRect().width ?? 0;
        if (!start || !duration || width <= 0) return;
        // Un doigt immobile n'est pas immobile au dixième de pixel près, et sur un
        // téléphone un pixel de barre vaut une vingtaine de secondes de film : sans ce
        // seuil, la vignette hésitait entre deux images sous un doigt posé.
        const x = e.touches[0].clientX;
        if (lastTouchXRef.current !== null && Math.abs(x - lastTouchXRef.current) < TOUCH_JITTER_PX) return;
        lastTouchXRef.current = x;
        if (start.target === null && Math.abs(x - start.x) < TOUCH_SLOP_PX) return;
        // Un pixel de doigt vaut un pixel de barre : la même échelle que la barre elle-même.
        const target = Math.min(duration, Math.max(0, start.time + ((x - start.x) / width) * duration));
        start.target = target;
        showPreviewAt(target, true);
      }}
      /**
       * Le saut est décidé ici, par le conteneur — et non par la valeur de l'input.
       *
       * Un `input[type=range]` sur iOS ne bouge que si l'on attrape sa pastille, cachée au
       * repos ; le conteneur, lui, suit le doigt depuis le début. Il ne valide qu'un vrai
       * glissement (`target`) : un toucher bref n'en est pas un, et ne déplace rien.
       */
      onTouchEnd={() => {
        const target = touchStartRef.current?.target ?? null;
        seekingRef.current = false;
        touchDragRef.current = false;
        lastTouchXRef.current = null;
        touchStartRef.current = null;
        lastTouchEndRef.current = performance.now();
        if (target !== null) commitSeek(target);
        setPreviewTime(null);
        setTimeout(() => showControls(5000), 0);
      }}
      // A touch the system takes back — a notification, a call, a gesture the browser
      // claims — never reaches touchend, and without this the bar would stay thick with
      // nothing on it. Rien n'est validé : le doigt n'a pas été relâché, il a été repris —
      // et la barre revient là où en est le film.
      onTouchCancel={() => {
        const start = touchStartRef.current;
        seekingRef.current = false;
        touchDragRef.current = false;
        lastTouchXRef.current = null;
        touchStartRef.current = null;
        if (start?.target != null) previewSeek(videoRef.current?.currentTime ?? start.time);
        setPreviewTime(null);
        showControls(5000);
      }}
    >
      {/* The rail at rest. Painted here rather than left to the native track, which cannot
          be sized at all without giving up `accent-color` — and giving that up is what
          lets the bar answer to a finger as well as to a pointer. */}
      <div className={`player-seek-rail pointer-events-none absolute top-1/2 w-full -translate-y-1/2 rounded-full bg-white/20 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`} />
      {/* Buffered range — deliberately subtle (a slightly lighter track, not a bold
          second color): its only job is "can I scrub ahead without waiting", not
          competing for attention with the actual playback position. Sits under the
          native range input's own track, which only leaves it visible in the *unplayed*
          portion — exactly the part worth showing. */}
      {downloadedFraction !== undefined && downloadedFraction > 0 && (
        <div
          data-downloaded-range=""
          // Plus sombre que la partie lue, nettement (Louis, 19/10/2026 : l'écart ne se voyait pas).
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/25 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`}
          style={{ width: `${Math.min(100, downloadedFraction * 100)}%`, WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
        />
      )}
      {/* Pas dans le lecteur hors ligne : la partie téléchargée y tient ce rôle, et les deux
          ensemble faisaient quatre teintes sur une barre qui doit en avoir trois (Louis, 19/10/2026). */}
      {downloadedFraction === undefined && duration > 0 && bufferedEnd > 0 && (
        <div
          className={`pointer-events-none absolute top-1/2 -translate-y-1/2 rounded-full bg-white/35 transition-[height] duration-[260ms] ease-[cubic-bezier(0.33,1,0.68,1)] ${scrubbing ? "h-3" : "h-2"}`}
          // Both pointer-events-none (blocks click/drag) AND the two -webkit- properties
          // (blocks the native long-press "Look Up / Copy / Writing Tools" callout menu,
          // which iOS can still trigger on an element even with pointer-events: none —
          // verified live, reported as an overlay that was somehow both unclickable and
          // yet opening iOS's text-selection UI on a long press) are needed together.
          style={{
            width: `${Math.min(100, (bufferedEnd / duration) * 100)}%`,
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
          }}
        />
      )}
      {/* Chapter markers — visual only, not independently clickable: the seek bar's own
          drag already covers the whole track, so a second, narrower hit target right on
          top of it would only make small drag corrections more error-prone. Jumping to a
          specific chapter is what the chapters menu button is for.
          Pendant le glissement seulement (19/10/2026) : au repos, une vingtaine de chapitres
          génériques (« Chapter 5 », Interstellar) hachaient la barre en pointillés. C'est en
          cherchant un passage qu'ils servent. */}
      {duration > 0 &&
        scrubbing &&
        chapters.map((ch, i) => (
          <div
            key={i}
            data-chapter-mark=""
            className="pointer-events-none absolute top-1/2 h-3 w-px -translate-y-1/2 bg-black/50"
            style={{ left: `${(ch.start / duration) * 100}%`, WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
          />
        ))}
      {previewTime !== null && (
        <div
          className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 overflow-hidden rounded-md bg-black shadow-xl ring-1 ring-white/20"
          style={{
            // Bornée aux bords de la barre : au début ou à la fin du film, la moitié de la
            // vignette sortait de l'écran, heure comprise.
            left: `clamp(${previewDisplayWidth / 2}px, ${previewFraction * 100}%, calc(100% - ${previewDisplayWidth / 2}px))`,
            width: previewDisplayWidth,
            height: previewDisplayHeight,
            WebkitTouchCallout: "none",
            WebkitUserSelect: "none",
          }}
        >
          {previewTile && (
            // Positioned/sized at Jellyfin's native trickplay resolution (unscaled — the
            // background-position math above is in those native pixel units), then scaled
            // down as a whole via transform to fit previewDisplayWidth/Height. Simpler and
            // exactly as sharp as recomputing every offset in scaled units would be, since
            // CSS transform scaling of a background-image is lossless the same way.
            <div
              style={{
                width: trickplay!.width,
                height: trickplay!.height,
                transform: `scale(${previewScale})`,
                transformOrigin: "top left",
                backgroundImage: `url(${previewTile.url})`,
                backgroundPosition: `${previewTile.bgX}px ${previewTile.bgY}px`,
                // Sized to the FULL sprite sheet, not one tile slot — a plain background
                // shorthand size here would stretch the whole sheet into one thumbnail's
                // box instead of just positioning the correct slot within it.
                backgroundSize: `${(trickplay!.width * trickplay!.tileWidth)}px ${(trickplay!.height * trickplay!.tileHeight)}px`,
              }}
            />
          )}
          <div className="absolute inset-x-0 bottom-0 bg-black/70 px-1 py-0.5 text-center text-white">
            {/* Discreet — a smaller, dimmer line above the time, not competing with it.
                Only shown once the item actually has chapters. */}
            {chapters.length > 0 && chapterIndexAt(previewTime) >= 0 && (
              <p className="truncate text-[10px] text-white/60">{chapters[chapterIndexAt(previewTime)].name ?? t("player.chapterN", { n: chapterIndexAt(previewTime) + 1 })}</p>
            )}
            <p className="text-[11px] tabular-nums">{formatTime(previewTime)}</p>
          </div>
        </div>
      )}
      <input
        data-player-nav="seek"
        type="range"
        min={0}
        max={duration || 0}
        value={currentTime}
        // Un nom et une valeur lisible (15/10/2026, passe de nuit, ROBUSTESSE-11) : sans eux,
        // un lecteur d'écran annonçait « curseur, 437 » — des secondes brutes, sans dire de quoi.
        aria-label={t("player.seekLabel")}
        aria-valuetext={t("player.seekValue", { at: formatTime(currentTime), total: formatTime(duration || 0) })}
        // Every intermediate value while dragging is a preview only (see previewSeek) —
        // native range inputs fire 'input'/onChange continuously during a drag, not just
        // on release, so onChange alone can't distinguish "still dragging" from "done".
        // mousedown/touchstart mark the start of a drag; mouseup/touchend (native pointer
        // capture keeps these firing on the input even if the pointer wanders outside its
        // bounds) commit the FINAL value as one real seek and let auto-hide resume after 5s.
        // Sauf sous la souris, où l'action par défaut de l'input passe après le mousemove
        // du conteneur et remettrait sa propre valeur par-dessus (voir mouseDragRef).
        onChange={(e) => {
          if (inputPointerRef.current === "touch") return;
          if (!mouseDragRef.current && !touchDragRef.current) previewSeek(Number(e.target.value));
        }}
        onPointerDown={(e) => {
          inputPointerRef.current = e.pointerType;
        }}
        onMouseDown={(e) => {
          // L'écho d'un toucher que le conteneur a déjà validé (voir lastTouchEndRef).
          if (isTouchEcho()) return;
          seekingRef.current = true;
          mouseDragRef.current = true;
          holdControls();
          // Un simple clic, sans mouvement : le même calcul que la vignette.
          const fraction = fractionAt(e.clientX);
          if (fraction !== null) previewSeek(fraction * duration);
        }}
        onTouchStart={() => {
          seekingRef.current = true;
          holdControls();
        }}
        // The 5s call is deferred a tick: mouseup/touchend is immediately followed by a
        // synchronous 'click' event, which the bottom bar's own onClickCapture (see its
        // comment) answers with a flat 10s for every other control there — since capture
        // fires on that ancestor before this handler's own effect could otherwise "stick",
        // running after the click's synchronous dispatch has already finished is what
        // makes 5s the one that actually wins, per what was asked for here specifically.
        onMouseUp={(e) => {
          if (isTouchEcho()) return;
          seekingRef.current = false;
          mouseDragRef.current = false;
          const fraction = fractionAt(e.clientX);
          commitSeek(fraction !== null ? fraction * duration : Number((e.target as HTMLInputElement).value));
          // Was missing here (only onTouchEnd cleared it) — a plain click/drag-release
          // with a mouse (or a mouse-like pointer, which iOS itself can synthesize in some
          // interaction patterns) left the trickplay preview frozen on screen indefinitely,
          // since nothing but leaving the bar entirely (onMouseLeave) would ever clear it.
          setPreviewTime(null);
          setTimeout(() => showControls(5000), 0);
        }}
        // Rien ici pour le toucher : c'est le conteneur qui le termine, et il est le seul
        // à savoir où le doigt était. Voir son onTouchEnd.
        onTouchEnd={() => {
          seekingRef.current = false;
        }}
        // ← et → appartiennent au clavier du lecteur (±10 s, l'écouteur de la fenêtre), barre
        // focalisée comprise : jamais le pas natif de l'input. La barre avait gardé de l'époque
        // d'avant le jeu fixe un aperçu au `keydown` et une validation au `keyup` — qui, la
        // fenêtre ayant déjà sauté de dix secondes entre-temps, validait l'ancienne valeur de
        // l'input (le tic de la position était suspendu par `seekingRef`) : après un clic sur la
        // barre, qui garde le focus, une flèche ne faisait rien, ou ramenait le film d'où il
        // venait (chasse aux défauts du 13/10/2026). Retenue ici aussi pour qu'un lecteur
        // suspendu, dont la fenêtre ignore les touches, ne laisse pas l'input bouger seul.
        //
        // Les autres touches d'un curseur natif (Début, Fin, Page préc./suiv., ↑ ↓) déplaçaient la
        // valeur de l'input sans saut : l'aperçu suivait, puis le tic suivant le ramenait à la
        // vraie position (audit du lecteur, 22/10/2026 — jamais validées, même avant 31bf7599).
        // Retenues ici aussi ; Début, Fin et les pages sautent par le même `skip` que les
        // flèches (Début au commencement, Fin à la fin, une minute par page). ↑ ↓ ne sautent
        // pas : sur une télécommande, ils ne font que montrer les commandes (l'écouteur de la
        // fenêtre, qui ne traite aucune des quatre autres — rien n'est fait deux fois).
        onKeyDown={(e) => {
          inputPointerRef.current = "keyboard";
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") e.preventDefault();
          const barDelta =
            e.key === "Home" ? -Infinity
            : e.key === "End" ? Infinity
            : e.key === "PageUp" ? 60
            : e.key === "PageDown" ? -60
            : null;
          if (barDelta === null && e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
          // Une combinaison reste au système, comme pour l'écouteur de la fenêtre.
          if (e.ctrlKey || e.metaKey || e.altKey) return;
          e.preventDefault();
          if (barDelta === null || suspendedRef.current) return;
          skip(barDelta);
          showControls();
        }}
        // h-5 (20px), not h-1: the native range control keeps its visual groove thin and
        // vertically centered regardless of the element's own box height, so a taller box
        // only grows the invisible hit area — reported live as too easy to lose while
        // trying to hold the mouse still on the bar to keep the trickplay preview up
        // during a straight horizontal drag. m-0: native range inputs carry a small
        // default margin in some engines' UA stylesheets that isn't reset by Tailwind's
        // own base styles — left in place, that margin would throw off centering the
        // buffered/chapter overlays on this taller box (see their top-1/2 above).
        className="player-seek relative m-0 block h-6 w-full cursor-pointer text-white"
        style={{
          // La part lue, que la piste native ne peut plus peindre elle-même.
          ["--played" as string]: `${duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0}%`,
          WebkitTouchCallout: "none",
        }}
      />
    </div>
    {/* Le temps restant porte son signe, comme sur l'Apple TV (19/10/2026) : « 2:13:36 » seul se
        lisait comme la durée du film. Pas de signe à zéro. */}
    <span data-player-remaining className="player-time shrink-0 text-right">{remainingLabel(duration, currentTime)}</span>
    </div>
  );
}
