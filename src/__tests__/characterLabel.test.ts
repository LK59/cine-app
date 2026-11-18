import { describe, it, expect } from "vitest";
import { characterLabel } from "@/lib/characterLabel";
import { createT } from "@/lib/i18n";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/** Les rôles TMDB arrivent en anglais ; les marqueurs connus sont traduits à l'affichage (18/11/2026). */
const tFr = createT(fr, fr, "fr");
const tEn = createT(en, fr, "en");
const tEs = createT(es, fr, "es");
const tDe = createT(de, fr, "de");

describe("characterLabel", () => {
  it("traduit les marqueurs relevés dans le cache de la prod, en français", () => {
    expect(characterLabel("Lucky (uncredited)", tFr)).toBe("Lucky (non crédité)");
    expect(characterLabel("Woody (voice) (archive footage)", tFr)).toBe("Woody (voix) (images d'archives)");
    expect(characterLabel("Self", tFr)).toBe("Dans son propre rôle");
    expect(characterLabel("self", tFr)).toBe("Dans son propre rôle");
    expect(characterLabel("Herself", tFr)).toBe("Elle-même");
    expect(characterLabel("Himself - Guest", tFr)).toBe("Lui-même - Invité");
    expect(characterLabel("Self (archive footage)", tFr)).toBe("Dans son propre rôle (images d'archives)");
    expect(characterLabel("Self - Narrator (voice)", tFr)).toBe("Dans son propre rôle - Narrateur (voix)");
    expect(characterLabel("The Narrator (voice)", tFr)).toBe("Narrateur (voix)");
    expect(characterLabel("Narrator", tFr)).toBe("Narrateur");
    expect(characterLabel("Various (voice) (archive sound)", tFr)).toBe("Various (voix) (archives sonores)");
  });

  it("laisse le personnage et l'inconnu tels quels", () => {
    expect(characterLabel("Ellen Ripley", tFr)).toBe("Ellen Ripley");
    expect(characterLabel("Transport Guard #1 (as Joseph Michael Self)", tFr)).toBe("Transport Guard #1 (as Joseph Michael Self)");
    expect(characterLabel("Self - Hermione Granger", tFr)).toBe("Dans son propre rôle - Hermione Granger");
    expect(characterLabel("Guest at Hearst Bungalow", tFr)).toBe("Guest at Hearst Bungalow");
    expect(characterLabel("Selfridge", tFr)).toBe("Selfridge");
    expect(characterLabel("(Performance Artist)", tFr)).toBe("(Performance Artist)");
    expect(characterLabel("", tFr)).toBe("");
    expect(characterLabel(undefined, tFr)).toBe("");
  });

  it("dans les quatre langues", () => {
    expect(characterLabel("Self (uncredited)", tEn)).toBe("Self (uncredited)");
    expect(characterLabel("Rex (voice)", tEn)).toBe("Rex (voice)");
    expect(characterLabel("Rex (voice) (uncredited)", tEs)).toBe("Rex (voz) (sin acreditar)");
    expect(characterLabel("Herself", tEs)).toBe("Ella misma");
    expect(characterLabel("Rex (voice) (uncredited)", tDe)).toBe("Rex (Stimme) (nicht im Abspann)");
    expect(characterLabel("Narrator", tDe)).toBe("Erzähler");
  });
});
