// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * Le lecteur hors ligne : « Garder » l'aide d'un passage rejoué retire l'aide et choisit la même piste,
 * dans le même rendu — la piste montrée ne change pas. Les lignes étaient vidées à chaque choix, et ne se
 * relisaient qu'à un changement de piste montrée : les sous-titres gardés disparaissaient (13/11/2026). De
 * même en rechoisissant la piste active dans le menu.
 */
vi.mock("@/components/TranslationProvider", () => ({ useT: () => (k: string) => k, useLocale: () => ({ locale: "fr" }) }));
vi.mock("@/lib/offline/downloads", () => ({ offlineAccount: () => "compte" }));
vi.mock("@/lib/offline/subtitles", () => ({
  readOfflineSubtitle: async () => "WEBVTT\n\n00:00:00.000 --> 00:10:00.000\nBonjour\n",
}));

import { useOfflineSubtitles } from "@/components/offline/useOfflineSubtitles";
import type { OfflineDownload } from "@/lib/offline/downloads";

const DOWNLOAD = {
  id: "d1",
  subtitles: [{ index: 3, language: "fre", title: null, isForced: false, isHearingImpaired: false, isExternal: false }],
} as unknown as OfflineDownload;

describe("useOfflineSubtitles", () => {
  it.each([
    ["« Garder » l'aide d'un passage rejoué", (h: ReturnType<typeof useOfflineSubtitles>) => {
      h.replaySubtitle.show(null);
      h.choose(3);
    }],
    ["rechoisir la piste active", (h: ReturnType<typeof useOfflineSubtitles>) => h.choose(3)],
  ])("%s garde la ligne affichée", async (_name, gesture) => {
    const video = document.createElement("video");
    Object.defineProperty(video, "currentTime", { value: 5, writable: true });
    const ref = { current: video };
    const { result } = renderHook(() => useOfflineSubtitles(DOWNLOAD, ref));
    // L'aide du passage rejoué montre la piste 3.
    act(() => result.current.replaySubtitle.show(3));
    await waitFor(() => expect(result.current.text).toBe("Bonjour"));
    if (_name.startsWith("rechoisir")) {
      act(() => {
        result.current.replaySubtitle.show(null);
        result.current.choose(3);
      });
      await waitFor(() => expect(result.current.text).toBe("Bonjour"));
    }
    act(() => gesture(result.current));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(result.current.current).toBe(3);
    expect(result.current.text).toBe("Bonjour");
  });
});
