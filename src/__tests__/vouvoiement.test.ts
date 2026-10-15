import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

/** Toutes les chaînes affichables du dictionnaire, avec le chemin de leur clé. */
function strings(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === "string") return [[path.join("."), node]];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]));
  }
  return [];
}

/**
 * L'allemand vouvoie, comme le français.
 *
 * Le dictionnaire mélangeait les deux : une soixantaine de chaînes en « du / dein / dich » (la
 * connexion, le lecteur, l'assistant de première installation) et une vingtaine en « Sie » (les
 * signalements, `services.notConfiguredHint`) — un même écran pouvait tutoyer dans son titre et
 * vouvoyer dans son bouton. Louis a tranché le 15/10/2026 : tout en Sie / Ihr / Ihnen.
 *
 * Les frontières de mot sont celles des lettres Unicode, pas `\b` (ASCII seulement en JavaScript) :
 * « Durchsucht », « Dubai » ou « Verbindungsdienst » ne doivent pas tomber, « dein » après une
 * apostrophe ou un tiret, si. La casse est ignorée — « Du » ouvre souvent une phrase.
 */
const DU = /(?<!\p{L})(du|dich|dir|dein|deine|deinen|deinem|deiner|deines|euch|euer|eure|euren|eurem|eurer|eures)(?!\p{L})/iu;

describe("le vouvoiement", () => {
  it("de ne tutoie nulle part", () => {
    const de = JSON.parse(readFileSync("src/locales/de.json", "utf8")) as Record<string, unknown>;
    const offenders = strings(de)
      .filter(([, value]) => DU.test(value))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });

  // Le motif lui-même : un garde-fou qui ne trouve rien parce qu'il ne cherche rien ne garde rien.
  it("reconnaît le tutoiement et laisse passer ce qui n'en est pas", () => {
    for (const bad of ["Melde dich an", "Du bist offline", "Für dich", "Deine Liste", "aus deiner .env", "hilft dir"]) {
      expect(DU.test(bad), bad).toBe(true);
    }
    for (const ok of ["Melden Sie sich an", "Durchsucht Ihre Bibliothek", "Dubai", "Ihr Konto", "Dienst", "Produkt"]) {
      expect(DU.test(ok), ok).toBe(false);
    }
  });
});
