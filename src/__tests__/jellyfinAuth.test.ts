import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { jellyfinAuth, jellyfinAuthHeaders } from "@/lib/jellyfinAuth";

describe("jellyfinAuth", () => {
  // Le serveur découpe l'en-tête sur les virgules et les guillemets, puis retire les guillemets de
  // chaque valeur. La forme compte donc autant que le contenu.
  it("écrit un en-tête réduit au jeton quand aucune identité n'est donnée", () => {
    expect(jellyfinAuth("abc123")).toBe('MediaBrowser Token="abc123"');
  });

  // Vérifié dans le source de v12.0-rc7 : `Client`, `Device`, `DeviceId` et `Version` passent par
  // `TryGetValue` et tolèrent d'être absents ; `HasToken` est le seul rejet. Un en-tête sans
  // identité est donc complet — et c'est ce qu'on envoie partout où il n'y en avait pas avant,
  // pour ne pas faire apparaître d'appareils dans le tableau de bord de Jellyfin.
  it("n'ajoute aucune identité par défaut", () => {
    const header = jellyfinAuth("abc123");
    for (const champ of ["Client=", "Device=", "DeviceId=", "Version="]) {
      expect(header).not.toContain(champ);
    }
  });

  // Là où l'identité comptait déjà : c'est elle qui permet de distinguer les deux lecteurs dans
  // la liste des sessions de Jellyfin — voir playbackClients.ts.
  it("porte l'identité complète quand on lui en donne une", () => {
    expect(
      jellyfinAuth("jeton", {
        client: "CineApp",
        device: "Navigateur",
        deviceId: "cine-app-42",
        version: "1.0.0",
      })
    ).toBe(
      'MediaBrowser Client="CineApp", Device="Navigateur", DeviceId="cine-app-42", Version="1.0.0", Token="jeton"'
    );
  });

  it("expose l'en-tête tout fait", () => {
    expect(jellyfinAuthHeaders("abc123")).toEqual({ Authorization: 'MediaBrowser Token="abc123"' });
  });
});

/**
 * Le garde-fou, sur le modèle du test qui interdit le vocabulaire d'infrastructure dans les
 * dictionnaires : ce n'est pas une règle qu'on peut tenir à la relecture.
 *
 * `X-Emby-Token` marchait encore parfaitement le jour de cette migration — le serveur en place le
 * lisait toujours. Un appel réintroduit par distraction n'aurait donc rien cassé, rien signalé, et
 * serait passé inaperçu jusqu'à la mise à jour du serveur, où il serait devenu un 401 sans
 * explication au milieu de douze appels qui marchent.
 */
describe("plus aucun en-tête d'authentification hérité dans le code", () => {
  const LEGACY = ["X-Emby-Token", "X-MediaBrowser-Token", "X-Emby-Authorization"];
  // Le module d'authentification les nomme dans son commentaire d'en-tête : c'est là qu'on
  // explique pourquoi ils ont disparu, ce serait absurde de le lui interdire.
  const EXEMPTS = new Set(["src/lib/jellyfinAuth.ts"]);

  function sources(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const chemin = join(dir, entry);
      if (statSync(chemin).isDirectory()) {
        if (entry !== "__tests__") sources(chemin, out);
      } else if (/\.(ts|tsx)$/.test(entry)) {
        out.push(chemin);
      }
    }
    return out;
  }

  it("n'envoie aucun des en-têtes retirés par Jellyfin 12", () => {
    const coupables: string[] = [];
    for (const fichier of sources("src")) {
      if (EXEMPTS.has(fichier)) continue;
      const contenu = readFileSync(fichier, "utf-8");
      for (const legacy of LEGACY) {
        if (contenu.includes(legacy)) coupables.push(`${fichier} → ${legacy}`);
      }
    }
    expect(coupables).toEqual([]);
  });
});
