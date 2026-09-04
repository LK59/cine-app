// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

/**
 * next/image est remplacé par une balise nue qui expose ce qui nous intéresse : le drapeau
 * `unoptimized`, qui décide si l'image passe ou non par l'optimiseur de Next.
 */
vi.mock("next/image", () => ({
  default: ({ src, alt, unoptimized }: { src: string; alt: string; unoptimized?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-unoptimized={unoptimized ? "1" : "0"} />
  ),
}));

import { PosterImage } from "@/components/PosterImage";

afterEach(() => cleanup());

const flag = (alt: string) => screen.getByAltText(alt).getAttribute("data-unoptimized");

describe("PosterImage", () => {
  /**
   * L'optimiseur de Next relaie une image locale par une requête interne qui n'emporte pas les
   * cookies : une route authentifiée de cette app y répond 400 et la carte affiche « No image ».
   * C'est ce qui a vidé « Continuer à regarder » le jour où le drapeau a été oublié en
   * déplaçant une carte — d'où la déduction depuis l'adresse plutôt qu'un drapeau à porter.
   */
  it("ne fait pas optimiser une image servie par une route de l'app", () => {
    render(<PosterImage src="/api/jellyfin/image?itemId=42&tag=abc" alt="Mentalist" />);
    expect(flag("Mentalist")).toBe("1");
  });

  it("laisse optimiser une image distante ordinaire", () => {
    render(<PosterImage src="https://image.tmdb.org/t/p/w342/x.jpg" alt="Un Film" />);
    expect(flag("Un Film")).toBe("0");
  });

  it("respecte encore le drapeau posé à la main", () => {
    render(<PosterImage src="https://image.tmdb.org/t/p/w342/x.jpg" alt="Forcé" unoptimized />);
    expect(flag("Forcé")).toBe("1");
  });

  it("affiche un substitut plutôt qu'une image vide quand il n'y a pas de source", () => {
    render(<PosterImage src={null} alt="Sans affiche" />);
    expect(screen.getByText("No image")).toBeInTheDocument();
  });
});
