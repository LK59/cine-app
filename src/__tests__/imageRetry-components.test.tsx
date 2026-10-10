// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@/lib/playbackBusy", () => ({ isWatchingFullScreen: () => false }));
vi.mock("next/image", () => ({
  default: ({ fill: _fill, unoptimized: _u, priority: _p, alt, ...props }: Record<string, unknown> & { alt: string }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img alt={alt} {...props} />
  ),
}));

import { PosterImage } from "@/components/PosterImage";
import { CinemaLogo } from "@/components/cinema/CinemaLogo";
import { RETRY_DELAYS_MS, resetImageRetryForTests, setRetryRandomForTests } from "@/lib/imageRetry";
import { jellyfinPoster, libraryPoster } from "@/lib/images";

// Les composants branchés sur le registre des nouveaux essais (DECISIONS.md) : le repli tient la
// place, l'image réessaie, et paraît en fondu à son arrivée.

/** Un `Image` dont on décide l'issue : les sondes des logos et des bannières passent par lui. */
const probes: { src: string; onload: (() => void) | null; onerror: (() => void) | null }[] = [];
class FakeImage {
  decoding = "";
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    probes.push(this as unknown as (typeof probes)[number]);
    (this as unknown as { _src: string })._src = value;
  }
  get src() {
    return (this as unknown as { _src: string })._src;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  resetImageRetryForTests();
  setRetryRandomForTests(() => 0.5);
  probes.length = 0;
  vi.stubGlobal("Image", FakeImage);
  Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetImageRetryForTests();
  vi.useRealTimers();
});

describe("PosterImage — l'affiche réessaie sous son carré gris", () => {
  it("garde le repli à l'échec, remonte l'image au bout de ~2 s, et l'enlève quand elle arrive", () => {
    const { container } = render(<PosterImage src="https://image.tmdb.org/t/p/w342/a.jpg" alt="Titre" />);
    const first = container.querySelector("img")!;
    act(() => {
      fireEvent.error(first);
    });
    expect(screen.getByRole("img", { name: "Titre" })).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    });
    const second = container.querySelector("img")!;
    expect(second).not.toBe(first); // remontée : la même adresse est redemandée
    expect(second.getAttribute("src")).toBe(first.getAttribute("src"));
    act(() => {
      fireEvent.load(second);
    });
    // Le carré gris est parti ; seule l'image, revenue, porte le titre.
    expect(container.querySelector('[role="img"]')).toBeNull();
    expect(second.getAttribute("alt")).toBe("Titre");
  });
});

describe("CinemaLogo — le titre écrit tient la place, le logo revient en fondu", () => {
  it("sonde l'adresse hors du document et rend le logo une fois chargé", () => {
    const { container } = render(
      <CinemaLogo src="https://image.tmdb.org/t/p/w500/logo.png" alt="Titre" surface="hero" fallback={<h1>Titre écrit</h1>} />
    );
    act(() => {
      fireEvent.error(container.querySelector("img")!);
    });
    expect(screen.getByText("Titre écrit")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    });
    expect(probes).toHaveLength(1);
    expect(probes[0].src).toBe("https://image.tmdb.org/t/p/w500/logo.png");
    act(() => {
      probes[0].onload?.();
    });
    expect(screen.queryByText("Titre écrit")).toBeNull();
    const logo = container.querySelector("img")!;
    expect(logo.className).toContain("animate-fade-in");
  });

  it("une sonde en échec passe à l'essai suivant, sans rendre le logo", () => {
    const { container } = render(
      <CinemaLogo src="https://image.tmdb.org/t/p/w500/l2.png" alt="T" surface="sheet" fallback={<h1>T écrit</h1>} />
    );
    act(() => {
      fireEvent.error(container.querySelector("img")!);
      vi.advanceTimersByTime(RETRY_DELAYS_MS[0]);
    });
    act(() => {
      probes[0].onerror?.();
      vi.advanceTimersByTime(RETRY_DELAYS_MS[1]);
    });
    expect(probes).toHaveLength(2);
    expect(screen.getByText("T écrit")).toBeTruthy();
  });
});

describe("libraryPoster + jellyfinPoster — une seule règle pour l'affiche d'une série", () => {
  const images = [{ coverType: "poster", remoteUrl: "https://artworks.thetvdb.com/banners/poster.jpg" }];
  it("la langue de qui regarde d'abord", () => {
    expect(
      libraryPoster({ fr: "https://image.tmdb.org/t/p/w342/fr.jpg" }, images, "fr", jellyfinPoster({ Id: "j1", ImageTags: { Primary: "t" } }))
    ).toBe("https://image.tmdb.org/t/p/w342/fr.jpg");
  });
  it("puis l'affiche de Jellyfin redimensionnée, gardée en cache", () => {
    expect(libraryPoster({}, images, "fr", jellyfinPoster({ Id: "j1", ImageTags: { Primary: "tag1" } }))).toBe(
      "/api/jellyfin/image?itemId=j1&kind=poster&tag=tag1"
    );
  });
  it("TheTVDB seulement si Jellyfin n'en a pas", () => {
    expect(libraryPoster(undefined, images, "fr", jellyfinPoster({ Id: "j1" }))).toBe("https://artworks.thetvdb.com/banners/poster.jpg");
  });
});

describe("imageReveal — une image servie par le cache paraît sans fondu", () => {
  it("transfert nul pour un corps décodé : venue du cache, aucun fondu même au-delà de 100 ms", async () => {
    const { revealLoaded } = await import("@/lib/imageReveal");
    const img = document.createElement("img");
    img.src = "http://localhost/_next/image?url=a";
    img.dataset.mountedAt = "0";
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([
      { duration: 340, transferSize: 0, decodedBodySize: 52000 } as unknown as PerformanceEntry,
    ]);
    revealLoaded(img);
    expect(img.style.transition).toBe("none");
    expect(img.style.opacity).toBe("1");
  });

  it("arrivée du réseau en plus de 100 ms : le fondu reste", async () => {
    const { revealLoaded } = await import("@/lib/imageReveal");
    const img = document.createElement("img");
    img.src = "http://localhost/_next/image?url=b";
    vi.spyOn(performance, "getEntriesByName").mockReturnValue([
      { duration: 340, transferSize: 52300, decodedBodySize: 52000 } as unknown as PerformanceEntry,
    ]);
    revealLoaded(img);
    expect(img.style.transition).toBe("");
  });
});
