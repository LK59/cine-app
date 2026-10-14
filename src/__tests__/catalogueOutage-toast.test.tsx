// @vitest-environment jsdom
// Le refus de Lecture pendant une panne de Jellyfin (DECISIONS.md §92) avec le VRAI fournisseur de
// toasts. Relecture du 14/10/2026 : le premier refus affichait un toast, le fournisseur se
// redessinait avec une valeur de contexte neuve, l'effet de `useCatalogueOutage` repartait — et son
// nettoyage remettait la panne à faux : le second appui ouvrait le lecteur. Le test à toast simulé
// (`catalogueOutage-ui.test.tsx`) ne pouvait pas le voir, sa valeur étant stable.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/TranslationProvider", () => {
  const t = (key: string) => key;
  return { useT: () => t, useLocale: () => ({ locale: "fr", setLocale: () => {} }) };
});

import { ToastProvider, useToast } from "@/components/Toast";
import { useCatalogueOutage } from "@/components/cinema/CatalogueOutage";
import { resetPlaybackOutage } from "@/lib/catalogueOutage";
import { PlaybackProvider, usePlayback } from "@/components/PlaybackProvider";

beforeEach(() => {
  vi.useFakeTimers();
  resetPlaybackOutage();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 502, json: async () => ({ code: "upstream_unreachable" }) })));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <PlaybackProvider>{children}</PlaybackProvider>
    </ToastProvider>
  );
}

function mount(down: boolean) {
  return renderHook(
    ({ down }: { down: boolean }) => {
      useCatalogueOutage({ jellyfinDown: down, stale: down });
      return { playback: usePlayback(), toast: useToast() };
    },
    { wrapper, initialProps: { down } }
  );
}

const dune = { itemId: "1", title: "Dune", resumeAt: 0 };

describe("Lecture refusée pendant la panne, avec le vrai ToastProvider", () => {
  it("deux appuis pendant la panne : deux refus, le lecteur reste fermé", () => {
    const { result } = mount(true);
    act(() => result.current.playback.play(dune));
    expect(result.current.playback.mode).toBe("closed");
    act(() => result.current.playback.play(dune));
    expect(result.current.playback.mode).toBe("closed");
    expect(result.current.playback.session).toBeNull();
    expect(document.body.textContent?.split("cinema.outage.playBlocked").length).toBe(3);
  });

  it("un autre toast pendant la panne ne lève pas le refus", () => {
    const { result } = mount(true);
    act(() => result.current.toast.success("ajouté à la liste"));
    act(() => result.current.toast.error("autre chose"));
    act(() => result.current.playback.play(dune));
    expect(result.current.playback.mode).toBe("closed");
  });

  it("la valeur du contexte reste la même d'un rendu à l'autre", () => {
    const { result } = mount(true);
    const first = result.current.toast;
    act(() => result.current.toast.info("un message"));
    expect(result.current.toast).toBe(first);
  });

  it("Jellyfin revenu : la lecture est permise", () => {
    const { result, rerender } = mount(true);
    act(() => result.current.playback.play(dune));
    expect(result.current.playback.mode).toBe("closed");
    rerender({ down: false });
    act(() => result.current.playback.play(dune));
    expect(result.current.playback.mode).toBe("full");
  });
});
