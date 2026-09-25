import { describe, it, expect } from "vitest";
import { coversGrid } from "@/lib/cinemaGridTop";
import { readCinemaRoute } from "@/lib/cinemaRoute";

// L'activité et un signalement s'ouvrent depuis le Compte, qui quitte l'adresse : oubliés ici, la
// grille se croyait à l'écran sous eux, et les flèches promenaient le focus sur des affiches
// cachées (chasse aux défauts du 25/09/2026).

describe("coversGrid", () => {
  const empty = readCinemaRoute();

  it("la grille nue n'est pas couverte", () => {
    expect(coversGrid(empty)).toBe(false);
  });

  it("l'activité et un signalement la couvrent", () => {
    expect(coversGrid({ ...empty, activity: "1" })).toBe(true);
    expect(coversGrid({ ...empty, report: "1" })).toBe(true);
  });
});
