// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, string | number>) =>
    vars ? `${key}:${Object.values(vars).join(",")}` : key,
}));
vi.mock("@/lib/webcodecs/capabilities", () => ({
  probeCapabilities: vi.fn().mockResolvedValue({}),
  describeCapabilities: () => ({ "HEVC matériel": "oui" }),
}));

import { PlaybackInfoPanel, type PlaybackPanelData } from "@/components/PlaybackInfoPanel";
import { describeJellyfinPlayback, describeRemuxPlayback, type JellyfinPlayback } from "@/lib/playbackPanel";

const t = (key: string, vars?: Record<string, string | number>) =>
  vars ? `${key}:${Object.values(vars).join(",")}` : key;

const jellyfin: JellyfinPlayback = {
  playMethod: "DirectPlay",
  transcodeReasons: [],
  container: "mkv",
  video: null,
  audio: null,
};

function panel(data: Omit<PlaybackPanelData, "report">): PlaybackPanelData {
  return { ...data, report: null };
}

afterEach(() => cleanup());
beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn() }, configurable: true });
});

describe("panneau d'infos de lecture", () => {
  it("ne rend rien fermé, ni sans données", () => {
    const data = panel(describeJellyfinPlayback(jellyfin, null, null, t));
    const { container: c1 } = render(<PlaybackInfoPanel data={data} open={false} onClose={vi.fn()} />);
    expect(c1).toBeEmptyDOMElement();

    const { container: c2 } = render(<PlaybackInfoPanel data={null} open onClose={vi.fn()} />);
    expect(c2).toBeEmptyDOMElement();
  });

  it("sonde ce que l'appareil accepte, quel que soit le lecteur qui l'ouvre", async () => {
    render(<PlaybackInfoPanel data={panel(describeJellyfinPlayback(jellyfin, null, null, t))} open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("HEVC matériel")).toBeInTheDocument());
    expect(screen.getByText("player.info.sections.device")).toBeInTheDocument();
  });

  it("se ferme sur son propre bouton", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PlaybackInfoPanel data={panel(describeJellyfinPlayback(jellyfin, null, null, t))} open onClose={onClose} />);

    await user.click(screen.getByLabelText("common.close"));
    expect(onClose).toHaveBeenCalled();
  });

  it("montre le rapport copiable quand le lecteur en fournit un", async () => {
    const data: PlaybackPanelData = {
      ...describeJellyfinPlayback(jellyfin, null, null, t),
      report: { error: null, elapsedMs: null, title: "Un Film", itemId: "abc", file: null, pathReason: "Lecteur stable", diagnostics: {}, running: true },
    };
    render(<PlaybackInfoPanel data={data} open onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeInTheDocument());
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toContain("Un Film");
  });
});

describe("describeJellyfinPlayback", () => {
  it("nomme et décrit la lecture directe, sans raison à donner", () => {
    const d = describeJellyfinPlayback(jellyfin, null, null, t);
    expect(d.headline.name).toBe("player.info.directPlay");
    expect(d.headline.tone).toBe("good");
    expect(d.notes).toEqual([]);
  });

  it("distingue un remultiplexage dû au son de celui dû au conteneur", () => {
    const audio = describeJellyfinPlayback({ ...jellyfin, playMethod: "DirectStream", transcodeReasons: ["AudioCodecNotSupported"] }, null, null, t);
    expect(audio.headline.detail).toBe("player.info.describeDirectStreamAudio");

    const container = describeJellyfinPlayback({ ...jellyfin, playMethod: "DirectStream", transcodeReasons: ["ContainerNotSupported"] }, null, null, t);
    expect(container.headline.detail).toBe("player.info.describeDirectStreamContainer");
  });

  it("traduit les raisons connues et recopie telles quelles celles qu'il ne connaît pas", () => {
    const d = describeJellyfinPlayback(
      { ...jellyfin, playMethod: "Transcode", transcodeReasons: ["VideoCodecNotSupported", "SomeFutureReason"] },
      null, null, t
    );
    expect(d.headline.tone).toBe("warn");
    expect(d.notes).toContain("· player.info.reasons.VideoCodecNotSupported");
    expect(d.notes).toContain("· SomeFutureReason");
  });

  it("garde trace du repli du lecteur natif", () => {
    const d = describeJellyfinPlayback(jellyfin, null, "codec refusé", t);
    expect(d.notes.some((n) => n.includes("codec refusé"))).toBe(true);
  });

  it("exprime les débits en Mb/s et n'invente pas les lignes absentes", () => {
    const d = describeJellyfinPlayback(
      { ...jellyfin, video: { codec: "h264", profile: null, width: 1920, height: 1080, bitDepth: 8, frameRate: 23.976, bitRate: 5_000_000 } },
      12_500_000, null, t
    );
    const rows = d.sections.flatMap((s) => s.rows);
    expect(rows).toContainEqual({ label: "player.info.resolution", value: "1920×1080" });
    expect(rows).toContainEqual({ label: "player.info.fps", value: "23.98" });
    expect(rows.some((r) => r.value === "5.0 Mb/s")).toBe(true);
    expect(rows.some((r) => r.value === "12.5 Mb/s")).toBe(true);
    // Aucune piste audio décrite : aucune ligne audio inventée.
    expect(rows.some((r) => r.label === "player.info.channels")).toBe(false);
  });
});

describe("describeRemuxPlayback", () => {
  const base = {
    path: "remux" as const,
    pathReason: null,
    container: "mkv",
    video: { codec: "hevc", width: 3840, height: 2160, bitDepth: 10, rangeType: "HDR10" },
    audioTrackCount: 3,
    subtitleTrackCount: 2,
    currentAudioCodec: "EAC3",
    diagnostics: {},
  };

  it("colore le chemin par le travail demandé à l'appareil, pas par la réussite", () => {
    expect(describeRemuxPlayback(base, t).headline.tone).toBe("good");
    expect(describeRemuxPlayback({ ...base, path: "webcodecs" }, t).headline.tone).toBe("warn");
    expect(describeRemuxPlayback({ ...base, path: null }, t).headline.tone).toBe("neutral");
  });

  it("dit toujours pourquoi ce chemin a été retenu, quand il y a un pourquoi", () => {
    expect(describeRemuxPlayback({ ...base, pathReason: "pas de HEVC matériel" }, t).notes).toEqual(["pas de HEVC matériel"]);
  });

  it("sépare les lignes de diagnostic du son de celles du transport", () => {
    const d = describeRemuxPlayback(
      { ...base, diagnostics: { "Traitement audio": "AAC 5.1", "Segments envoyés": "12" } },
      t
    );
    const sound = d.sections.find((s) => s.title === "player.info.sections.sound")!;
    const stream = d.sections.find((s) => s.title === "player.info.sections.stream")!;
    expect(sound.rows.some((r) => r.label === "Traitement audio")).toBe(true);
    expect(stream.rows.some((r) => r.label === "Segments envoyés")).toBe(true);
    expect(stream.rows.some((r) => r.label === "Traitement audio")).toBe(false);
  });

  it("annonce qu'aucun transcodage serveur n'a lieu sur ce chemin", () => {
    const stream = describeRemuxPlayback(base, t).sections.find((s) => s.title === "player.info.sections.stream")!;
    expect(stream.rows).toContainEqual({ label: "player.info.serverTranscode", value: "player.info.serverTranscodeNo" });
  });

  it("le dit quand aucune piste audio n'est décodable", () => {
    const sound = describeRemuxPlayback({ ...base, currentAudioCodec: null }, t).sections
      .find((s) => s.title === "player.info.sections.sound")!;
    expect(sound.rows[0].value).toBe("player.info.noDecodableTrack");
  });
});
