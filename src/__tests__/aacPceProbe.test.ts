// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";

// La question « ce navigateur prend-il un AAC à PCE tel quel ? » (DECISIONS.md §62, couche 4) : un
// vrai envoi, la réponse gardée par navigateur, jamais d'exception, jamais sur le chemin d'une
// ouverture.

/** Une MediaSource de test : ouverte aussitôt, son tampon accepte ou refuse le segment d'initialisation. */
function fakeSource(accepts: boolean, opens = true) {
  return class FakeSource extends EventTarget {
    static isTypeSupported = () => true;
    readyState = "closed";
    constructor() {
      super();
      if (opens)
        setTimeout(() => {
          this.readyState = "open";
          this.dispatchEvent(new Event("sourceopen"));
        }, 0);
    }
    addSourceBuffer() {
      const source = this;
      const buffer = Object.assign(new EventTarget(), {
        buffered: { length: 0 },
        appended: 0,
        appendBuffer() {
          buffer.appended++;
          setTimeout(() => {
            if (!accepts) {
              buffer.dispatchEvent(new Event("error"));
              source.readyState = "ended";
              source.dispatchEvent(new Event("sourceended"));
              return;
            }
            if (buffer.appended === 2) buffer.buffered = { length: 1 };
            buffer.dispatchEvent(new Event("updateend"));
          }, 0);
        },
      });
      return buffer;
    }
  };
}

async function load(Source: unknown) {
  vi.resetModules();
  // jsdom n'implémente pas `load()` ; la sonde l'appelle en se défaisant de son élément.
  HTMLMediaElement.prototype.load = () => {};
  (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource = Source;
  return import("@/lib/webcodecs/aacPceProbe");
}

afterEach(() => {
  delete (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource;
  localStorage.clear();
  vi.useRealTimers();
});

describe("la sonde du PCE", () => {
  it("un navigateur qui refuse le segment d'initialisation (Chromium) : non, et c'est gardé", async () => {
    const probe = await load(fakeSource(false));
    await expect(probe.probePceCopy()).resolves.toBe(false);
    expect(probe.pceCopyAccepted()).toBe(false);
  });

  it("un navigateur qui tamponne le PCE et sa trame : oui, et c'est gardé", async () => {
    const probe = await load(fakeSource(true));
    await expect(probe.probePceCopy()).resolves.toBe(true);
    expect(probe.pceCopyAccepted()).toBe(true);
  });

  it("une réponse ne vaut que pour le navigateur qui l'a donnée", async () => {
    const probe = await load(fakeSource(true));
    localStorage.setItem(probe.__testing.STORAGE_KEY, JSON.stringify({ ua: "un autre navigateur", ok: true }));
    expect(probe.pceCopyAccepted()).toBeNull();
  });

  it("une sonde qui n'aboutit pas ne répond rien — la question sera reposée", async () => {
    vi.useFakeTimers();
    const probe = await load(fakeSource(true, false));
    const answer = probe.probePceCopy();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(answer).resolves.toBeNull();
    expect(probe.pceCopyAccepted()).toBeNull();
  });

  it("sans MediaSource : rien à demander, rien de levé", async () => {
    const probe = await load(undefined);
    const saved = (window as unknown as { MediaSource?: unknown }).MediaSource;
    delete (window as unknown as { MediaSource?: unknown }).MediaSource;
    await expect(probe.probePceCopy()).resolves.toBeNull();
    (window as unknown as { MediaSource?: unknown }).MediaSource = saved;
  });

  it("un stockage illisible ne fait pas lever la lecture de la réponse", async () => {
    const probe = await load(fakeSource(true));
    localStorage.setItem(probe.__testing.STORAGE_KEY, "{pas du json");
    expect(probe.pceCopyAccepted()).toBeNull();
  });

  it("une seule question à la fois, et aucune quand la réponse est connue", async () => {
    const Source = fakeSource(true);
    const spy = vi.fn();
    class Counting extends Source {
      constructor() {
        super();
        spy();
      }
    }
    const probe = await load(Counting);
    probe.primePceProbe();
    probe.primePceProbe();
    await vi.waitFor(() => expect(probe.pceCopyAccepted()).toBe(true));
    probe.primePceProbe();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
