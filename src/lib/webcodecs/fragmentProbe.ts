/**
 * Où commence un fragment fMP4, lu dans ses propres octets — pour le journal seulement.
 *
 * Le 14/10/2026, un « Media failed to decode » après un saut arrière sur un iPhone (Lucifer
 * S01E05) n'a laissé au journal ni où la tête se trouvait dans le fragment, ni lequel venait
 * d'être envoyé : le fichier et nos octets se sont montrés sains après coup, et rien ne permettait
 * de rapprocher l'échec d'un endroit du flux. Le fragment le dit lui-même — `mfhd` (son numéro),
 * `tfdt` (le décodage de sa première image) et la première entrée du `trun` (son décalage de
 * présentation) — sans toucher au `mdat` : une lecture de quelques dizaines d'octets d'en-tête.
 *
 * Ne lève jamais : un fragment mal formé, un segment d'initialisation ou un tampon tronqué
 * répondent `null`. Rien ici n'est sur le chemin d'une lecture.
 */

/** L'horloge de toutes les pistes que le remultiplexeur écrit (`TIMESCALE` de remuxer.ts). */
export const REMUX_TIMESCALE = 1_000_000;

export interface FragmentTimes {
  /** Numéro de séquence du `mfhd`, ou `null` s'il manque. */
  seq: number | null;
  /** Décodage de la première image, en secondes sur l'horloge des octets (celle de l'élément). */
  dts: number;
  /** Présentation de la première image dans l'ordre de décodage (dts + décalage du `trun`). */
  pts: number;
}

interface Box {
  type: string;
  start: number;
  end: number;
  /** Début du contenu, après l'en-tête. */
  body: number;
}

function boxesIn(view: DataView, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to && out.length < 64) {
    let size = view.getUint32(at);
    const type = String.fromCharCode(view.getUint8(at + 4), view.getUint8(at + 5), view.getUint8(at + 6), view.getUint8(at + 7));
    let body = at + 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = view.getUint32(at + 8) * 2 ** 32 + view.getUint32(at + 12);
      body = at + 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < body - at || at + size > to) break;
    out.push({ type, start: at, end: at + size, body });
    at += size;
  }
  return out;
}

export function fragmentTimes(data: Uint8Array, timescale = REMUX_TIMESCALE): FragmentTimes | null {
  try {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const moof = boxesIn(view, 0, data.byteLength).find((b) => b.type === "moof");
    if (!moof) return null;
    const inner = boxesIn(view, moof.body, moof.end);
    const mfhd = inner.find((b) => b.type === "mfhd");
    const seq = mfhd && mfhd.body + 8 <= mfhd.end ? view.getUint32(mfhd.body + 4) : null;
    const traf = inner.find((b) => b.type === "traf");
    if (!traf) return null;
    const parts = boxesIn(view, traf.body, traf.end);
    const tfdt = parts.find((b) => b.type === "tfdt");
    if (!tfdt) return null;
    const tfdtVersion = view.getUint8(tfdt.body);
    const decode =
      tfdtVersion === 1
        ? view.getUint32(tfdt.body + 4) * 2 ** 32 + view.getUint32(tfdt.body + 8)
        : view.getUint32(tfdt.body + 4);
    let offset = 0;
    const trun = parts.find((b) => b.type === "trun");
    if (trun) {
      const version = view.getUint8(trun.body);
      const flags = view.getUint32(trun.body) & 0xffffff;
      const count = view.getUint32(trun.body + 4);
      let p = trun.body + 8;
      if (flags & 0x1) p += 4; // data-offset
      if (flags & 0x4) p += 4; // first-sample-flags
      if (count > 0) {
        if (flags & 0x100) p += 4; // duration
        if (flags & 0x200) p += 4; // size
        if (flags & 0x400) p += 4; // flags
        if (flags & 0x800 && p + 4 <= trun.end) offset = version === 1 ? view.getInt32(p) : view.getUint32(p);
      }
    }
    return { seq, dts: decode / timescale, pts: (decode + offset) / timescale };
  } catch {
    return null;
  }
}
