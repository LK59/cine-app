// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));
vi.mock("@/lib/webcodecs/capabilities", () => ({
  probeCapabilities: vi.fn().mockResolvedValue({}),
  describeCapabilities: () => ({ "HEVC matériel": "oui" }),
}));

import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import { describeJellyfinPlayback, describeRemuxPlayback } from "@/lib/playbackPanel";
import { ENGINE_BRICKS, brickOfDiagnostic } from "@/lib/engineBricks";
import fr from "@/locales/fr.json";
import en from "@/locales/en.json";
import es from "@/locales/es.json";
import de from "@/locales/de.json";

/**
 * Les briques de Lumen : un rangement d'affichage des informations que le lecteur donnait déjà.
 * Aucun intitulé de ligne ne change, aucune ligne ne disparaît.
 */
const t = (key: string) => key;
afterEach(() => cleanup());

const remux = {
  path: "remux" as const,
  pathReason: null,
  container: "mkv",
  video: { codec: "hevc", width: 3840, height: 2160, bitDepth: 10, rangeType: "HDR10" },
  audioTrackCount: 2,
  subtitleTrackCount: 1,
  currentAudioCodec: "EAC3",
  diagnostics: {
    Chemin: "remux",
    Décodage: "matériel, par le navigateur",
    Vidéo: "hev1 3840×2160",
    Audio: "A_EAC3 6 canaux",
    "Traitement audio": "copié tel quel",
    "Décalage de présentation": "0 ms",
    "Images recalées": "0",
    Index: "120 points vidéo / 120",
    "Tampon vidéo": "0–30",
    "Avance sur la tête": "28.0 s",
    MediaSource: "open",
    "Sauts servis": "2",
    "Une ligne future": "x",
  },
};

describe("les briques du moteur", () => {
  it("sept briques, chacune avec son rôle dans les quatre langues", () => {
    expect(ENGINE_BRICKS).toEqual(["PlaybackCore", "MuxCore", "AudioCore", "BufferCore", "StreamCore", "CodecBridge", "PlaybackBridge"]);
    for (const dict of [fr, en, es, de]) {
      const roles = (dict as { player: { info: { engineRoles: Record<string, string> } } }).player.info.engineRoles;
      for (const brick of ENGINE_BRICKS) expect(roles[brick]).toBeTruthy();
    }
  });

  it("le lecteur natif range chaque ligne sous sa brique, sans en perdre ni en renommer", () => {
    const d = describeRemuxPlayback(remux, t);
    expect(d.brick).toBe("PlaybackCore");
    const byBrick = Object.fromEntries(d.sections.map((s) => [s.brick, s.rows.map((r) => r.label)]));
    expect(byBrick.MuxCore).toEqual(expect.arrayContaining(["Index", "Images recalées"]));
    expect(byBrick.AudioCore).toEqual(expect.arrayContaining(["Audio", "Traitement audio", "Décalage de présentation"]));
    expect(byBrick.CodecBridge).toEqual(["Décodage", "Vidéo"]);
    expect(byBrick.BufferCore).toEqual(["Tampon vidéo", "Avance sur la tête", "MediaSource"]);
    expect(byBrick.PlaybackCore).toEqual(["Chemin", "Sauts servis"]);
    // Une ligne qu'aucune brique ne réclame reste dans « Le flux », comme avant.
    expect(byBrick.StreamCore).toContain("Une ligne future");
    expect(brickOfDiagnostic("Une ligne future")).toBe("StreamCore");
    const all = d.sections.flatMap((s) => s.rows.map((r) => r.label));
    for (const label of Object.keys(remux.diagnostics)) expect(all.filter((l) => l === label)).toHaveLength(1);
  });

  it("sans diagnostic, pas de section vide de plus", () => {
    const d = describeRemuxPlayback({ ...remux, diagnostics: {} }, t);
    expect(d.sections.map((s) => s.brick)).toEqual(["MuxCore", "AudioCore", "StreamCore"]);
  });

  it("le lecteur serveur se présente comme PlaybackBridge", () => {
    const d = describeJellyfinPlayback({ playMethod: "DirectPlay", transcodeReasons: [], container: "mkv", video: null, audio: null }, null, null, t);
    expect(d.brick).toBe("PlaybackBridge");
    expect(d.sections.find((s) => s.title === "player.info.sections.stream")?.brick).toBe("StreamCore");
  });

  it("le panneau montre Lumen et le nom de chaque brique, son rôle en info-bulle", async () => {
    render(<PlaybackInfoPanel data={{ ...describeRemuxPlayback(remux, t), report: null }} open onClose={vi.fn()} />);
    expect(screen.getByText("Lumen")).toBeInTheDocument();
    const tag = document.querySelector('[data-engine-brick="BufferCore"]')!;
    expect(tag.textContent).toBe("BufferCore");
    expect(tag.getAttribute("title")).toBe("player.info.engineRoles.BufferCore");
    await waitFor(() => expect(document.querySelector('[data-engine-brick="CodecBridge"]')).not.toBeNull());
  });
});
