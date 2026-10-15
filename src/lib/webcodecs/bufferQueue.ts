// One operation at a time, per source buffer.
//
// MediaSource permits exactly one: starting a second while the first is still running throws, and
// that throw used to surface as a fatal playback error even though nothing was actually broken.
// Appends, removals and codec changes all come through here.

import { trace } from "./trace";

/** How long one buffer operation may go unanswered before the queue looks at it again. */
const BUFFER_OPERATION_TIMEOUT_MS = 4000;

/**
 * Encore occupé au-delà : le tampon ne répondra plus. L'opération est interrompue (`abort()`) et
 * rejetée — l'appelant la traite comme un envoi refusé. Une borne longue : à 4 s, c'est presque
 * toujours le fil principal qui était bloqué, pas le tampon.
 */
const BUFFER_OPERATION_GIVE_UP_MS = 30_000;

/**
 * Une minuterie qui part avec plus de retard que cela n'a pas pu laisser passer l'événement : le fil
 * principal était bloqué, et le `updateend` du navigateur attend peut-être juste derrière elle. On
 * regarde de nouveau, peu après, au lieu de conclure.
 */
const LATE_TIMER_MS = 1000;
const LATE_RECHECK_MS = 250;

/** L'`updateend` d'un `abort()` : attendu au plus ce temps avant de libérer la file. */
const ABORT_SETTLE_MS = 1000;

/**
 * Serialises everything done to one source buffer.
 *
 * MediaSource permits exactly one operation per buffer at a time: starting a second while the
 * first is still running throws, and that throw used to surface as a fatal playback error even
 * though nothing was actually broken. Appends, removals and codec changes all come through here
 * in order, so overlapping is impossible rather than merely unlikely — which matters because the
 * things that touch a buffer are driven by unrelated events (a seek, a language change, the
 * eviction of played media) that can land in the same instant.
 */
export class BufferQueue {
  private chain: Promise<void> = Promise.resolve();
  private closed = false;

  /**
   * @param why Whatever the element and the source can say about a refusal. The `error` event
   * carries no detail of its own, so without this the one failure that stops playback on iOS
   * arrives as a sentence with nothing in it.
   */
  constructor(
    readonly buffer: SourceBuffer,
    private readonly why: () => string = () => ""
  ) {}

  /**
   * La source est détruite : ce qui attend encore dans la file ne s'exécute plus.
   *
   * Un saut met un retrait en file derrière l'envoi en cours ; détruit entre-temps (un changement
   * de piste, une reconstruction), le lecteur voyait ce retrait partir sur un tampon qui n'était
   * plus le sien. Sans effet dans un navigateur — une source détachée refuse, et le refus est
   * avalé —, mais c'est l'inverse de ce que `destroy` promet, et le fuzz du 24/09/2026 le relevait
   * dans une séquence sur quarante qui reconstruit.
   */
  close(): void {
    this.closed = true;
  }

  enqueue(operation: () => void): Promise<void> {
    const run = this.chain.then(() => this.runOne(operation));
    // The queue outlives a failed operation: one refused append must not wedge every later one.
    this.chain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  private runOne(operation: () => void): Promise<void> {
    // Résolue sans rien faire plutôt que rejetée : un appelant qui attendait n'a plus rien à
    // conclure, et un rejet l'enverrait réparer une source qui n'existe plus.
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const startedAt = Date.now();
      // Passed through untouched rather than re-wrapped: a full buffer is signalled by the type
      // of what is thrown, and coercing it to a plain Error loses exactly the distinction
      // between "make room and carry on" and "this segment is bad".
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        this.buffer.removeEventListener("updateend", onEnd);
        this.buffer.removeEventListener("error", onFail);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onEnd = () => finish();
      const onFail = () => finish(new Error(`Le navigateur a refusé une opération sur le tampon. ${this.why()}`));

      /**
       * A browser that answers neither must not hold the queue for the rest of the session — but
       * a buffer still working must not be handed the next operation either.
       *
       * Libre à l'échéance : un événement manqué, l'opération est finie. Encore occupé : on attend,
       * sans libérer la file. Jusqu'au 15/10/2026, l'échéance de 4 s rejetait l'opération et la file
       * passait à la suivante, sur un tampon toujours occupé — `InvalidStateError` à coup sûr, et
       * trois de suite menaient au lecteur serveur. Or c'est un fil principal bloqué qui fait tomber
       * l'échéance avant le `updateend` déjà dû : reproduit trois fois sur trois avec 4,6 s de calcul
       * pendant un envoi, et vu une fois sans intervention sur une machine chargée (passe de nuit,
       * LECTEUR-1). Le délai de 4 s datait du 03/09 (filet supposé, sans mesure) ; le cas « libre »
       * avait été corrigé le 23/09, le cas « occupé » rendait l'erreur suivante certaine.
       */
      const check = (dueAt: number) => {
        timer = null;
        if (settled) return;
        if (!this.buffer.updating) {
          finish();
          return;
        }
        const now = Date.now();
        // Partie très en retard : le fil principal était bloqué. On regarde de nouveau, peu après.
        if (now - dueAt > LATE_TIMER_MS) {
          trace(`tampon occupé, minuterie partie avec ${now - dueAt} ms de retard (fil principal bloqué) : on attend`);
          const recheckAt = now + LATE_RECHECK_MS;
          timer = setTimeout(() => check(recheckAt), LATE_RECHECK_MS);
          return;
        }
        const elapsed = now - startedAt;
        if (elapsed < BUFFER_OPERATION_GIVE_UP_MS) {
          const wait = Math.min(BUFFER_OPERATION_TIMEOUT_MS, BUFFER_OPERATION_GIVE_UP_MS - elapsed);
          trace(`tampon toujours occupé après ${(elapsed / 1000).toFixed(1)} s : on attend, la file reste tenue`);
          const nextAt = now + wait;
          timer = setTimeout(() => check(nextAt), wait);
          return;
        }
        giveUp(elapsed);
      };

      /**
       * Trente secondes et toujours occupé : l'opération est interrompue, puis rejetée — après le
       * `updateend` que l'interruption fait partir, pour qu'il n'arrive pas sur l'opération suivante
       * et ne la fasse pas passer pour finie.
       */
      const giveUp = (elapsed: number) => {
        const error = new Error(`Le tampon n'a pas répondu en ${Math.round(elapsed / 1000)} s. ${this.why()}`);
        this.buffer.removeEventListener("updateend", onEnd);
        this.buffer.removeEventListener("error", onFail);
        let released = false;
        let fallback: ReturnType<typeof setTimeout> | null = null;
        const release = () => {
          if (released) return;
          released = true;
          if (fallback !== null) clearTimeout(fallback);
          this.buffer.removeEventListener("updateend", release);
          finish(error);
        };
        this.buffer.addEventListener("updateend", release);
        fallback = setTimeout(release, ABORT_SETTLE_MS);
        try {
          this.buffer.abort();
        } catch {
          // Source fermée ou détachée : il n'y a plus rien à interrompre.
          release();
        }
      };

      this.buffer.addEventListener("updateend", onEnd);
      this.buffer.addEventListener("error", onFail);
      try {
        operation();
        // changeType, and a removal of nothing, finish without ever going busy.
        if (!this.buffer.updating) {
          finish();
          return;
        }
      } catch (error) {
        finish(error);
        return;
      }
      const dueAt = Date.now() + BUFFER_OPERATION_TIMEOUT_MS;
      timer = setTimeout(() => check(dueAt), BUFFER_OPERATION_TIMEOUT_MS);
    });
  }
}
