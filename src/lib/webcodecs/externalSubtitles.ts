import type { EngineTrack, SubtitleCue } from "./engine";

/**
 * Subtitles that live beside the film rather than inside it.
 *
 * Nothing in a Matroska file names them, so a player that opens the file directly cannot find
 * them at all — it is the media server, which sees the folder, that knows they exist. On this
 * library that gap is not academic: forty-six films carry only image subtitles inside the
 * container, which this player does not render, and every one of them has a text file next to it.
 *
 * They are fetched whole. A two-hour film's subtitles are on the order of a hundred kilobytes,
 * so streaming them would buy nothing and cost a seek path, and holding all of them in memory
 * means a jump backwards is a lookup rather than a re-parse.
 */

/** Track numbers from the container are positive, so these can never collide with one. */
export function isExternalTrack(id: number): boolean {
  return id < 0;
}

/** What the route hands over: enough to name the track and to go and get it. */
export interface ExternalSubtitleSource {
  id: number;
  language: string | null;
  title: string | null;
  url: string;
}

export function toEngineTrack(source: ExternalSubtitleSource): EngineTrack {
  return {
    number: source.id,
    // Named for what the viewer will see, not for what the file was before Jellyfin converted it.
    codecId: "S_TEXT/UTF8",
    language: source.language,
    name: source.title,
    isDefault: false,
    isForced: false,
  };
}

const TIMING = /(\d+):(\d{2}):(\d{2})[.,](\d{1,3})\s*-->\s*(\d+):(\d{2}):(\d{2})[.,](\d{1,3})/;

function seconds(h: string, m: string, s: string, fraction: string): number {
  // A cue may be written with one, two or three decimals; ".5" is half a second, not five
  // milliseconds, so the fraction is scaled by its own length rather than assumed to be three.
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(fraction) / 10 ** fraction.length;
}

/** Everything a cue carries that is not the words: position hints, karaoke spans, markup. */
function plainText(lines: string[]): string {
  return lines
    .join("\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .trim();
}

/**
 * WebVTT and SubRip, which differ here only in the comma of a timestamp and a header line.
 *
 * Jellyfin converts whatever is on disk — SubRip, ASS, mov_text — to WebVTT before sending it,
 * so in practice this parses VTT; accepting the comma as well costs one character of regular
 * expression and makes the function usable on a file read straight off a disk.
 */
export function parseSubtitles(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  // Both formats separate cues by a blank line. \r is stripped first so a CRLF file does not
  // leave a stray carriage return at the end of every line of every subtitle.
  for (const block of text.replace(/\r/g, "").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => TIMING.test(line));
    if (at === -1) continue; // the WEBVTT header, a NOTE, a STYLE block, or a numbering line alone

    const [, h1, m1, s1, f1, h2, m2, s2, f2] = TIMING.exec(lines[at])!;
    const body = plainText(lines.slice(at + 1));
    if (!body) continue;

    cues.push({
      startSeconds: seconds(h1, m1, s1, f1),
      endSeconds: seconds(h2, m2, s2, f2),
      text: body,
    });
  }
  // Sorted because the lookup below bisects, and because a file with cues out of order is a real
  // thing — some converters write overlapping cues in the order they finish, not the order they
  // start.
  return cues.sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * One track's cues, in memory, looked up by time.
 *
 * Unlike the engine's queue, this is not consumed as it is read: the viewer can jump backwards,
 * and re-parsing the file to do it would be absurd when it is already here.
 */
export class ExternalSubtitleTrack {
  private constructor(readonly id: number, private readonly cues: SubtitleCue[]) {}

  static async load(source: ExternalSubtitleSource, signal?: AbortSignal): Promise<ExternalSubtitleTrack> {
    const res = await fetch(source.url, { signal });
    if (!res.ok) throw new Error(`sous-titres indisponibles (${res.status})`);
    return new ExternalSubtitleTrack(source.id, parseSubtitles(await res.text()));
  }

  get count(): number {
    return this.cues.length;
  }

  textAt(seconds: number): string | null {
    // Bisect to the last cue that starts at or before the playhead, then walk back over any
    // that overlap it — two speakers talking at once are two cues covering the same instant, and
    // the one that starts later is not necessarily the one still on screen.
    let low = 0;
    let high = this.cues.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.cues[mid].startSeconds <= seconds) low = mid + 1;
      else high = mid;
    }
    for (let i = low - 1; i >= 0 && i >= low - 8; i--) {
      const cue = this.cues[i];
      if (cue.startSeconds <= seconds && cue.endSeconds >= seconds) return cue.text;
    }
    return null;
  }
}
