// Le son qui commence après l'image — et le silence qui comble l'écart (DECISIONS.md §148).
//
// The Circle, iPhone, 12/11/2026 : l'image tamponnée dès 1,4 s, le son seulement dès 30,2 s. La
// piste AC-3 du fichier n'a aucun bloc avant 30 s (ffprobe : premier paquet à 30,000 s, alors que
// le conteneur annonce un début à 0). Or une MediaSource ne joue un instant que si *tous* ses
// tampons l'ont — l'élément ne voit que l'intersection — : rien de lisible sous la tête, une reprise
// au même endroit, le tampon audio de WebKit qui déborde à force d'avance, le lecteur serveur, qui
// échoue à son tour. Sous quinze secondes d'écart, l'atterrissage (`landingFor`) posait la tête au
// début du son : le film démarrait, mais sautait ses premières secondes d'image. 44 films ici au
// recensement du 12/11/2026, presque toujours une VF plus courte en tête que la VO (« Green Book » :
// VF à 24 s, VO à 0,02 s ; « WALL·E » : VF à 11,8 s, VO à −0,005 s).
//
// La réponse est celle d'un lecteur de fichier : jouer l'image, muette, jusqu'au premier son. Le
// silence passe par le ré-encodage existant (`audioTranscode.ts`), parce que c'est le seul endroit
// où l'on sait en fabriquer dans n'importe quel codec : du PCM nul donné à l'encodeur avant le
// premier bloc décodé. Des trames silencieuses écrites à la main dans le codec copié — une trame
// AAC-LC se fabrique, une trame AC-3 ou E-AC-3 beaucoup moins, et aucun navigateur n'en encode —
// auraient été un pari sur le décodeur de quelqu'un d'autre, invérifiable ici.

import type { MatroskaFile } from "./matroska";
import type { DecodedAudio } from "./softwareAudio";

/**
 * L'écart, en secondes, au-delà duquel le son « commence après l'image ».
 *
 * En dessous, rien ne change : l'atterrissage pose la tête sur le premier instant commun, ce qui
 * saute au pire une demi-seconde d'image — d'ordinaire du noir —, et les écarts ordinaires vivent
 * là : une VO à 20 ms de l'image (« Green Book »), une trame audio de 21 ou 32 ms, les 200 ms de
 * présentation d'une image réordonnée. Au-dessus, le recensement du 12/11/2026 (931 films) trouve 63
 * pistes de 0,59 à 30 s, dont une quinzaine à 1,00 s tout rond (« 1917 ») : la moitié de ces pistes
 * ne perdaient qu'une ou deux secondes d'ouverture, et paient désormais un ré-encodage pour les
 * rendre — DECISIONS.md §148 dit le compte, et que ce nombre est le seul réglage à toucher.
 *
 * **Deux secondes** (choix du 12/11/2026, à la relecture) : sous ce seuil, l'atterrissage n'enjambe qu'une ou
 * deux secondes d'ouverture — presque toujours du noir —, et ré-encoder tout le film pour les rendre coûtait
 * plus (une génération de perte, le décodeur sur l'appareil) que ce qu'il rendait. Au-dessus, le film ne
 * démarrait plus du tout (*The Circle*, 30 s) ou sautait ses premières secondes d'image (*WALL·E*, 11,8 s).
 */
export const AUDIO_LEAD_GAP_SECONDS = 2;

/** Ce que le lecteur a fait d'un son en retard : comblé, ou enjambé comme avant (piste qu'on ne sait pas décoder). */
export type AudioGapAction = "silence" | "enjambé";

export interface AudioLeadGap {
  /** L'écart mesuré, en secondes — ou retenu par la page (`rememberLeadGap`) quand ce pipeline s'ouvre au-delà. */
  gapS: number;
  action: AudioGapAction;
}

/**
 * **La décision** : l'écart entre le premier instant de l'image et le premier son de la piste, s'il
 * dépasse le seuil — sinon `null`, et rien ne change. Une seule fonction, appelée à l'ouverture
 * (`Remuxer.open`, sonde de la piste copiée), par le transcodeur à chaque saut (`withLeadSilence`)
 * et pour le journal : jamais une seconde copie de la règle.
 *
 * Un son qui arrive *avant* l'image (le bloc audio rangé devant l'image clé, le cas courant) n'est
 * pas un trou.
 */
export function audioLeadGapSeconds(videoStartSeconds: number, firstAudioSeconds: number): number | null {
  const gap = firstAudioSeconds - videoStartSeconds;
  return gap > AUDIO_LEAD_GAP_SECONDS ? gap : null;
}

/**
 * Les pistes de ce fichier dont on a vu, sur cette page, que le son commence tard.
 *
 * Une reprise ou un changement de piste au-delà du trou ouvre un pipeline qui n'en voit rien — la
 * sonde ne lit que là où la lecture commence, jamais la tête du fichier (des mégaoctets sur un
 * téléphone en itinérance). Copiée, la piste ne pourrait plus combler le trou si le spectateur
 * revenait au début. Retenue ici dès qu'un pipeline l'a vu, elle reste ré-encodée pour toute la
 * page. L'en-tête analysé est gardé et rendu tel quel d'une ouverture à l'autre
 * (`rememberedHeaders`) : la clé est cet objet, et l'entrée part avec lui.
 */
const lateTracks = new WeakMap<MatroskaFile, Map<number, number>>();

export function rememberLeadGap(file: MatroskaFile, trackNumber: number, gapS: number): void {
  let tracks = lateTracks.get(file);
  if (!tracks) lateTracks.set(file, (tracks = new Map()));
  // Le plus grand vu : mesuré depuis une image clé plus proche du début, il dit mieux le trou de tête.
  tracks.set(trackNumber, Math.max(gapS, tracks.get(trackNumber) ?? 0));
}

/** L'écart retenu pour cette piste, ou `undefined` si aucun pipeline de la page ne l'a vu. */
export function rememberedLeadGap(file: MatroskaFile, trackNumber: number): number | undefined {
  return lateTracks.get(file)?.get(trackNumber);
}

/** Combien d'images de silence par bloc : ~85 ms à 48 kHz, la taille d'un bloc décodé ordinaire. */
const SILENCE_BLOCK_FRAMES = 4096;

/**
 * Le décodé à partir de `fromSeconds`, précédé du silence qui manque quand le premier son arrive
 * plus tard que le seuil — sinon le flux du décodeur, bloc pour bloc, les mêmes objets.
 *
 * Le silence va de `fromSeconds` (le début de l'image du segment, que le remultiplexeur donne au
 * transcodeur à chaque saut) jusqu'au premier bloc réel, au nombre d'images près : arrondi une fois
 * sur le total, il finit à moins d'un demi-échantillon de ce bloc, et l'encodeur, qui compte ses
 * échantillons, enchaîne le vrai son sans trou ni recouvrement. Mêmes plans et même fréquence que
 * ce premier bloc — ce que le décodeur rend vraiment, pas ce que l'en-tête annonçait. Produit au
 * fil de la demande : trente secondes de 5.1 d'un coup, ce seraient 35 Mo de zéros.
 *
 * Le premier bloc réel se fait attendre le temps de lire le trou (8 Mo pour « The Circle ») : c'est
 * la seule façon de savoir où finir le silence, et ces octets sont ceux que l'image lira juste après
 * (cache de `HttpByteSource`).
 */
export async function* withLeadSilence(
  decoded: AsyncGenerator<DecodedAudio>,
  fromSeconds: number,
  onGap?: (gapS: number) => void
): AsyncGenerator<DecodedAudio> {
  // Fermé quoi qu'il arrive : un saut ferme ce générateur (`AudioTranscoder.seekTo`) pendant qu'il
  // rend du silence, et le flux du décodeur, suspendu derrière, serait resté ouvert.
  try {
    const first = await decoded.next();
    if (first.done) return;
    const block = first.value;
    const gap = audioLeadGapSeconds(fromSeconds, block.timestampSeconds);
    if (gap !== null) {
      onGap?.(gap);
      const rate = block.sampleRate;
      const total = Math.round(gap * rate);
      // Des plans nuls partagés par tous les blocs pleins : l'encodeur ne fait que les lire.
      const full = Array.from({ length: block.planes.length }, () => new Float32Array(SILENCE_BLOCK_FRAMES));
      for (let done = 0; done < total; done += SILENCE_BLOCK_FRAMES) {
        const frames = Math.min(SILENCE_BLOCK_FRAMES, total - done);
        yield {
          planes: frames === SILENCE_BLOCK_FRAMES ? full : full.map(() => new Float32Array(frames)),
          sampleRate: rate,
          timestampSeconds: fromSeconds + done / rate,
        };
      }
    }
    yield block;
    yield* decoded;
  } finally {
    await decoded.return?.(undefined);
  }
}

/** Les champs de la ligne `start` pour un fichier à trou — rien pour les autres, dont la ligne ne change pas. */
export function audioLeadGapFields(gap: AudioLeadGap | null | undefined): Record<string, unknown> {
  if (!gap) return {};
  return { audioLeadGapS: Math.round(gap.gapS * 10) / 10, audioGap: gap.action };
}
