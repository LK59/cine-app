// One operation at a time, per source buffer.
//
// MediaSource permits exactly one: starting a second while the first is still running throws, and
// that throw used to surface as a fatal playback error even though nothing was actually broken.
// Appends, removals and codec changes all come through here.

/** How long one buffer operation may go unanswered before the queue moves on without it. */
const BUFFER_OPERATION_TIMEOUT_MS = 4000;

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

  /**
   * @param why Whatever the element and the source can say about a refusal. The `error` event
   * carries no detail of its own, so without this the one failure that stops playback on iOS
   * arrives as a sentence with nothing in it.
   */
  constructor(
    readonly buffer: SourceBuffer,
    private readonly why: () => string = () => ""
  ) {}

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
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // Passed through untouched rather than re-wrapped: a full buffer is signalled by the type
      // of what is thrown, and coercing it to a plain Error loses exactly the distinction
      // between "make room and carry on" and "this segment is bad".
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.buffer.removeEventListener("updateend", onEnd);
        this.buffer.removeEventListener("error", onFail);
        if (error !== undefined) reject(error);
        else resolve();
      };
      const onEnd = () => finish();
      const onFail = () => finish(new Error(`Le navigateur a refusé une opération sur le tampon. ${this.why()}`));
      // A browser that answers neither must not hold the queue for the rest of the session.
      const timer = setTimeout(() => finish(), BUFFER_OPERATION_TIMEOUT_MS);

      this.buffer.addEventListener("updateend", onEnd);
      this.buffer.addEventListener("error", onFail);
      try {
        operation();
        // changeType, and a removal of nothing, finish without ever going busy.
        if (!this.buffer.updating) finish();
      } catch (error) {
        finish(error);
      }
    });
  }
}
