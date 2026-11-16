import { describe, it, expect } from "vitest";
import {
  audioChoicesOf,
  audioTrackPosition,
  enabledAudioNumber,
  jellyfinIndexOf,
  matroskaNumberOf,
  openingAudioOf,
  openingSubtitleOf,
  parseMasterAudio,
  textSubtitles,
  verdictRefusal,
  type LumenAudioFacts,
} from "@/components/player/lumen/lumenOpening";
import { preferredOpeningTrack } from "@/lib/openingAudioChoice";
import type { TrackPreferences } from "@/lib/trackPreferences";

/** Ce que `LumenServerHost` décide avant de poser une adresse (DECISIONS.md §180). */
const facts = (number: number, language: string, codec: string, channels: number, servable: boolean, isDefault = false): LumenAudioFacts => ({
  number,
  codec,
  language,
  name: null,
  channels,
  hlsChannels: String(channels),
  isDefault,
  servable,
  refusal: servable ? null : "son-codec",
  repairs: [],
  // La conversion du son (phase 2, §161) : ici, aucune piste convertie.
  converted: null,
  convertible: false,
  convertRefusal: null,
});
const prefs = (audioLanguage: string | null, extra: Partial<TrackPreferences> = {}): TrackPreferences => ({
  audioLanguage,
  subtitleLanguage: null,
  subtitleMode: "Default",
  playDefaultAudioTrack: false,
  ...extra,
});

describe("la piste d'ouverture — la règle du lecteur actuel, sur ce que le serveur sert", () => {
  const film = audioChoicesOf([facts(2, "fre", "A_AC3", 6, true, true), facts(3, "eng", "A_DTS", 6, false), facts(4, "eng", "A_EAC3", 2, true)]);

  it("la langue du compte, parmi les pistes servies", () => {
    expect(openingAudioOf(film, prefs("eng"), null)).toEqual({ kind: "ok", number: 4 });
  });
  it("sans préférence : la langue de la piste par défaut, la plus riche", () => {
    expect(openingAudioOf(film, null, null)).toEqual({ kind: "ok", number: 2 });
  });
  it("la langue du compte seulement sur une piste non servie : le lecteur actuel (il décode le DTS)", () => {
    const vo = audioChoicesOf([facts(2, "fre", "A_AC3", 6, true, true), facts(3, "eng", "A_DTS", 6, false)]);
    expect(openingAudioOf(vo, prefs("eng"), null)).toMatchObject({ kind: "refus" });
  });
  it("une piste déjà choisie (rechargement) : prise si servie, refus sinon — jamais une autre langue", () => {
    expect(openingAudioOf(film, prefs("eng"), 2)).toEqual({ kind: "ok", number: 2 });
    expect(openingAudioOf(film, null, 3)).toMatchObject({ kind: "refus" });
  });
  it("aucune piste servie : refus ; aucune piste du tout : rien à choisir", () => {
    expect(openingAudioOf(audioChoicesOf([facts(2, "eng", "A_DTS", 6, false, true)]), null, null)).toMatchObject({ kind: "refus" });
    expect(openingAudioOf([], null, null)).toEqual({ kind: "ok", number: null });
  });
  it("« und » est une absence de langue, pas une langue", () => {
    expect(audioChoicesOf([facts(2, "und", "A_AAC", 2, true)])[0].language).toBeNull();
  });
  it("`preferredOpeningTrack` est la règle de `preferredAudio` : canaux livrés, puis copie, puis défaut", () => {
    const tracks = [
      { n: 1, language: "en", name: null, isDefault: true, isForced: false, ch: 2, copy: true },
      { n: 2, language: "en", name: null, isDefault: false, isForced: false, ch: 6, copy: false },
      { n: 3, language: "en", name: null, isDefault: false, isForced: false, ch: 6, copy: true },
    ];
    const pick = preferredOpeningTrack(tracks, () => true, (t) => ({ channels: t.ch, copied: t.copy }), null);
    expect(pick?.n).toBe(3);
  });
});

describe("deux espaces de numéros — le rang parmi les pistes son", () => {
  const lumen = [{ number: 2 }, { number: 3 }, { number: 4 }];
  const jellyfin = [{ index: 1 }, { index: 2 }, { index: 3 }];
  it("Matroska → Jellyfin et retour", () => {
    expect(jellyfinIndexOf(lumen, jellyfin, 3)).toBe(2);
    expect(matroskaNumberOf(lumen, jellyfin, 3)).toBe(4);
  });
  it("des listes de longueurs différentes ne se relient pas", () => {
    expect(jellyfinIndexOf(lumen, jellyfin.slice(0, 2), 3)).toBeUndefined();
    expect(matroskaNumberOf(lumen, jellyfin.slice(0, 2), 2)).toBeNull();
  });
});

describe("la liste maître et `video.audioTracks`", () => {
  const master = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="fr",NAME="Français — 5.1",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="6",URI="a2.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-ec-3",LANGUAGE="en",NAME="Anglais — 5.1",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="6",URI="a3.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud-mp4a.40.2",LANGUAGE="en",NAME="Anglais — 2.0",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="a5.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="hvc1,ec-3",AUDIO="aud-ec-3"',
    "v.m3u8",
  ].join("\n");
  const parsed = parseMasterAudio(master);

  it("chaque piste avec son numéro de fichier, son groupe, son nom", () => {
    expect(parsed.map((m) => [m.number, m.group, m.name, m.isDefault])).toEqual([
      [2, "aud-ec-3", "Français — 5.1", true],
      [3, "aud-ec-3", "Anglais — 5.1", false],
      [5, "aud-mp4a.40.2", "Anglais — 2.0", true],
    ]);
  });
  it("dans le groupe exposé : par le nom, sinon par le rang ; hors du groupe : -1 (rechargement)", () => {
    const exposed = [
      { label: "Français — 5.1", language: "fr", enabled: true },
      { label: "Anglais — 5.1", language: "en", enabled: false },
    ];
    expect(audioTrackPosition(exposed, parsed, 3)).toBe(1);
    expect(audioTrackPosition(exposed.map((t) => ({ ...t, label: "" })), parsed, 3)).toBe(1);
    expect(audioTrackPosition(exposed, parsed, 5)).toBe(-1);
    expect(enabledAudioNumber(exposed, parsed)).toBe(2);
  });
  it("le rang seul ne vaut pas contre la langue", () => {
    const wrong = [
      { label: "", language: "en", enabled: true },
      { label: "", language: "fr", enabled: false },
    ];
    expect(audioTrackPosition(wrong, parsed, 3)).toBe(-1);
  });
});

describe("les sous-titres à l'ouverture", () => {
  const tracks = [
    { index: 5, url: "u5", label: "Français", language: "fre", title: null, isDefault: false, isForced: false },
    { index: 6, url: "u6", label: "Français forcés", language: "fre", title: "Forced", isDefault: false, isForced: true },
    { index: 7, url: "u7", label: "Anglais", language: "eng", title: null, isDefault: false, isForced: false },
  ];
  it("la règle du compte, la langue entendue : forcés sur une VF, complets sur une VO", () => {
    const p = prefs("fre", { subtitleLanguage: "fre", subtitleMode: "Default" });
    expect(openingSubtitleOf(tracks, p, { language: "fre", name: null })).toBe(6);
    expect(openingSubtitleOf(tracks, p, { language: "eng", name: null })).toBe(5);
    expect(openingSubtitleOf(tracks, null, { language: "eng", name: null })).toBeNull();
  });
  it("les pistes en images ne sont pas proposées", () => {
    expect(textSubtitles([{ isText: false }, {}, { isText: null }])).toHaveLength(2);
  });
});

describe("le verdict", () => {
  it("oui, non, en construction", () => {
    expect(verdictRefusal({ ok: true } as never)).toBeNull();
    expect(verdictRefusal({ ok: false, reason: "son-codec", detail: "DTS", audioTrack: 1, audio: [] })).toBe("son-codec : DTS");
    expect(verdictRefusal({ ok: false, pending: true, reason: "index-en-cours", audioTrack: null, audio: [] })).toBe("index en cours de construction");
  });
});
