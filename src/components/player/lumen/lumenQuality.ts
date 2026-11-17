/**
 * Le temps passé à chaque hauteur d'image pendant une lecture Lumen serveur : ce que la page voit des bascules de
 * Safari entre la vidéo d'origine et la version allégée (`resize` de l'élément, `videoHeight`). Rien n'est envoyé en
 * cours de route : le bilan (`stop`) porte `quality` (« 1608:540 692:60 », secondes par hauteur, la plus longue
 * d'abord) et `qualitySwitches` — seulement si la hauteur a changé au moins une fois, pour que la ligne d'une lecture
 * sans bascule reste celle d'avant.
 */
export class QualityTally {
  private height = 0;
  private since = 0;
  private readonly seconds = new Map<number, number>();
  switches = 0;

  /** Une hauteur vue à l'instant `now` (ms). 0 : pas encore d'image. */
  note(height: number, now: number): boolean {
    if (height <= 0 || height === this.height) return false;
    this.close(now);
    const changed = this.height > 0;
    if (changed) this.switches += 1;
    this.height = height;
    this.since = now;
    return changed;
  }

  private close(now: number): void {
    if (this.height > 0) this.seconds.set(this.height, (this.seconds.get(this.height) ?? 0) + Math.max(0, now - this.since) / 1000);
    this.since = now;
  }

  /** Les champs du bilan, ou rien sans bascule. */
  fields(now: number): Record<string, string | number> {
    if (this.switches === 0) return {};
    this.close(now);
    const summary = [...this.seconds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([h, s]) => `${h}:${Math.round(s)}`)
      .join(" ");
    return { quality: summary, qualitySwitches: this.switches };
  }
}
