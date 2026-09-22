import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HttpByteSource, forgetHandover } from "@/lib/webcodecs/byteSource";

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
