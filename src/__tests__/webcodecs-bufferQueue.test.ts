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
  return Object.assign(new EventTarget(), { updating: false, appendBuffer: vi.fn() }) as unknown as SourceBuffer & {
    updating: boolean;
  };
}

afterEach(() => vi.useRealTimers());

describe("BufferQueue — échéance", () => {
  it("échoue si le tampon est toujours occupé à l'échéance", async () => {
    vi.useFakeTimers();
    const buffer = fakeBuffer();
    const queue = new BufferQueue(buffer);
    const done = queue.enqueue(() => {
      buffer.updating = true; // commencé, jamais terminé
    });
    const verdict = done.then(
      () => "résolue",
      () => "rejetée"
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await verdict).toBe("rejetée");
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
