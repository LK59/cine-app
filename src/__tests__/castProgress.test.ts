import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CastProgressRelay,
  CAST_BUFFER_MARGIN_SECONDS,
  IDLE_FORGET_MS,
  MAX_ENTRIES,
  PAGE_FRESH_MS,
  REPORT_EVERY_MS,
  SILENCE_STOP_MS,
  deducedPosition,
  segmentStartSeconds,
} from "@/lib/castProgress";

// DECISIONS.md §64 — la reprise d'une diffusion, gardée par le serveur quand la page s'est tue.

const JF = "jf-louis";
const ITEM = "a".repeat(32);

/** Un segment comme Jellyfin les écrit (relevé sur le vrai serveur le 11/10/2026). */
function segment(index: number, startSeconds: number) {
  return {
    restPath: `hls1/main/${index}.mp4`,
    search: new URLSearchParams(`MediaSourceId=x&PlaySessionId=p&runtimeTicks=${Math.round(startSeconds * 10_000_000)}&actualSegmentLengthTicks=30000000&castToken=t`),
  };
}

function relay() {
  const save = vi.fn(async (..._args: unknown[]) => "position");
  const log = vi.fn();
  return { r: new CastProgressRelay({ save, log }), save, log };
}

const pass = (s: { restPath: string; search: URLSearchParams }, jfId: string | null = JF) => ({ jfId, user: "louis", itemId: ITEM, ...s });

beforeEach(() => vi.clearAllMocks());

describe("segmentStartSeconds — la position que Jellyfin écrit dans l'adresse", () => {
  it("lit runtimeTicks d'un segment vidéo numéroté", () => {
    const s = segment(400, 1200);
    expect(segmentStartSeconds(s.restPath, s.search)).toBe(1200);
    expect(segmentStartSeconds("hls1/main/0.ts", new URLSearchParams("runtimeTicks=0"))).toBe(0);
  });

  it("ignore le segment d'initialisation, les manifestes, les sous-titres et une adresse sans position", () => {
    expect(segmentStartSeconds("hls1/main/-1.mp4", new URLSearchParams("runtimeTicks=0"))).toBeNull();
    expect(segmentStartSeconds("main.m3u8", new URLSearchParams("runtimeTicks=10"))).toBeNull();
    expect(segmentStartSeconds("hls1/subs/3.vtt", new URLSearchParams("runtimeTicks=10"))).toBeNull();
    expect(segmentStartSeconds("hls1/main/3.mp4", new URLSearchParams(""))).toBeNull();
    expect(segmentStartSeconds("hls1/main/3.mp4", new URLSearchParams("runtimeTicks=abc"))).toBeNull();
  });

  it("retranche la marge d'avance du récepteur, jamais sous zéro", () => {
    expect(CAST_BUFFER_MARGIN_SECONDS).toBe(30);
    expect(deducedPosition(1200)).toBe(1170);
    expect(deducedPosition(12)).toBe(0);
  });
});

describe("le relais", () => {
  it("page active → serveur muet : aucun rapport, aucune ligne au journal", () => {
    const { r, save, log } = relay();
    let now = 1_000_000;
    r.notePageReport(JF, ITEM, now);
    for (let i = 0; i < 20; i++) {
      now += 3_000;
      r.noteCastSegment(pass(segment(i, i * 3)), now);
      if (i % 3 === 0) r.notePageReport(JF, ITEM, now); // la page bat toutes les dix secondes
    }
    expect(save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    // …mais la position est suivie, pour un relais immédiat si la page se tait.
    expect(r.entry(JF, ITEM)?.position).toBe(deducedPosition(19 * 3));
  });

  it("la page se tait : le serveur prend le relais après une minute, le dit au journal, rapporte la position", () => {
    const { r, save, log } = relay();
    const t0 = 2_000_000;
    r.notePageReport(JF, ITEM, t0);
    r.noteCastSegment(pass(segment(600, 1800)), t0 + PAGE_FRESH_MS - 1);
    expect(save).not.toHaveBeenCalled();
    r.noteCastSegment(pass(segment(601, 1803)), t0 + PAGE_FRESH_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(JF, ITEM, "progress", Math.floor(1773 * 10_000_000));
    expect(log).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("louis", expect.objectContaining({ itemId: ITEM, serverRelay: true, cast: true, player: "serveur", at: 1773 }));
  });

  it("au plus un rapport toutes les 30 s par diffusion", () => {
    const { r, save, log } = relay();
    let now = 3_000_000;
    for (let i = 0; i < 40; i++) {
      r.noteCastSegment(pass(segment(i, i * 3)), now);
      now += 3_000; // un segment de 3 s, demandé au rythme de la lecture
    }
    // 120 s de segments : un rapport au premier, puis un toutes les 30 s.
    expect(save).toHaveBeenCalledTimes(Math.floor((39 * 3_000) / REPORT_EVERY_MS) + 1);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("la page revient : le serveur se tait à nouveau", () => {
    const { r, save } = relay();
    let now = 4_000_000;
    r.noteCastSegment(pass(segment(1, 3)), now);
    expect(save).toHaveBeenCalledTimes(1);
    now += REPORT_EVERY_MS;
    r.notePageReport(JF, ITEM, now);
    r.noteCastSegment(pass(segment(11, 33)), now + 1);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("un laissez-passer d'avant (sans identifiant Jellyfin) : rien, comme avant", () => {
    const { r, save, log } = relay();
    r.noteCastSegment(pass(segment(1, 3), null), 5_000_000);
    expect(save).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(r.size).toBe(0);
  });

  it("une adresse qui n'est pas un segment ne compte pas", () => {
    const { r, save } = relay();
    r.noteCastSegment(pass({ restPath: "main.m3u8", search: new URLSearchParams("castToken=t") }), 6_000_000);
    r.noteCastSegment(pass({ restPath: "hls1/main/-1.mp4", search: new URLSearchParams("runtimeTicks=0") }), 6_000_000);
    expect(save).not.toHaveBeenCalled();
    expect(r.size).toBe(0);
  });

  it("une erreur de Jellyfin ne remonte jamais sur le chemin du flux", async () => {
    const save = vi.fn(async () => {
      throw new Error("Jellyfin muet");
    });
    const r = new CastProgressRelay({ save, log: vi.fn() });
    expect(() => r.noteCastSegment(pass(segment(1, 100)), 7_000_000)).not.toThrow();
    await Promise.resolve();
  });
});

describe("l'arrêt", () => {
  it("plus rien demandé pendant 90 s, page muette : l'arrêt à la dernière position — Jellyfin applique ses seuils", () => {
    const { r, save, log } = relay();
    const t0 = 8_000_000;
    r.noteCastSegment(pass(segment(2390, 7170)), t0);
    save.mockClear();
    log.mockClear();
    r.sweep(t0 + SILENCE_STOP_MS - 1);
    expect(save).not.toHaveBeenCalled();
    r.sweep(t0 + SILENCE_STOP_MS);
    expect(save).toHaveBeenCalledWith(JF, ITEM, "stop", Math.floor(7140 * 10_000_000));
    expect(log).toHaveBeenCalledWith("louis", expect.objectContaining({ serverRelay: true, reason: "relais du serveur — arrêt", at: 7140 }));
    expect(r.size).toBe(0);
  });

  it("pas d'arrêt si le serveur n'a jamais pris le relais : la page enverra le sien", () => {
    const { r, save } = relay();
    const t0 = 9_000_000;
    r.notePageReport(JF, ITEM, t0);
    r.noteCastSegment(pass(segment(10, 30)), t0 + 1);
    r.sweep(t0 + SILENCE_STOP_MS + 1);
    expect(save).not.toHaveBeenCalled();
    // Oubliée après dix minutes sans nouvelles.
    r.sweep(t0 + IDLE_FORGET_MS + 2);
    expect(r.size).toBe(0);
  });

  it("pas d'arrêt tant que la page parle", () => {
    const { r, save } = relay();
    const t0 = 10_000_000;
    r.noteCastSegment(pass(segment(10, 30)), t0);
    save.mockClear();
    r.notePageReport(JF, ITEM, t0 + SILENCE_STOP_MS - 1);
    r.sweep(t0 + SILENCE_STOP_MS);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("un état borné", () => {
  it("au plus MAX_ENTRIES diffusions suivies, les plus anciennes oubliées d'abord", () => {
    const { r } = relay();
    for (let i = 0; i <= MAX_ENTRIES + 10; i++) r.noteCastSegment({ jfId: `jf-${i}`, user: `u${i}`, itemId: ITEM, ...segment(1, 3) }, 11_000_000 + i);
    expect(r.size).toBe(MAX_ENTRIES);
    expect(r.entry("jf-0", ITEM)).toBeUndefined();
    expect(r.entry(`jf-${MAX_ENTRIES + 10}`, ITEM)).toBeDefined();
  });
});
