// Client-only: detects what the browser can actually decode, so the DeviceProfile sent to
// Jellyfin (see PlaybackInfoOptions in clients/jellyfin.ts) reflects real capabilities instead
// of the previous "always transcode everything" fallback. Mirrors jellyfin-web's approach:
// MediaSource.isTypeSupported() as a fast pre-filter, then a real SourceBuffer instantiation to
// catch the documented false-positive rate on some Firefox/Windows builds (isTypeSupported
// there can claim support for a codec it then refuses to actually attach as a SourceBuffer).
// isTypeSupported has no known false-negative problem, so a `false` there is trusted outright —
// only a `true` gets the extra real-SourceBuffer confirmation.

export interface CodecSupport {
  /** Keyed "container/codec", e.g. "mp4/h264", "mp4/hevc". */
  video: Record<string, boolean>;
  /** Keyed by audio codec, e.g. "aac", "ac3", "eac3", "opus". dts/truehd are expected to test
   *  false in almost every browser — that's correct, not a bug in the test. */
  audio: Record<string, boolean>;
}

interface Candidate {
  key: string;
  mime: string;
}

// One representative profile/level per codec is enough here — Jellyfin's own StreamBuilder
// still does the fine-grained per-file compatibility check (resolution, bit depth, level) when
// deciding DirectPlay vs DirectStream vs Transcode; this only needs to answer "can this browser
// decode this codec inside an MP4 container at all".
const VIDEO_CANDIDATES: Candidate[] = [
  { key: "mp4/h264", mime: 'video/mp4; codecs="avc1.640028"' },
  { key: "mp4/hevc", mime: 'video/mp4; codecs="hvc1.1.6.L153.B0"' },
  { key: "mp4/vp9", mime: 'video/mp4; codecs="vp09.00.10.08"' },
  { key: "mp4/av1", mime: 'video/mp4; codecs="av01.0.04M.08"' },
];

const AUDIO_CANDIDATES: Candidate[] = [
  { key: "aac", mime: 'audio/mp4; codecs="mp4a.40.2"' },
  { key: "ac3", mime: 'audio/mp4; codecs="ac-3"' },
  { key: "eac3", mime: 'audio/mp4; codecs="ec-3"' },
  { key: "opus", mime: 'audio/mp4; codecs="opus"' },
  { key: "flac", mime: 'audio/mp4; codecs="fLaC"' },
];

const SOURCEBUFFER_TIMEOUT_MS = 2000;

function testSourceBuffer(mime: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const video = document.createElement("video");
    const ms = new MediaSource();
    const objectUrl = URL.createObjectURL(ms);

    function finish(result: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      URL.revokeObjectURL(objectUrl);
      video.removeAttribute("src");
      video.load();
      resolve(result);
    }

    const timer = setTimeout(() => finish(false), SOURCEBUFFER_TIMEOUT_MS);

    ms.addEventListener(
      "sourceopen",
      () => {
        try {
          ms.addSourceBuffer(mime);
          finish(true);
        } catch {
          finish(false);
        }
      },
      { once: true }
    );

    video.src = objectUrl;
  });
}

async function checkCodec(mime: string): Promise<boolean> {
  if (typeof window === "undefined" || !("MediaSource" in window)) return false;
  if (!MediaSource.isTypeSupported(mime)) return false;
  return testSourceBuffer(mime);
}

const CACHE_KEY = "cine:codec-support:v1";

interface CachedSupport {
  userAgent: string;
  support: CodecSupport;
}

function readCache(): CodecSupport | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedSupport;
    // Invalidates on browser version change (userAgent includes it) — a codec support answer
    // from a previous browser version can't be trusted after an update.
    if (parsed.userAgent !== navigator.userAgent) return null;
    return parsed.support;
  } catch {
    return null;
  }
}

function writeCache(support: CodecSupport): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ userAgent: navigator.userAgent, support } satisfies CachedSupport));
  } catch {
    // Storage unavailable (private browsing, quota) — detection just re-runs next time.
  }
}

export async function detectCodecSupport(): Promise<CodecSupport> {
  if (typeof window === "undefined") return { video: {}, audio: {} };

  const cached = readCache();
  if (cached) return cached;

  const [videoEntries, audioEntries] = await Promise.all([
    Promise.all(VIDEO_CANDIDATES.map(async (c): Promise<[string, boolean]> => [c.key, await checkCodec(c.mime)])),
    Promise.all(AUDIO_CANDIDATES.map(async (c): Promise<[string, boolean]> => [c.key, await checkCodec(c.mime)])),
  ]);

  const support: CodecSupport = {
    video: Object.fromEntries(videoEntries),
    audio: Object.fromEntries(audioEntries),
  };
  writeCache(support);
  return support;
}
