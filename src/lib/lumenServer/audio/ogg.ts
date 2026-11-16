// Un Ogg Opus minimal (RFC 3533, RFC 7845), pour donner à ffmpeg les paquets Opus d'une fenêtre (DECISIONS.md §161).
//
// L'Opus n'a pas de flux élémentaire qui se délimite seul : ses paquets n'ont ni mot de synchronisation ni
// longueur. Le Matroska les délimite par ses blocs ; ffmpeg, sur son entrée standard, a besoin d'un conteneur.
// Le plus petit qu'il lise est l'Ogg : une page d'en-tête (`OpusHead`), une page de commentaires (`OpusTags`),
// puis une page par paquet, chacune avec sa position (`granulepos`, le nombre d'échantillons à la fin du paquet).
//
// Le `pre-skip` de l'en-tête est **mis à zéro** : ffmpeg retrancherait sinon ces échantillons du début de *chaque*
// fenêtre, alors qu'ils ne valent qu'au tout début de la piste — et la position de la fenêtre (`planFeed`) les a
// déjà comptés (`firstSample` = premier bloc − pre-skip). La position finale est exacte (somme des durées) : ffmpeg
// ne rogne pas la fin. Tout le reste de l'en-tête (canaux, table de canaux, gain) est recopié tel quel.

/** CRC-32 de l'Ogg : polynôme 0x04C11DB7, sans réflexion, valeur initiale 0. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(bytes: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < bytes.length; i++) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const SERIAL = 0x4c554d4e; // « LUMN » : un seul flux, n'importe quel numéro fait l'affaire

/** Une page Ogg portant un paquet entier (au plus 255 × 255 octets — un paquet Opus en fait au plus 1 275 × 6). */
function page(packet: Uint8Array, sequence: number, granule: bigint, flags: number): Uint8Array {
  const lacing: number[] = [];
  let left = packet.length;
  while (left >= 255) {
    lacing.push(255);
    left -= 255;
  }
  lacing.push(left);
  if (lacing.length > 255) throw new Error("Paquet Opus trop long pour une page Ogg.");
  const header = 27 + lacing.length;
  const out = new Uint8Array(header + packet.length);
  const view = new DataView(out.buffer);
  out.set([0x4f, 0x67, 0x67, 0x53], 0); // « OggS »
  out[4] = 0; // version
  out[5] = flags;
  view.setBigInt64(6, granule, true);
  view.setUint32(14, SERIAL, true);
  view.setUint32(18, sequence, true);
  // CRC (22..25) à zéro pour le calcul.
  out[26] = lacing.length;
  out.set(lacing, 27);
  out.set(packet, header);
  view.setUint32(22, oggCrc(out), true);
  return out;
}

/** L'en-tête `OpusHead` recopié, `pre-skip` à zéro. */
export function zeroPreSkip(head: Uint8Array): Uint8Array {
  const copy = new Uint8Array(head);
  copy[10] = 0;
  copy[11] = 0;
  return copy;
}

const OPUS_TAGS = (() => {
  // Un vendeur neutre : le nom de l'application ne s'écrit qu'à un endroit (`appBuild.ts`, `playback-clients-noms.test.ts`).
  const vendor = new TextEncoder().encode("lumen-ogg");
  const out = new Uint8Array(8 + 4 + vendor.length + 4);
  out.set(new TextEncoder().encode("OpusTags"), 0);
  new DataView(out.buffer).setUint32(8, vendor.length, true);
  out.set(vendor, 12);
  // 0 commentaire.
  return out;
})();

/** Un flux Ogg Opus complet : en-tête, commentaires, et chaque paquet avec sa position. */
export function oggOpus(head: Uint8Array, packets: readonly { data: Uint8Array; samples: number }[]): Uint8Array {
  const pages: Uint8Array[] = [page(zeroPreSkip(head), 0, BigInt(0), 0x02), page(OPUS_TAGS, 1, BigInt(0), 0)];
  let granule = BigInt(0);
  packets.forEach((p, i) => {
    granule += BigInt(p.samples);
    pages.push(page(p.data, i + 2, granule, i === packets.length - 1 ? 0x04 : 0));
  });
  const total = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of pages) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
