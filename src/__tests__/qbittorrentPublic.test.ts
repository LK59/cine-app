import { describe, it, expect } from "vitest";
import { trackerOrigin, publicTorrent } from "@/lib/qbittorrentPublic";
import type { QbTorrent } from "@/lib/clients/qbittorrent";

// `/api/qbittorrent/torrents` renvoyait la réponse brute de qBittorrent à tout compte connecté :
// passkeys des trackers privés dans `tracker` et `magnet_uri` (26/09/2026).

// Le nom d'hôte tel que la page le tire du champ (`trackerHost`, qbittorrent/page.tsx) : il doit
// rester le même avant et après réduction, sans quoi le filtre « tracker » change.
const pageHost = (tracker: string) => {
  try {
    return new URL(tracker).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

describe("trackerOrigin", () => {
  it("retire le chemin, et avec lui la passkey", () => {
    expect(trackerOrigin("https://tracker.example/0123456789abcdef/announce")).toBe("https://tracker.example/");
    expect(trackerOrigin("https://tracker.example:8443/announce.php?passkey=secret")).toBe("https://tracker.example:8443/");
    expect(trackerOrigin("https://user:secret@tracker.example/announce")).toBe("https://tracker.example/");
  });

  it("garde les trackers UDP, que la page filtre aussi", () => {
    expect(trackerOrigin("udp://tracker.opentrackr.org:1337/announce")).toBe("udp://tracker.opentrackr.org:1337/");
  });

  it("donne une chaîne vide pour ce qui n'est pas une URL", () => {
    expect(trackerOrigin("")).toBe("");
    expect(trackerOrigin("pas une url")).toBe("");
    expect(trackerOrigin(undefined)).toBe("");
  });

  it("ne change pas ce que le filtre de la page affiche", () => {
    for (const tr of [
      "https://www.tracker.example/abc/announce",
      "udp://tracker.opentrackr.org:1337/announce",
      "http://t.example:8080/x",
      "",
    ]) {
      expect(pageHost(trackerOrigin(tr))).toBe(pageHost(tr));
    }
  });
});

describe("publicTorrent", () => {
  it("ne garde que les champs de QbTorrent", () => {
    const raw = {
      hash: "h", name: "n", state: "uploading", progress: 1, dlspeed: 0, upspeed: 0, size: 1, eta: 0,
      category: "radarr", tracker: "https://t.example/pk/announce", ratio: 1, added_on: 1, uploaded: 1,
      downloaded: 1, content_path: "/data/n", num_seeds: 1, num_leechs: 0,
      magnet_uri: "magnet:?xt=urn:btih:h&tr=https%3A%2F%2Ft.example%2Fpk%2Fannounce",
      save_path: "/data", comment: "https://t.example/details?pk",
    } as unknown as QbTorrent;
    const out = publicTorrent(raw);
    expect(Object.keys(out).sort()).toEqual(
      ["hash", "name", "state", "progress", "dlspeed", "upspeed", "size", "eta", "category", "tracker",
        "ratio", "added_on", "uploaded", "downloaded", "content_path", "num_seeds", "num_leechs"].sort()
    );
    expect(out.tracker).toBe("https://t.example/");
    expect(JSON.stringify(out)).not.toContain("pk");
  });
});
