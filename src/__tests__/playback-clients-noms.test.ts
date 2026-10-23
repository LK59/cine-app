import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/lib/config", () => ({ config: { jellyfin: { url: "http://jf", apiKey: "cle" } } }));
vi.mock("@/lib/db", () => ({ sessionDb: { liveJfDevices: () => [] } }));
vi.mock("@/lib/logger", () => ({ logError: vi.fn() }));
vi.mock("@/lib/eventLogs", () => ({ logAuthEvent: vi.fn() }));

import {
  PLAYBACK_CLIENTS,
  LEGACY_PLAYBACK_CLIENTS,
  OWN_APP_NAMES,
  currentPlaybackClient,
  isOwnAppName,
  isPlaybackClient,
} from "@/lib/playbackClients";
import { selectPrunableDevices } from "@/lib/jellyfinDevicePrune";

/**
 * Le renommage CineApp → Laterna (moteur : CineEngine By CineApp → Lumen by Laterna). Les anciens
 * noms restent reconnus pour toujours : un onglet ouvert avant le déploiement continue de les
 * envoyer, et Jellyfin garde des appareils inscrits sous « CineApp ».
 */
describe("les noms sous lesquels l'application se présente à Jellyfin", () => {
  it("annonce Laterna et Lumen by Laterna", () => {
    expect(PLAYBACK_CLIENTS).toEqual({ stable: "Laterna", engine: "Lumen by Laterna" });
  });

  it("reconnaît les deux noms d'aujourd'hui et les deux d'avant, et rien d'autre", () => {
    for (const name of ["Laterna", "Lumen by Laterna", "CineApp", "CineEngine By CineApp"]) expect(isPlaybackClient(name)).toBe(true);
    for (const name of ["Jellyfin Web", "cineapp", "CineEngine", "", null, undefined, 42, "toString", "__proto__"]) {
      expect(isPlaybackClient(name)).toBe(false);
    }
  });

  it("rapporte un ancien nom sous son successeur — la séance reste une seule chez Jellyfin", () => {
    expect(currentPlaybackClient("CineApp")).toBe("Laterna");
    expect(currentPlaybackClient("CineEngine By CineApp")).toBe("Lumen by Laterna");
    expect(currentPlaybackClient("Laterna")).toBe("Laterna");
    expect(currentPlaybackClient("Lumen by Laterna")).toBe("Lumen by Laterna");
    expect(currentPlaybackClient("Kodi")).toBeNull();
    expect(Object.values(LEGACY_PLAYBACK_CLIENTS).every((name) => Object.values(PLAYBACK_CLIENTS).includes(name))).toBe(true);
  });

  it("les appareils inscrits sous l'un ou l'autre nom sont les nôtres", () => {
    expect(OWN_APP_NAMES).toEqual(["Laterna", "CineApp"]);
    expect(isOwnAppName("Laterna")).toBe(true);
    expect(isOwnAppName("CineApp")).toBe(true);
    expect(isOwnAppName("Jellyfin Web")).toBe(false);
    expect(isOwnAppName(undefined)).toBe(false);
  });

  it("le ménage des appareils traite les deux noms, et jamais un autre client", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const old = new Date(now - 31 * 24 * 3600_000).toISOString();
    const devices = [
      { Id: "cine-app-1", AppName: "CineApp", DateLastActivity: old },
      { Id: "cine-app-2", AppName: "Laterna", DateLastActivity: old },
      { Id: "cine-app-3", AppName: "Jellyfin Web", DateLastActivity: old },
    ];
    expect(selectPrunableDevices(devices, now).map((d) => d.Id)).toEqual(["cine-app-1", "cine-app-2"]);
  });

  it("aucun module ne compare ni n'annonce un de ces noms écrit en dur : la liste vit dans playbackClients.ts, la marque dans appBuild.ts", () => {
    const root = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__") continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith(path.join("lib", "playbackClients.ts"))) {
          const text = fs.readFileSync(full, "utf8");
          // Une valeur entre guillemets, pas un commentaire : c'est une comparaison ou une annonce.
          if (/["'`](CineApp|CineEngine By CineApp|Lumen by Laterna)["'`]/.test(text)) offenders.push(path.relative(root, full));
          // « Laterna » seul est aussi la marque affichée : `APP_NAME` (appBuild.ts) l'écrit une fois.
          else if (/["'`]Laterna["'`]/.test(text) && !full.endsWith(path.join("lib", "appBuild.ts"))) offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
