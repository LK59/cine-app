// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";

/**
 * « Lire le fichier téléchargé » de la feuille de gestion d'un téléchargement, et la position d'où
 * il repart (audit des fiches, 23/10/2026, V5).
 *
 * La ligne de tête (`OfflinePlayButton`) reçoit la position que Jellyfin connaît *et* si Jellyfin a
 * répondu (`onlineKnown`). `OfflineDownloadControl` ne recevait que la position : `null` — « je ne
 * sais pas » — y devenait « Jellyfin dit 0 » (`onlineResumeTicks !== undefined`), et un film commencé,
 * téléchargement en pause, Jellyfin injoignable, repartait du début depuis la feuille alors que la
 * ligne de tête disait « Reprendre · 40 min ».
 */
const playMock = vi.fn();
vi.mock("@/components/PlaybackProvider", () => ({ usePlayback: () => ({ mode: "idle", play: playMock }) }));
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }));
vi.mock("@/lib/offline/useOfflineEnabled", () => ({ useOfflineDownloadsEnabled: () => true }));
vi.mock("@/lib/offline/deviceStore", () => ({ deviceStoreSupported: () => true }));
vi.mock("@/lib/unsentPosition", () => ({ findUnsentPositions: () => [] }));

const DOWNLOAD = {
  id: "dl1",
  itemId: "d".repeat(32),
  radarrId: 3,
  title: "Un film",
  year: 1999,
  runtimeSeconds: 7200,
  quality: "standard",
  codec: "h264",
  audioIndex: 1,
  audioLabel: "Français",
  audioTracks: [],
  generation: 1,
  expectedBytes: 1e9,
  serverBytes: 5e8,
  serverDone: false,
  state: "paused",
  bytes: 4e8,
  positionSeconds: 2400,
};
vi.mock("@/lib/offline/downloads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/offline/downloads")>()),
  initOfflineDownloads: async () => {},
  useOfflineDownloadFor: () => DOWNLOAD,
  adoptOnlinePosition: vi.fn(),
}));

import { OfflineDownloadControl } from "@/components/offline/OfflineDownloadControl";

beforeEach(() => {
  vi.useFakeTimers();
  playMock.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function playFromManageSheet(props: { onlineResumeTicks: number | null; onlineKnown: boolean }) {
  render(
    <OfflineDownloadControl
      variant="row"
      itemId={DOWNLOAD.itemId}
      radarrId={3}
      title="Un film"
      year={1999}
      posterUrl={null}
      runtimeMinutes={120}
      {...props}
    />
  );
  // La ligne dit l'état du téléchargement ; l'appui ouvre la gestion.
  fireEvent.click(document.body.querySelector("button[data-detail-menu]")!);
  act(() => vi.advanceTimersByTime(50));
  const play = Array.from(document.body.querySelectorAll<HTMLButtonElement>("[data-sheet-action]")).find((b) =>
    b.textContent?.includes("player.downloads.playDownloaded")
  );
  expect(play).toBeDefined();
  fireEvent.click(play!);
  expect(playMock).toHaveBeenCalledTimes(1);
  return playMock.mock.calls[0][0] as { resumeAt?: number; offline?: { id: string } };
}

describe("« Lire le fichier téléchargé » de la gestion", () => {
  it("Jellyfin n'a pas répondu : la position de l'appareil, comme la ligne de tête", () => {
    const call = playFromManageSheet({ onlineResumeTicks: null, onlineKnown: false });
    expect(call.offline).toEqual({ id: "dl1" });
    expect(call.resumeAt).toBe(2400);
  });

  it("Jellyfin a répondu : sa position, à la seconde", () => {
    expect(playFromManageSheet({ onlineResumeTicks: 1800 * 1e7, onlineKnown: true }).resumeAt).toBe(1800);
  });

  it("Jellyfin a répondu « jamais commencé » : du début", () => {
    expect(playFromManageSheet({ onlineResumeTicks: null, onlineKnown: true }).resumeAt).toBe(0);
  });
});
