import { describe, it, expect } from "vitest";
import { castRefusalFor, buildDeviceProfile } from "@/lib/deviceProfile";

// Deux règles qui décident si un film part vers un téléviseur, et sous quelle forme.

const sub = (Index: number, IsTextSubtitleStream?: boolean) => ({ Type: "Subtitle", Index, IsTextSubtitleStream });

describe("castRefusalFor", () => {
  it("laisse passer un sous-titre texte", () => {
    expect(castRefusalFor([sub(3, true)], 3)).toBeNull();
  });

  it("refuse un sous-titre image", () => {
    // Jellyfin devrait l'incruster, donc ré-encoder la vidéo — et la couche Dolby Vision part
    // avec. Le refus explicite vaut mieux qu'un transcodage 4K silencieux.
    expect(castRefusalFor([sub(7, false)], 7)).toBe("image-subtitle");
  });

  it("laisse passer quand aucun sous-titre n'est demandé", () => {
    expect(castRefusalFor([sub(7, false)], null)).toBeNull();
    expect(castRefusalFor([sub(7, false)], undefined)).toBeNull();
    expect(castRefusalFor([sub(7, false)], -1)).toBeNull();
  });

  it("ne juge que la piste demandée", () => {
    // Un fichier peut porter des sous-titres images sans qu'on les ait choisis.
    expect(castRefusalFor([sub(3, true), sub(7, false)], 3)).toBeNull();
  });

  it("laisse passer quand Jellyfin ne se prononce pas", () => {
    // Une hypothèse sur le serveur d'en face ne doit pas refuser une diffusion qui aurait marché.
    expect(castRefusalFor([sub(3)], 3)).toBeNull();
    expect(castRefusalFor(undefined, 3)).toBeNull();
    expect(castRefusalFor([], 3)).toBeNull();
  });
});

describe("le profil de diffusion", () => {
  const support = { video: { hevc: true }, audio: { aac: true } };

  it("fait voyager les sous-titres dans le flux", () => {
    // Sinon le téléviseur, qui lit le flux lui-même, ne voit rien de ce que la page dessine.
    const profile = buildDeviceProfile(support, 120_000_000, { subtitlesInStream: true });
    expect(profile.SubtitleProfiles).toEqual([{ Format: "vtt", Method: "Hls" }]);
  });

  it("laisse la lecture dans la page exactement comme avant", () => {
    // La garantie de non-régression : sans l'option, le profil est celui d'hier, à l'identique.
    const profile = buildDeviceProfile(support, 120_000_000);
    expect(profile.SubtitleProfiles).toEqual([
      { Format: "vtt", Method: "External" },
      { Format: "vtt", Method: "Hls" },
    ]);
    expect(buildDeviceProfile(support, 120_000_000, {})).toEqual(profile);
  });
});
