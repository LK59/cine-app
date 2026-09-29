import { describe, it, expect, vi, afterEach } from "vitest";
import type { MatroskaFile, MatroskaTrack } from "@/lib/webcodecs/matroska";

/**
 * Les canaux qui comptent sont ceux que le spectateur **reçoit**, pas ceux de la source (audit P5).
 *
 * « Le Mans 66 » porte une TrueHD 7.1 et une AC-3 5.1 anglaises. Sur un iPhone, l'AC-3 passe telle
 * quelle, alors que la TrueHD est décodée en WebAssembly sur le fil principal puis ré-encodée par
 * l'AAC d'Apple, plafonné à six canaux : elle sort en 5.1 elle aussi. Classées par les canaux de
 * la source, c'est la TrueHD qui gagnait — tout ce travail pour aucun canal de plus. Classées par
 * les canaux livrés, les deux font jeu égal, et la copie l'emporte.
 *
 * Firefox, lui, encode l'Opus en huit canaux : la 7.1 y est réellement livrée, et elle gagne.
 */
const piste = (n: number, codecId: string, language: string, channels: number, isDefault = false): MatroskaTrack =>
  ({
    number: n,
    type: "audio",
    codecId,
    language,
    name: null,
    isDefault,
    isForced: false,
    isHearingImpaired: false,
    audio: { channels, sampleRate: 48000 },
  }) as unknown as MatroskaTrack;

const leMans = () =>
  ({
    tracks: [piste(1, "A_DTS", "fra", 6, true), piste(2, "A_TRUEHD", "eng", 8), piste(3, "A_AC3", "eng", 6)],
  }) as unknown as MatroskaFile;

const anglais = { audioLanguage: "eng", subtitleLanguage: null, subtitleMode: "Default", playDefaultAudioTrack: false } as never;

/** Un navigateur simulé : ce que sa MediaSource prend, ce que son encodeur produit, son système. */
async function navigateur(options: { accepts: RegExp; encodes: (codec: string, channels: number) => boolean; userAgent: string }) {
  vi.resetModules();
  vi.stubGlobal("window", { ManagedMediaSource: { isTypeSupported: (t: string) => options.accepts.test(t) } });
  vi.stubGlobal("navigator", { userAgent: options.userAgent });
  vi.stubGlobal("AudioEncoder", {
    isConfigSupported: async (config: AudioEncoderConfig) => ({ supported: options.encodes(config.codec, config.numberOfChannels) }),
  });
  const playback = await import("@/lib/webcodecs/remuxPlayback");
  const remuxer = await import("@/lib/webcodecs/remuxer");
  const preferences = await import("@/lib/trackPreferences");
  const { fromMatroskaTrack } = await import("@/lib/webcodecs/playerTrack");
  const file = leMans();
  // Ce que `probeOpened` fait avant de choisir la piste d'ouverture.
  await remuxer.primeAudioDelivery(file);
  const ouverture = playback.openingAudio(file, anglais, null)?.number;
  // L'écran : les pistes telles que `RemuxPlayback.audioTracks` les lui donne, et les deux
  // questions que l'hôte pose (`applyPreferences`).
  const byNumber = new Map(file.tracks.map((t) => [t.number, t]));
  const vues = file.tracks.map((t) => ({ ...fromMatroskaTrack(t), delivered: remuxer.deliveredAudio(t) }));
  const ecran = preferences.chooseAudioTrack(
    vues,
    anglais,
    (t) => remuxer.playableAudio(byNumber.get(t.number)!),
    (t) => t.delivered ?? { channels: t.channels ?? 0, copied: false }
  )?.number;
  return { ouverture, ecran };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classement par canaux livrés", () => {
  it("iPhone : l'AC-3 5.1 copiée passe devant la TrueHD 7.1 qui sortirait en 5.1, à l'ouverture comme à l'écran", async () => {
    const { ouverture, ecran } = await navigateur({
      // Safari : AC-3, E-AC3 et AAC dans MediaSource ; ni FLAC, ni DTS, ni TrueHD, ni Opus.
      accepts: /ac-3|ec-3|mp4a/,
      // L'encodeur d'Apple accepte huit canaux ; c'est `appleAacCap` qui le plafonne à six.
      encodes: () => true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
    });
    expect(ouverture).toBe(3);
    expect(ecran).toBe(3);
  });

  it("Firefox : la TrueHD sort en Opus 7.1, elle garde la première place", async () => {
    const { ouverture, ecran } = await navigateur({
      // Firefox : pas de Dolby dans MediaSource ; il encode l'Opus, pas l'AAC.
      accepts: /mp4a|opus/,
      encodes: (codec) => codec === "opus",
      userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0",
    });
    expect(ouverture).toBe(2);
    expect(ecran).toBe(2);
  });

  it("à canaux livrés égaux, la copie passe devant le ré-encodage même quand le drapeau dit l'inverse", async () => {
    vi.resetModules();
    const { chooseAudioTrack } = await import("@/lib/trackPreferences");
    const pistes = [
      { number: 1, language: "eng", name: null, isDefault: true, isForced: false },
      { number: 2, language: "eng", name: null, isDefault: false, isForced: false },
    ];
    const livre = (t: { number: number }) => ({ channels: 6, copied: t.number === 2 });
    expect(chooseAudioTrack(pistes, anglais, () => true, livre)?.number).toBe(2);
  });
});
