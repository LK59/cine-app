import { describe, it, expect, vi, afterEach } from "vitest";
import { isWebKitEngine, playsHlsNatively } from "@/lib/webkitEngine";

/** De vrais agents, relevés dans les journaux du lecteur ou sur les appareils de la maison. */
const AGENTS: [string, boolean, string][] = [
  [
    "l'iPhone de la maison",
    true,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1",
  ],
  [
    "Chrome sur iOS — WebKit lui aussi, la plateforme n'en propose pas d'autre",
    true,
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.108 Mobile/15E148 Safari/604.1",
  ],
  [
    "Safari de bureau",
    true,
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
  ],
  [
    "le Chrome Android qui rechargeait la page — le cas qui a tout révélé",
    false,
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Mobile Safari/537.36",
  ],
  [
    "Chrome de bureau",
    false,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
  ],
  [
    "Opera sous Windows, envoyé sur le HLS intégré de Chromium le 25/09/2026",
    false,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 OPR/135.0.0.0",
  ],
  [
    "Firefox sous Linux",
    false,
    "Mozilla/5.0 (X11; Linux x86_64; rv:154.0) Gecko/20100101 Firefox/154.0",
  ],
  [
    "Edge, Chromium sous un autre nom",
    false,
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
  ],
  [
    "Firefox sur Android",
    false,
    "Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0",
  ],
];

describe("isWebKitEngine", () => {
  it.each(AGENTS)("%s → %s", (_name, expected, ua) => {
    expect(isWebKitEngine(ua)).toBe(expected);
  });

  /**
   * Le mot « Safari » et le mot « AppleWebKit » sont dans presque tous les agents du monde, pour
   * la compatibilité, et ne disent plus rien du moteur depuis quinze ans. C'est exactement ce qui
   * faisait prendre Chrome Android pour WebKit.
   */
  it("ne se laisse pas prendre par les mots hérités des agents Chromium", () => {
    const chromeAndroid = AGENTS.find(([, expected]) => !expected)![2];
    expect(chromeAndroid).toContain("AppleWebKit");
    expect(chromeAndroid).toContain("Safari");
    expect(isWebKitEngine(chromeAndroid)).toBe(false);
  });
});

describe("playsHlsNatively", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Un élément qui répond oui au HLS, comme Chromium 151 le fait désormais sur ordinateur. */
  const saysYesToHls = { canPlayType: (t: string) => (t === "application/vnd.apple.mpegurl" ? "maybe" : "") } as unknown as HTMLVideoElement;
  const agent = (name: string) => AGENTS.find(([n]) => n.startsWith(name))![2];

  /**
   * Opera 135 (Chromium 151) répondait oui : le lecteur serveur lui donnait la playlist en direct,
   * le HLS intégré de Chromium la refusait quatre fois, et le film ne démarrait jamais — alors que
   * la sonde des codecs avait décrit MediaSource, c'est-à-dire hls.js.
   */
  it.each(["Opera sous Windows", "Chrome de bureau", "le Chrome Android", "Edge"])("%s : hls.js, même s'il dit lire le HLS", (name) => {
    vi.stubGlobal("navigator", { userAgent: agent(name) });
    expect(playsHlsNatively(saysYesToHls)).toBe(false);
  });

  it.each(["l'iPhone de la maison", "Safari de bureau"])("%s : le pipeline du navigateur", (name) => {
    vi.stubGlobal("navigator", { userAgent: agent(name) });
    expect(playsHlsNatively(saysYesToHls)).toBe(true);
  });
});
