// Reprendre l'affichage d'une vidéo HDR que le navigateur rend mal.
//
// Le chemin natif laisse tout faire au navigateur : il décode en matériel, convertit les couleurs
// et compose lui-même. C'est ce qui le rend bon marché, et sur la plupart des plateformes c'est
// aussi ce qui donne la meilleure image. Mais certaines combinaisons — Firefox sous Linux en
// tête — envoient les valeurs BT.2020/PQ d'un fichier HDR à un écran qui ne l'est pas sans les
// convertir, et le film sort gris et délavé.
//
// Ce module reprend alors la dernière étape, et elle seule. L'élément vidéo continue de décoder en
// matériel, de porter le son et de mener l'horloge ; on lui prend seulement l'image, à chaque
// image présentée, pour la faire passer par le shader du chemin canevas — le même, écrit pour ce
// problème exact — et la peindre sur un canevas posé par-dessus.
//
// Ce qui décide n'est pas le navigateur ni le système, mais ce que l'image répond quand on lui
// demande dans quel espace elle est. Deux réponses, deux traitements :
//
//   * `pq` — les vraies valeurs HDR ont survécu au décodage matériel. Conversion complète :
//     PQ vers la lumière, repli BT.2390, BT.2020 vers BT.709, courbe sRGB.
//   * autre chose — la conversion a déjà eu lieu avant qu'on puisse la voir, et ce qu'elle a
//     écrasé est perdu. On ne convertit pas : on remet le contraste et la couleur qu'elle a
//     emportés, ce qui est une réparation et se dit comme telle.
//
// Rien n'est supposé, tout est demandé, et le module se retire proprement dès qu'il ne peut pas
// tenir sa promesse — l'élément est resté dessous, intact, il suffit de découvrir.

import { createRenderer, createHdrRecoveryRenderer, type FrameRenderer } from "./renderer";
import { trace } from "./trace";

/** Ce que le présentateur fait réellement, une fois la question posée à l'image. */
export type HdrPresentation = "tonemap" | "recovery";

export interface HdrProbe {
  /**
   * Ce que l'image dit d'elle-même, repris tel quel dans le relevé.
   *
   * L'espace colorimétrique d'abord, mais pas seulement : Firefox sous Linux construit bien une
   * image à partir de l'élément et n'en déclare aucun — les trois champs reviennent nuls, ce qui
   * veut dire « je ne sais pas » et non « sRGB ». La question reste alors entière, et c'est le
   * format qui la tranche : des plans 10 bits sont ceux du décodeur, donc encore en BT.2020/PQ,
   * là où du RGBA a forcément traversé une conversion. La taille d'allocation dit la dernière
   * chose qui manque — si les octets sont seulement lisibles.
   */
  colorSpace: string;
  presentation: HdrPresentation;
}

/**
 * Ce qu'une image de cet élément porte.
 *
 * Peut échouer pour de bonnes raisons — aucune image encore décodée, un navigateur sans
 * `VideoFrame`, une image que la plateforme refuse de laisser capturer. Toutes se traitent
 * pareil : on ne reprend pas l'affichage.
 */
export function probeFrame(video: HTMLVideoElement): HdrProbe | null {
  const Frame = (globalThis as { VideoFrame?: new (source: CanvasImageSource) => VideoFrame }).VideoFrame;
  if (!Frame || video.readyState < 2) return null;
  let frame: VideoFrame | null = null;
  try {
    frame = new Frame(video);
    const space = frame.colorSpace;
    const format = frame.format ?? "format non déclaré";
    let readable: string;
    try {
      readable = `${frame.allocationSize()} o lisibles`;
    } catch (error) {
      readable = `octets illisibles (${error instanceof Error ? error.message : String(error)})`;
    }
    // Typé en `string` volontairement : la définition de lib.dom livrée avec ce TypeScript ne
    // connaît que bt709/sRGB/smpte170m et ignore « pq » et « hlg », qui sont pourtant les seules
    // valeurs qui nous intéressent ici. Comparer contre l'énumération périmée ne compilerait pas.
    const transfer: string = space.transfer ?? "?";
    return {
      colorSpace: `${space.primaries ?? "?"} · ${transfer} · ${space.matrix ?? "?"} · ${format} · ${readable}`,
      // « pq » est le nom que la spécification donne à la courbe SMPTE ST 2084 ; certaines
      // implémentations rendent l'autre. Les deux disent la même chose.
      presentation: transfer === "pq" || transfer === "smpte2084" ? "tonemap" : "recovery",
    };
  } catch {
    return null;
  } finally {
    frame?.close();
  }
}

export interface HdrPresenterOptions {
  /** Ce que le présentateur a fini par faire, ou pourquoi il s'est retiré. */
  onState: (state: { presentation: HdrPresentation; colorSpace: string } | null) => void;
  /** La conversion complète a renoncé en cours de route — trop lente pour cet appareil. */
  onDowngrade?: (reason: string) => void;
}

/**
 * Le présentateur.
 *
 * Démarré seulement quand l'appelant a décidé qu'il fallait le faire ; il ne juge pas de
 * l'opportunité, seulement de la faisabilité.
 */
export class HdrPresenter {
  private renderer: FrameRenderer | null = null;
  private stopped = false;
  private rvfcHandle: number | null = null;
  private rafHandle: number | null = null;
  private drawing = false;
  private readonly FrameCtor: (new (source: CanvasImageSource) => VideoFrame) | undefined;

  private constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly options: HdrPresenterOptions
  ) {
    this.FrameCtor = (globalThis as { VideoFrame?: new (source: CanvasImageSource) => VideoFrame }).VideoFrame;
  }

  /** Renvoie null si rien ne peut être repris : l'appelant laisse alors l'élément à découvert. */
  static start(
    video: HTMLVideoElement,
    canvas: HTMLCanvasElement,
    options: HdrPresenterOptions
  ): HdrPresenter | null {
    const probe = probeFrame(video);
    if (!probe) {
      trace("affichage HDR : aucune image lisible, l'élément garde l'affichage");
      return null;
    }
    const presenter = new HdrPresenter(video, canvas, options);
    try {
      presenter.renderer =
        probe.presentation === "tonemap"
          ? createRenderer(canvas, {
              hdr: true,
              onHdrFallback: (reason) => options.onDowngrade?.(reason),
            })
          : createHdrRecoveryRenderer(canvas);
    } catch (error) {
      trace(`affichage HDR : impossible de préparer le rendu — ${message(error)}`);
      return null;
    }
    trace(
      `affichage HDR : image en ${probe.colorSpace} → ${
        probe.presentation === "tonemap" ? "conversion complète" : "récupération du contraste"
      }`
    );
    options.onState({ presentation: probe.presentation, colorSpace: probe.colorSpace });
    presenter.schedule();
    return presenter;
  }

  /**
   * Une image dessinée par image présentée.
   *
   * `requestVideoFrameCallback` est fait pour ça : il se déclenche quand l'élément a réellement
   * une nouvelle image, ni plus ni moins souvent. Là où il manque, on retombe sur la boucle
   * d'animation, qui dessine parfois deux fois la même image — coûteux mais jamais faux.
   */
  private schedule(): void {
    if (this.stopped) return;
    const element = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };
    if (element.requestVideoFrameCallback) {
      this.rvfcHandle = element.requestVideoFrameCallback(() => void this.paint());
    } else {
      this.rafHandle = requestAnimationFrame(() => void this.paint());
    }
  }

  private async paint(): Promise<void> {
    if (this.stopped || !this.renderer || !this.FrameCtor) return;
    // Une image encore en cours de dessin : on saute celle-ci plutôt que d'en empiler deux, ce
    // qui ferait grossir la file sans jamais rattraper.
    if (this.drawing) {
      this.schedule();
      return;
    }
    this.drawing = true;
    let frame: VideoFrame | null = null;
    try {
      frame = new this.FrameCtor(this.video);
      await this.renderer.draw(frame);
    } catch (error) {
      // Un échec de dessin n'est pas rattrapable image par image : on rend l'affichage à
      // l'élément, qui n'a jamais cessé de jouer.
      trace(`affichage HDR : abandon — ${message(error)}`);
      this.stop();
      this.options.onState(null);
      return;
    } finally {
      frame?.close();
      this.drawing = false;
    }
    this.schedule();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const element = this.video as HTMLVideoElement & { cancelVideoFrameCallback?: (handle: number) => void };
    if (this.rvfcHandle !== null) element.cancelVideoFrameCallback?.(this.rvfcHandle);
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.renderer?.destroy();
    this.renderer = null;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
