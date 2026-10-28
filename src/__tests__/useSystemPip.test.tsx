// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

/**
 * L'image dans l'image du système (`useSystemPip`) : proposée seulement là où le système l'accepte
 * vraiment — jamais dans l'app installée depuis Safari sur iPhone, qui se dit capable et refuse —, et
 * « Réduire » (le mini-lecteur de l'app) masqué tant qu'elle est ouverte.
 */

vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k }));

import { systemPipAvailable } from "@/components/playerControls/useSystemPip";
import { PlayerTopBar } from "@/components/playerControls/PlayerTopBar";

function video(extra: Record<string, unknown> = {}): HTMLVideoElement {
  return Object.assign(document.createElement("video"), { requestPictureInPicture: vi.fn(() => Promise.resolve({})) }, extra);
}
function pipEnabled(value: boolean | undefined) {
  Object.defineProperty(document, "pictureInPictureEnabled", { configurable: true, value });
}

afterEach(() => {
  cleanup();
  pipEnabled(undefined);
});

describe("le système accepte-t-il l'image dans l'image ?", () => {
  it("Chrome, Edge : l'API standard suffit", () => {
    pipEnabled(true);
    expect(systemPipAvailable(video())).toBe(true);
  });

  it("app installée depuis Safari sur iPhone : se dit capable, mais la question de WebKit dit non", () => {
    pipEnabled(true);
    expect(systemPipAvailable(video({ webkitSupportsPresentationMode: () => false }))).toBe(false);
  });

  it("Safari dans un onglet, ou sur Mac : WebKit dit oui", () => {
    pipEnabled(true);
    expect(systemPipAvailable(video({ webkitSupportsPresentationMode: (mode: string) => mode === "picture-in-picture" }))).toBe(true);
  });

  it("Firefox (pas d'API), ou l'élément qui l'interdit : non", () => {
    pipEnabled(undefined);
    expect(systemPipAvailable(video())).toBe(false);
    pipEnabled(true);
    expect(systemPipAvailable(video({ disablePictureInPicture: true }))).toBe(false);
  });
});

function bar(pip?: { supported: boolean; active: boolean; toggle: () => void }) {
  return render(
    <PlayerTopBar
      rowRef={{ current: null }}
      visible
      showControls={() => {}}
      onClose={() => {}}
      onMinimize={() => {}}
      pip={pip}
      castSupported={false}
      castKind="remote"
      showCastPicker={async () => {}}
      muted={false}
      volume={1}
      volumeSettable={false}
      toggleMute={() => {}}
      changeVolume={() => {}}
    />
  );
}

describe("les deux boutons de la barre du haut", () => {
  it("sans image dans l'image du système : seul « Réduire », avec son chevron", () => {
    bar({ supported: false, active: false, toggle: () => {} });
    expect(screen.queryByLabelText("player.pip")).toBeNull();
    expect(screen.getByLabelText("player.minimize").querySelector(".lucide-chevron-down")).not.toBeNull();
  });

  it("avec : les deux, et l'appui demande l'image dans l'image dans le geste", () => {
    const toggle = vi.fn();
    bar({ supported: true, active: false, toggle });
    fireEvent.click(screen.getByLabelText("player.pip"));
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("player.minimize")).toBeTruthy();
  });

  it("pendant l'image dans l'image : « Réduire » disparaît, le mini-lecteur l'en ferait sortir", () => {
    bar({ supported: true, active: true, toggle: () => {} });
    expect(screen.getByLabelText("player.pip").getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByLabelText("player.minimize")).toBeNull();
  });
});
