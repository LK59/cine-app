import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  LinkMeter,
  MIN_MEASURED_MS,
  MIN_RECEIVED_BYTES,
  SLOW_LINK_REASON,
  armOpeningMeter,
  capForSlowLink,
  disarmOpeningMeter,
  fileNeedBps,
  forgetSlowLinks,
  frozenReading,
  linkVerdictWord,
  readLink,
  meterOpeningRequest,
  meterXhr,
  noteSlowLink,
  readCounted,
  serverCanCarry,
  slowLinkFields,
  slowLinkFigures,
  slowLinkVerdict,
  streamNeedBps,
} from "@/lib/slowLink";

// « Connexion trop lente » (DECISIONS.md §77) : une cause nommée seulement quand les mesures la
// prouvent. Le cas réel : un PC recevant ~40 Ko/s pour un épisode qui en demande ~3,9 Mbit/s.

const NEED = 3_900_000;

/** Un compteur à horloge manuelle. */
function meterAt() {
  let now = 0;
  const meter = new LinkMeter(() => now);
  return { meter, advance: (ms: number) => (now += ms) };
}

describe("le verdict", () => {
  it("valide la lenteur du cas réel : ≈0,3 Mbit/s sur 30 s pour 3,9 demandés", () => {
    const slow = slowLinkVerdict({ bytes: 40_000 * 30, receivingMs: 30_000 }, NEED);
    expect(slow).not.toBeNull();
    expect(slowLinkFields(slow!)).toEqual({ recvMbps: 0.32, needMbps: 3.9, measuredS: 30, bytes: 1_200_000 });
    expect(serverCanCarry(slow!)).toBe(false);
  });

  it("une connexion normale ne dit rien", () => {
    expect(slowLinkVerdict({ bytes: 20_000_000, receivingMs: 20_000 }, NEED)).toBeNull();
    // Juste au-dessus de la moitié du besoin : pas « nettement sous ».
    expect(slowLinkVerdict({ bytes: (0.51 * NEED * 20) / 8, receivingMs: 20_000 }, NEED)).toBeNull();
  });

  it("trop peu de temps mesuré : rien de prouvé", () => {
    expect(slowLinkVerdict({ bytes: 400_000, receivingMs: MIN_MEASURED_MS - 1 }, NEED)).toBeNull();
  });

  it("presque rien reçu : une coupure, pas une lenteur — l'écran « connexion perdue » s'en charge", () => {
    expect(slowLinkVerdict({ bytes: MIN_RECEIVED_BYTES - 1, receivingMs: 30_000 }, NEED)).toBeNull();
    expect(slowLinkVerdict({ bytes: 0, receivingMs: 30_000 }, NEED)).toBeNull();
  });

  it("sans besoin connu ni mesure, rien — et jamais d'exception", () => {
    expect(slowLinkVerdict({ bytes: 1_000_000, receivingMs: 30_000 }, null)).toBeNull();
    expect(slowLinkVerdict({ bytes: 1_000_000, receivingMs: 30_000 }, 0)).toBeNull();
    expect(slowLinkVerdict(null, NEED)).toBeNull();
    expect(slowLinkVerdict({ bytes: NaN, receivingMs: 30_000 }, NEED)).toBeNull();
    const hostile = {
      get bytes(): number {
        throw new Error("boum");
      },
      receivingMs: 30_000,
    };
    expect(slowLinkVerdict(hostile, NEED)).toBeNull();
  });

  it("le lecteur serveur peut aider dès que sa version la plus réduite passe", () => {
    const slow = slowLinkVerdict({ bytes: (1_800_000 * 20) / 8, receivingMs: 20_000 }, NEED)!;
    expect(serverCanCarry(slow)).toBe(true);
  });

  it("le motif est stable", () => {
    expect(SLOW_LINK_REASON).toBe("connexion trop lente");
  });
});

describe("le compteur", () => {
  it("compte le temps de réception, pas l'attente du serveur, et une fois chaque instant", () => {
    const { meter, advance } = meterAt();
    const a = meter.open();
    const b = meter.open();
    // Le serveur prépare sa réponse dix secondes : rien ne compte encore.
    advance(10_000);
    a.headers();
    b.headers();
    for (let i = 0; i < 10; i++) {
      advance(1000);
      a.received(20_000);
      b.received(20_000);
    }
    a.end();
    b.end();
    // Deux requêtes en parallèle sur dix secondes : dix secondes de réception, pas vingt.
    expect(meter.measure()).toEqual({ bytes: 400_000, receivingMs: 10_000 });
  });

  it("une requête encore en vol compte jusqu'à maintenant", () => {
    const { meter, advance } = meterAt();
    const a = meter.open();
    a.headers();
    advance(5000);
    a.received(1000);
    advance(5000);
    expect(meter.measure()).toEqual({ bytes: 1000, receivingMs: 10_000 });
  });

  it("rien ne compte après la fin", () => {
    const { meter, advance } = meterAt();
    const a = meter.open();
    a.headers();
    advance(1000);
    a.end();
    a.received(5000);
    expect(meter.measure().bytes).toBe(0);
  });

  it("n'existe qu'armé : hors ouverture, aucune requête n'est suivie", () => {
    expect(meterOpeningRequest()).toBeNull();
    const meter = armOpeningMeter();
    const request = meterOpeningRequest();
    expect(request).not.toBeNull();
    disarmOpeningMeter(meter);
    expect(meterOpeningRequest()).toBeNull();
  });
});

describe("la lecture comptée", () => {
  it("rend exactement les octets d'arrayBuffer, dans un tampon à soi", async () => {
    const bytes = new Uint8Array(3000).map((_, i) => i % 251);
    const meter = new LinkMeter();
    const request = meter.open();
    // Un flux en trois morceaux, dont un vu à l'intérieur d'un tampon plus grand.
    const big = new Uint8Array(5000);
    big.set(bytes.subarray(1000, 2000), 100);
    const parts = [bytes.subarray(0, 1000), big.subarray(100, 1100), bytes.subarray(2000)];
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      })
    );
    const out = await readCounted(res, request);
    expect([...out]).toEqual([...bytes]);
    expect(out.byteOffset).toBe(0);
    expect(out.buffer.byteLength).toBe(3000);
    request.end();
    expect(meter.measure().bytes).toBe(3000);
  });

  it("sans flux lisible, lit d'un bloc", async () => {
    const meter = new LinkMeter();
    const request = meter.open();
    const fake = { body: null, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer } as unknown as Response;
    expect([...(await readCounted(fake, request))]).toEqual([1, 2, 3]);
    expect(meter.measure().bytes).toBe(3);
  });

  it("une erreur du flux remonte telle quelle", async () => {
    const meter = new LinkMeter();
    const failure = new DOMException("délai", "TimeoutError");
    const res = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1]));
          controller.error(failure);
        },
      })
    );
    await expect(readCounted(res, meter.open())).rejects.toBe(failure);
  });
});

describe("hls.js : les requêtes suivies par leurs événements", () => {
  it("en-têtes, progression cumulée et fin", () => {
    let now = 0;
    const meter = new LinkMeter(() => now);
    const xhr = new EventTarget() as EventTarget & { readyState: number };
    xhr.readyState = 0;
    meterXhr(meter, xhr as unknown as XMLHttpRequest);
    xhr.readyState = 2;
    xhr.dispatchEvent(new Event("readystatechange"));
    for (let i = 1; i <= 12; i++) {
      now += 1000;
      xhr.dispatchEvent(Object.assign(new Event("progress"), { loaded: i * 40_000 }));
    }
    xhr.dispatchEvent(Object.assign(new Event("loadend"), { loaded: 12 * 40_000 }));
    expect(meter.measure()).toEqual({ bytes: 480_000, receivingMs: 12_000 });
  });

  it("ne lève jamais, même sur un objet qui n'écoute rien", () => {
    expect(() => meterXhr(new LinkMeter(), {} as XMLHttpRequest)).not.toThrow();
  });
});

describe("les chiffres", () => {
  it("lisibles et arrondis, dans la langue du spectateur", () => {
    const slow = slowLinkVerdict({ bytes: 40_000 * 30, receivingMs: 30_000 }, NEED)!;
    expect(slowLinkFigures(slow, "fr")).toEqual({ recv: "0,3", need: "4" });
    expect(slowLinkFigures(slow, "en")).toEqual({ recv: "0.3", need: "4" });
    // Jamais « 0 » reçu.
    const crawl = slowLinkVerdict({ bytes: MIN_RECEIVED_BYTES, receivingMs: 600_000 }, NEED)!;
    expect(slowLinkFigures(crawl, "fr").recv).toBe("0,1");
    // Un petit besoin garde sa décimale.
    const small = slowLinkVerdict({ bytes: 400_000, receivingMs: 20_000 }, 1_500_000)!;
    expect(slowLinkFigures(small, "fr")).toEqual({ recv: "0,2", need: "1,5" });
  });

  it("le besoin d'un fichier et d'un flux négocié", () => {
    expect(fileNeedBps(1_170_000_000, 2400)).toBe(3_900_000);
    expect(fileNeedBps(null, 2400)).toBeNull();
    expect(fileNeedBps(1000, 0)).toBeNull();
    expect(streamNeedBps({ video: { bitRate: 3_500_000 }, audio: { bitRate: 400_000 } })).toBe(3_900_000);
    expect(streamNeedBps({ video: { bitRate: null }, audio: { bitRate: 400_000 } })).toBeNull();
    expect(streamNeedBps(null)).toBeNull();
  });
});

describe("le débit retenu pour le lecteur serveur", () => {
  beforeEach(() => forgetSlowLinks());

  it("sans mesure, le plafond ordinaire passe tel quel", () => {
    expect(capForSlowLink("film", 100_000_000)).toBe(100_000_000);
  });

  it("après une mesure, ce titre seul est abaissé, jamais sous le plancher, et pour dix minutes", () => {
    const slow = slowLinkVerdict({ bytes: (1_800_000 * 20) / 8, receivingMs: 20_000 }, NEED)!;
    noteSlowLink("film", slow, 0);
    expect(capForSlowLink("film", 100_000_000, 1000)).toBe(1_500_000);
    expect(capForSlowLink("autre", 100_000_000, 1000)).toBe(100_000_000);
    expect(capForSlowLink("film", 100_000_000, 11 * 60_000)).toBe(100_000_000);
    const faster = slowLinkVerdict({ bytes: (2_400_000 * 20) / 8, receivingMs: 20_000 }, 6_000_000)!;
    noteSlowLink("film", faster, 0);
    expect(capForSlowLink("film", 100_000_000, 1000)).toBe(1_800_000);
    // Un plafond déjà plus bas reste le sien.
    expect(capForSlowLink("film", 1_000_000, 1000)).toBe(1_000_000);
  });
});

describe("le panneau technique", () => {
  const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key}:${JSON.stringify(vars)}` : key);
  const remux = {
    path: "remux" as const,
    pathReason: null,
    container: "mkv",
    video: null,
    audioTrackCount: 1,
    subtitleTrackCount: 0,
    currentAudioCodec: "AAC",
    diagnostics: {},
  };
  const rowsOf = (data: { sections: { rows: { label: string; value: string }[] }[] }) =>
    Object.fromEntries(data.sections.flatMap((s) => s.rows.map((r) => [r.label, r.value])));

  it("en direct : débit reçu, besoin, verdict par le même critère", async () => {
    const { describeRemuxPlayback } = await import("@/lib/playbackPanel");
    const ok = rowsOf(describeRemuxPlayback({ ...remux, link: readLink({ bytes: 20_000_000, receivingMs: 20_000 }, NEED) }, t));
    expect(ok["player.info.linkReceived"]).toBe("8.0 Mb/s");
    expect(ok["player.info.linkNeeded"]).toBe("3.9 Mb/s");
    expect(ok["player.info.linkVerdict"]).toBe("player.info.linkOk");
    const slow = rowsOf(describeRemuxPlayback({ ...remux, link: readLink({ bytes: 1_200_000, receivingMs: 30_000 }, NEED) }, t));
    expect(slow["player.info.linkVerdict"]).toBe("player.info.linkSlow");
    // Trop tôt pour juger : le chiffre, sans verdict.
    const early = rowsOf(describeRemuxPlayback({ ...remux, link: readLink({ bytes: 1_000_000, receivingMs: 2_000 }, NEED) }, t));
    expect(early["player.info.linkVerdict"]).toBe("player.info.linkUnknown");
    // Rien de mesuré : aucune ligne.
    expect(rowsOf(describeRemuxPlayback({ ...remux, link: readLink(null, NEED) }, t))["player.info.linkReceived"]).toBeUndefined();
  });

  it("figé au moment de l'échec", async () => {
    const { describeJellyfinPlayback } = await import("@/lib/playbackPanel");
    const slow = slowLinkVerdict({ bytes: 1_200_000, receivingMs: 30_000 }, NEED)!;
    const info = { playMethod: "DirectStream" as const, transcodeReasons: [], container: "ts", video: null, audio: null };
    const rows = rowsOf(describeJellyfinPlayback(info, null, null, t, frozenReading(slow)));
    expect(rows["player.info.linkReceived"]).toBe("0.3 Mb/s");
    expect(rows["player.info.linkVerdict"]).toBe("player.info.linkSlow · player.info.linkFrozen");
    expect(linkVerdictWord(frozenReading(slow))).toBe("trop lente");
  });
});

describe("les lignes `stall` et `stop` (diag.*)", () => {
  it("portent le verdict du lien et le temps de réception, à côté des débits déjà là", async () => {
    const diag = await import("@/lib/webcodecs/playbackDiagnosis");
    let clock = 1_000;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    diag.diagBegin("séance-lien");
    try {
      diag.diagMedia(1_170_000_000, 2400, null);
      clock += 40_000;
      const at = diag.diagNow();
      // Une requête de 1,2 Mo reçue en 30 s, après 2 s d'attente du serveur.
      diag.diagRequest(at - 32_000, at - 30_000, at, 1_200_000, null);
      const stall = diag.diagStallFacts(null, 60_000);
      expect(stall).toMatchObject({ needMbps: 3.9, linkVerdict: "trop lente" });
      expect(stall.linkS).toBeCloseTo(30, 0);
      const stop = diag.diagSessionFacts();
      expect(stop).toMatchObject({ needMbps: 3.9, linkVerdict: "trop lente" });
      expect(stop.recvMbps).toBeDefined();
      expect(stop.linkMbps).toBeDefined();
    } finally {
      diag.diagEnd("séance-lien");
      now.mockRestore();
    }
  });
});
