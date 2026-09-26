import { describe, it, expect, vi } from "vitest";
import { isAllowedPushEndpoint } from "@/lib/pushEndpoint";

// Une base à ce fichier seul.
vi.hoisted(() => {
  const { mkdtempSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  process.env.DATA_DIR = mkdtempSync(`${tmpdir()}/cine-push-`);
});

// `POST /api/push/subscribe` enregistrait n'importe quelle URL, vers laquelle le serveur fait
// ensuite un POST — et `/api/push/test` en renvoyait la réponse (26/09/2026).
describe("isAllowedPushEndpoint", () => {
  it("accepte les adresses que rendent les navigateurs", () => {
    for (const endpoint of [
      // Safari, et tout navigateur sous iOS — les trois abonnements en base le 26/09/2026.
      "https://web.push.apple.com/QGuKNeuxsBRqZyDJpdDhk3XWIHc1U6rgyHvZkrc4Z0gbdkNQbHG5GemSMOfyCz4gHd8HM82Pmw",
      "https://api.push.apple.com/3/device/abc",
      // Chrome, Edge sous Android, Opera, Brave, Samsung Internet.
      "https://fcm.googleapis.com/fcm/send/dGhpcyBpcyBub3Q6YSByZWFsIHRva2Vu",
      "https://fcm.googleapis.com/wp/dGhpcyBpcyBub3Q",
      // Firefox.
      "https://updates.push.services.mozilla.com/wpush/v2/gAAAAABk",
      "https://push.services.mozilla.com/wpush/v1/abc",
      // Edge sous Windows.
      "https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB",
    ]) {
      expect(isAllowedPushEndpoint(endpoint), endpoint).toBe(true);
    }
  });

  it("refuse tout le reste", () => {
    for (const endpoint of [
      "http://radarr:7878/api/v3/system/status",
      "http://127.0.0.1:8096/System/Info",
      "https://169.254.169.254/latest/meta-data/",
      "http://fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com:444/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilnotify.windows.com/x",
      "https://evil.example/web.push.apple.com",
      "https://user:pw@web.push.apple.com/x",
      "pas une url",
      "",
      42,
      null,
    ]) {
      expect(isAllowedPushEndpoint(endpoint), String(endpoint)).toBe(false);
    }
  });
});

describe("pushDb — abonnements d'un compte", () => {
  it("ne garde que les dix plus récents, celui qu'on enregistre toujours compris", async () => {
    const { pushDb } = await import("@/lib/db");
    const now = vi.spyOn(Date, "now");
    // Un appareil fidèle, enregistré il y a longtemps, puis douze autres.
    now.mockReturnValue(1_000);
    pushDb.upsert("lucas", "https://web.push.apple.com/fidele", "p", "a");
    for (let i = 0; i < 12; i++) {
      now.mockReturnValue(2_000 + i);
      pushDb.upsert("lucas", `https://web.push.apple.com/n${i}`, "p", "a");
    }
    now.mockRestore();
    // Le panneau Compte le renvoie : il reste, et les plus anciens des autres partent.
    pushDb.upsert("lucas", "https://web.push.apple.com/fidele", "p", "a");
    pushDb.trimForUser("lucas", 10, "https://web.push.apple.com/fidele");
    const kept = pushDb.getByUser("lucas").map((s) => s.endpoint);
    expect(kept).toHaveLength(10);
    expect(kept).toContain("https://web.push.apple.com/fidele");
    expect(kept).toContain("https://web.push.apple.com/n11");
    expect(kept).not.toContain("https://web.push.apple.com/n2");
  });

  it("ne touche pas aux abonnements des autres comptes", async () => {
    const { pushDb } = await import("@/lib/db");
    pushDb.upsert("sarah", "https://web.push.apple.com/sarah", "p", "a");
    pushDb.trimForUser("lucas", 1, "https://web.push.apple.com/fidele");
    pushDb.removeForUser("lucas", "https://web.push.apple.com/sarah");
    expect(pushDb.getByUser("sarah").map((s) => s.endpoint)).toEqual(["https://web.push.apple.com/sarah"]);
    expect(pushDb.getByUser("lucas").map((s) => s.endpoint)).toEqual(["https://web.push.apple.com/fidele"]);
  });
});
