// Lire et écrire bit à bit, poids fort d'abord — l'ordre de l'AAC (ISO/IEC 14496-3) et de l'AC-3
// (ATSC A/52). Un module à lui plutôt que le `BitReader` de `mp4SampleEntries.ts` : Lumen serveur ne
// touche à rien sous `src/lib/webcodecs/` (le lecteur de production ne bouge pas d'un octet), et les
// deux lecteurs n'ont pas le même contrat — celui-ci lève en dépassant la fin, ce qui est le signal
// qu'une trame n'a pas la forme qu'on croit.

export class BitsExhausted extends Error {
  constructor() {
    super("Lecture au-delà de la fin de la trame.");
    this.name = "BitsExhausted";
  }
}

export class BitReader {
  /** La position, en bits depuis le début. */
  pos = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get length(): number {
    return this.bytes.length * 8;
  }

  get left(): number {
    return this.length - this.pos;
  }

  bit(): number {
    if (this.pos >= this.length) throw new BitsExhausted();
    const value = (this.bytes[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos += 1;
    return value;
  }

  /** `n` bits (n ≤ 32), comme un entier non signé. */
  read(n: number): number {
    if (this.pos + n > this.length) throw new BitsExhausted();
    let value = 0;
    for (let i = 0; i < n; i++) value = value * 2 + this.bit();
    return value;
  }

  skip(n: number): void {
    if (n < 0 || this.pos + n > this.length) throw new BitsExhausted();
    this.pos += n;
  }

  /** Au prochain octet entier (relativement au début du tampon). */
  align(): void {
    this.pos = Math.min(this.length, (this.pos + 7) & ~7);
  }
}

export class BitWriter {
  private readonly bits: number[] = [];

  get length(): number {
    return this.bits.length;
  }

  /** `value` sur `n` bits, poids fort d'abord. */
  write(value: number, n: number): this {
    if (value < 0 || value >= 2 ** n) throw new RangeError(`${value} ne tient pas sur ${n} bits`);
    for (let i = n - 1; i >= 0; i--) this.bits.push(Math.floor(value / 2 ** i) & 1);
    return this;
  }

  /** Les bits [from, to) d'un tampon, recopiés tels quels. */
  copy(bytes: Uint8Array, from: number, to: number): this {
    for (let p = from; p < to; p++) this.bits.push((bytes[p >> 3] >> (7 - (p & 7))) & 1);
    return this;
  }

  /** Des zéros jusqu'au prochain octet entier. */
  align(): this {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    return this;
  }

  /** Les octets écrits ; `size` complète de zéros (et refuse un contenu trop long). */
  bytes(size?: number): Uint8Array {
    const total = size ?? Math.ceil(this.bits.length / 8);
    if (this.bits.length > total * 8) throw new RangeError(`${this.bits.length} bits pour ${total} octets`);
    const out = new Uint8Array(total);
    this.bits.forEach((b, i) => {
      if (b) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}
