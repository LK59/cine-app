import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpByteSource, forgetHandover, SessionEnded } from "@/lib/webcodecs/byteSource";

// The transport under a demuxer that asks for four bytes at a time. What matters here is not what
// comes back — it is how many round trips it took and whether they overlapped, because on a real
// link that is almost the whole of the wait before a film starts.

const CHUNK = 1 << 20;
const SIZE = 10 * CHUNK;

/** Ranges asked for, in order, with a hook to hold answers open. */
let asked: [number, number][] = [];
let hold: ((value: void) => void) | null = null;
let inFlight = 0;
let peakInFlight = 0;

function stubFetch(options: { rangeStatus?: number; contentLength?: string | null } = {}) {
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
    if (init?.method === "HEAD") {
      return {
        ok: true,
        headers: { get: (name: string) => (name === "Content-Length" ? (options.contentLength ?? String(SIZE)) : null) },
      };
    }
    const range = init?.headers?.Range ?? "";
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
    asked.push([from, to]);

    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    if (hold) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;

    return {
      status: options.rangeStatus ?? 206,
      // Le même total que le HEAD : la source se range désormais à celui d'une plage, et un
      // serveur qui se contredit n'est pas ce que ces tests examinent.
      headers: { get: () => `bytes ${from}-${to}/${options.contentLength ?? SIZE}` },
      arrayBuffer: async () => new Uint8Array(to - from + 1).buffer,
    };
  });
}

beforeEach(() => {
  forgetHandover();
  asked = [];
  hold = null;
  inFlight = 0;
  peakInFlight = 0;
});
afterEach(() => vi.unstubAllGlobals());

const chunksAsked = () => [...new Set(asked.map(([from]) => from / CHUNK))].sort((a, b) => a - b);
const settle = () => new Promise((r) => setTimeout(r, 20));

describe("HttpByteSource", () => {
  it("fetches both ends of the file before anyone asks", async () => {
    // A Matroska file is read from the front for its header and from wherever the Cues were
    // written for its index, which on a file made for streaming is the very end. Fetched one
    // after the other, those two were most of the second between opening a file and knowing
    // what was in it.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();

    expect(chunksAsked()).toContain(0);
    expect(chunksAsked()).toContain(9);
    source.close();
  });

  it("answers hundreds of small reads from one fetch", async () => {
    // A demuxer asks for a four-byte element header, then a three-byte size, then a payload. One
    // request per call would be thousands of round trips.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];

    for (let at = 0; at < 4096; at += 4) await source.read(at, 4);
    // A thousand reads, and not one of them asked for the chunk they all sit in — it was already
    // held. What is asked for is only ever the read-ahead running in front of them.
    expect(chunksAsked()).not.toContain(0);
    expect(asked.length).toBeLessThanOrEqual(8);
    source.close();
  });

  it("reads ahead far enough to keep the link busy", async () => {
    // One chunk ahead is a relay, not a pipeline: every megabyte after the first pays a fresh
    // round trip before its first byte arrives. Reading one keyframe group means five or six.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];

    await source.read(2 * CHUNK, 16);
    await settle();
    // The chunk itself, and several after it.
    expect(chunksAsked().length).toBeGreaterThanOrEqual(5);
    expect(chunksAsked()).toContain(2);
    expect(chunksAsked()).toContain(3);
    source.close();
  });

  it("asks for the chunks of one read together, not one after another", async () => {
    stubFetch();
    hold = () => {};
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    peakInFlight = 0;

    // A read spanning four chunks used to be four round trips deep.
    await source.read(4 * CHUNK, 3 * CHUNK + 10);
    expect(peakInFlight).toBeGreaterThan(1);
    source.close();
  });

  it("asks again for a range that failed to arrive", async () => {
    // A range request is not a stream: nothing resumes it, and one refused fetch used to travel
    // all the way up as the player giving up. A phone moving from Wi-Fi to mobile drops every
    // connection it has, which is an ordinary thing to do while watching a film.
    let refusals = 2;
    stubFetch();
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if ((init as { method?: string } | undefined)?.method !== "HEAD" && refusals-- > 0) {
        throw new TypeError("Failed to fetch");
      }
      return (real as typeof fetch)(url as unknown as RequestInfo, init);
    });

    const source = await HttpByteSource.open("/film.mkv");
    const bytes = await source.read(3 * CHUNK, 32);
    expect(bytes.length).toBe(32);
    expect(refusals).toBeLessThanOrEqual(0);
    source.close();
  }, 15000);

  // 13/10/2026 : un corps plus court que ce que son `Content-Range` annonce — une réponse coupée
  // qui se termine « proprement » — était rendu tel quel à la lecture qui l'attendait. Le cache le
  // refusait (mauvaise longueur), mais le démultiplexeur recevait moins d'octets que demandé, ce
  // qu'il lit comme la fin du fichier. La réserve d'avance, elle, refusait déjà une telle plage.
  it("redemande une plage dont le corps est plus court que son Content-Range", async () => {
    let truncations = 1;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      const cut = from === 3 * CHUNK && truncations-- > 0;
      const body = new Uint8Array(cut ? 1000 : to - from + 1).fill(7);
      return { status: 206, headers: { get: (n: string) => (n === "Content-Range" ? `bytes ${from}-${to}/${SIZE}` : null) }, arrayBuffer: async () => body.buffer };
    });
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    const bytes = await source.read(3 * CHUNK, CHUNK);
    expect(bytes.length).toBe(CHUNK);
    expect(truncations).toBeLessThan(0);
    source.close();
  }, 15000);

  it("gives up at once on a server that does not do ranges at all", async () => {
    // 200 is not a bad moment: asking again would only download a forty-gigabyte film four times.
    stubFetch({ rangeStatus: 200 });
    const source = await HttpByteSource.open("/film.mkv");
    await expect(source.read(0, 16)).rejects.toThrow(/plage/);
    // Asked once for that chunk and never again — a retry here downloads the film a second time.
    expect(asked.filter(([from]) => from === 0).length).toBe(1);
    source.close();
  });

  it("refuses a server that ignores the range and sends the whole file", async () => {
    // 200 on a 40 GB film is not a successful chunk read, it is a download nobody asked for.
    stubFetch({ rangeStatus: 200 });
    const source = await HttpByteSource.open("/film.mkv");
    await expect(source.read(0, 16)).rejects.toThrow(/plage/);
    source.close();
  });

  it("fills the link at a seek, before anything has asked to read there", async () => {
    // The index says where a seek lands several milliseconds before the parser asks for its
    // first byte, and until now those were spent idle: the read-ahead only started once the
    // first chunk had already arrived, so a seek began with one lone request on an empty link —
    // on a file needing four megabytes before it can show a picture.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    asked = [];

    source.warm(2 * CHUNK + 512);
    await settle();

    // The chunk it lands in, and the ones after it, all in flight without a read.
    expect(chunksAsked()).toContain(2);
    expect(chunksAsked().length).toBeGreaterThanOrEqual(5);
    source.close();
  });

  it("does not ask twice for what it already has, or is already fetching", async () => {
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();

    source.warm(3 * CHUNK);
    await settle();
    const first = asked.length;

    source.warm(3 * CHUNK);
    await settle();
    expect(asked.length).toBe(first);
    source.close();
  });

  it("serves a read at a warmed offset without a fresh request", async () => {
    // The point of it: by the time the parser gets there, the bytes are already on their way.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv");
    await settle();
    source.warm(7 * CHUNK);
    await settle();
    asked = [];

    await source.read(7 * CHUNK, 64);
    expect(chunksAsked()).not.toContain(7);
    source.close();
  });

  it("takes the size from Content-Range when HEAD does not give it", async () => {
    stubFetch({ contentLength: null });
    const source = await HttpByteSource.open("/film.mkv");
    expect(source.size).toBe(SIZE);
    source.close();
  });
});

/**
 * Une socket qui pend, et tout ce qui n'arrivait jamais derrière.
 *
 * Le lecteur natif a déjà tout ce qu'il faut pour survivre à une coupure : quatre tentatives avec
 * temporisation, l'attente du retour du réseau, un écran « Connexion perdue » avec son bouton, et
 * la reprise automatique à la position exacte. Rien de tout cela ne s'armait dans un cas précis,
 * qui est le plus courant sur un téléphone — une bascule Wi-Fi → 5G ne *refuse* pas les connexions
 * en cours, elle les laisse pendre. Sans échéance, le `fetch` ne se résout jamais : pas d'erreur,
 * donc pas de nouvelle tentative, donc pas d'écran, donc une image figée pour toujours.
 */
describe("HttpByteSource — la zone autour de la tête de lecture", () => {
  // Le lecteur lit en avance, jusqu'à trente secondes : sans zone gardée, l'endroit qu'on regarde
  // était chassé du cache par cette avance, et un changement de piste le retéléchargeait.
  const readAhead = async (source: HttpByteSource) => {
    for (let chunk = 0; chunk < 8; chunk++) await source.read(chunk * CHUNK, 16);
    for (let chunk = 20; chunk < 110; chunk++) await source.read(chunk * CHUNK, 16);
    await settle();
  };
  const refetched = async (source: HttpByteSource, chunk: number) => {
    const before = asked.length;
    await source.read(chunk * CHUNK, 16);
    return asked.slice(before).some(([from]) => from === chunk * CHUNK);
  };

  it("garde la zone désignée quand la lecture en avance remplit le cache", async () => {
    stubFetch({ contentLength: String(200 * CHUNK) });
    const source = await HttpByteSource.open("/film.mkv");
    source.keep(0, 8 * CHUNK);
    await readAhead(source);
    expect(await refetched(source, 3)).toBe(false);
    source.close();
  });

  it("sans elle, la même zone était chassée — ce que le test d'au-dessus mesure vraiment", async () => {
    stubFetch({ contentLength: String(200 * CHUNK) });
    const source = await HttpByteSource.open("/film.mkv");
    await readAhead(source);
    expect(await refetched(source, 3)).toBe(true);
    source.close();
  });

  it("passe la zone à la source qui rouvre le même fichier", async () => {
    stubFetch({ contentLength: String(200 * CHUNK) });
    const first = await HttpByteSource.open("/film.mkv");
    first.keep(0, 8 * CHUNK);
    for (let chunk = 0; chunk < 70; chunk++) await first.read(chunk * CHUNK, 16);
    await settle();
    first.close();
    const second = await HttpByteSource.open("/film.mkv");
    // La reconstruction lit en avance avant que le lecteur ne redésigne la zone.
    for (let chunk = 70; chunk < 110; chunk++) await second.read(chunk * CHUNK, 16);
    await settle();
    expect(await refetched(second, 3)).toBe(false);
    second.close();
  });

  it("ne laisse jamais la zone figer tout le cache", async () => {
    // Des images clés à vingt-cinq secondes d'intervalle : l'appelant peut demander beaucoup.
    stubFetch({ contentLength: String(200 * CHUNK) });
    const source = await HttpByteSource.open("/film.mkv");
    source.keep(0, 150 * CHUNK);
    for (let chunk = 0; chunk < 150; chunk++) await source.read(chunk * CHUNK, 16);
    await settle();
    // Borné à 24 morceaux : le 30e, hors de la borne, a été évincé comme n'importe quel autre.
    expect(await refetched(source, 30)).toBe(true);
    source.close();
  });
});

describe("HttpByteSource — le relais d'une reconstruction", () => {
  const heads = () => (fetch as unknown as { heads: number }).heads;
  const countingFetch = () => {
    stubFetch();
    const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    const counted = Object.assign(
      async (url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") counted.heads++;
        return inner(url, init);
      },
      { heads: 0 }
    );
    vi.stubGlobal("fetch", counted);
  };

  it("rouvre le même fichier sans demander sa taille, avec ce qui était déjà téléchargé", async () => {
    // 21/09/2026, iPhone : une reconstruction pour changement de piste rouvrait tout — une seconde
    // de HEAD pour une taille connue, puis les octets autour de la tête retéléchargés.
    countingFetch();
    const first = await HttpByteSource.open("/film.mkv");
    await first.read(3 * CHUNK, 16);
    await settle();
    first.close();
    const before = asked.length;
    const headsBefore = heads();

    const second = await HttpByteSource.open("/film.mkv");
    expect(heads()).toBe(headsBefore);
    expect(second.size).toBe(SIZE);
    await second.read(3 * CHUNK, 16);
    expect(asked.slice(before).some(([from]) => from === 3 * CHUNK)).toBe(false);
    second.close();
  });

  it("ne transmet rien à un autre fichier, ni au-delà de quelques secondes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      countingFetch();
      const first = await HttpByteSource.open("/film.mkv");
      await first.read(0, 16);
      first.close();
      // Un autre fichier : sa taille est demandée, rien n'est hérité du premier.
      const other = await HttpByteSource.open("/autre.mkv");
      expect(heads()).toBe(2);
      await other.read(0, 16);
      other.close();

      // Le même, rouvert tout de suite : hérité, sans HEAD.
      const again = await HttpByteSource.open("/autre.mkv");
      expect(heads()).toBe(2);
      await again.read(0, 16);
      again.close();

      // Rouvert six secondes plus tard : le relais est rendu, on redemande.
      vi.advanceTimersByTime(6000);
      await HttpByteSource.open("/autre.mkv");
      expect(heads()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HttpByteSource — une requête qui ne revient pas", () => {
  /**
   * Ce que ce test prouve, et ce qu'il ne prouve pas.
   *
   * Il vérifie le maillon qui compte : un abandon **qui ne vient pas du lecteur** est traité comme
   * un échec réseau ordinaire — nouvelle tentative — et non comme une annulation à faire remonter.
   * C'est exactement le chemin qu'emprunte une échéance, et c'est la distinction que fait le
   * `catch` de `fetchWithRetries`.
   *
   * Il ne vérifie pas les vingt-cinq secondes elles-mêmes : `AbortSignal.timeout` tient son propre
   * horloge, hors de portée des minuteurs simulés, et figer une constante n'apprend rien.
   */
  it("traite un abandon qui n'est pas le sien comme un échec réseau, et redemande", async () => {
    let calls = 0;
    const pendantes: (() => void)[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") {
        return { ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } };
      }
      calls += 1;
      // La première plage pend, et n'est délivrée que par l'abandon du signal — exactement ce que
      // fait une socket morte. Les suivantes répondent normalement.
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          const fail = () => reject(new DOMException("aborted", "AbortError"));
          if (signal?.aborted) fail();
          else signal?.addEventListener("abort", fail, { once: true });
          pendantes.push(fail);
        });
      }
      return {
        status: 206,
        arrayBuffer: async () => new ArrayBuffer(Math.min(CHUNK, SIZE)),
      };
    });

    const source = await HttpByteSource.open("/film.mkv");
    const lecture = source.read(0, 4);
    // L'échéance réelle est de vingt-cinq secondes ; on la déclenche à la main plutôt que
    // d'attendre, ce qui testerait la patience de la machine et non le code.
    pendantes.forEach((fail) => fail());
    await expect(lecture).resolves.toBeInstanceOf(Uint8Array);
    // Elle a bien été redemandée : sans échéance, il n'y aurait jamais eu de seconde requête.
    expect(calls).toBeGreaterThan(1);
  });
});

describe("HttpByteSource — une taille déjà connue", () => {
  const countingHeads = () => {
    stubFetch();
    const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    const counted = Object.assign(
      async (url: string, init?: RequestInit) => {
        if (init?.method === "HEAD") counted.heads++;
        return inner(url, init);
      },
      { heads: 0 }
    );
    vi.stubGlobal("fetch", counted);
    return counted;
  };

  it("ouvre sans HEAD, et les deux bouts du fichier partent aussitôt", async () => {
    // 22/09/2026, serveur lointain : le HEAD coûtait un aller-retour entier avant la première
    // plage, pour une taille que la description du fichier portait déjà.
    const counted = countingHeads();
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    expect(counted.heads).toBe(0);
    expect(source.size).toBe(SIZE);
    await settle();
    expect(chunksAsked()).toEqual([0, 9]);
    source.close();
  });

  it("demande encore la taille quand on ne la connaît pas", async () => {
    const counted = countingHeads();
    for (const unknown of [undefined, null, 0, NaN, -1]) {
      forgetHandover();
      const source = await HttpByteSource.open("/film.mkv", unknown);
      expect(source.size).toBe(SIZE);
      source.close();
    }
    expect(counted.heads).toBe(5);
  });

  it("se range à la taille que le serveur annonce quand celle d'avance était fausse", async () => {
    // Une description gardée en mémoire toute la session, et un fichier remplacé entre-temps : le
    // `Content-Range` de la première plage dit la vérité, avant que rien n'ait été lu.
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv", SIZE - CHUNK / 2);
    const bytes = await source.read(0, 16);
    expect(bytes.length).toBe(16);
    expect(source.size).toBe(SIZE);
    // Le dernier morceau, coupé à la mauvaise taille, n'est pas gardé : relu, il est redemandé
    // en entier.
    await settle();
    asked = [];
    const tail = await source.read(9 * CHUNK, CHUNK);
    expect(tail.length).toBe(CHUNK);
    expect(asked).toContainEqual([9 * CHUNK, SIZE - 1]);
    source.close();
  });
});

describe("HttpByteSource — le protocole de chaque requête", () => {
  it("compte le protocole des requêtes depuis le saut, et la ligne de trace le nomme", async () => {
    stubFetch();
    const spy = vi
      .spyOn(performance, "getEntriesByName")
      .mockImplementation(((name: string) =>
        name.endsWith("/film.mkv") ? [{ nextHopProtocol: "http/1.1" }, { nextHopProtocol: "h2" }] : []) as never);
    try {
      const { describeNetwork } = await import("@/lib/webcodecs/byteSource");
      const source = await HttpByteSource.open("/film.mkv", SIZE);
      source.abandon(4 * CHUNK);
      await source.read(4 * CHUNK, 2 * CHUNK);
      const w = source.networkSinceSeek()!;
      // La dernière entrée de ce nom : la requête qu'on vient de finir.
      expect(w.protocols).toEqual({ h2: w.requests });
      expect(describeNetwork(w)).toMatch(/, protocole h2$/);
      expect(describeNetwork({ ...w, protocols: { h2: 3, "http/1.1": 1 } })).toMatch(/, protocoles h2 ×3, http\/1\.1 ×1$/);
      source.close();
    } finally {
      spy.mockRestore();
    }
  });

  it("une mesure qui lève ne casse pas la lecture", async () => {
    stubFetch();
    const spy = vi.spyOn(performance, "getEntriesByName").mockImplementation(() => {
      throw new Error("indisponible");
    });
    try {
      const { describeNetwork } = await import("@/lib/webcodecs/byteSource");
      const source = await HttpByteSource.open("/film.mkv", SIZE);
      source.abandon(4 * CHUNK);
      await expect(source.read(4 * CHUNK, 16)).resolves.toHaveLength(16);
      const w = source.networkSinceSeek()!;
      expect(w.protocols).toEqual({});
      expect(describeNetwork(w)).not.toMatch(/protocole/);
      source.close();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("HttpByteSource — un morceau abandonné pendant son attente avant nouvelle tentative", () => {
  /**
   * Chasse aux défauts du 22/09/2026. Un morceau dont la première requête avait échoué attendait
   * son délai avant de redemander (200 ms à 1,5 s) sans écouter son interrupteur. `abandon` le
   * coupait mais laissait sa promesse dans `inflight` : pendant tout ce délai, `fetchChunk` la
   * rendait à la première lecture venue — qui recevait `ReadAbandoned` pour un morceau que le
   * lecteur voulait bel et bien (boucle de remplissage arrêtée sans un mot, image en double, son
   * perdu jusqu'au saut suivant) —, la lecture en avance le croyait en route, et le saut lui-même
   * attendait la fin du délai.
   */
  const failFirst = (index: number) => {
    stubFetch();
    const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    let failed = false;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      const from = Number(/bytes=(\d+)-/.exec(init?.headers?.Range ?? "")?.[1] ?? -1);
      if (from === index * CHUNK && !failed) {
        failed = true;
        asked.push([from, from + CHUNK - 1]);
        throw new TypeError("Failed to fetch");
      }
      return inner(url, init);
    });
  };
  const askedFor = (index: number) => asked.filter(([from]) => from === index * CHUNK).length;

  it("une lecture demandée après l'abandon repart d'une requête neuve, et une seule", async () => {
    failFirst(3);
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    source.warm(3 * CHUNK);
    // La première requête du morceau 3 a échoué : il attend son délai avant de redemander.
    await settle();
    expect(askedFor(3)).toBe(1);

    source.abandon(8 * CHUNK);
    // Deux lectures du même morceau, la seconde après que l'ancienne promesse s'est éteinte : une
    // seule requête neuve pour les deux, et aucune ne reçoit l'abandon de l'ancienne.
    const first = source.read(3 * CHUNK, 16);
    await settle();
    const second = source.read(3 * CHUNK + 32, 16);
    await expect(first).resolves.toHaveLength(16);
    await expect(second).resolves.toHaveLength(16);
    expect(askedFor(3)).toBe(2);
    source.close();
  });

  it("l'abandon interrompt l'attente au lieu d'en attendre la fin", async () => {
    failFirst(3);
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    const doomed = source.read(3 * CHUNK, 16);
    await settle();
    source.abandon(8 * CHUNK);
    const outcome = await Promise.race([
      doomed.then(
        () => "résolue",
        (error: unknown) => (error instanceof Error ? error.name : "autre")
      ),
      new Promise((resolve) => setTimeout(() => resolve("toujours en attente"), 100)),
    ]);
    expect(outcome).toBe("ReadAbandoned");
    source.close();
  });
});

describe("HttpByteSource — après la fermeture", () => {
  it("ne lance plus aucune requête : ni lecture, ni préchauffage", async () => {
    stubFetch();
    const source = await HttpByteSource.open("/film.mkv", SIZE);
    await settle();
    source.close();
    asked = [];
    await expect(source.read(4 * CHUNK, 16)).rejects.toThrow();
    source.warm(6 * CHUNK);
    await settle();
    expect(asked).toEqual([]);
  });

  it("une seconde fermeture n'efface pas le relais laissé par une autre source", async () => {
    let heads = 0;
    stubFetch();
    const inner = fetch as unknown as (url: string, init?: RequestInit) => Promise<unknown>;
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") heads++;
      return inner(url, init);
    });
    const first = await HttpByteSource.open("/film.mkv");
    await first.read(0, 16);
    first.close();
    // Une reconstruction : même fichier, hérité, puis refermée à son tour.
    const second = await HttpByteSource.open("/film.mkv");
    await second.read(0, 16);
    second.close();
    const headsBefore = heads;

    // L'ancienne source, refermée une seconde fois par un nettoyage tardif.
    first.close();
    await HttpByteSource.open("/film.mkv");
    expect(heads).toBe(headsBefore);
  });
});

/**
 * Une session de connexion expirée arrête la lecture des octets tout de suite.
 *
 * Chaque plage refusée pour ce motif était redemandée quatre fois, avec des pauses entre les
 * essais, puis présentée comme une panne réseau : « connexion perdue » et une reconstruction, là
 * où il fallait simplement se reconnecter (relevé le 23/09/2026).
 */
describe("HttpByteSource — session expirée", () => {
  it("ne redemande pas une plage refusée faute de session", async () => {
    let ranges = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      if (init?.method === "HEAD") {
        return { ok: true, headers: { get: (name: string) => (name === "Content-Length" ? String(SIZE) : null) } };
      }
      ranges += 1;
      return {
        status: 401,
        ok: false,
        headers: { get: (name: string) => (name.toLowerCase() === "x-session-expired" ? "1" : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      };
    });
    const source = await HttpByteSource.open("/film.mkv");
    await expect(source.read(4 * CHUNK, 4)).rejects.toBeInstanceOf(SessionEnded);
    await settle();
    // Une demande par plage — celles des deux bouts et celle-ci —, jamais les quatre essais.
    expect(ranges).toBeLessThanOrEqual(3);
    source.close();
  });
});

// « Connexion trop lente » (DECISIONS.md §77) : pendant une ouverture mesurée, la réception des
// octets ne change pas — corps lu d'un bloc, compté une fois arrivé. Une lecture au fil de l'eau
// (`readCounted`) existe mais n'est pas branchée : ce test échoue si quelqu'un la rebranche sans
// l'avoir validée sur les vrais moteurs.
describe("HttpByteSource pendant une ouverture mesurée", () => {
  it("lit d'un bloc et compte chaque morceau arrivé", async () => {
    const { armOpeningMeter, disarmOpeningMeter } = await import("@/lib/slowLink");
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") return { ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } };
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      return {
        status: 206,
        headers: { get: () => `bytes ${from}-${to}/${SIZE}` },
        get body(): never {
          throw new Error("le corps ne doit pas être lu en flux");
        },
        arrayBuffer: async () => new Uint8Array(to - from + 1).buffer,
      };
    });
    const meter = armOpeningMeter();
    try {
      const source = await HttpByteSource.open("/film.mkv");
      const bytes = await source.read(0, 16);
      expect(bytes.byteLength).toBe(16);
      await settle();
      expect(meter.measure().bytes).toBeGreaterThanOrEqual(CHUNK);
    } finally {
      disarmOpeningMeter(meter);
    }
  });
});

describe("« Connexion perdue ou instable… » (DECISIONS.md §78)", () => {
  it("dit à l'hôte qu'un morceau réessaie, et le retire quand il arrive — sans rien changer aux octets reçus", async () => {
    const { networkUnstable, resetNetworkTrouble, subscribeNetworkTrouble } = await import("@/lib/networkTrouble");
    resetNetworkTrouble();
    const seen: boolean[] = [];
    const stop = subscribeNetworkTrouble((v) => seen.push(v));
    let calls = 0;
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") return { ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } };
      const range = init?.headers?.Range ?? "";
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
      calls += 1;
      // Les deux premières plages échouent une fois (la socket tombe), puis répondent.
      if (calls <= 2) throw new TypeError("Failed to fetch");
      return { status: 206, headers: { get: () => `bytes ${from}-${to}/${SIZE}` }, arrayBuffer: async () => new Uint8Array(to - from + 1).fill(7).buffer };
    });
    const source = await HttpByteSource.open("/film.mkv");
    const bytes = await source.read(0, 4);
    await settle();
    expect(Array.from(bytes)).toEqual([7, 7, 7, 7]);
    expect(seen[0]).toBe(true);
    expect(networkUnstable()).toBe(false);
    expect(seen[seen.length - 1]).toBe(false);
    stop();
    source.close();
  });
});

describe("un saut relancé faute de premier octet n'est pas une coupure (§78)", () => {
  it("la relance d'une plage muette après un saut (`muted`) ne dit pas « Connexion perdue ou instable… »", async () => {
    const { resetNetworkTrouble, subscribeNetworkTrouble } = await import("@/lib/networkTrouble");
    resetNetworkTrouble();
    const seen: boolean[] = [];
    const stop = subscribeNetworkTrouble((v) => seen.push(v));
    let ranges = 0;
    let afterSeek = false;
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") return Promise.resolve({ ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } });
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      // La première plage après le saut reste muette : pas un octet, jusqu'à l'échéance du saut.
      if (afterSeek && ++ranges === 1) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("coupée", "AbortError"))));
      }
      return Promise.resolve({ status: 206, headers: { get: () => `bytes ${from}-${to}/${SIZE}` }, arrayBuffer: async () => new Uint8Array(to - from + 1).fill(7).buffer });
    });
    const source = await HttpByteSource.open("/film.mkv");
    vi.useFakeTimers();
    try {
      afterSeek = true;
      source.abandon(5 * CHUNK);
      const read = source.read(5 * CHUNK, 4);
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(Array.from(await read)).toEqual([7, 7, 7, 7]);
      expect(ranges).toBeGreaterThanOrEqual(2);
      expect(seen).not.toContain(true);
    } finally {
      vi.useRealTimers();
      stop();
      source.close();
    }
  });
});

describe("retour au premier plan : une requête muette est redemandée (13/10/2026)", () => {
  type Doc = { visibilityState: string; addEventListener: (t: string, f: () => void) => void; removeEventListener: (t: string, f: () => void) => void };
  function fakeDocument(): { doc: Doc; wake: () => void; hide: () => void } {
    const listeners = new Set<() => void>();
    const doc: Doc = {
      visibilityState: "visible",
      addEventListener: (_t, f) => void listeners.add(f),
      removeEventListener: (_t, f) => void listeners.delete(f),
    };
    const fire = (state: string) => {
      doc.visibilityState = state;
      for (const f of listeners) f();
    };
    return { doc, wake: () => fire("visible"), hide: () => fire("hidden") };
  }

  /** Les `mutedFirst` premières demandes de chaque plage restent muettes, jusqu'à leur abandon (la lecture en avance compte à part). */
  function stubMuted(mutedFirst: number) {
    const perRange = new Map<number, number>();
    const counter = { of: (chunk: number) => perRange.get(chunk * CHUNK) ?? 0 };
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      if (init?.method === "HEAD") return Promise.resolve({ ok: true, headers: { get: (n: string) => (n === "Content-Length" ? String(SIZE) : null) } });
      const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
      const n = (perRange.get(from) ?? 0) + 1;
      perRange.set(from, n);
      if (n <= mutedFirst) {
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("coupée", "AbortError"))));
      }
      return Promise.resolve({ status: 206, headers: { get: () => `bytes ${from}-${to}/${SIZE}` }, arrayBuffer: async () => new Uint8Array(to - from + 1).fill(9).buffer });
    });
    return counter;
  }

  it("une requête posée juste après le retour, muette 5 s, est redemandée sans attendre les 25 s", async () => {
    const { doc, wake, hide } = fakeDocument();
    vi.stubGlobal("document", doc);
    const source = await HttpByteSource.open("/retour.mkv", SIZE);
    const counter = stubMuted(1);
    vi.useFakeTimers();
    try {
      hide();
      wake();
      const read = source.read(3 * CHUNK, 4);
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(Array.from(await read)).toEqual([9, 9, 9, 9]);
      expect(counter.of(3)).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
      source.close();
      vi.unstubAllGlobals();
    }
  });

  it("une requête déjà en vol pendant l'arrière-plan reçoit l'échéance au retour", async () => {
    const { doc, wake, hide } = fakeDocument();
    vi.stubGlobal("document", doc);
    const source = await HttpByteSource.open("/en-vol.mkv", SIZE);
    const counter = stubMuted(1);
    vi.useFakeTimers();
    try {
      const read = source.read(2 * CHUNK, 4);
      hide();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(counter.of(2)).toBe(1);
      wake();
      await vi.advanceTimersByTimeAsync(5_100);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(Array.from(await read)).toEqual([9, 9, 9, 9]);
      expect(counter.of(2)).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
      source.close();
      vi.unstubAllGlobals();
    }
  });

  it("une fois par morceau : sur un lien vraiment lent, pas de relance en boucle", async () => {
    const { doc, wake } = fakeDocument();
    vi.stubGlobal("document", doc);
    const source = await HttpByteSource.open("/lent.mkv", SIZE);
    const counter = stubMuted(99);
    vi.useFakeTimers();
    try {
      wake();
      const read = source.read(4 * CHUNK, 4).catch(() => null);
      await vi.advanceTimersByTimeAsync(5_100);
      // La relance part après sa pause ordinaire.
      await vi.advanceTimersByTimeAsync(3_000);
      const afterDeadline = counter.of(4);
      expect(afterDeadline).toBe(2);
      // La relance n'a plus d'échéance courte : rien de neuf avant l'échéance ordinaire.
      await vi.advanceTimersByTimeAsync(8_000);
      expect(counter.of(4)).toBe(afterDeadline);
      source.close();
      await read;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // 13/10/2026 : `OFFLINE_PATIENCE_MS` (une minute) était attendue à *chaque* nouvelle tentative —
  // trois fois de suite pour un même morceau. Un appareil réellement hors ligne gardait l'image figée
  // trois minutes avant l'écran « connexion perdue », qui seul propose de reprendre.
  it("hors ligne pour de bon : la lecture renonce après une minute d'attente, pas trois", async () => {
    const { doc } = fakeDocument();
    vi.stubGlobal("document", doc);
    const source = await HttpByteSource.open("/hors-ligne.mkv", SIZE);
    const windowListeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("window", {
      addEventListener: (t: string, f: () => void) => void (windowListeners.get(t) ?? windowListeners.set(t, new Set()).get(t)!).add(f),
      removeEventListener: (t: string, f: () => void) => void windowListeners.get(t)?.delete(f),
    });
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
    vi.useFakeTimers();
    try {
      let outcome: unknown = "en attente";
      const read = source.read(5 * CHUNK, 4).then(
        () => "lu",
        (error: unknown) => (outcome = error)
      );
      await vi.advanceTimersByTimeAsync(65_000);
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as { network?: boolean }).network).toBe(true);
      await read;
    } finally {
      vi.useRealTimers();
      source.close();
      vi.unstubAllGlobals();
    }
  });

  it("sans retour au premier plan, rien ne change : pas d'échéance courte", async () => {
    const { doc } = fakeDocument();
    vi.stubGlobal("document", doc);
    const source = await HttpByteSource.open("/ordinaire.mkv", SIZE);
    const counter = stubMuted(99);
    vi.useFakeTimers();
    try {
      const read = source.read(1 * CHUNK, 4).catch(() => null);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(counter.of(1)).toBe(1);
      source.close();
      await read;
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

/**
 * Le silence du réseau sous une demande (DECISIONS.md §97) : ce que la borne d'une coupure en pleine
 * lecture mesure. Trois coupures avec un `fetch` factice — hors ligne, refus immédiat, requête pendante
 * avec `onLine` vrai (le cas réel : Wi-Fi sans Internet, 5G morte en itinérance) — et un lien lent.
 */
describe("le silence du réseau (§97)", () => {
  /** Une fenêtre factice dont on garde les écouteurs (`online`). */
  function fakeWindow() {
    const listeners = new Map<string, Set<() => void>>();
    vi.stubGlobal("window", {
      addEventListener: (t: string, f: () => void) => void (listeners.get(t) ?? listeners.set(t, new Set()).get(t)!).add(f),
      removeEventListener: (t: string, f: () => void) => void listeners.get(t)?.delete(f),
    });
    return { fire: (t: string) => listeners.get(t)?.forEach((f) => f()) };
  }
  const ok = (init?: RequestInit & { headers?: Record<string, string> }) => {
    const [, from, to] = /bytes=(\d+)-(\d+)/.exec(init?.headers?.Range ?? "")!.map(Number);
    return { status: 206, headers: { get: () => `bytes ${from}-${to}/${SIZE}` }, arrayBuffer: async () => new Uint8Array(to - from + 1).buffer };
  };

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rien demandé : aucun silence", async () => {
    stubFetch();
    const source = await HttpByteSource.open("/calme.mkv", SIZE);
    await source.read(0, 4);
    await settle();
    expect(source.networkSilentMs()).toBe(0);
    source.close();
  });

  it("hors ligne (`onLine` faux) : le silence court pendant l'attente du réseau, et repart de zéro à `online`", async () => {
    const win = fakeWindow();
    vi.stubGlobal("navigator", { onLine: false });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Load failed")));
    vi.useFakeTimers();
    const source = await HttpByteSource.open("/hors-ligne-silence.mkv", SIZE);
    const read = source.read(5 * CHUNK, 4).catch(() => null);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.networkSilentMs()).toBeGreaterThanOrEqual(30_000);
    // Le réseau revient : le silence repart d'ici (la lecture, elle, repart toute seule).
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit & { headers?: Record<string, string> }) => ok(init));
    (navigator as { onLine: boolean }).onLine = true;
    win.fire("online");
    expect(source.networkSilentMs()).toBeLessThan(100);
    await vi.advanceTimersByTimeAsync(2000);
    await read;
    expect(source.networkSilentMs()).toBe(0);
    source.close();
  });

  it("refus immédiat (`onLine` vrai) : chaque lecture échoue en ~2 s, mais le silence dure d'un essai à l'autre", async () => {
    fakeWindow();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    vi.useFakeTimers();
    const source = await HttpByteSource.open("/refus-silence.mkv", SIZE);
    const first = source.read(3 * CHUNK, 4).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first) as { network?: boolean }).toMatchObject({ network: true });
    // Rien n'est en vol entre deux essais : le silence n'en est pas effacé.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(source.networkSilentMs()).toBeGreaterThanOrEqual(15_000);
    const second = source.read(4 * CHUNK, 4).catch(() => null);
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    expect(source.networkSilentMs()).toBeGreaterThanOrEqual(20_000);
    // Un morceau arrive : fini.
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit & { headers?: Record<string, string> }) => ok(init));
    await source.read(6 * CHUNK, 4);
    await vi.advanceTimersByTimeAsync(100);
    expect(source.networkSilentMs()).toBe(0);
    source.close();
  });

  it("requête pendante, `onLine` vrai : le silence court tant qu'elle pend", async () => {
    fakeWindow();
    vi.stubGlobal("navigator", { onLine: true });
    vi.stubGlobal("fetch", (_u: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true }))
    );
    vi.useFakeTimers();
    const source = await HttpByteSource.open("/pendante-silence.mkv", SIZE);
    const read = source.read(2 * CHUNK, 4).catch(() => null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(source.networkSilentMs()).toBeGreaterThanOrEqual(20_000);
    source.close();
    await read;
  });

  it("un lien lent qui livre ses morceaux n'est jamais un silence long", async () => {
    fakeWindow();
    vi.stubGlobal("navigator", { onLine: true });
    // Chaque morceau met 8 s à arriver (≈ 1 Mbit/s), l'un après l'autre.
    vi.stubGlobal("fetch", async (_u: string, init?: RequestInit & { headers?: Record<string, string> }) => {
      await new Promise((r) => setTimeout(r, 8000));
      return ok(init);
    });
    vi.useFakeTimers();
    const source = await HttpByteSource.open("/lent-silence.mkv", SIZE);
    let worst = 0;
    for (let i = 1; i < 6; i++) {
      const read = source.read(i * CHUNK, 4);
      for (let s = 0; s < 9; s++) {
        await vi.advanceTimersByTimeAsync(1000);
        worst = Math.max(worst, source.networkSilentMs());
      }
      await read;
    }
    expect(worst).toBeLessThan(10_000);
    source.close();
  });
});
