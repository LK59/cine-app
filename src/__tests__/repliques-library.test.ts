import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkMoviesMount, containerPathOf } from "@/lib/repliques/library";
import { MOVIES_PATH } from "@/lib/media-paths";
import type { RadarrMovie } from "@/lib/clients/radarr";

/**
 * Où lire les films (DECISIONS.md §88) : le chemin de Radarr ramené sous `MOVIES_PATH`, jamais
 * ailleurs, et l'option refusée tant que le dossier n'est pas monté et lisible.
 */

const movie = (p: string, rel: string) => ({ path: p, movieFile: { relativePath: rel } }) as unknown as RadarrMovie;

describe("containerPathOf", () => {
  it("ramène le chemin de Radarr sous la racine des films du conteneur", () => {
    expect(containerPathOf(movie("/media/movies/Alien (1979)", "Alien (1979).mkv"), "/mnt/media/video/movies")).toBe("/mnt/media/video/movies/Alien (1979)/Alien (1979).mkv");
    expect(containerPathOf(movie("/media/movies/Alien (1979)/", "Alien (1979).mkv"), "/films")).toBe("/films/Alien (1979)/Alien (1979).mkv");
  });
  it("ne suit jamais un chemin qui remonte, ni un film sans fichier", () => {
    expect(containerPathOf(movie("/media/movies/X", "../../downloads/seeds/x.mkv"), "/films")).toBeNull();
    expect(containerPathOf({ path: "/media/movies/X" } as RadarrMovie, "/films")).toBeNull();
  });
});

describe("checkMoviesMount", () => {
  it("dit « non monté » quand la racine des films n'existe pas dans le conteneur", async () => {
    // La suite tourne dans un conteneur où /mnt/media/video n'est pas monté.
    if (fs.existsSync(MOVIES_PATH)) return;
    const check = await checkMoviesMount({ movies: async () => [], rootFolders: async () => [] });
    expect(check).toMatchObject({ ok: false, problem: "not-mounted", moviesPath: MOVIES_PATH });
  });

  it("vérifie un échantillon de films à leur chemin : trouvé, ou racine qui ne correspond pas", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "repliques-mount-"));
    fs.mkdirSync(path.join(root, "Alien (1979)"));
    fs.writeFileSync(path.join(root, "Alien (1979)", "Alien (1979).mkv"), "x");
    const movies = async () => [{ ...movie("/media/movies/Alien (1979)", "Alien (1979).mkv"), hasFile: true } as RadarrMovie];
    expect(await checkMoviesMount({ movies, rootFolders: async () => ["/media/movies"], moviesPath: root })).toMatchObject({ ok: true, sample: { checked: 1, found: 1 }, rootFolders: ["/media/movies"] });
    const other = async () => [{ ...movie("/media/movies/Brazil (1985)", "Brazil (1985).mkv"), hasFile: true } as RadarrMovie];
    expect(await checkMoviesMount({ movies: other, rootFolders: async () => [], moviesPath: root })).toMatchObject({ ok: false, problem: "files-missing" });
    expect(await checkMoviesMount({ movies: async () => { throw new Error("down"); }, rootFolders: async () => [], moviesPath: root })).toMatchObject({ ok: false, problem: "no-radarr" });
  });
});
