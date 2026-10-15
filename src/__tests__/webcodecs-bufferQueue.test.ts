import { describe, it, expect, vi, afterEach } from "vitest";
import { BufferQueue } from "@/lib/webcodecs/bufferQueue";

/**
 * Une opération qui ne répond pas ne passe pour finie que si le tampon est libre.
 *
 * L'échéance de quatre secondes résolvait l'opération quoi qu'il en soit. Un tampon encore occupé
 * recevait alors l'opération suivante, que le navigateur refusait (InvalidStateError) — et l'erreur
 * accusait le mauvais segment (relevé le 23/09/2026).
 */
function fakeBuffer() {
  return Object.assign(new EventTarget(), { updating: false, appendBuffer: vi.fn(), abort: vi.fn() }) as unknown as SourceBuffer & {
    updating: boolean;
    abort: ReturnType<typeof vi.fn>;
  };
}

afterEach(() => vi.useRealTimers());

describe("BufferQueue — échéance", () => {
  /**
   * 15/10/2026 (passe de nuit, LECTEUR-1) : à 4 s, l'opération encore en cours était rejetée et la
   * file passait à la suivante sur un tampon occupé — `InvalidStateError` à coup sûr, trois de suite
   * et le film partait au lecteur serveur. Un fil principal bloqué 4,6 s suffisait.
   */
  it("un tampon occupé 5 s : la file attend, et rien ne part sur le tampon occupé", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    const queue = new BufferQueue(buffer);
    const first = queue.enqueue(() => {
      buffer.updating = true;
      setTimeout(() => {
        buffer.updating = false;
        buffer.dispatchEvent(new Event("updateend"));
      }, 5000);
    });
    const sentWhileBusy: boolean[] = [];
    const second = queue.enqueue(() => {
      sentWhileBusy.push(buffer.updating);
    });
    const verdict = first.then(
      () => "résolue",
      () => "rejetée"
    );
    await vi.advanceTimersByTimeAsync(4500);
    expect(sentWhileBusy).toEqual([]);
    await vi.advanceTimersByTimeAsync(600);
    expect(await verdict).toBe("résolue");
    await second;
    expect(sentWhileBusy).toEqual([false]);
  });

  it("une minuterie partie très en retard (fil principal bloqué) regarde de nouveau au lieu de conclure", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    const queue = new BufferQueue(buffer);
    const done = queue.enqueue(() => {
      buffer.updating = true;
    });
    // 29 s d'attente ordinaire, puis le fil principal bloqué 3 s : la minuterie des 30 s part en retard.
    await vi.advanceTimersByTimeAsync(28_500);
    const t = Date.now();
    vi.setSystemTime(t + 3000);
    await vi.advanceTimersByTimeAsync(1600);
    // Le `updateend` qui attendait derrière elle passe : l'opération est finie, pas abandonnée.
    buffer.updating = false;
    buffer.dispatchEvent(new Event("updateend"));
    await expect(done).resolves.toBeUndefined();
    expect(buffer.abort).not.toHaveBeenCalled();
  });

  it("toujours occupé au bout de 30 s : interrompu (`abort`), puis rejeté — la file reprend ensuite", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    buffer.abort = vi.fn(() => {
      // Comme un vrai : `updating` retombe, et `updateend` part ensuite.
      buffer.updating = false;
      queueMicrotask(() => buffer.dispatchEvent(new Event("updateend")));
    });
    const queue = new BufferQueue(buffer);
    const done = queue.enqueue(() => {
      buffer.updating = true; // commencé, jamais terminé
    });
    const verdict = done.then(
      () => "résolue",
      () => "rejetée"
    );
    await vi.advanceTimersByTimeAsync(29_000);
    expect(buffer.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(buffer.abort).toHaveBeenCalledTimes(1);
    expect(await verdict).toBe("rejetée");
    const next = vi.fn();
    await queue.enqueue(next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("passe si l'événement a seulement été manqué", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    const queue = new BufferQueue(buffer);
    const done = queue.enqueue(() => {
      buffer.updating = true;
      setTimeout(() => {
        buffer.updating = false; // fini, sans `updateend`
      }, 1000);
    });
    await vi.advanceTimersByTimeAsync(5000);
    await expect(done).resolves.toBeUndefined();
  });
});

describe("BufferQueue — fermeture", () => {
  it("n'exécute plus ce qui attendait quand la source est détruite", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    const queue = new BufferQueue(buffer);
    const removed = vi.fn();
    // Un envoi en cours, et derrière lui le retrait qu'un saut vient de mettre en file.
    void queue.enqueue(() => {
      buffer.updating = true;
    });
    const pending = queue.enqueue(removed);
    queue.close();
    buffer.updating = false;
    buffer.dispatchEvent(new Event("updateend"));
    await vi.advanceTimersByTimeAsync(0);
    await expect(pending).resolves.toBeUndefined();
    expect(removed).not.toHaveBeenCalled();
  });
});
