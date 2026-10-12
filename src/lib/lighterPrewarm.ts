"use client";

// Le préchauffage de la version allégée (DECISIONS.md §78) : la négociation Jellyfin et le premier
// segment, demandés en arrière-plan pendant que le lecteur natif essaie encore — pour qu'au moment de
// basculer, le lecteur serveur trouve un ffmpeg déjà parti et une image à quelques centaines de
// millisecondes, au lieu d'une négociation et d'un démarrage d'encodeur de plus.
//
// Le point critique est le réemploi EXACT : le lecteur serveur reprend la réponse de cette négociation
// telle quelle (même `PlaySessionId`, même `MediaSourceId`, mêmes adresses de liste et de segments) et
// hls.js part à la position préchauffée (`startPosition`) : Jellyfin sert alors le segment déjà
// produit et poursuit le même ffmpeg, sans en relancer un. Un préchauffage abandonné (le natif a
// trouvé son image) est arrêté chez Jellyfin (`ActiveEncodings`, par la route d'arrêt marquée
// `prewarm`) : aucun transcodage orphelin.
//
// Un seul à la fois (un lecteur à la fois). Rien ici ne lève : un préchauffage qui échoue laisse la
// bascule négocier elle-même, comme avant.

import { detectCodecSupport } from "@/lib/codecSupport";
import { playsHlsNatively } from "@/lib/webkitEngine";
import { touchHintHeaders } from "@/lib/deviceLabel";
import type { LighterStep, PrewarmStatus, SwitchCause } from "@/lib/slowLinkPolicy";

export type PrewarmState = "running" | "ready" | "failed" | "cancelled" | "used";

/** Ce que `/api/jellyfin/playback/start` a répondu — repris tel quel par le lecteur serveur. */
export type PrewarmedStart = Record<string, unknown> & { playSessionId?: string; mediaSourceId?: string; manifestUrl?: string; castUrl?: string | null };

export interface Prewarm {
  itemId: string;
  step: LighterStep;
  /** La position préchauffée, en secondes — celle où le lecteur serveur doit partir. */
  startSeconds: number;
  audioStreamIndex?: number;
  state: PrewarmState;
  /** `performance.now()` du lancement, et du premier segment reçu. */
  startedAt: number;
  readyAt: number | null;
  /** La réponse de la négociation, quand elle est arrivée. */
  data: PrewarmedStart | null;
  /** Le segment préchauffé : son rang dans la liste, et la seconde où il commence. */
  segment: { index: number; startsAt: number } | null;
  /** Codec et largeur annoncés par le maître (`CODECS`, `RESOLUTION`), pour le journal. */
  variant: { codecs: string | null; resolution: string | null } | null;
  /** Résolue quand le premier segment est là (vrai) ou que le préchauffage a échoué (faux). */
  ready: Promise<boolean>;
  /**
   * Interrompt les listes et le segment en cours (`cancelPrewarm`) : sur un lien lent, le segment d'un
   * préchauffage abandonné prenait encore le peu de débit que la lecture native venait de retrouver.
   * Pas la négociation : sa réponse porte la séance à refermer chez Jellyfin, et elle est petite.
   */
  abort: AbortController;
}

let current: Prewarm | null = null;

/** Une ligne `#EXT-X-STREAM-INF` et l'adresse qui la suit. */
function firstVariant(master: string, base: string): { url: string; codecs: string | null; resolution: string | null } | null {
  const lines = master.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
    const next = lines.slice(i + 1).find((l) => l.trim() && !l.startsWith("#"));
    if (!next) return null;
    return {
      url: new URL(next.trim(), base).href,
      codecs: /CODECS="([^"]+)"/.exec(lines[i])?.[1] ?? null,
      resolution: /RESOLUTION=([0-9x]+)/.exec(lines[i])?.[1] ?? null,
    };
  }
  return null;
}

/** Le segment qui contient `seconds`, d'après les `#EXTINF` cumulés de la variante. */
export function segmentAt(variant: string, base: string, seconds: number): { url: string; index: number; startsAt: number } | null {
  let at = 0;
  let index = 0;
  let pending: number | null = null;
  let last: { url: string; index: number; startsAt: number } | null = null;
  for (const raw of variant.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      pending = Number.parseFloat(line.slice(8));
      continue;
    }
    if (!line || line.startsWith("#") || pending === null) continue;
    const segment = { url: new URL(line, base).href, index, startsAt: at };
    if (seconds < at + pending) return segment;
    last = segment;
    at += pending;
    index += 1;
    pending = null;
  }
  return last;
}

/**
 * Lance un préchauffage — le précédent, s'il y en a un, est arrêté chez Jellyfin. `prewarm: true`
 * dit à la route de ne pas annoncer la lecture à Jellyfin : ce n'en est pas encore une (le lecteur
 * serveur l'annoncera s'il la reprend).
 */
export function startPrewarm(options: { itemId: string; step: LighterStep; startSeconds: number; audioStreamIndex?: number }): Prewarm {
  if (current && current.state !== "used") cancelPrewarm(current);
  let settle: (ok: boolean) => void = () => {};
  const prewarm: Prewarm = {
    ...options,
    state: "running",
    startedAt: now(),
    readyAt: null,
    data: null,
    segment: null,
    variant: null,
    ready: new Promise<boolean>((resolve) => (settle = resolve)),
    abort: new AbortController(),
  };
  const signal = prewarm.abort.signal;
  current = prewarm;
  void (async () => {
    try {
      const codecSupport = await detectCodecSupport();
      const res = await fetch("/api/jellyfin/playback/start", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...touchHintHeaders() },
        body: JSON.stringify({
          itemId: options.itemId,
          maxBitrate: options.step.targetBps,
          lighter: true,
          prewarm: true,
          audioStreamIndex: options.audioStreamIndex,
          startTicks: options.startSeconds > 0 ? Math.floor(options.startSeconds * 10_000_000) : undefined,
          codecSupport,
          disableAudioCodecs: [],
          forCast: false,
          nativeHls: playsHlsNatively(),
        }),
      });
      if (!res.ok) throw new Error(`négociation ${res.status}`);
      const data = (await res.json()) as PrewarmedStart;
      prewarm.data = data;
      // Annulé pendant la négociation : Jellyfin a ouvert une séance, on la lui referme.
      if (prewarm.state === "cancelled") {
        void stopAtJellyfin(prewarm);
        return settle(false);
      }
      if (data.isDirectPlay) {
        // Rien à transcoder : rien à chauffer (n'arrive pas à ces débits, mais ne coûte rien).
        prewarm.state = "ready";
        prewarm.readyAt = now();
        return settle(true);
      }
      const masterUrl = String(data.castUrl ?? data.manifestUrl ?? "");
      const base = typeof location !== "undefined" ? location.href : "http://localhost/";
      const masterAbs = new URL(masterUrl, base).href;
      const master = await (await fetch(masterAbs, { signal })).text();
      const variant = firstVariant(master, masterAbs);
      if (!variant) throw new Error("liste maître sans variante");
      prewarm.variant = { codecs: variant.codecs, resolution: variant.resolution };
      const list = await (await fetch(variant.url, { signal })).text();
      const segment = segmentAt(list, variant.url, options.startSeconds);
      if (!segment) throw new Error("variante sans segment");
      prewarm.segment = { index: segment.index, startsAt: segment.startsAt };
      // Le segment lui-même, en entier : c'est sa demande qui fait partir ffmpeg chez Jellyfin.
      const seg = await fetch(segment.url, { signal });
      await seg.arrayBuffer();
      if (prewarm.state !== "running") return settle(false);
      prewarm.state = "ready";
      prewarm.readyAt = now();
      settle(true);
    } catch {
      // Annulé : `cancelPrewarm` a déjà refermé la séance — une seule fois.
      if (prewarm.state === "cancelled") return settle(false);
      if (prewarm.state === "running") prewarm.state = "failed";
      if (prewarm.data) void stopAtJellyfin(prewarm);
      settle(false);
    }
  })();
  return prewarm;
}

/** Le préchauffage de ce titre, pris par le lecteur serveur qui va le lire — une seule fois. */
export function takePrewarm(itemId: string): Prewarm | null {
  const prewarm = current;
  if (!prewarm || prewarm.itemId !== itemId || (prewarm.state !== "ready" && prewarm.state !== "running")) return null;
  prewarm.state = "used";
  current = null;
  return prewarm;
}

/** Abandonner : le natif a trouvé son image, ou le lecteur se ferme. Le transcodage est arrêté. */
export function cancelPrewarm(prewarm: Prewarm | null = current): void {
  if (!prewarm || prewarm.state === "used" || prewarm.state === "cancelled") return;
  prewarm.state = "cancelled";
  if (current === prewarm) current = null;
  prewarm.abort.abort();
  if (prewarm.data) void stopAtJellyfin(prewarm);
}

/**
 * Ce que la décision (`decideOpening` / `decidePlayback`) doit savoir du préchauffage tenu par l'hôte
 * pour une cause : aucun, en cours, prêt ou en échec. Un préchauffage tenu pour une autre cause compte
 * « en cours » : il occupe la place (un seul à la fois).
 */
export function prewarmStatusOf(held: { prewarm: Prewarm; cause: SwitchCause } | null | undefined, cause: SwitchCause): PrewarmStatus {
  if (!held) return "none";
  if (held.cause !== cause) return "running";
  return held.prewarm.state === "ready" ? "ready" : held.prewarm.state === "failed" ? "failed" : "running";
}

/** Les paramètres de la séance Jellyfin, lus dans l'adresse qu'elle a donnée. */
function sessionParams(data: PrewarmedStart): { playSessionId: string; deviceId: string | null; mediaSourceId: string } | null {
  try {
    const url = new URL(String(data.manifestUrl ?? ""), "http://x");
    const playSessionId = String(data.playSessionId ?? url.searchParams.get("PlaySessionId") ?? "");
    const mediaSourceId = String(data.mediaSourceId ?? url.searchParams.get("MediaSourceId") ?? "");
    if (!playSessionId || !mediaSourceId) return null;
    return { playSessionId, mediaSourceId, deviceId: url.searchParams.get("DeviceId") };
  } catch {
    return null;
  }
}

async function stopAtJellyfin(prewarm: Prewarm): Promise<void> {
  try {
    const params = prewarm.data ? sessionParams(prewarm.data) : null;
    if (!params) return;
    await fetch("/api/jellyfin/playback/stop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ itemId: prewarm.itemId, ...params, prewarm: true }),
      keepalive: true,
    });
  } catch {
    /* Jellyfin arrête de lui-même un transcodage que plus personne ne lit */
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Les champs du journal d'un préchauffage (`prewarm.*`, aplatis par la route). */
export function prewarmFields(prewarm: Prewarm | null): Record<string, string | number> {
  if (!prewarm) return {};
  return {
    mbps: Math.round(prewarm.step.targetBps / 1e5) / 10,
    tier: prewarm.step.tier,
    state: prewarm.state,
    ...(prewarm.variant?.codecs ? { codecs: prewarm.variant.codecs.slice(0, 40) } : {}),
    ...(prewarm.variant?.resolution ? { res: prewarm.variant.resolution } : {}),
    ...(prewarm.readyAt !== null ? { readyMs: Math.round(prewarm.readyAt - prewarm.startedAt) } : {}),
    ...(prewarm.segment ? { segment: prewarm.segment.index } : {}),
  };
}

/** Pour les tests. */
export function forgetPrewarm(): void {
  current = null;
}
