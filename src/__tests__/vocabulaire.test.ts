import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";

const LANGS = ["fr", "en", "es", "de"] as const;
const load = (lang: string) => JSON.parse(readFileSync(`src/locales/${lang}.json`, "utf8")) as Record<string, unknown>;

/** Toutes les chaînes affichables du dictionnaire, avec le chemin de leur clé. */
function strings(node: unknown, path: string[] = []): [string, string][] {
  if (typeof node === "string") return [[path.join("."), node]];
  if (node && typeof node === "object") {
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => strings(v, [...path, k]));
  }
  return [];
}

/**
 * Le vocabulaire de l'infrastructure ne s'affiche pas.
 *
 * « Tableau de bord », « dashboard », « stack média » décrivent comment l'application est faite,
 * pas ce qu'elle sert. L'écran de connexion s'appelait « Connexion au tableau de bord » : la
 * première phrase que lit quelqu'un venu regarder un film lui parlait d'administration système.
 *
 * Le test porte sur les *valeurs* du dictionnaire, jamais sur ses clés — `dashboard` reste un nom
 * de section parfaitement légitime dans le code, il ne doit simplement jamais atteindre l'écran.
 */
const BANNED = [/tableau de bord/i, /\bdashboards?\b/i, /\bstack\b/i, /panel de control/i, /\bpanneau de bord\b/i];

describe("le vocabulaire visible", () => {
  it.each(LANGS)("%s n'affiche aucun mot d'infrastructure", (lang) => {
    const offenders = strings(load(lang))
      .filter(([, value]) => BANNED.some((re) => re.test(value)))
      .map(([key, value]) => `${key} = ${value}`);
    expect(offenders).toEqual([]);
  });

  it.each(LANGS)("%s ne dit pas non plus « stack média » dans le manifeste", () => {
    const manifest = JSON.parse(readFileSync("public/manifest.json", "utf8")) as Record<string, string>;
    for (const field of ["name", "short_name", "description"]) {
      expect(BANNED.some((re) => re.test(manifest[field]))).toBe(false);
      // Court : c'est une tuile sous une icône et une ligne dans une fiche d'installation.
      expect(manifest[field].length).toBeLessThanOrEqual(40);
    }
  });
});

describe("les textes de l'écran de connexion", () => {
  it.each(LANGS)("%s porte toutes les clés que la page utilise", (lang) => {
    const auth = (load(lang) as { auth: Record<string, unknown> }).auth;
    const flat = Object.fromEntries(strings(auth));
    for (const key of [
      "tagline",
      "hint",
      "statusLink",
      "reasonPlayback",
      "jellyfin.username",
      "jellyfin.password",
      "jellyfin.submit",
      "jellyfin.submitting",
      "local.heading",
      "local.usernamePlaceholder",
      "local.passwordPlaceholder",
      "local.submit",
      "error.failed",
      "error.unknown",
    ]) {
      expect(flat[key], `${lang}: auth.${key}`).toBeTruthy();
    }
  });
});
