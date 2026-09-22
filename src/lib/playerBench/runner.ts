/**
 * Le banc d'essai du lecteur : des scénarios joués sur le vrai lecteur, film après film.
 *
 * Pourquoi un banc, et pourquoi sur l'appareil : chaque défaut sérieux de ce lecteur a été trouvé
 * par quelqu'un qui regardait un film, puis reconstitué à partir du journal. Le banc fait les mêmes
 * gestes que ce spectateur — ouvrir, sauter, mettre en pause, changer de langue, de sous-titres —
 * sur les fichiers qui ont déjà posé problème, et mesure ce que le navigateur en fait. Rien n'est
 * simulé : les gestes passent par le pont (`bridge.ts`) que le lecteur ouvre pour lui, c'est-à-dire
 * par le code même des commandes.
 *
 * Ce qu'une mesure ne peut pas dire — l'image et le son vont-ils ensemble, la langue a-t-elle
 * changé —, le banc le demande, quand on l'a lancé avec les questions.
 *
 * Tout ici passe par `BenchDeps` : l'horloge, l'attente, l'ouverture du lecteur, les questions.
 * C'est ce qui permet de le tester sans navigateur.
 */

import type { BenchBridge } from "./bridge";
import { trace } from "../webcodecs/trace";
import { seekArrived } from "../webcodecs/seekArrival";
import { readPlayback, seededPositions, worst, type Sample, type Verdict } from "./measure";

export interface BenchItem {
  itemId: string;
  title: string;
}

export type BenchDepth = "quick" | "full" | "extreme";

export interface BenchConfig {
  runId: string;
  items: BenchItem[];
  depth: BenchDepth;
  interactive: boolean;
}

export interface CheckResult {
  id: string;
  verdict: Verdict | "skip";
  /** Ce qui s'est passé, en français technique, comme le reste du journal du lecteur. */
  detail: string;
  ms?: number;
  /** La trace du lecteur, jointe à ce qui n'est pas passé. */
  steps?: string;
}

export interface ItemResult {
  itemId: string;
  title: string;
  /** « skip » : la question ne se pose pas — voir `handedOver`. */
  verdict: Verdict | "skip";
  path: string | null;
  openMs: number | null;
  durationSeconds: number;
  audioTracks: number;
  subtitleTracks: number;
  elapsedMs: number;
  checks: CheckResult[];
  facts: Record<string, unknown>;
}

export interface BenchQuestion {
  /** Traduit par l'écran : `bench.question.<id>`. */
  id: string;
  /** « tap » : un toucher est demandé pour lancer la lecture, que le navigateur a refusée. */
  kind: "yesno" | "tap";
  /** Appelé pendant le toucher lui-même, là où un navigateur accepte de lancer une lecture. */
  onTap?: () => void;
}

export interface BenchDeps {
  open(item: BenchItem): void;
  close(): void;
  bridge(): BenchBridge | null;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** « yes », « no » ou « skip ». */
  ask(question: BenchQuestion): Promise<string>;
  progress(itemIndex: number, step: string): void;
  cancelled(): boolean;
  report(result: ItemResult): void;
  /** La page est-elle cachée ? Sans réponse, on la suppose visible. */
  hidden?(): boolean;
  /** Ce film a-t-il déjà été confié au lecteur serveur ? Sans réponse, on suppose que non. */
  handedOver?(itemId: string): boolean;
}

class Cancelled extends Error {}

/** Le mode extrême a fini ses scénarios : le reste du parcours ordinaire ne se joue pas. */
class ExtremeDone extends Error {}

/** Le lecteur n'est plus le nôtre : erreur affichée, ou passage au lecteur serveur. */
class Lost extends Error {}

const SAMPLE_MS = 250;
const OPEN_TIMEOUT_MS = 45_000;
const ARRIVAL_TIMEOUT_MS = 15_000;
const SWITCH_TIMEOUT_MS = 20_000;
const STEPS_MAX = 3500;

/**
 * Au-delà, un saut est « lent », puis « en échec ». Relevé de 2,5 à 4 s le 22/09/2026 : la lecture
 * est toujours distante (serveur loin des spectateurs), et un saut en 4K doit faire venir le groupe
 * d'images depuis l'image clé précédente — 2 à 4 s de réseau, qui marquaient presque tous les sauts.
 */
const SEEK_SLOW_MS = 4000;
const SEEK_FAIL_MS = 8000;

/** Ce que coûte un film, en secondes, pour annoncer la durée avant de lancer. */
export function estimateSeconds(depth: BenchDepth, items: number, interactive: boolean): number {
  const perItem = depth === "full" ? 200 : depth === "extreme" ? 150 : 90;
  return items * (perItem + (interactive ? 30 : 0));
}

export async function runBench(config: BenchConfig, deps: BenchDeps): Promise<ItemResult[]> {
  const results: ItemResult[] = [];
  for (let index = 0; index < config.items.length; index++) {
    if (deps.cancelled()) break;
    const result = await runItem(config, deps, index);
    results.push(result);
    deps.report(result);
    deps.close();
    // Le temps que le lecteur se démonte : le suivant s'ouvrirait sinon sur ses restes.
    await deps.sleep(1500);
  }
  return results;
}

async function runItem(config: BenchConfig, deps: BenchDeps, index: number): Promise<ItemResult> {
  const item = config.items[index];
  const startedAt = deps.now();
  const checks: CheckResult[] = [];
  const result: ItemResult = {
    itemId: item.itemId,
    title: item.title,
    verdict: "ok",
    path: null,
    openMs: null,
    durationSeconds: 0,
    audioTracks: 0,
    subtitleTracks: 0,
    elapsedMs: 0,
    checks,
    facts: {},
  };
  const full = config.depth === "full";
  const step = (text: string) => deps.progress(index, text);

  // Confié au lecteur serveur — par une diffusion, ou parce que le lecteur natif n'a pas su porter
  // ce fichier. Le pont n'existera pas, et l'attendre 45 s pour conclure « échec » dirait le
  // contraire de ce qui s'est passé.
  if (deps.handedOver?.(item.itemId)) {
    checks.push({ id: "handed-over", verdict: "skip", detail: "confié au lecteur serveur : rien à mesurer ici" });
    result.verdict = "skip";
    result.elapsedMs = deps.now() - startedAt;
    return result;
  }

  const bridge = (): BenchBridge => {
    if (deps.cancelled()) throw new Cancelled();
    const b = deps.bridge();
    if (!b || b.itemId !== item.itemId) throw new Lost("le lecteur natif s'est fermé — passé au lecteur serveur ?");
    const error = b.error();
    if (error) throw new Lost(`erreur affichée : ${error}`);
    return b;
  };
  const media = () => {
    const element = bridge().media();
    if (!element) throw new Lost("aucun élément média");
    return element;
  };
  const time = () => media().currentTime;

  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<number | null> => {
    const start = deps.now();
    while (deps.now() - start < timeoutMs) {
      if (predicate()) return deps.now() - start;
      await deps.sleep(50);
    }
    return predicate() ? deps.now() - start : null;
  };

  const watch = async (ms: number) => {
    const samples: Sample[] = [];
    const end = deps.now() + ms;
    for (;;) {
      const element = media();
      samples.push({
        wall: deps.now(),
        time: element.currentTime,
        frames: bridge().frames(),
        paused: element.paused,
        seeking: element.seeking,
        hidden: deps.hidden?.() ?? false,
      });
      if (deps.now() >= end) break;
      await deps.sleep(SAMPLE_MS);
    }
    return readPlayback(samples, bridge().nominalFps());
  };

  const record = (check: CheckResult, traceMs?: number) => {
    if (check.verdict === "fail" || check.verdict === "warn") {
      try {
        check.steps = bridge().trace(traceMs ?? 15_000).slice(-STEPS_MAX);
      } catch {
        /* le lecteur est parti : la trace avec lui */
      }
    }
    checks.push(check);
  };

  const ask = async (id: string) => {
    if (!config.interactive) return;
    const answer = await deps.ask({ id, kind: "yesno" });
    if (answer === "skip") return;
    checks.push({ id: `question:${id}`, verdict: answer === "yes" ? "ok" : "fail", detail: answer === "yes" ? "oui" : "non" });
  };

  /** Ce que la dernière demande de geste a fait attendre — voir `ensurePlaying`. */
  let lastGestureWaitMs = 0;
  const ensurePlaying = async () => {
    lastGestureWaitMs = 0;
    const element = media();
    if (!element.paused) return;
    try {
      await element.play();
    } catch {
      /* refusée sans geste : voir plus bas */
    }
    if ((await waitFor(() => !media().paused, 1500)) !== null) return;
    // Le navigateur exige un geste. La question porte le geste : c'est pendant le toucher que
    // `play()` est appelé, là où il est accepté.
    // Mesuré à part : c'est le temps de la personne qui tient le téléphone, pas celui du lecteur —
    // un banc du 22/09/2026 a noté « rouvert en 393 s » pour six minutes passées à attendre un
    // toucher, le film ouvert en 0,3 s.
    const askedAt = deps.now();
    await deps.ask({ id: "tap", kind: "tap", onTap: () => void deps.bridge()?.media()?.play().catch(() => {}) });
    lastGestureWaitMs = deps.now() - askedAt;
    trace(`banc : lecture relancée par un geste, attendu ${lastGestureWaitMs} ms`);
    await waitFor(() => !media().paused, 3000);
  };

  /** Arrivé : plus de saut en cours, la tête près de la cible, le pipeline prêt. */
  const arrivedAt = (target: number) => () => {
    const b = bridge();
    const element = b.media();
    return !!element && b.ready() && !element.seeking && seekArrived(element.currentTime, target);
  };

  const seekCheck = async (id: string, target: number, watchMs: number) => {
    step(`saut ${id} → ${target.toFixed(0)} s`);
    const from = time();
    bridge().seek(target);
    const ms = await waitFor(arrivedAt(target), ARRIVAL_TIMEOUT_MS);
    if (ms === null) {
      record({ id, verdict: "fail", detail: `${from.toFixed(1)} → ${target.toFixed(1)} s : jamais arrivé (tête à ${time().toFixed(1)} s)`, ms: ARRIVAL_TIMEOUT_MS }, ARRIVAL_TIMEOUT_MS + 2000);
      return;
    }
    const landing = time() - target;
    const reading = await watch(watchMs);
    let verdict: Verdict = reading.verdict;
    const notes = [...reading.problems];
    if (ms > SEEK_FAIL_MS) {
      verdict = "fail";
      notes.push("arrivée très lente");
    } else if (ms > SEEK_SLOW_MS) {
      verdict = worst(verdict, "warn");
      notes.push("arrivée lente");
    }
    if (Math.abs(landing) > 1) {
      verdict = worst(verdict, "warn");
      notes.push(`tombé à ${landing > 0 ? "+" : ""}${landing.toFixed(1)} s de la cible`);
    }
    record(
      {
        id,
        verdict,
        ms,
        detail:
          `${from.toFixed(1)} → ${target.toFixed(1)} s en ${ms} ms, écart ${landing.toFixed(2)} s` +
          (reading.fps !== null ? `, ${reading.fps.toFixed(0)} im/s` : "") +
          (notes.length ? ` — ${notes.join(" ; ")}` : ""),
      },
      ms + watchMs + 2000
    );
  };

  /** Un changement de piste : jusqu'à ce que la nouvelle piste joue, au même endroit. */
  const switchAudio = async (id: string, track: number, expectAt: number, paused: boolean) => {
    const start = deps.now();
    bridge().changeAudio(track);
    // Jusqu'à ce que la tête soit revenue où elle était : le lecteur neuf se dit prêt un instant
    // avant d'y avoir posé sa tête, et la mesure lisait alors 0 s (banc du 22/09/2026). Ce que le
    // spectateur attend, c'est l'image au bon endroit.
    const near = () => Math.abs(time() - expectAt) < 3 + (paused ? 0 : (deps.now() - start) / 1000);
    const ms = await waitFor(() => {
      const b = bridge();
      const element = b.media();
      return !!element && b.ready() && b.currentAudio() === track && !element.seeking && (paused || !element.paused) && near();
    }, SWITCH_TIMEOUT_MS);
    if (ms === null) {
      const b = deps.bridge();
      record(
        {
          id,
          verdict: "fail",
          ms: SWITCH_TIMEOUT_MS,
          detail:
            `piste ${track} : pas rouvert au bon endroit en ${SWITCH_TIMEOUT_MS / 1000} s — attendu ${expectAt.toFixed(1)} s, ` +
            `tête à ${b?.media()?.currentTime.toFixed(1) ?? "?"} s, piste en cours ${b?.currentAudio() ?? "?"}, prêt ${b?.ready() ?? "?"}`,
        },
        SWITCH_TIMEOUT_MS + 2000
      );
      return false;
    }
    const at = time();
    const drift = at - expectAt;
    let verdict: Verdict = ms > 6000 ? "fail" : ms > 3000 ? "warn" : "ok";
    const notes: string[] = [];
    if (Math.abs(drift) > 3 + (paused ? 0 : (deps.now() - start) / 1000)) {
      verdict = "fail";
      notes.push(`position perdue : attendu ${expectAt.toFixed(1)} s, rouvert à ${at.toFixed(1)} s`);
    }
    if (paused && !media().paused) {
      verdict = "fail";
      notes.push("la pause n'a pas été gardée");
    }
    record({ id, verdict, ms, detail: `piste ${track} en ${ms} ms, à ${at.toFixed(1)} s${notes.length ? ` — ${notes.join(" ; ")}` : ""}` }, ms + 3000);
    return true;
  };

  /**
   * Le mode extrême : ce qu'aucun spectateur ne fait exprès, mais que des doigts pressés, un
   * réseau lent et un téléphone qui rame finissent par produire. Chaque scénario se termine sur
   * une question simple — la tête est-elle là où le dernier geste l'a demandée, sur la bonne piste,
   * et l'image repart-elle —, parce que c'est ce qu'un spectateur constate.
   */
  const extreme = async (D: number) => {
    const positions = seededPositions(`${item.itemId}:extreme`, 60, D);
    let cursor = 0;
    const next = () => positions[cursor++ % positions.length];

    const land = async (id: string, target: number, extra = "") => {
      const ms = await waitFor(arrivedAt(target), 20_000);
      if (ms === null) {
        record({ id, verdict: "fail", detail: `jamais arrivé à ${target.toFixed(1)} s (tête à ${time().toFixed(1)} s)${extra}` }, 25_000);
        return;
      }
      await ensurePlaying();
      const reading = await watch(3000);
      record(
        { id, verdict: worst(reading.verdict, ms > SEEK_FAIL_MS ? "warn" : "ok"), ms, detail: `arrivé à ${target.toFixed(1)} s en ${ms} ms${extra} — ${describe(reading)}` },
        ms + 5000
      );
    };

    await ensurePlaying();

    step("tempête : 20 sauts en 0,6 s");
    let last = 0;
    for (let i = 0; i < 20; i++) {
      last = next();
      bridge().seek(last);
      await deps.sleep(30);
    }
    await land("x-storm", last);

    step("aller-retour entre deux positions");
    const a = next();
    const b = next();
    for (let i = 0; i < 6; i++) {
      bridge().seek(i % 2 === 0 ? a : b);
      await deps.sleep(150);
    }
    await land("x-pingpong", b);

    step("petits pas de 0,2 s");
    let stepTarget = time();
    for (let i = 0; i < 10; i++) {
      stepTarget += 0.2;
      bridge().seek(stepTarget);
      await deps.sleep(60);
    }
    await land("x-steps", stepTarget);

    const tracks = bridge().audioTracks();
    if (tracks.length > 1) {
      step("saut, langue, saut");
      const other = tracks.find((t) => t.id !== bridge().currentAudio())!;
      bridge().seek(next());
      await deps.sleep(100);
      bridge().changeAudio(other.id);
      await deps.sleep(100);
      const target = next();
      bridge().seek(target);
      const applied = await waitFor(() => bridge().ready() && bridge().currentAudio() === other.id, 20_000);
      if (applied === null) {
        record({ id: "x-seek-audio-seek", verdict: "fail", detail: `piste ${other.id} jamais appliquée (piste ${bridge().currentAudio()})` }, 25_000);
      } else {
        await land("x-seek-audio-seek", target, `, piste ${other.id}`);
      }

      step("trois langues en 0,6 s");
      let wanted = bridge().currentAudio();
      // La position d'avant la rafale : c'est là que le film doit rouvrir, pas où il est après.
      const before = time();
      for (let i = 0; i < 3; i++) {
        const o = tracks.find((t) => t.id !== wanted)!;
        wanted = o.id;
        bridge().changeAudio(o.id);
        await deps.sleep(200);
      }
      const ms = await waitFor(() => {
        const bb = bridge();
        const m = bb.media();
        return bb.ready() && bb.currentAudio() === wanted && !!m && !m.seeking && Math.abs(m.currentTime - before) < 10;
      }, 25_000);
      if (ms === null) {
        record({ id: "x-audio-storm", verdict: "fail", detail: `la dernière piste demandée (${wanted}) n'est jamais devenue celle qui joue (piste ${bridge().currentAudio()}, prêt ${bridge().ready()})` }, 30_000);
      } else {
        await ensurePlaying();
        const reading = await watch(3000);
        record({ id: "x-audio-storm", verdict: worst(reading.verdict, "ok"), ms, detail: `piste ${wanted} en place en ${ms} ms, à ${time().toFixed(1)} s — ${describe(reading)}` }, ms + 5000);
      }
    }

    step("pause et lecture en rafale pendant un saut");
    const paused = next();
    bridge().seek(paused);
    for (let i = 0; i < 8; i++) {
      const m = media();
      if (i % 2 === 0) m.pause();
      else void m.play().catch(() => {});
      await deps.sleep(80);
    }
    await land("x-pause-storm", paused);

    const subs = bridge().subtitleTracks();
    if (subs.length > 0) {
      step("sous-titres en rafale pendant un saut");
      const target = next();
      bridge().seek(target);
      let choice: number | null = null;
      for (let i = 0; i < 6; i++) {
        choice = i % 2 === 0 ? subs[i % subs.length].id : null;
        bridge().changeSubtitle(choice);
        await deps.sleep(70);
      }
      await land("x-subs-storm", target);
      if (bridge().currentSubtitle() !== choice) {
        record({ id: "x-subs-storm", verdict: "fail", detail: `sous-titres : ${bridge().currentSubtitle()} au lieu du dernier choix (${choice})` });
      }
    }

    step("bords du film");
    bridge().seek(0.5);
    await land("x-edge-start", 0.5);
    const nearEnd = Math.max(0, D - 4);
    bridge().seek(nearEnd);
    const endArrived = await waitFor(arrivedAt(nearEnd), 20_000);
    await ensurePlaying();
    const ended = endArrived === null ? null : await waitFor(() => media().ended || time() >= D - 0.5, 10_000);
    record({
      id: "x-edge-end",
      verdict: endArrived === null ? "fail" : ended === null ? "warn" : "ok",
      detail: endArrived === null ? `fin du film jamais atteinte (tête à ${time().toFixed(1)} s)` : ended === null ? `arrivé près de la fin, mais la lecture ne l'a pas atteinte (tête à ${time().toFixed(1)} s)` : `lu jusqu'à la fin (${time().toFixed(1)} s)`,
    }, 15_000);
    const back = D * 0.5;
    bridge().seek(back);
    await land("x-after-end", back);
    bridge().seek(D + 100);
    const clamped = await waitFor(() => !media().seeking && time() >= D - 3, 10_000);
    record({ id: "x-beyond-end", verdict: clamped === null ? "warn" : "ok", detail: clamped === null ? `saut au-delà de la fin : tête à ${time().toFixed(1)} s` : `ramené à la fin (${time().toFixed(1)} s)` });

    step("fermer et rouvrir aussitôt");
    deps.close();
    await deps.sleep(250);
    const reopenStart = deps.now();
    deps.open(item);
    const reopened = await waitFor(() => {
      const bb = deps.bridge();
      if (bb?.itemId === item.itemId && bb.error()) throw new Lost(`erreur à la réouverture : ${bb.error()}`);
      return bb?.itemId === item.itemId && bb.ready();
    }, OPEN_TIMEOUT_MS);
    if (reopened === null) {
      record({ id: "x-reopen", verdict: "fail", detail: "pas de première image après une réouverture immédiate" });
      return;
    }
    const firstImageMs = deps.now() - reopenStart;
    await ensurePlaying();
    const reading = await watch(3000);
    record({
      id: "x-reopen",
      verdict: worst(reading.verdict, firstImageMs > 8000 ? "warn" : "ok"),
      ms: firstImageMs,
      detail:
        `première image en ${firstImageMs} ms` +
        (lastGestureWaitMs > 0 ? `, puis ${Math.round(lastGestureWaitMs / 1000)} s à attendre un toucher (Safari exige un geste)` : "") +
        ` — ${describe(reading)}`,
    });
  };

  try {
    // ── Ouverture ──────────────────────────────────────────────────────────────────────────────
    step("ouverture");
    const openStart = deps.now();
    deps.open(item);
    const opened = await waitFor(() => {
      if (deps.cancelled()) throw new Cancelled();
      const b = deps.bridge();
      if (b?.itemId === item.itemId && b.error()) throw new Lost(`erreur à l'ouverture : ${b.error()}`);
      return b?.itemId === item.itemId && b.ready();
    }, OPEN_TIMEOUT_MS);
    if (opened === null) throw new Lost(`pas de première image en ${OPEN_TIMEOUT_MS / 1000} s — lecteur serveur ou blocage`);
    result.openMs = deps.now() - openStart;
    const b0 = bridge();
    result.path = b0.path();
    result.durationSeconds = Math.round(b0.duration());
    result.audioTracks = b0.audioTracks().length;
    result.subtitleTracks = b0.subtitleTracks().length;
    record({
      id: "open",
      verdict: result.openMs > 8000 ? "fail" : result.openMs > 4000 ? "warn" : "ok",
      ms: result.openMs,
      detail: `chemin ${result.path}, première image en ${result.openMs} ms, ${result.durationSeconds} s, ${result.audioTracks} piste(s) audio, ${result.subtitleTracks} sous-titre(s)`,
    });
    await ensurePlaying();

    // ── Lecture au début ───────────────────────────────────────────────────────────────────────
    step("lecture");
    // Après l'atterrissage : un film ouvert à 0 pose sa tête sur son premier média, 1,3 s plus
    // loin dans un fichier à images B, et ce pas-là n'est pas un saut (banc du 22/09/2026).
    await waitFor(() => time() > 0.5, 3000);
    const start = await watch(full ? 10_000 : 6000);
    record({ id: "play", verdict: start.verdict, detail: describe(start) });

    const D = result.durationSeconds;
    if (config.depth === "extreme") {
      if (D < 120) record({ id: "seeks", verdict: "skip", detail: "trop court pour le mode extrême" });
      else await extreme(D);
      throw new ExtremeDone();
    }
    if (D < 60) {
      record({ id: "seeks", verdict: "skip", detail: "trop court pour les sauts" });
    } else {
      // ── Sauts ────────────────────────────────────────────────────────────────────────────────
      const watchMs = full ? 4000 : 3000;
      await seekCheck("seek-far", D * 0.5, watchMs);
      // La synchro se juge au milieu d'un film, sur des visages qui parlent — pas sur un générique
      // d'ouverture, où il n'y a rien à comparer (remarque du 22/09/2026).
      await ask("sync");
      await seekCheck("seek-back-10", Math.max(5, time() - 10), watchMs);
      await ask("seekPicture");
      await seekCheck("seek-forward-30", Math.min(D - 40, time() + 30), watchMs);
      const random = seededPositions(item.itemId, full ? 5 : 2, D);
      for (let i = 0; i < random.length; i++) await seekCheck(`seek-random-${i + 1}`, random[i], watchMs);
      await seekCheck("seek-back-far", D * 0.1, watchMs);
      if (full) await seekCheck("seek-near-end", D - 45, watchMs);
      await seekCheck("seek-return", D * 0.3, watchMs);

      // ── Rafale : le doigt qui glisse sur la barre ────────────────────────────────────────────
      step("rafale de sauts");
      const burst = [0.2, 0.28, 0.36, 0.44, 0.52].map((f) => D * f);
      for (const target of burst) {
        bridge().seek(target);
        await deps.sleep(120);
      }
      const final = burst[burst.length - 1];
      const burstMs = await waitFor(arrivedAt(final), ARRIVAL_TIMEOUT_MS);
      if (burstMs === null) {
        record({ id: "burst", verdict: "fail", detail: `cinq sauts en 0,6 s : jamais arrivé à ${final.toFixed(1)} s (tête à ${time().toFixed(1)} s)` }, ARRIVAL_TIMEOUT_MS + 3000);
      } else {
        const reading = await watch(3000);
        record({ id: "burst", verdict: worst(reading.verdict, burstMs > 5000 ? "warn" : "ok"), ms: burstMs, detail: `arrivé au dernier en ${burstMs} ms — ${describe(reading)}` }, burstMs + 5000);
      }

      // ── Pause ─────────────────────────────────────────────────────────────────────────────────
      step("pause");
      media().pause();
      await deps.sleep(400);
      const held = time();
      await deps.sleep(3000);
      const drift = Math.abs(time() - held);
      const resumeFrom = time();
      const resumeStart = deps.now();
      await media().play().catch(() => {});
      const resumed = await waitFor(() => time() > resumeFrom + 0.2, 4000);
      if (resumed === null) await ensurePlaying();
      const after = await watch(3000);
      let pauseVerdict: Verdict = drift > 0.3 ? "fail" : "ok";
      if (resumed === null) pauseVerdict = "fail";
      else if (resumed > 1500) pauseVerdict = worst(pauseVerdict, "warn");
      record({
        id: "pause",
        verdict: worst(pauseVerdict, after.verdict),
        ms: resumed ?? undefined,
        detail: `dérive en pause ${drift.toFixed(2)} s, reprise en ${resumed ?? "—"} ms (${deps.now() - resumeStart} ms avec la mesure) — ${describe(after)}`,
      });

      // ── Saut pendant la pause ────────────────────────────────────────────────────────────────
      step("saut en pause");
      media().pause();
      const pausedTarget = D * 0.55;
      bridge().seek(pausedTarget);
      const pausedMs = await waitFor(arrivedAt(pausedTarget), ARRIVAL_TIMEOUT_MS);
      await deps.sleep(1000);
      const stillPaused = media().paused;
      const pausedDrift = Math.abs(time() - pausedTarget);
      await media().play().catch(() => {});
      await ensurePlaying();
      const afterPaused = await watch(3000);
      record({
        id: "paused-seek",
        verdict: worst(pausedMs === null || !stillPaused || pausedDrift > 1.5 ? "fail" : "ok", afterPaused.verdict),
        ms: pausedMs ?? undefined,
        detail:
          `arrivé en ${pausedMs ?? "—"} ms, ${stillPaused ? "resté en pause" : "reparti seul"}, écart ${pausedDrift.toFixed(2)} s — ` +
          describe(afterPaused),
      });
    }

    // ── Pistes audio ───────────────────────────────────────────────────────────────────────────
    const tracks = bridge().audioTracks();
    const original = bridge().currentAudio();
    const others = tracks.filter((t) => t.id !== original).slice(0, full ? 3 : 1);
    if (others.length === 0) {
      record({ id: "audio", verdict: "skip", detail: "une seule piste audio" });
    } else {
      let asked = false;
      for (const track of others) {
        step(`piste audio ${track.label}`);
        await ensurePlaying();
        if (!(await switchAudio(`audio-${track.id}`, track.id, time(), false))) continue;
        const reading = await watch(full ? 5000 : 3000);
        record({ id: `audio-${track.id}-play`, verdict: reading.verdict, detail: describe(reading) });
        if (!asked) {
          asked = true;
          await ask("audioSwitch");
        }
      }
      if (D >= 60) {
        // Le cas qui perdait un geste sur deux (22/09/2026) : un saut encore en chargement, et
        // la langue changée aussitôt.
        step("saut puis piste aussitôt");
        const target = D * 0.7;
        bridge().seek(target);
        const next = tracks.find((t) => t.id !== bridge().currentAudio());
        if (next) {
          await switchAudio("seek-then-audio", next.id, target, false);
          await watch(2000);
        }
        step("piste en pause");
        media().pause();
        await deps.sleep(300);
        // Vers une autre piste que celle qui joue, quelle qu'elle soit : c'est la pause qui est
        // mise à l'épreuve, pas la piste.
        const other = tracks.find((t) => t.id !== bridge().currentAudio());
        if (other) await switchAudio("audio-paused", other.id, time(), true);
        await deps.sleep(800);
        await media().play().catch(() => {});
        await ensurePlaying();
        const reading = await watch(3000);
        record({ id: "audio-back-play", verdict: reading.verdict, detail: describe(reading) });
      }
    }

    // ── Sous-titres ───────────────────────────────────────────────────────────────────────────
    const subtitles = bridge().subtitleTracks().slice(0, full ? 2 : 1);
    if (subtitles.length === 0) {
      record({ id: "subtitles", verdict: "skip", detail: "aucun sous-titre" });
    } else {
      const before = bridge().currentSubtitle();
      let askedSubs = false;
      for (const track of subtitles) {
        step(`sous-titres ${track.label}`);
        bridge().changeSubtitle(track.id);
        const applied = await waitFor(() => bridge().currentSubtitle() === track.id, 5000);
        // Le texte vient avec les segments : on regarde s'il en passe pendant quelques secondes.
        let seen = false;
        const until = deps.now() + (full ? 8000 : 5000);
        while (deps.now() < until) {
          if (bridge().subtitleText()) seen = true;
          await deps.sleep(SAMPLE_MS);
        }
        record({
          id: `subtitles-${track.id}`,
          verdict: applied === null ? "fail" : "ok",
          detail: `${track.label} : ${applied === null ? "jamais appliqué" : `appliqué en ${applied} ms`}, ${seen ? "texte affiché" : "aucun texte vu (peut-être un passage sans dialogue)"}`,
        });
        if (!askedSubs && seen) {
          askedSubs = true;
          await ask("subtitles");
        }
      }
      bridge().changeSubtitle(before);
    }

    // ── Lecture longue ─────────────────────────────────────────────────────────────────────────
    if (full) {
      step("lecture longue");
      await ensurePlaying();
      const long = await watch(30_000);
      record({ id: "long-play", verdict: long.verdict, detail: describe(long) }, 32_000);
      await ask("picture");
    }
  } catch (error) {
    if (error instanceof ExtremeDone) {
      // Fini : rien à noter.
    } else if (error instanceof Cancelled) {
      checks.push({ id: "cancelled", verdict: "skip", detail: "banc arrêté" });
    } else {
      const b = deps.bridge();
      checks.push({
        id: "lost",
        verdict: "fail",
        detail: error instanceof Error ? error.message : String(error),
        steps: b?.itemId === item.itemId ? b.trace(20_000).slice(-STEPS_MAX) : undefined,
      });
    }
  }

  try {
    const b = deps.bridge();
    if (b?.itemId === item.itemId) result.facts = b.facts();
  } catch {
    /* rien à ajouter */
  }
  result.elapsedMs = deps.now() - startedAt;
  result.verdict = checks.reduce<Verdict>((acc, c) => (c.verdict === "skip" ? acc : worst(acc, c.verdict)), "ok");

  return result;
}

function describe(reading: ReturnType<typeof readPlayback>): string {
  return (
    `${reading.clockSeconds.toFixed(1)} s de film en ${reading.wallSeconds.toFixed(1)} s` +
    (reading.fps !== null ? `, ${reading.fps.toFixed(0)} im/s` : "") +
    (reading.problems.length ? ` — ${reading.problems.join(" ; ")}` : "")
  );
}
