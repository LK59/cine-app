/**
 * Ce que dit la configuration d'une piste AAC (AudioSpecificConfig, ISO 14496-3 §1.6.2.1) — assez
 * pour savoir si un navigateur la prendra telle quelle.
 *
 * Né de « Elle s'appelle Ruby » sur une Fire TV (10/10/2026) : ses deux pistes AAC-LC 6 canaux
 * portent une `channelConfiguration` à 0, la disposition étant décrite par un élément PCE (écrit par
 * l'encodeur AAC de FFmpeg pour une disposition hors norme). Chromium répond oui à
 * `isTypeSupported('audio/mp4; codecs="mp4a.40.2"')`, puis refuse le segment d'initialisation : la
 * MediaSource passe à `ended`, sans un son. Vérifié dans Chromium avec les octets exacts que produit
 * notre remultiplexeur pour ce fichier, l'image passant, elle, sans encombre. Son AudioDecoder, lui,
 * décode ces trames sans difficulté (40 sur 40, six canaux) : la piste se ré-encode, elle ne se
 * copie pas.
 */

/** La disposition décrite par un PCE : les éléments de chaque rang, et le total de canaux. */
export interface AacPce {
  /** Pour chaque élément avant, `true` s'il est stéréo (CPE), `false` s'il est mono (SCE). */
  front: boolean[];
  side: boolean[];
  back: boolean[];
  lfe: number;
  channels: number;
}

export interface AacConfig {
  objectType: number;
  channelConfiguration: number;
  pce: AacPce | null;
}

class Bits {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  read(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new RangeError("configuration AAC tronquée");
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
}

/** La configuration relue, ou `null` si les octets n'en sont pas une. */
export function parseAacConfig(asc: Uint8Array | null | undefined): AacConfig | null {
  if (!asc || asc.length < 2) return null;
  try {
    const b = new Bits(asc);
    let objectType = b.read(5);
    if (objectType === 31) objectType = 32 + b.read(6);
    const frequencyIndex = b.read(4);
    if (frequencyIndex === 15) b.read(24);
    const channelConfiguration = b.read(4);
    if (channelConfiguration !== 0) return { objectType, channelConfiguration, pce: null };
    // GASpecificConfig des profils courants (1, 2, 3, 4, 6, 7) : frameLengthFlag,
    // dependsOnCoreCoder (et son délai), extensionFlag — puis le PCE, quand la configuration vaut 0.
    if (![1, 2, 3, 4, 6, 7].includes(objectType)) return { objectType, channelConfiguration, pce: null };
    b.read(1);
    if (b.read(1)) b.read(14);
    b.read(1);
    b.read(4); // element_instance_tag
    b.read(2); // object_type
    b.read(4); // sampling_frequency_index
    const nFront = b.read(4);
    const nSide = b.read(4);
    const nBack = b.read(4);
    const nLfe = b.read(2);
    const nAssoc = b.read(3);
    const nCc = b.read(4);
    if (b.read(1)) b.read(4); // mono_mixdown
    if (b.read(1)) b.read(4); // stereo_mixdown
    if (b.read(1)) b.read(3); // matrix_mixdown
    const elements = (n: number) =>
      Array.from({ length: n }, () => {
        const cpe = b.read(1) === 1;
        b.read(4);
        return cpe;
      });
    const front = elements(nFront);
    const side = elements(nSide);
    const back = elements(nBack);
    for (let i = 0; i < nLfe; i++) b.read(4);
    for (let i = 0; i < nAssoc; i++) b.read(4);
    for (let i = 0; i < nCc; i++) b.read(5);
    const count = (list: boolean[]) => list.reduce((n, cpe) => n + (cpe ? 2 : 1), 0);
    const channels = count(front) + count(side) + count(back) + nLfe;
    return { objectType, channelConfiguration, pce: { front, side, back, lfe: nLfe, channels } };
  } catch {
    return null;
  }
}

/**
 * Faux pour une piste qu'un navigateur ne prendra pas telle quelle dans MediaSource : celle dont la
 * disposition n'est pas une configuration standard mais un PCE (`channelConfiguration` à 0).
 */
export function aacCopyable(asc: Uint8Array | null | undefined): boolean {
  const config = parseAacConfig(asc);
  return !config || config.channelConfiguration !== 0;
}

/**
 * Le nombre de canaux d'un PCE quand il décrit exactement une disposition dont le rang de chaque
 * canal est connu (mono, stéréo, 3.0, 5.1, 7.1 — `KNOWN_LAYOUTS` du transcodeur), sinon `null`.
 *
 * Le décodeur ne rend que le compte : six canaux sans caisson, comme ceux de « Ruby » (avant
 * L R + C, un mono latéral, une paire arrière), seraient lus comme un 5.1 — une ambiance envoyée
 * dans le caisson. Hors de ces dispositions, le transcodeur garde L R C, comme pour toute
 * disposition inconnue (voir `frontOnly`).
 */
export function aacKnownPceChannels(asc: Uint8Array | null | undefined): number | null {
  const pce = parseAacConfig(asc)?.pce;
  if (!pce) return null;
  const shape = (list: boolean[]) => list.map((cpe) => (cpe ? "C" : "S")).join("");
  const front = shape(pce.front);
  const surround = shape([...pce.side, ...pce.back]);
  if (pce.lfe === 0 && surround === "" && front === "S") return 1;
  if (pce.lfe === 0 && surround === "" && front === "C") return 2;
  if (pce.lfe === 0 && surround === "" && front === "SC") return 3;
  if (pce.lfe === 1 && front === "SC" && surround === "C") return 6;
  if (pce.lfe === 1 && front === "SCC" && surround === "C") return 8;
  if (pce.lfe === 1 && front === "SC" && surround === "CC") return 8;
  return null;
}
