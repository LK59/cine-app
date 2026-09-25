// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { PosterImage } from "@/components/PosterImage";
import { FAST_REVEAL_MS, READY_REVEAL, noteWarmed } from "@/lib/imageReveal";

/**
 * Le fondu d'arrivée réservé aux vraies arrivées (25/09/2026) : les affiches déjà là —
 * cache HTTP, décodage anticipé — s'annonçaient une à une en fondu, et « l'app avait l'air
 * d'aller chercher les images ».
 *
 * `next/image` n'appelle `onLoad` qu'après avoir décodé l'image, un tour plus tard : on attend
 * l'apparition avant de lire la transition.
 */
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mount(src: string) {
  const { container } = render(<PosterImage src={src} alt="" unoptimized />);
  return container.querySelector("img")!;
}

function fetchedIn(ms: number | null) {
  vi.spyOn(performance, "getEntriesByName").mockReturnValue(
    ms === null ? [] : ([{ duration: ms }] as unknown as PerformanceEntryList)
  );
}

async function loaded(img: HTMLImageElement) {
  fireEvent.load(img);
  await waitFor(() => expect(img.style.opacity).toBe("1"));
  return img.style.transition;
}

describe("l'apparition d'une affiche", () => {
  it("sans fondu quand le navigateur l'a obtenue en un instant", async () => {
    fetchedIn(12);
    expect(await loaded(mount("/api/jellyfin/image/a"))).toBe(READY_REVEAL);
  });

  it("en fondu quand elle est vraiment arrivée par le réseau", async () => {
    fetchedIn(FAST_REVEAL_MS * 4);
    expect(await loaded(mount("/api/jellyfin/image/b"))).toBe("");
  });

  it("sans fondu quand le décodage anticipé l'avait chauffée", async () => {
    fetchedIn(FAST_REVEAL_MS * 4);
    const img = mount("/api/jellyfin/image/c");
    noteWarmed(img.src);
    expect(await loaded(img)).toBe(READY_REVEAL);
  });

  it("faute de mesure, jugée sur le temps écoulé depuis son montage", async () => {
    fetchedIn(null);
    let t = 1000;
    vi.spyOn(performance, "now").mockImplementation(() => t);
    const vite = mount("/api/jellyfin/image/d");
    t += 20;
    expect(await loaded(vite)).toBe(READY_REVEAL);
    cleanup();

    const lente = mount("/api/jellyfin/image/e");
    t += 800;
    expect(await loaded(lente)).toBe("");
  });
});
