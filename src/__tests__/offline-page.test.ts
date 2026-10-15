// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * La page « Pas de connexion » (`public/offline.html`) — 15/10/2026, passe de nuit, ROBUSTESSE-4/5 :
 * elle ne revenait pas seule au retour du réseau, n'était qu'en français, et pas aux couleurs de
 * l'application.
 */
const html = readFileSync(join(process.cwd(), "public/offline.html"), "utf8");
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
const body = /<body>([\s\S]*?)<script>/.exec(html)![1];

function boot(fetchImpl: () => Promise<{ ok: boolean }>) {
  document.body.innerHTML = body;
  const location = { reload: vi.fn() };
  const fetch = vi.fn(fetchImpl);
  new Function("location", "fetch", script)(location, fetch);
  return { location, fetch };
}

afterEach(() => {
  document.cookie = "cine-lang=;max-age=0";
  vi.useRealTimers();
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("offline.html", () => {
  it("parle la langue de l'app", () => {
    document.cookie = "cine-lang=de";
    boot(async () => ({ ok: false }));
    expect(document.getElementById("title")!.textContent).toBe("Keine Verbindung");
    expect(document.documentElement.lang).toBe("de");
  });

  it("se recharge au retour du réseau, seulement si le serveur répond vraiment", async () => {
    const down = boot(async () => ({ ok: false }));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(down.fetch).toHaveBeenCalledWith("/api/ping", { cache: "no-store" });
    expect(down.location.reload).not.toHaveBeenCalled();

    const up = boot(async () => ({ ok: true }));
    window.dispatchEvent(new Event("online"));
    await flush();
    expect(up.location.reload).toHaveBeenCalledTimes(1);
  });

  it("noir et blanc, et rien à charger d'ailleurs (servie sans session, ACTIFS_PUBLICS)", () => {
    expect(html).toContain("background: #000");
    expect(html).not.toMatch(/<(link|img|script)\s[^>]*(href|src)=/i);
  });
});
