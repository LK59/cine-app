import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { deviceLabel, readTouchHint, requestDeviceLabel, jellyfinDeviceName, TOUCH_HINT_HEADER } from "@/lib/deviceLabel";
import { jellyfinIdentityAuth } from "@/lib/jellyfinAuth";

/**
 * Le nom et l'identité sous lesquels l'application se présente à Jellyfin (29/09/2026).
 *
 * La connexion s'annonçait « Server », la lecture « Navigateur », sous deux identifiants
 * différents : chaque appareil réel apparaissait deux fois dans le tableau de bord de Jellyfin, et
 * aucun ne disait lequel c'était. Un iPad, qui se déclare « Macintosh », s'y nommait « Mac ».
 */

const IPAD_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const MAC_UA = IPAD_UA; // c'est tout le problème : les deux signatures sont identiques
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

describe("deviceLabel et l'indice tactile", () => {
  it("nomme iPad une signature Macintosh quand le navigateur dit avoir un écran tactile", () => {
    expect(deviceLabel(IPAD_UA, { touch: true })).toBe("iPad · Safari");
  });

  it("garde Mac sans indice, ou avec un indice négatif", () => {
    expect(deviceLabel(MAC_UA)).toBe("Mac · Safari");
    expect(deviceLabel(MAC_UA, { touch: false })).toBe("Mac · Safari");
  });

  it("ne touche qu'au Mac : un iPhone ou un Android tactile restent ce qu'ils sont", () => {
    expect(deviceLabel(IPHONE_UA, { touch: true })).toBe("iPhone · Safari");
    expect(deviceLabel(ANDROID_UA, { touch: true })).toBe("Android · Chrome");
  });

  it("rend null sans signature reconnaissable, et Jellyfin reçoit alors « Navigateur »", () => {
    expect(deviceLabel("curl/8.0", { touch: true })).toBeNull();
    expect(jellyfinDeviceName(null)).toBe("Navigateur");
    expect(jellyfinDeviceName("iPad · Safari")).toBe("iPad · Safari");
  });

  it("n'accepte de l'indice que « 1 » ou « 0 », jamais du texte libre", () => {
    expect(readTouchHint("1")).toBe(true);
    expect(readTouchHint("0")).toBe(false);
    for (const v of ["true", "oui", "iPad", " 1", "1,", "", null, undefined]) expect(readTouchHint(v)).toBeUndefined();
  });

  it("lit l'indice dans l'en-tête de la requête", () => {
    const req = (touch?: string) => ({ headers: new Headers({ "user-agent": IPAD_UA, ...(touch ? { [TOUCH_HINT_HEADER]: touch } : {}) }) });
    expect(requestDeviceLabel(req("1"))).toBe("iPad · Safari");
    expect(requestDeviceLabel(req("0"))).toBe("Mac · Safari");
    expect(requestDeviceLabel(req("iPad"))).toBe("Mac · Safari");
    expect(requestDeviceLabel(req())).toBe("Mac · Safari");
  });
});

describe("le champ Device de l'en-tête MediaBrowser", () => {
  const identity = (device: string) => ({ client: "CineApp", device, deviceId: "cine-app-x", version: "8.1.0" });

  // Envoyé en clair, le « · » faisait répondre 400 au serveur (mesuré en production le 29/09/2026).
  it("encode le libellé, « · » compris, pour que le serveur le rende tel quel après UrlDecode", () => {
    const header = jellyfinIdentityAuth(identity("iPad · Safari"));
    expect(header).toContain('Device="iPad%20%C2%B7%20Safari"');
    expect(decodeURIComponent("iPad%20%C2%B7%20Safari")).toBe("iPad · Safari");
    // Rien hors ASCII dans l'en-tête : Node l'enverrait en Latin-1.
    expect(/^[\x20-\x7e]*$/.test(header)).toBe(true);
  });

  it("n'y laisse ni virgule ni guillemet, qui couperaient la valeur au découpage du serveur", () => {
    const header = jellyfinIdentityAuth(identity('a,b"c+d'));
    const device = /Device="([^"]*)"/.exec(header)?.[1];
    expect(device).toBe("a%2Cb%22c%2Bd");
  });

  it("laisse les noms de client exactement tels quels", () => {
    expect(jellyfinIdentityAuth({ ...identity("x"), client: "CineEngine By CineApp" })).toContain('Client="CineEngine By CineApp"');
  });
});

describe("l'en-tête des rapports de lecture", () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
      statusText: "No Content",
      headers: { get: () => null },
      json: async () => undefined,
      text: async () => "",
    } as unknown as Response);
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function sentAuth(): string {
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    return (init.headers as Record<string, string>).Authorization;
  }

  // Un appareil réel, une seule identité chez Jellyfin : le rapport reprend l'appareil de la
  // connexion. Sans risque d'éviction — voir playbackDevice.ts pour la preuve dans le source.
  it("s'annonce sous l'appareil de la connexion et son vrai nom", async () => {
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    await jellyfin.reportPlaybackProgress("u1", "item", "jeton", "ps", "ms", 1, "DirectPlay", "CineEngine By CineApp", false, {
      name: "iPad · Safari",
      id: "cine-app-1234",
    });
    const auth = sentAuth();
    expect(auth).toContain('DeviceId="cine-app-1234"');
    expect(auth).toContain('Device="iPad%20%C2%B7%20Safari"');
    expect(auth).toContain('Client="CineEngine By CineApp"');
    expect(auth).not.toContain('Device="Navigateur"');
    expect(auth).not.toContain("Server");
  });

  it("les deux lecteurs gardent le même appareil : Jellyfin les distingue par leur nom de client", async () => {
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    const device = { name: "Mac · Chrome", id: "cine-app-1234" };
    await jellyfin.reportPlaybackStart("u1", "item", "jeton", "ps", "ms", "Transcode", "CineApp", device);
    await jellyfin.reportPlaybackStopped("u1", "item", "jeton", "ps", "ms", 0, "CineEngine By CineApp", device);
    const auths = vi.mocked(global.fetch).mock.calls.map((c) => ((c[1] as RequestInit).headers as Record<string, string>).Authorization);
    expect(auths.every((a) => a.includes('DeviceId="cine-app-1234"'))).toBe(true);
    expect(auths[0]).toContain('Client="CineApp"');
    expect(auths[1]).toContain('Client="CineEngine By CineApp"');
  });

  it("sans appareil connu (session ancienne), garde l'identifiant par compte d'avant", async () => {
    const { jellyfin } = await import("@/lib/clients/jellyfin");
    await jellyfin.reportPlaybackStopped("u1", "item", "jeton", "ps", "ms", 0, "CineEngine By CineApp", { name: "Navigateur", id: null });
    expect(sentAuth()).toContain('DeviceId="cine-engine-u1"');
  });
});

describe("playbackDevice", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/db");
    vi.resetModules();
  });

  async function load(jfDevice: () => string | null) {
    vi.resetModules();
    vi.doMock("@/lib/db", () => ({ sessionDb: { jfDevice } }));
    return (await import("@/lib/playbackDevice")).playbackDevice;
  }
  const req = { headers: new Headers({ "user-agent": IPAD_UA, [TOUCH_HINT_HEADER]: "1" }) };

  it("reprend l'appareil gardé avec la session et le libellé de la requête", async () => {
    const playbackDevice = await load(() => "cine-app-abcd");
    expect(playbackDevice(req, "jti-1")).toEqual({ name: "iPad · Safari", id: "cine-app-abcd" });
  });

  it("n'en invente pas : pas de session, pas d'appareil gardé, ou une base qui lève → null", async () => {
    expect((await load(() => "cine-app-abcd"))(req, undefined).id).toBeNull();
    expect((await load(() => null))(req, "jti-1").id).toBeNull();
    expect(
      (
        await load(() => {
          throw new Error("base verrouillée");
        })
      )(req, "jti-1").id
    ).toBeNull();
  });

  it("n'accepte qu'un appareil inscrit par l'application", async () => {
    expect((await load(() => "TW96aWxsYS"))(req, "jti-1").id).toBeNull();
  });
});
