// @vitest-environment jsdom
// « Deux sous-titres » du lecteur serveur (DECISIONS.md §87) : `timeupdate` arrive quatre fois par
// seconde, et l'état était remplacé par un objet neuf à chaque fois — tout le lecteur redessiné pour
// rien (relecture du 14/10/2026). Il ne change plus que si l'un des deux textes change.
import { describe, it, expect, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useServerDualSubtitles } from "@/lib/useServerDualSubtitles";

function fakeTrack() {
  const target = new EventTarget() as EventTarget & { mode: string; activeCues: { length: number; [i: number]: unknown } | null };
  target.mode = "disabled";
  target.activeCues = { length: 0 };
  return target;
}

function setup() {
  const tracks = [fakeTrack(), fakeTrack()];
  const video = new EventTarget() as EventTarget & { textTracks: unknown };
  video.textTracks = Object.assign([...tracks], { length: tracks.length });
  const videoRef = { current: video as unknown as HTMLVideoElement };
  const trackIds = [1, 2];
  const primaryNow = () => 1;
  let renders = 0;
  const hook = renderHook(() => {
    renders += 1;
    return useServerDualSubtitles({ videoRef, trackIds, primaryNow, primary: 1, second: 2, enabled: true, videoKey: 0 });
  });
  return { tracks, video, hook, renders: () => renders };
}

const cues = (text: string) => ({ length: 1, 0: { startTime: 1, text } });

describe("useServerDualSubtitles — pas de rendu pour un texte inchangé", () => {
  it("timeupdate sans changement de réplique : aucun nouveau rendu ; une réplique neuve : un", () => {
    vi.useFakeTimers();
    const { tracks, video, hook, renders } = setup();
    act(() => void vi.runAllTimers());
    tracks[0].activeCues = cues("Bonjour");
    tracks[1].activeCues = cues("Hello");
    act(() => void video.dispatchEvent(new Event("timeupdate")));
    expect(hook.result.current).toEqual({ primary: "Bonjour", second: "Hello", active: true });
    const before = renders();
    for (let i = 0; i < 8; i++) act(() => void video.dispatchEvent(new Event("timeupdate")));
    // React peut faire un rendu de vérification avant de renoncer (sans rien valider) : au plus un,
    // là où chaque `timeupdate` en coûtait un.
    expect(renders() - before).toBeLessThanOrEqual(1);
    const settled = renders();
    tracks[1].activeCues = cues("Goodbye");
    act(() => void video.dispatchEvent(new Event("timeupdate")));
    expect(renders()).toBeGreaterThan(settled);
    expect(hook.result.current.second).toBe("Goodbye");
    vi.useRealTimers();
  });
});
