// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string) => key,
}));

import { PlaybackInfoPanel } from "@/components/PlaybackInfoPanel";
import type { PlaybackInfoSummary } from "@/components/PlayerHost";

afterEach(() => cleanup());

const baseInfo: PlaybackInfoSummary = {
  playMethod: "DirectPlay",
  transcodeReasons: [],
  container: "mkv",
  requestedVideoCodecs: [],
  video: null,
  audio: null,
};

describe("PlaybackInfoPanel", () => {
  it("renders nothing when closed or info is missing", () => {
    const { container: c1 } = render(<PlaybackInfoPanel info={baseInfo} networkBitrate={null} open={false} onClose={vi.fn()} />);
    expect(c1).toBeEmptyDOMElement();

    const { container: c2 } = render(<PlaybackInfoPanel info={null} networkBitrate={null} open onClose={vi.fn()} />);
    expect(c2).toBeEmptyDOMElement();
  });

  it("shows the DirectPlay method label and description with no transcode-reasons section", () => {
    render(<PlaybackInfoPanel info={baseInfo} networkBitrate={null} open onClose={vi.fn()} />);

    expect(screen.getByText("player.info.directPlay")).toBeInTheDocument();
    expect(screen.getByText("player.info.describeDirectPlay")).toBeInTheDocument();
    expect(screen.queryByText("player.info.reason")).not.toBeInTheDocument();
  });

  it("describes an audio-only DirectStream differently from a container-only one", () => {
    const { rerender } = render(
      <PlaybackInfoPanel
        info={{ ...baseInfo, playMethod: "DirectStream", transcodeReasons: ["AudioCodecNotSupported"] }}
        networkBitrate={null}
        open
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("player.info.describeDirectStreamAudio")).toBeInTheDocument();

    rerender(
      <PlaybackInfoPanel
        info={{ ...baseInfo, playMethod: "DirectStream", transcodeReasons: ["ContainerNotSupported"] }}
        networkBitrate={null}
        open
        onClose={vi.fn()}
      />
    );
    expect(screen.getByText("player.info.describeDirectStreamContainer")).toBeInTheDocument();
  });

  it("translates known transcode reasons and falls back to the raw string for unknown ones", () => {
    render(
      <PlaybackInfoPanel
        info={{ ...baseInfo, playMethod: "Transcode", transcodeReasons: ["VideoCodecNotSupported", "SomeFutureReason"] }}
        networkBitrate={null}
        open
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("· player.info.reasons.VideoCodecNotSupported")).toBeInTheDocument();
    expect(screen.getByText("· SomeFutureReason")).toBeInTheDocument();
  });

  it("formats bitrates in Mb/s and shows a dash when absent", () => {
    render(
      <PlaybackInfoPanel
        info={{ ...baseInfo, video: { codec: "h264", profile: null, width: 1920, height: 1080, bitDepth: 8, frameRate: 23.976, bitRate: 5_000_000 } }}
        networkBitrate={12_500_000}
        open
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText("12.5 Mb/s")).toBeInTheDocument(); // network
    expect(screen.getByText("5.0 Mb/s")).toBeInTheDocument(); // video
    expect(screen.getByText("1920×1080")).toBeInTheDocument();
    expect(screen.getByText("23.98")).toBeInTheDocument();
  });

  it("shows dashes for missing video/audio fields rather than crashing", () => {
    render(
      <PlaybackInfoPanel
        info={{ ...baseInfo, audio: { codec: null, channels: null, bitRate: null, language: null } }}
        networkBitrate={null}
        open
        onClose={vi.fn()}
      />
    );

    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("calls onClose when the close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<PlaybackInfoPanel info={baseInfo} networkBitrate={null} open onClose={onClose} />);

    await user.click(screen.getByRole("button"));
    expect(onClose).toHaveBeenCalled();
  });
});
