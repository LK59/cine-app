import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { TrueHdCore } from "@/lib/webcodecs/truehd/truehdCore";
import { contiguousAudio } from "@/lib/webcodecs/truehd/truehdAudio";

/** Les unités d'accès d'un flux TrueHD brut : la longueur, en mots de 16 bits, dans les 12 bits bas. */
function accessUnits(bytes: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = [];
  for (let at = 0; at + 4 <= bytes.length; ) {
    const length = (((bytes[at] & 0x0f) << 8) | bytes[at + 1]) * 2;
    if (length < 4) break;
    units.push(bytes.subarray(at, at + length));
    at += length;
  }
  return units;
}

/**
 * Le décodeur lui-même, sans flux réel : l'encodeur TrueHD de FFmpeg — 6.1, 7.1 et 8.1, essayés le
 * 21/09/2026 — produit des flux multicanaux que son propre décodeur refuse, et le dépôt est public,
 * donc pas d'extrait de film ici. Ce que le décodage donne sur de vrais fichiers est vérifié par
 * truehd-bench.spec.ts (contre ffmpeg, canal par canal) et ffmpeg-wasm-regress-bench.spec.ts. Seuls
 * le mono et la stéréo de l'encodeur de FFmpeg 9.0 se relisent : fixtures/truehd/generate.sh.
 */
describe("le décodeur TrueHD de FFmpeg, compilé en WebAssembly", () => {
  /**
   * FFmpeg 7.1.2 ne donnait un masque au seul sous-flux d'un TrueHD mono ou stéréo que si
   * l'appelant avait déjà nommé ce compte de canaux ; ce module n'en nomme aucun, et ces pistes ne
   * rendaient rien (« invalid output channel »), sans erreur. Corrigé en 7.1.3 (« don't depend on
   * context channel layout when setting substream masks »), embarqué depuis 7.1.5 le 14/10/2026.
   * Aucune piste de la bibliothèque n'est dans ce cas ce jour-là ; les niveaux attendus sont ceux
   * d'`ffmpeg -af astats` (FFmpeg 9.0) sur les mêmes fixtures.
   */
  it.each([
    ["mono", [-27.09]],
    ["stereo", [-27.09, -41.07]],
  ])("décode un TrueHD %s à un sous-flux, chaque canal à son rang", async (name, expected) => {
    const units = accessUnits(new Uint8Array(readFileSync(`src/__tests__/fixtures/truehd/${name}.thd`)));
    const core = await TrueHdCore.create(false);
    const batch = core.decode(units);
    core.close();
    expect(batch.errors).toBe(0);
    expect(batch.channels).toBe(expected.length);
    expect(batch.sampleRate).toBe(48000);
    const frames = batch.pcm.length / batch.channels;
    expect(frames).toBeGreaterThanOrEqual(24000);
    const rms = expected.map((_, c) => {
      let sum = 0;
      for (let i = 0; i < frames; i++) sum += batch.pcm[i * batch.channels + c] ** 2;
      return 10 * Math.log10(sum / frames);
    });
    rms.forEach((db, c) => expect(Math.abs(db - expected[c])).toBeLessThan(0.05));
  });

  it("se charge dans Node et refuse proprement ce qui n'est pas du TrueHD", async () => {
    const core = await TrueHdCore.create(false);
    const batch = core.decode([new Uint8Array(64).fill(7), new Uint8Array(3000).fill(0x55)]);
    expect([...batch.frames]).toEqual([0, 0]);
    expect(batch.pcm).toHaveLength(0);
    core.reset();
    core.close();
  });

  it("ne touche plus à rien une fois fermé, et ne se ferme qu'une fois", async () => {
    // Relu le 22/09/2026 : un lot pouvait encore être décodé après la fermeture — dans un
    // contexte libéré, sur une instance WebAssembly partagée par toute la page. Et fermer deux
    // fois, c'était libérer deux fois.
    const core = await TrueHdCore.create(false);
    core.close();
    expect(() => core.decode([new Uint8Array(16)])).toThrow(/fermé/);
    expect(() => core.close()).not.toThrow();
    expect(() => core.reset()).not.toThrow();
    // Et l'instance partagée sert encore au suivant.
    const next = await TrueHdCore.create(false);
    expect(next.decode([new Uint8Array(16)]).frames[0]).toBe(0);
    next.close();
  });

  it("s'ouvre aussi en MLP", async () => {
    const core = await TrueHdCore.create(true);
    expect(core.decode([new Uint8Array(16)]).frames[0]).toBe(0);
    core.close();
  });
});

describe("contiguousAudio", () => {
  const batch = (frames: number[], channels = 2) => {
    const total = frames.reduce((n, f) => n + f, 0);
    const pcm = new Float32Array(total * channels);
    // Chaque image porte son propre numéro, pour vérifier ce qui est gardé et où.
    for (let i = 0; i < total; i++) for (let c = 0; c < channels; c++) pcm[i * channels + c] = i + c / 10;
    return { pcm, frames: Int32Array.from(frames), channels, sampleRate: 1000, errors: 0 };
  };

  it("garde un seul morceau quand les blocs se suivent", () => {
    const out = contiguousAudio([0, 10_000, 20_000], batch([10, 10, 10]), 0, 2);
    expect(out).toHaveLength(1);
    expect(out[0].timestampSeconds).toBe(0);
    expect(out[0].planes[0]).toHaveLength(30);
  });

  it("commence au bloc qui contient l'instant demandé, pas avant", () => {
    // Le son d'avant, rendu à l'encodeur, aurait débordé sur le segment précédent.
    const out = contiguousAudio([0, 10_000, 20_000], batch([10, 10, 10]), 0.015, 2);
    expect(out[0].timestampSeconds).toBeCloseTo(0.01);
    expect(out[0].planes[0][0]).toBe(10);
  });

  it("coupe là où un bloc n'a rien rendu, pour que chaque morceau garde son instant", () => {
    const out = contiguousAudio([0, 10_000, 20_000, 30_000], batch([10, 0, 10, 10]), 0, 2);
    expect(out.map((piece) => piece.timestampSeconds)).toEqual([0, 0.02]);
    expect(out[1].planes[1][0]).toBeCloseTo(10.1);
  });

  it("lit les unités d'un bloc laçé comme une suite, pas comme un retour en arrière", () => {
    // Matroska donne à chaque unité d'un bloc laçé l'instant du bloc : trois unités à 0, puis un
    // bloc à 30 ms. Lues telles quelles, trois morceaux au même instant, qui se chevauchaient.
    const out = contiguousAudio([0, 0, 0, 30_000], batch([10, 10, 10, 10]), 0, 2);
    expect(out).toHaveLength(1);
    expect(out[0].planes[0]).toHaveLength(40);
  });

  it("ramène les canaux à ceux que l'en-tête annonce", () => {
    const out = contiguousAudio([0], batch([4], 2), 0, 3);
    expect(out[0].planes).toHaveLength(3);
    expect([...out[0].planes[2]]).toEqual([0, 0, 0, 0]);
  });
});

describe("le décodeur logiciel", () => {
  it("confie le TrueHD et le MLP à notre décodeur, pas à mediabunny qui ne les connaît pas", async () => {
    vi.resetModules();
    const opened: number[] = [];
    vi.doMock("@/lib/webcodecs/truehd/truehdAudio", () => ({
      openTrueHdTrack: async (_source: unknown, trackNumber: number) => {
        opened.push(trackNumber);
        return { format: { sampleRate: 48000, numberOfChannels: 8 }, samples: async function* () {}, close: () => {} };
      },
    }));
    try {
      const { SoftwareAudioTrack } = await import("@/lib/webcodecs/softwareAudio");
      const source = { size: 0, read: async () => new Uint8Array(0), close: () => {} };
      const track = await SoftwareAudioTrack.open(source, 3, "A_TRUEHD");
      expect(track.format).toEqual({ sampleRate: 48000, numberOfChannels: 8 });
      await SoftwareAudioTrack.open(source, 4, "A_MLP");
      expect(opened).toEqual([3, 4]);
    } finally {
      vi.doUnmock("@/lib/webcodecs/truehd/truehdAudio");
    }
  });
});

describe("ce que le build de production sait faire", () => {
  it("n'a aucun worker écrit en TypeScript derrière new URL", async () => {
    // 21/09/2026 : Turbopack (Next 16) a copié truehd.worker.ts tel quel dans static/media au lieu
    // de le compiler — un worker qui n'aurait jamais démarré, et chaque TrueHD serait reparti au
    // lecteur serveur. Le portail et le build passaient tous deux ; seul l'examen de ce que le build
    // avait produit l'a montré.
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(name)) {
          // Le code seulement : un commentaire qui raconte l'erreur a le droit de la citer.
          const code = readFileSync(full, "utf8")
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");
          if (!/new Worker\(\s*new URL\(\s*["'][^"']+\.tsx?["']/.test(code)) continue;
          offenders.push(full);
        }
      }
    };
    walk("src/lib");
    walk("src/components");
    expect(offenders).toEqual([]);
  });
});

describe("ouvrir une piste sans relire le fichier", () => {
  it("le TrueHD se contente du fichier déjà lu par le lecteur", async () => {
    // 21/09/2026 : 4,4 et 5,3 s par changement de piste sur un iPhone, passées à relire l'en-tête
    // et l'index d'un 4K de soixante gigaoctets que le lecteur avait déjà.
    const { openTrueHdTrack } = await import("@/lib/webcodecs/truehd/truehdAudio");
    const source = {
      size: 60e9,
      read: async () => {
        throw new Error("relu alors qu'il était déjà lu");
      },
      close: () => {},
    };
    const file = {
      timestampScaleNs: 1_000_000, durationSeconds: 7800, cues: [], segmentDataStart: 0, segmentEnd: 60e9, firstClusterOffset: 0,
      tracks: [{ number: 3, type: "audio", codecId: "A_TRUEHD", audio: { sampleRate: 48000, channels: 8 } }],
    } as never;
    const track = await openTrueHdTrack(source, 3, file);
    expect(track.format).toEqual({ sampleRate: 48000, numberOfChannels: 8 });
    track.close();
  });

  it("mediabunny lit un fichier une fois pour toutes ses pistes", async () => {
    // 1,6 s pour ouvrir l'E-AC3 de Braveheart, à chaque changement de langue : un lecteur de
    // conteneur neuf par piste, qui relisait tout.
    vi.resetModules();
    let created = 0;
    vi.doMock("mediabunny", () => {
      class Input {
        constructor() {
          created++;
        }
        async getAudioTracks() {
          return [2, 3].map((id) => ({ id, codec: "eac3", sampleRate: 48000, numberOfChannels: 6, canDecode: async () => true }));
        }
      }
      class AudioSampleSink {}
      class CustomSource {}
      class MatroskaInputFormat {}
      return { Input, AudioSampleSink, CustomSource, MatroskaInputFormat };
    });
    vi.doMock("@mediabunny/ac3", () => ({ registerAc3Decoder: () => {} }));
    try {
      const { SoftwareAudioTrack } = await import("@/lib/webcodecs/softwareAudio");
      const film = { size: 1, read: async () => new Uint8Array(0), close: () => {} };
      const autre = { size: 1, read: async () => new Uint8Array(0), close: () => {} };
      (await SoftwareAudioTrack.open(film, 2, "A_EAC3")).close();
      (await SoftwareAudioTrack.open(film, 3, "A_EAC3")).close();
      (await SoftwareAudioTrack.open(film, 2, "A_EAC3")).close();
      expect(created).toBe(1);
      // Un autre film, un autre lecteur : rien ne se mélange entre deux lectures.
      (await SoftwareAudioTrack.open(autre, 2, "A_EAC3")).close();
      expect(created).toBe(2);
    } finally {
      vi.doUnmock("mediabunny");
      vi.doUnmock("@mediabunny/ac3");
    }
  });
});
