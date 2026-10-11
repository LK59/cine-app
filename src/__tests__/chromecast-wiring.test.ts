import { describe, it, expect } from "vitest";
import { castCarriedTo, castingNow, chromecastNow, type StableTakeover } from "@/lib/useStableFallback";
import { castEstablishedFields, serverStartFields, type ServerPlayerContext } from "@/lib/serverPlayerLog";
import { buildSeances } from "@/lib/activity/seances";

// DECISIONS.md §64 — ce qui relie le Chromecast au reste : l'aiguillage des lecteurs, le journal, la
// page Activité. Pour chacun, AirPlay ne change pas.

describe("chromecastNow — l'aiguillage vers la télécommande", () => {
  const session = { itemId: "a", openId: 3 };

  it("un relais de diffusion marqué Chromecast, pour cette séance", () => {
    const takeover: StableTakeover = { resumeAt: 10, cast: true, castTarget: "chromecast", owner: session };
    expect(chromecastNow(takeover, null, session)).toBe(true);
  });

  it("AirPlay (diffusion sans cible) : le lecteur serveur, comme avant", () => {
    const takeover: StableTakeover = { resumeAt: 10, cast: true, owner: session };
    expect(chromecastNow(takeover, null, session)).toBe(false);
    expect(castingNow(takeover, session)).toBe(true);
  });

  it("un relais d'une autre séance, ou un repli d'échec, n'emmène rien vers le Chromecast", () => {
    expect(chromecastNow({ resumeAt: 0, cast: true, castTarget: "chromecast", owner: { itemId: "a", openId: 2 } }, null, session)).toBe(false);
    expect(chromecastNow({ resumeAt: 0, castTarget: "chromecast", owner: session }, null, session)).toBe(false);
    expect(chromecastNow(null, null, session)).toBe(false);
  });

  it("l'épisode suivant garde la cible : la diffusion continue sur le Chromecast", () => {
    const first = { itemId: "a", openId: 3 };
    const next = { itemId: "b", openId: 3, resumeAt: 0 };
    const carried = castCarriedTo({ resumeAt: 3000, cast: true, castTarget: "chromecast", owner: first }, next);
    expect(carried).toMatchObject({ castTarget: "chromecast", resumeAt: 0, owner: next });
    expect(chromecastNow(null, carried, next)).toBe(true);
  });
});

describe("le journal : `target` sur les lignes du Chromecast, et seulement sur elles", () => {
  const airplay: ServerPlayerContext = { itemId: "a", title: "T", cast: true, session: "s" };

  it("AirPlay : aucune clé `target` — les lignes restent ce qu'elles étaient", () => {
    expect(castEstablishedFields(airplay, 12)).not.toHaveProperty("target");
    expect(serverStartFields(airplay, { directPlay: false, nativeHls: true, resumeAt: 0, audioStreamIndex: undefined })).not.toHaveProperty("target");
  });

  it("Chromecast : `target: \"chromecast\"`", () => {
    expect(castEstablishedFields({ ...airplay, target: "chromecast" }, 12)).toMatchObject({ target: "chromecast", cast: true });
  });
});

describe("la page Activité", () => {
  const base = { user: "louis", itemId: "film", title: "Le Film", agent: "Mozilla/5.0 Chrome/152" };
  const at = (s: number) => 1_000_000 + s * 1000;

  it("nomme le Chromecast d'une séance diffusée vers lui ; une séance AirPlay reste « sur un téléviseur »", () => {
    const [cc] = buildSeances([
      { ...base, _t: at(0), kind: "start", session: "s1", player: "natif" },
      { ...base, _t: at(10), kind: "fallback", session: "s1", cast: true, reason: "diffusion demandée" },
      { ...base, _t: at(12), kind: "cast", session: "s1", player: "serveur", cast: true, target: "chromecast" },
    ] as never);
    expect(cc).toMatchObject({ onTv: true, castTarget: "chromecast", casts: 1, fallbacks: 0 });
    const [air] = buildSeances([
      { ...base, _t: at(0), kind: "start", session: "s2", player: "natif" },
      { ...base, _t: at(12), kind: "cast", session: "s2", player: "serveur", cast: true },
    ] as never);
    expect(air).toMatchObject({ onTv: true, castTarget: null });
  });

  it("le relais du serveur se rattache à la dernière séance du compte et du titre, sans en ouvrir une", () => {
    const seances = buildSeances([
      { ...base, _t: at(0), kind: "start", session: "old", player: "natif" },
      { ...base, _t: at(100), kind: "start", session: "s1", player: "natif" },
      { ...base, _t: at(110), kind: "cast", session: "s1", player: "serveur", cast: true },
      { _t: at(900), kind: "cast", user: "louis", itemId: "film", player: "serveur", cast: true, serverRelay: true, reason: "relais du serveur — position déduite des segments" },
      { _t: at(5000), kind: "cast", user: "louis", itemId: "film", player: "serveur", cast: true, serverRelay: true, reason: "relais du serveur — arrêt" },
    ] as never);
    expect(seances).toHaveLength(2);
    const s1 = seances.find((s) => s.id === "s1")!;
    expect(s1.serverRelay).toBe(true);
    expect(s1.end).toBe(at(5000));
    expect(seances.find((s) => s.id === "old")!.serverRelay).toBe(false);
  });

  it("un relais sans séance à qui le rattacher est laissé de côté", () => {
    expect(buildSeances([{ _t: at(1), kind: "cast", user: "x", itemId: "y", serverRelay: true }] as never)).toEqual([]);
  });
});
