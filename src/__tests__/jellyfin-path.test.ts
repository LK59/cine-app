import { describe, it, expect } from "vitest";
import { isJellyfinId, isStreamPath, isSubtitleStreamIndex, isUnderJellyfinPrefix } from "@/lib/jellyfinPath";

const ID = "a".repeat(32);

describe("isUnderJellyfinPrefix", () => {
  // Ce pour quoi la garde existe : `fetch` résout les `..` avant de partir, donc une traversée
  // qui a survécu à la validation par segment se voit ici, sur le chemin réellement demandé.
  it("refuse une traversée qui remonte au-dessus du préfixe", () => {
    expect(
      isUnderJellyfinPrefix(
        `http://jellyfin:8096/videos/${ID}/../../Users`,
        `http://jellyfin:8096/videos/${ID}/`
      )
    ).toBe(false);
  });

  it("accepte un segment de flux ordinaire", () => {
    expect(
      isUnderJellyfinPrefix(
        `http://jellyfin:8096/videos/${ID}/hls1/main/0.mp4?static=true`,
        `http://jellyfin:8096/videos/${ID}/`
      )
    ).toBe(true);
  });

  /**
   * Les trois formes de `JELLYFIN_URL` que la normalisation WHATWG réécrit.
   *
   * Elles ne cassaient rien tant que la valeur servie était `http://jellyfin:8096` — port
   * explicite et non par défaut, minuscules, sans slash final — que `new URL()` laisse intact.
   * Une comparaison de chaînes entre une URL normalisée et un préfixe brut refusait chacune
   * d'elles en 400, sur une requête parfaitement légitime.
   */
  it("ne dépend pas de la forme de JELLYFIN_URL", () => {
    const cases: Array<[string, string]> = [
      // Port par défaut écrit explicitement : `new URL().href` le supprime.
      [`http://jellyfin:80/videos/${ID}/master.m3u8`, `http://jellyfin:80/videos/${ID}/`],
      [`https://media.example:443/videos/${ID}/master.m3u8`, `https://media.example:443/videos/${ID}/`],
      // Hôte en majuscules : `new URL()` le minuscule.
      [`http://JELLYFIN:8096/videos/${ID}/master.m3u8`, `http://JELLYFIN:8096/videos/${ID}/`],
      // Slash final dans la variable : les deux côtés portent le `//`, donc ils se correspondent.
      [`http://jellyfin:8096//videos/${ID}/master.m3u8`, `http://jellyfin:8096//videos/${ID}/`],
    ];
    for (const [target, prefix] of cases) {
      expect(isUnderJellyfinPrefix(target, prefix), target).toBe(true);
    }
  });

  it("refuse un autre hôte, un autre port ou un autre schéma", () => {
    const prefix = `http://jellyfin:8096/videos/${ID}/`;
    expect(isUnderJellyfinPrefix(`http://evil.example/videos/${ID}/master.m3u8`, prefix)).toBe(false);
    expect(isUnderJellyfinPrefix(`http://jellyfin:9096/videos/${ID}/master.m3u8`, prefix)).toBe(false);
    expect(isUnderJellyfinPrefix(`https://jellyfin:8096/videos/${ID}/master.m3u8`, prefix)).toBe(false);
  });

  // Sans frontière de segment, `…/videos/{id}` couvrirait `…/videos/{id}malicieux`.
  it("compare sur une frontière de segment, même si le préfixe n'a pas de slash final", () => {
    expect(
      isUnderJellyfinPrefix(`http://jellyfin:8096/videos/${ID}x/master.m3u8`, `http://jellyfin:8096/videos/${ID}`)
    ).toBe(false);
    expect(
      isUnderJellyfinPrefix(`http://jellyfin:8096/videos/${ID}/master.m3u8`, `http://jellyfin:8096/videos/${ID}`)
    ).toBe(true);
  });

  it("refuse plutôt que de deviner quand l'une des deux URL est illisible", () => {
    expect(isUnderJellyfinPrefix("pas une url", `http://jellyfin:8096/videos/${ID}/`)).toBe(false);
    expect(isUnderJellyfinPrefix(`http://jellyfin:8096/videos/${ID}/master.m3u8`, "pas une url")).toBe(false);
  });
});

describe("isJellyfinId", () => {
  it("n'accepte que 32 hexadécimaux", () => {
    expect(isJellyfinId(ID)).toBe(true);
    expect(isJellyfinId(ID.toUpperCase())).toBe(true);
    expect(isJellyfinId("abc")).toBe(false);
    expect(isJellyfinId(`${ID}/..`)).toBe(false);
    expect(isJellyfinId(undefined)).toBe(false);
  });
});

describe("isStreamPath", () => {
  it("accepte les formes réelles et refuse ce qui porte un séparateur", () => {
    expect(isStreamPath(["master.m3u8"])).toBe(true);
    expect(isStreamPath(["hls1", "main", "0.mp4"])).toBe(true);
    expect(isStreamPath([])).toBe(false);
    expect(isStreamPath(["a", "b", "c", "d", "e"])).toBe(false);
    expect(isStreamPath([".."])).toBe(false);
    expect(isStreamPath(["hls1/main"])).toBe(false);
    expect(isStreamPath(["%2e%2e"])).toBe(false);
  });
});

describe("isSubtitleStreamIndex", () => {
  it("n'accepte qu'un entier", () => {
    expect(isSubtitleStreamIndex("0")).toBe(true);
    expect(isSubtitleStreamIndex("12")).toBe(true);
    expect(isSubtitleStreamIndex("-1")).toBe(false);
    expect(isSubtitleStreamIndex("2/..")).toBe(false);
  });
});
