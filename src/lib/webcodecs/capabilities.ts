// What this device will actually accept, measured rather than assumed.
//
// Every codec decision in this player has one of two answers: what the documentation says, and
// what the machine in your hand does. They have disagreed twice already in this project — an
// iPhone that claimed E-AC-3 and decoded silence, a browser that takes a codec in a file and
// refuses the same codec inside a MediaSource. So the technical panel asks directly.
//
// It exists for the DTS question in particular. No browser decodes DTS, so playing it means
// decoding it here and handing the browser something else — which only works if the browser will
// encode that something else. Whether it will is exactly what this reports.

export interface Capability {
  label: string;
  supported: boolean | null;
  detail?: string;
}

async function encoderSupport(codec: string, numberOfChannels: number): Promise<Capability> {
  const label = `Encodage ${codec === "mp4a.40.2" ? "AAC" : codec} ${numberOfChannels === 2 ? "stéréo" : `${numberOfChannels} canaux`}`;
  const Encoder = (globalThis as { AudioEncoder?: typeof AudioEncoder }).AudioEncoder;
  // Absent entirely on Safari before 26, where WebCodecs was video-only.
  if (!Encoder?.isConfigSupported) return { label, supported: null, detail: "AudioEncoder absent" };

  // Asked twice before being believed. A browser may refuse one bitrate and accept the codec, and
  // reporting "no" for what was really "not at that rate" would send the whole plan down the
  // wrong path for a platform that could in fact have carried it.
  const attempts: { config: AudioEncoderConfig; note?: string }[] = [
    { config: { codec, sampleRate: 48000, numberOfChannels, bitrate: 256_000 } },
    { config: { codec, sampleRate: 48000, numberOfChannels }, note: "sans débit imposé" },
  ];
  let lastError: string | undefined;
  for (const attempt of attempts) {
    try {
      const result = await Encoder.isConfigSupported(attempt.config);
      if (result.supported) return { label, supported: true, detail: attempt.note };
    } catch (error) {
      // A configuration the browser considers malformed rather than unsupported.
      lastError = error instanceof Error ? error.name : "refusé";
    }
  }
  return { label, supported: false, detail: lastError };
}

function sourceSupport(mimeType: string, label: string): Capability {
  const Source =
    (globalThis as { ManagedMediaSource?: typeof ManagedMediaSource }).ManagedMediaSource ??
    (typeof MediaSource !== "undefined" ? MediaSource : undefined);
  if (!Source) return { label, supported: null, detail: "MediaSource absent" };
  try {
    return { label, supported: Source.isTypeSupported(mimeType) };
  } catch {
    return { label, supported: false };
  }
}

let cached: Promise<Capability[]> | null = null;

/**
 * Asked once per session: none of these answers change while a page is open, and two of them
 * cost a round trip through the platform's codec registry.
 */
export function probeCapabilities(): Promise<Capability[]> {
  cached ??= (async () => [
    // Could a DTS track be handed straight to the player? The answer is expected to be no
    // everywhere, and this is where that stops being an assumption.
    sourceSupport('audio/mp4; codecs="dtsc"', "DTS dans MediaSource"),
    sourceSupport('audio/mp4; codecs="dtse"', "DTS Express dans MediaSource"),
    // If not, the way through is to re-encode what we decode. These say whether that is possible.
    await encoderSupport("mp4a.40.2", 2),
    await encoderSupport("mp4a.40.2", 6),
    await encoderSupport("opus", 2),
    await encoderSupport("opus", 6),
    // Encoding to something the player will not take is no use: these close the loop.
    sourceSupport('audio/mp4; codecs="mp4a.40.2"', "AAC dans MediaSource"),
    sourceSupport('audio/mp4; codecs="opus"', "Opus dans MediaSource"),
  ])();
  return cached;
}

/** The panel's own shape: one line per answer, readable at a glance. */
export function describeCapabilities(capabilities: Capability[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const capability of capabilities) {
    out[capability.label] =
      capability.supported === null
        ? (capability.detail ?? "indisponible")
        : capability.supported
          ? "oui"
          : `non${capability.detail ? ` (${capability.detail})` : ""}`;
  }
  return out;
}
