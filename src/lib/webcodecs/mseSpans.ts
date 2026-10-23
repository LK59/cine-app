// Ce que `MseSource` écrit des tampons et de l'élément pour la trace, le journal et le panneau
// technique — des fonctions sans état, sorties de mseSource.ts telles quelles.

/** Un écart en secondes, signé et arrondi au centième — pour le journal. */
export function signed(seconds: number): string {
  return `${seconds >= 0 ? "+" : ""}${seconds.toFixed(2)}`;
}

/** Les plages de ce tampon, toutes (quatre au plus), sans rapport à la tête. Ne lève jamais. */
export function spansAll(buffer: SourceBuffer | null): string {
  if (!buffer) return "aucun";
  try {
    const ranges = buffer.buffered;
    if (ranges.length === 0) return "vide";
    const spans: string[] = [];
    for (let i = 0; i < ranges.length && i < 4; i++) spans.push(`${ranges.start(i).toFixed(2)}–${ranges.end(i).toFixed(2)}`);
    if (ranges.length > 4) spans.push(`+${ranges.length - 4}`);
    return spans.join(" · ");
  } catch {
    return "illisible (source fermée)";
  }
}

/** One buffer's ranges within half a minute of the head, written short. Never throws. */
export function spansNear(buffer: SourceBuffer | null, at: number): string {
  try {
    const ranges = buffer?.buffered;
    if (!ranges || ranges.length === 0) return "vide";
    const spans: string[] = [];
    for (let i = 0; i < ranges.length && spans.length < 4; i++) {
      if (ranges.end(i) < at - 30 || ranges.start(i) > at + 30) continue;
      spans.push(`${ranges.start(i).toFixed(2)}–${ranges.end(i).toFixed(2)}`);
    }
    return spans.join(" · ") || "rien près de la tête";
  } catch {
    return "illisible (source fermée)";
  }
}

/** The element's own playable ranges, written out. */
export function playableSpans(video: HTMLVideoElement): string {
  const ranges = video.buffered;
  const spans: string[] = [];
  for (let i = 0; i < ranges.length; i++) spans.push(`${ranges.start(i).toFixed(2)}–${ranges.end(i).toFixed(1)}`);
  return spans.join(" · ") || "vide";
}

/** Images perdues sur images rendues, telles que l'élément lui-même les compte. */
export function frameQuality(video: HTMLVideoElement): string {
  const quality = video.getVideoPlaybackQuality?.();
  if (!quality) return "non mesurable ici";
  const { droppedVideoFrames: dropped, totalVideoFrames: total } = quality;
  if (total === 0) return "aucune image rendue";
  return `${dropped} / ${total} (${((dropped / total) * 100).toFixed(1)} %)`;
}
