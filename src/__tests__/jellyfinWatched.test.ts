import { describe, it, expect } from "vitest";
import { hasSomethingWatched } from "@/lib/clients/jellyfin";
import type { JellyfinItem } from "@/lib/clients/jellyfin";

// `Filters=IsPlayed` répond « oui » pour une série vide — tous ses épisodes, les zéro, ont été
// vus. Une série suivie par Sonarr mais dont aucun fichier n'est encore importé apparaissait donc
// comme vue par tout le monde, comptes créés à l'instant compris.

const series = (over: Partial<JellyfinItem> = {}): JellyfinItem =>
  ({ Id: "s1", Name: "Une série", Type: "Series", ...over }) as JellyfinItem;

describe("hasSomethingWatched", () => {
  it("écarte une série dont Jellyfin ne connaît aucun épisode", () => {
    expect(hasSomethingWatched(series({ RecursiveItemCount: 0, ChildCount: 0 }))).toBe(false);
  });

  it("garde une série qui a réellement des épisodes", () => {
    expect(hasSomethingWatched(series({ RecursiveItemCount: 24, ChildCount: 3 }))).toBe(true);
  });

  it("garde tous les films, qui ne peuvent pas être vides", () => {
    // Un film n'a pas d'enfants : le compte vaut zéro par nature et ne dit rien.
    expect(hasSomethingWatched({ Id: "m1", Name: "Un film", Type: "Movie" } as JellyfinItem)).toBe(true);
    expect(hasSomethingWatched({ Id: "m2", Name: "Un film", Type: "Movie", ChildCount: 0 } as JellyfinItem)).toBe(true);
  });

  it("garde quand le serveur ne dit rien du nombre d'épisodes", () => {
    // Les champs ne viennent qu'avec `Fields`. En leur absence — une version de Jellyfin qui ne
    // les sert plus, un intermédiaire qui les retire — on ne coupe rien : mieux vaut une ligne de
    // trop qu'un historique amputé par une hypothèse sur le serveur d'en face.
    expect(hasSomethingWatched(series())).toBe(true);
  });

  it("se contente de ChildCount quand le compte récursif manque", () => {
    expect(hasSomethingWatched(series({ ChildCount: 0 }))).toBe(false);
    expect(hasSomethingWatched(series({ ChildCount: 5 }))).toBe(true);
  });

  it("fait confiance au compte récursif avant celui des enfants directs", () => {
    // Une série dont les saisons existent mais sans aucun épisode dedans : trois enfants
    // directs, zéro élément réel. C'est le compte récursif qui dit la vérité.
    expect(hasSomethingWatched(series({ RecursiveItemCount: 0, ChildCount: 3 }))).toBe(false);
  });
});
