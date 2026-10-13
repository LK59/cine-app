import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Les chiffres qui disent ce qui a retenu la chaîne : le réseau, le calcul ou le décodeur. Écrit
// pour les coupures du S23 de Lucas (28/09/2026), que rien dans le journal ne permettait
// d'attribuer — le Wi-Fi du téléphone, le son ré-encodé qu'Android seul paie, ou son décodeur.

let clock = 0;

beforeEach(() => {
  clock = 1_000;
  vi.resetModules();
  vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function load() {
  return import("@/lib/webcodecs/playbackDiagnosis");
}

describe("playbackDiagnosis", () => {
  it("ne mesure rien hors d'une séance, et ne lève jamais", async () => {
    const d = await load();
    expect(() => d.diagRequest(0, 10, 20, 1000, null)).not.toThrow();
    expect(() => d.diagInterval("read", 0)).not.toThrow();
    expect(d.diagStallFacts(0)).toEqual({});
    expect(d.diagSessionFacts()).toEqual({});
  });

  it("sépare le débit reçu du débit du lien quand il est occupé", async () => {
    const d = await load();
    d.diagBegin("s1");
    // 30 s de fenêtre, un lien occupé 10 s en tout (deux requêtes qui se chevauchent n'en comptent
    // qu'une fois), 25 Mo reçus.
    clock = 31_000;
    d.diagRequest(5_000, 5_100, 12_000, 15_000_000, 20);
    d.diagRequest(10_000, 10_050, 15_000, 10_000_000, null);
    const facts = d.diagStallFacts(0.2);
    expect(facts.winMs).toBe(30_000);
    expect(facts.req).toBe(2);
    expect(facts.linkBusyPct).toBe(33);
    expect(facts.recvMbps).toBeCloseTo(6.7, 1);
    expect(facts.linkMbps).toBe(20);
    expect(facts.fbMaxMs).toBe(100);
    expect(facts.slowestMs).toBe(7_000);
    d.diagEnd("s1");
  });

  it("dit « réseau » quand la chaîne a surtout attendu ses octets", async () => {
    const d = await load();
    d.diagBegin("s1");
    clock = 21_000;
    d.diagInterval("read", 3_000);
    clock = 31_000;
    expect(d.diagStallFacts(0.1).verdict).toBe("réseau");
    d.diagEnd("s1");
  });

  it("dit « calcul » quand la construction hors attente, les envois et les tâches longues l'emportent", async () => {
    const d = await load();
    d.diagBegin("s1");
    // Un segment de 18 s dont 2 s d'attente d'octets, et 1 s d'envoi : 17 s de calcul sur 30.
    clock = 20_000;
    d.diagInterval("read", 18_000);
    clock = 21_000;
    d.diagInterval("segment", 3_000);
    clock = 22_000;
    d.diagInterval("append", 21_000);
    clock = 31_000;
    const facts = d.diagStallFacts(0.1);
    expect(facts.verdict).toBe("calcul");
    expect(facts.buildMs).toBe(18_000);
    expect(facts.readWaitMs).toBe(2_000);
    d.diagEnd("s1");
  });

  it("dit « décodeur » quand le média était sous la tête, quoi que fasse le réseau", async () => {
    const d = await load();
    d.diagBegin("s1");
    clock = 21_000;
    d.diagInterval("read", 3_000);
    clock = 31_000;
    expect(d.diagStallFacts(2.6).verdict).toBe("décodeur");
    d.diagEnd("s1");
  });

  it("classe chaque attente d'après ce qui la précédait, et ignore les brèves et les sauts", async () => {
    const d = await load();
    d.diagBegin("s1");
    // Attente 1 : précédée de 8 s d'attente d'octets → réseau.
    clock = 10_000;
    d.diagInterval("read", 2_000);
    d.diagWaitStarted(0.1);
    clock = 12_000;
    d.diagWaitEnded();
    // Attente 2 : média présent → décodeur.
    clock = 40_000;
    d.diagWaitStarted(2.5);
    clock = 41_000;
    d.diagWaitEnded();
    // Trop brève, puis interrompue par un saut : ni l'une ni l'autre.
    clock = 50_000;
    d.diagWaitStarted(0);
    clock = 50_100;
    d.diagWaitEnded();
    clock = 60_000;
    d.diagWaitStarted(0);
    clock = 65_000;
    d.diagWaitEnded(false);
    const facts = d.diagSessionFacts();
    expect(facts.waitsNet).toBe(1);
    expect(facts.waitsNetMs).toBe(2_000);
    expect(facts.waitsDecoder).toBe(1);
    expect(facts.waitsCpu).toBeUndefined();
    expect(facts.waitsOther).toBeUndefined();
    d.diagEnd("s1");
  });

  it("donne le débit que le fichier demande, à côté de celui reçu", async () => {
    const d = await load();
    d.diagBegin("s1");
    d.diagMedia(10_590_000_000, 3_080, null);
    clock = 11_000;
    d.diagRequest(2_000, 2_050, 3_000, 1_048_576, null);
    const facts = d.diagSessionFacts();
    expect(facts.needMbps).toBe(27.5);
    expect(facts.req).toBe(1);
    expect(facts.fbMedMs).toBe(50);
    d.diagEnd("s1");
  });

  it("une séance en remplace une autre, et la fin d'une ancienne n'éteint pas la nouvelle", async () => {
    const d = await load();
    d.diagBegin("ancienne");
    d.diagRequest(1_000, 1_010, 1_500, 1_000, null);
    d.diagBegin("nouvelle");
    d.diagEnd("ancienne");
    clock = 5_000;
    d.diagRequest(4_000, 4_010, 4_500, 2_000, null);
    expect(d.diagSessionFacts().req).toBe(1);
    // Le même identifiant une seconde fois ne remet rien à zéro.
    d.diagBegin("nouvelle");
    expect(d.diagSessionFacts().req).toBe(1);
    d.diagEnd("nouvelle");
    expect(d.diagSessionFacts()).toEqual({});
  });

  it("dit le type de réseau quand le navigateur le dit, et compte ses changements", async () => {
    const listeners: (() => void)[] = [];
    const connection = {
      type: "wifi",
      effectiveType: "4g",
      downlink: 10,
      rtt: 50,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: () => {},
    };
    vi.stubGlobal("navigator", { ...navigator, connection });
    try {
      const d = await load();
      d.diagBegin("s1");
      connection.type = "cellular";
      connection.downlink = 1.2;
      listeners.forEach((fn) => fn());
      const facts = d.diagSessionFacts();
      expect(facts.conn).toBe("cellular");
      expect(facts.connSeen).toBe("wifi,cellular");
      expect(facts.connChanges).toBe(1);
      expect(facts.downlinkMinMbps).toBe(1.2);
      expect(facts.rttMs).toBe(50);
      d.diagEnd("s1");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("porte dans le bilan de `stop` ce que disaient `reserve/point` et `arrêt`, cumulé sur les passages de la séance", async () => {
    // 13/10/2026 : les lignes `point` (34/h) et `arrêt` sont retirées ; leur bilan vit ici.
    const d = await load();
    d.diagBegin("s1");
    const run = (id: number, over: Record<string, number | string>) => ({
      id, bursts: 0, emptied: 0, emptiedMB: 0, maxAheadMB: 0, maxAheadS: 0, activeMs: 0, fetchedBytes: 0, fetchBusyMs: 0, idle: "", ...over,
    });
    const snap = (netChunks: number, r: ReturnType<typeof run>) => ({ netChunks, aheadChunks: 10, allowedChunks: 143, reserveMB: 5, deviceMB: 1, networkMB: 50, run: r });
    // Premier pipeline : deux rafales, vidée une fois (30 Mo), 2 min de marche.
    d.diagReserve(snap(40, run(1, { bursts: 2, emptied: 1, emptiedMB: 30, maxAheadMB: 120, maxAheadS: 200, activeMs: 120_000, fetchedBytes: 40e6, fetchBusyMs: 8_000 })));
    // Une reconstruction : un second passage repart de zéro.
    d.diagReserve(snap(10, run(2, { bursts: 1, maxAheadMB: 60, maxAheadS: 250, activeMs: 60_000, fetchedBytes: 10e6, fetchBusyMs: 2_000, idle: "au repos — la radio dort" })));
    const facts = d.diagSessionFacts();
    expect(facts).toMatchObject({
      reserveNetMB: 50,
      reserveBursts: 3,
      reserveEmptied: 1,
      reserveEmptiedMB: 30,
      reserveMaxAheadMB: 120,
      reserveMaxAheadS: 250,
      reserveS: 180,
      reserveFetchMbps: 40,
      reserveRuns: 2,
      reserveIdle: "au repos — la radio dort",
      reserveAheadMB: 10,
      reserveAllowedMB: 143,
    });
    // Une ligne `stall` garde l'instant seulement, comme avant.
    const stall = d.diagStallFacts(1);
    expect(stall.reserveAheadMB).toBe(10);
    expect(stall.reserveBursts).toBeUndefined();
    d.diagEnd("s1");
  });

  it("la copie de secours lit ses centiles sur un échantillon ; le vrai bilan les trie en entier", async () => {
    // 13/10/2026 : `saveUnsentStop` triait jusqu'à 2 000 premiers octets toutes les 30 s (~1,5 ms).
    const d = await load();
    d.diagBegin("s1");
    for (let i = 0; i < 1_500; i++) d.diagRequest(i * 10, i * 10 + (i % 100), i * 10 + 200, 1_000, null);
    const exact = d.diagSessionFacts();
    const approx = d.diagSessionFacts({ exact: false });
    expect(exact.fbMedMs).toBe(50);
    expect(exact.fbP90Ms).toBe(90);
    // Un échantillon régulier de 200 valeurs : à une ou deux unités près, et les mêmes clés.
    expect(Math.abs(Number(approx.fbMedMs) - 50)).toBeLessThanOrEqual(2);
    expect(Math.abs(Number(approx.fbP90Ms) - 90)).toBeLessThanOrEqual(2);
    expect(Object.keys(approx).sort()).toEqual(Object.keys(exact).sort());
    d.diagEnd("s1");
  });
});
