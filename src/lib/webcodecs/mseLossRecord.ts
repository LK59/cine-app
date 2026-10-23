// Le relevé d'une perte de `MseSource` : les tampons au dernier envoi réussi, les fragments vidéo
// envoyés depuis le dernier vidage, l'état et les faits de l'échec au premier signal — ce que porte
// une ligne `rebuild`. Purement informatif : rien du lecteur ne le lit hors du journal. Sorti de
// mseSource.ts tel quel ; la source lui prête une vue étroite d'elle-même (`LossHost`).

import { traceRecent } from "./trace";
import { fragmentTimes } from "./fragmentProbe";
import { SENT_FRAGMENTS_KEPT, STALL_TRACE_MS } from "./mseTuning";
import { signed, spansAll } from "./mseSpans";

/** Un fragment vidéo envoyé — voir `LossRecord.sentFragments`. */
export type SentFragment = { n: number; seq: number | null; dts: number; pts: number; at: number };

/** Ce que le relevé lit de la source : l'élément, ses deux tampons, et son état en peu de champs. */
export interface LossHost {
  readonly video: HTMLVideoElement;
  readonly videoBuffer: SourceBuffer | null;
  readonly audioBuffer: SourceBuffer | null;
  stateFacts(now: number): Record<string, unknown>;
}

export class LossRecord {
  constructor(private readonly host: LossHost) {}

  /**
   * Les plages des deux tampons après la dernière opération réussie — envoi ou retrait —, pour la
   * ligne d'une perte (`failureFacts`).
   *
   * Relevées à ce moment-là parce qu'après la fermeture de la source elles ne se lisent plus : le
   * « Media failed to decode » de Lucifer S01E05 sur un iPhone (14/10/2026) n'a laissé que
   * « illisible (source fermée) », la source étant déjà fermée quand l'élément a signalé son
   * erreur. Purement informatif : rien ne lit ce relevé hors du journal.
   */
  private lastGoodBuffered: { at: number; after: string; video: string; audio: string } | null = null;
  /**
   * Les derniers fragments vidéo envoyés depuis le dernier vidage : numéro, début (dts/pts, horloge
   * de l'élément) et rang depuis le saut — de quoi dire, à l'échec, dans quel fragment était la
   * tête et lequel venait de partir. Bornés, et vidés avec les tampons qu'ils décrivent.
   */
  sentFragments: SentFragment[] = [];
  fragmentsSinceSeek = 0;
  /** Les faits propres à l'échec, relevés avec `lossSnapshot` — voir `failureFacts`. */
  private lossFailure: Record<string, unknown> | null = null;

  /**
   * L'état au moment où la plateforme a lâché la source, gardé pour la ligne `rebuild`.
   *
   * Pris ici et pas au moment d'écrire la ligne : l'hôte ne l'apprend qu'au prochain envoi refusé,
   * quand les tampons sont déjà détachés et illisibles. Le 23/09/2026, trois « Media failed to
   * decode » sur un iPhone 12 (Love Story, 4K) n'ont laissé que leur motif — ni les tampons, ni ce
   * qui venait d'être envoyé —, et rien ne permettait de dire si nos données y étaient pour
   * quelque chose. Le premier des deux événements l'emporte : c'est lui qui a vu les tampons.
   */
  private lossSnapshot: Record<string, unknown> | null = null;

  noteLoss(): void {
    // Relevés au premier signal, comme l'état : c'est lui qui a vu l'élément au moment de l'échec.
    this.lossFailure ??= this.failureFacts();
    if (this.lossSnapshot) return;
    try {
      this.lossSnapshot = this.host.stateFacts(this.host.video.currentTime);
    } catch {
      /* le journal ne vaut pas un lecteur */
    }
  }

  /**
   * Ce qu'un échec de décodage laisse à dire, en plus de l'état (14/10/2026) : les tampons au
   * dernier envoi réussi, les images comptées par l'élément, son message d'erreur, et la place de
   * la tête dans les fragments envoyés — pour dire si c'est l'image ou le son qui a lâché, et où.
   *
   * Chaque fait dans sa propre garde : une lecture qui lève perd ce fait-là, jamais les autres, et
   * jamais la ligne. Ne lève pas.
   */
  private failureFacts(): Record<string, unknown> {
    const facts: Record<string, unknown> = {};
    const now = Date.now();
    let head = NaN;
    try {
      head = this.host.video.currentTime;
    } catch {
      /* rien */
    }
    try {
      const seen = this.lastGoodBuffered;
      if (seen) {
        facts.lastBuffered = `vidéo ${seen.video} · audio ${seen.audio} — après ${seen.after}, ${now - seen.at} ms avant`;
      }
    } catch {
      /* rien */
    }
    try {
      const quality = this.host.video.getVideoPlaybackQuality?.();
      if (quality) {
        const corrupted = (quality as { corruptedVideoFrames?: number }).corruptedVideoFrames;
        facts.videoQuality =
          `total ${quality.totalVideoFrames} · perdues ${quality.droppedVideoFrames}` +
          (typeof corrupted === "number" ? ` · corrompues ${corrupted}` : "");
      }
    } catch {
      /* rien */
    }
    try {
      const failure = this.host.video.error;
      if (failure) facts.mediaError = `${failure.code}${failure.message ? ` « ${failure.message.slice(0, 300)} »` : ""}`;
    } catch {
      /* rien */
    }
    try {
      const last = this.sentFragments.at(-1);
      if (last) {
        const offset = Number.isFinite(head) ? ` · tête ${signed(head - last.pts)} s` : "";
        facts.lastFragment =
          `n°${last.seq ?? "?"} (${last.n}e depuis le saut) dts ${last.dts.toFixed(3)} pts ${last.pts.toFixed(3)}` +
          `${offset} · envoyé ${now - last.at} ms avant`;
      }
      if (Number.isFinite(head)) {
        // Celui dont la première image est la dernière à ne pas dépasser la tête : le fragment
        // qui la contient, si la tête est bien dans ce qui a été envoyé depuis le vidage.
        let under: (typeof this.sentFragments)[number] | null = null;
        for (const fragment of this.sentFragments) {
          if (fragment.pts <= head && (!under || fragment.pts >= under.pts)) under = fragment;
        }
        if (under) {
          facts.headFragment = `n°${under.seq ?? "?"} (${under.n}e) pts ${under.pts.toFixed(3)} · tête ${signed(head - under.pts)} s`;
        }
      }
    } catch {
      /* rien */
    }
    return facts;
  }

  /** Voir `lastGoodBuffered`. Ne lève jamais. */
  rememberBuffered(after: string): void {
    try {
      this.lastGoodBuffered = {
        at: Date.now(),
        after,
        video: spansAll(this.host.videoBuffer),
        audio: spansAll(this.host.audioBuffer),
      };
    } catch {
      /* rien */
    }
  }

  /** Un fragment vidéo accepté par le tampon — voir `sentFragments`. Ne lève jamais. */
  rememberFragment(data: Uint8Array): void {
    try {
      const times = fragmentTimes(data);
      if (!times) return;
      this.fragmentsSinceSeek += 1;
      this.sentFragments.push({ n: this.fragmentsSinceSeek, ...times, at: Date.now() });
      if (this.sentFragments.length > SENT_FRAGMENTS_KEPT) this.sentFragments.shift();
    } catch {
      /* rien */
    }
  }

  /**
   * Ce qu'une ligne `rebuild` porte en plus de son motif : l'état relevé à la perte, et les vingt
   * dernières secondes de la trace — les envois, les sauts, l'erreur de l'élément, dans l'ordre.
   */
  lossReport(): Record<string, unknown> {
    // Chaque part dans sa garde (14/10/2026) : un état illisible — une source déjà détachée — ne
    // doit plus emporter avec lui les faits de l'échec ni la trace, qui sont faits pour ce cas-là.
    let state: Record<string, unknown> = {};
    try {
      state = this.lossSnapshot ?? this.host.stateFacts(this.host.video.currentTime);
    } catch {
      /* le journal ne vaut pas un lecteur */
    }
    let failure: Record<string, unknown> = {};
    try {
      failure = this.lossFailure ?? this.failureFacts();
    } catch {
      /* idem */
    }
    try {
      // `steps` reste le dernier champ de la ligne.
      return { ...state, ...failure, steps: traceRecent(STALL_TRACE_MS).join(" | ") };
    } catch {
      return { ...state, ...failure };
    }
  }
}
