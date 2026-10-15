// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { useRef, type RefObject } from "react";

/**
 * Le geste liquide du lecteur et le clic du doigt (passe de nuit du 15/10/2026, LECTEUR-3).
 *
 * « Passer l'intro » porte `data-liquid` sans être une des cibles du geste du lecteur
 * (`.player-pill-btn`, `.player-center-btn`, `.player-capsule`) : son clic, venu du doigt ou de la
 * souris, était retenu par le geste en capture — rien ne se passait depuis le 04/10. Les tests du
 * lecteur ne pouvaient pas le voir : sous jsdom, `isTrusted` est faux et le geste laisse passer
 * tout clic qu'il ne croit pas venu d'un doigt. Ici, le geste est le vrai, branché par le vrai
 * `PlayerControls` ; seule sa façon de reconnaître un clic « du doigt » est remplacée par
 * `detail > 0` — ce que produit un vrai clic de souris ou de toucher.
 */

vi.mock("@/components/TranslationProvider", () => ({
  useT: () => (key: string, vars?: Record<string, unknown>) => (vars ? `${key}:${JSON.stringify(vars)}` : key),
}));
vi.mock("@/lib/liquidGlass/liquid", async (original) => {
  const actual = await original<typeof import("@/lib/liquidGlass/liquid")>();
  return {
    ...actual,
    createLiquidPress: (options: Parameters<typeof actual.createLiquidPress>[0]) =>
      actual.createLiquidPress({ ...options, trusted: (e: MouseEvent) => e.detail > 0 }),
  };
});

import { PlayerControls } from "@/components/PlayerControls";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = () => {};

function Harness(props: Partial<React.ComponentProps<typeof PlayerControls>> & { onVideoRef?: (v: HTMLVideoElement) => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={containerRef}>
      <video
        ref={(el) => {
          videoRef.current = el;
          if (el && props.onVideoRef) props.onVideoRef(el);
        }}
      />
      <PlayerControls
        videoRef={videoRef as RefObject<HTMLVideoElement | null>}
        containerRef={containerRef}
        itemId="item-1"
        title="Un titre"
        onClose={noop}
        onMinimize={noop}
        onTogglePlaybackInfo={noop}
        audioTracks={[]}
        currentAudioId={null}
        onChangeAudio={noop}
        subtitleTracks={[]}
        currentSubtitleId={null}
        onChangeSubtitle={noop}
        hidden={false}
        loading={false}
        introSkip={null}
        creditsStart={null}
        nextEpisode={null}
        onAdvance={noop}
        {...props}
      />
    </div>
  );
}

/** Un appui du doigt complet : posé, relâché, puis le clic natif que le navigateur en tire. */
function fingerTap(el: Element) {
  const opts = { bubbles: true, cancelable: true, clientX: 0, clientY: 0, pointerId: 7, button: 0, pointerType: "touch" };
  el.dispatchEvent(new PointerEvent("pointerdown", opts));
  window.dispatchEvent(new PointerEvent("pointerup", opts));
  el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
}

describe("PlayerControls — le geste liquide ne retient pas un clic qu'il ne prend pas en charge", () => {
  it("« Passer l'intro » saute à la fin de l'intro sous un vrai clic du doigt", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => null }));
    let video!: HTMLVideoElement;
    const onSeekRequest = vi.fn();
    render(<Harness introSkip={{ start: 10, end: 30 }} onSeekRequest={onSeekRequest} onVideoRef={(v) => (video = v)} />);
    Object.defineProperty(video, "currentTime", { value: 15, writable: true, configurable: true });
    act(() => void video.dispatchEvent(new Event("timeupdate")));
    const skip = (await screen.findByText("player.skipIntro")).closest("button")!;
    // C'est bien le geste qui est en jeu : le bouton est une surface du verre.
    expect(skip.hasAttribute("data-liquid")).toBe(true);

    act(() => fingerTap(skip));

    expect(onSeekRequest).toHaveBeenCalledWith(30);
    expect(video.currentTime).toBe(30);
  });
});
