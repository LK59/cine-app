import { describe, it, expect } from "vitest";
import { torrentStateLabel } from "@/lib/torrentState";
import { createT, LOCALES } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/** La gestion affichait « Downloading », « StalledDL » bruts sur une page française (18/11/2026). */
const DICTS = { fr, en, es, de } as Record<string, Record<string, unknown>>;
const STATES = Object.keys((fr as { qbittorrent: { states: Record<string, string> } }).qbittorrent.states);

describe("torrentStateLabel", () => {
  it("dit l'état dans la langue de l'écran", () => {
    const t = createT(fr, fr, "fr");
    expect(torrentStateLabel("downloading", t)).toBe("Téléchargement");
    expect(torrentStateLabel("stalledDL", t)).toBe("En attente de sources");
    expect(torrentStateLabel("stoppedUP", t)).toBe("Terminé, arrêté");
  });

  it("chaque état de l'API v2 a sa clé dans les quatre langues", () => {
    expect(STATES).toHaveLength(22);
    for (const locale of LOCALES) {
      // Sans repli : une clé absente reviendrait telle quelle.
      const t = createT(DICTS[locale], {}, locale);
      for (const s of STATES) expect(torrentStateLabel(s, t)).not.toBe(`qbittorrent.states.${s}`);
    }
  });

  it("un état inconnu reste affiché tel quel", () => {
    const t = createT(fr, fr, "fr");
    expect(torrentStateLabel("someFutureState", t)).toBe("someFutureState");
  });
});
