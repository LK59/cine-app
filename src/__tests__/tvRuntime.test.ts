import { describe, it, expect } from "vitest";
import { tvEpisodeRuntime } from "@/lib/tvRuntime";

// TMDB a abandonné `episode_run_time` : vide pour Mr Robot et Ted Lasso (mesuré le 21/09/2026),
// d'où « 45min/ép. » sur certaines séries et rien sur d'autres.
describe("tvEpisodeRuntime", () => {
  it("prend le champ historique quand il existe encore", () => {
    expect(tvEpisodeRuntime({ episode_run_time: [50], last_episode_to_air: { runtime: 57 } })).toBe(50);
  });

  it("se rabat sur Sonarr, puis sur le dernier épisode diffusé, puis le prochain", () => {
    expect(tvEpisodeRuntime({ episode_run_time: [], last_episode_to_air: { runtime: 51 } }, 45)).toBe(45);
    expect(tvEpisodeRuntime({ episode_run_time: [], last_episode_to_air: { runtime: 51 } })).toBe(51);
    expect(tvEpisodeRuntime({ episode_run_time: [], last_episode_to_air: null, next_episode_to_air: { runtime: 30 } }, 0)).toBe(30);
  });

  it("ne dit rien plutôt qu'un zéro", () => {
    expect(tvEpisodeRuntime({ episode_run_time: [0], last_episode_to_air: { runtime: null } }, 0)).toBeNull();
    expect(tvEpisodeRuntime(null)).toBeNull();
  });
});
