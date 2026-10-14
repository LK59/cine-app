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
  /**
   * Le palier de la version allégée — ou `null` pour la négociation **ordinaire** du lecteur serveur,
   * celle du relais préparé avant une zone illisible (DECISIONS.md §93) : même mécanique, même
   * réemploi, sans débit abaissé. Reprise seulement par `takeOrdinaryPrewarm`.
   */
  step: LighterStep | null;
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
  /** Repris d'une page rechargée (`carryPrewarmAcrossReload`) : sa négociation a eu lieu avant le rechargement. */
  carried?: boolean;
}

let current: Prewarm | null = null;

/** Le préchauffage emporté à travers un rechargement de page (WebKit, rechargement direct). */
const RELOAD_CARRY_KEY = "cine:prewarm-carry";
/** Au-delà, le transcodage préchauffé ne vaut plus la peine d'être repris : arrêté, renégocié. */
export const PREWARM_CARRY_MS = 60_000;

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
export function startPrewarm(options: {
  itemId: string;
  step: LighterStep | null;
  startSeconds: number;
  audioStreamIndex?: number;
  /** La négociation ordinaire (`step: null`) : le plafond que le lecteur serveur demanderait (`pickMaxBitrate`). */
  maxBitrate?: number;
}): Prewarm {
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
          // Le palier allégé (§78) ; sans palier, la négociation ordinaire du relais (§93), au plafond
          // que le lecteur serveur aurait demandé lui-même.
          maxBitrate: options.step ? options.step.targetBps : options.maxBitrate,
          ...(options.step ? { lighter: true } : {}),
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
        return settleReady(prewarm, settle);
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
      settleReady(prewarm, settle);
    } catch {
      // Annulé : `cancelPrewarm` a déjà refermé la séance — une seule fois.
      if (prewarm.state === "cancelled") return settle(false);
      // Pris en cours par le lecteur serveur (`used`) puis en échec : il n'en fera rien
      // (`discardTakenPrewarm` ne refermera pas une seconde fois une séance déjà refermée ici).
      if (prewarm.state === "running" || prewarm.state === "used") prewarm.state = "failed";
      if (prewarm.data) void stopAtJellyfin(prewarm);
      settle(false);
    }
  })();
  return prewarm;
}

/**
 * Le segment est là. Un préchauffage pris en cours par le lecteur serveur (`used` — la bascule au délai
 * du renoncement n'attend pas qu'il soit prêt) l'est aussi : il se résolvait « en échec » parce que son
 * état n'était plus `running`, le lecteur serveur le laissait tomber sans pouvoir l'arrêter
 * (`cancelPrewarm` ignore un préchauffage pris) et renégociait — deux ffmpeg, dont un que rien ne
 * refermait (13/10/2026). Seul un abandon (`cancelled`) le fait échouer.
 */
function settleReady(prewarm: Prewarm, settle: (ok: boolean) => void): void {
  if (prewarm.state === "cancelled" || prewarm.state === "failed") return settle(false);
  if (prewarm.state === "running") prewarm.state = "ready";
  prewarm.readyAt = now();
  settle(true);
}

/**
 * Le préchauffage pris convient-il à la négociation que le lecteur serveur allait faire ? Même palier, et
 * même piste audio : la piste est gravée dans l'adresse du transcodage. Un préchauffage du 2e blocage
 * suivi d'un changement de piste, repris au 3e, jouait l'ancienne piste sous un menu qui disait la
 * nouvelle (13/10/2026). Dans le doute, non : la négociation d'avant le préchauffage.
 */
export function prewarmFits(prewarm: Prewarm, step: LighterStep | null | undefined, audioStreamIndex: number | undefined): boolean {
  if (!step || !prewarm.step || prewarm.step.targetBps !== step.targetBps) return false;
  return (prewarm.audioStreamIndex ?? null) === (audioStreamIndex ?? null);
}

/**
 * Le lecteur serveur a pris ce préchauffage (`takePrewarm`) et n'en fera rien — autre palier, autre
 * piste, échec, ou négociation remplacée entre-temps : sa séance est refermée chez Jellyfin. Le seul
 * chemin d'arrêt d'un préchauffage pris ; `cancelPrewarm` ne le touche jamais, puisqu'un préchauffage
 * pris peut être en lecture. Une seule fois.
 */
export function discardTakenPrewarm(prewarm: Prewarm | null | undefined): void {
  if (!prewarm) return;
  if (prewarm.state !== "used") return cancelPrewarm(prewarm);
  prewarm.state = "cancelled";
  if (current === prewarm) current = null;
  prewarm.abort.abort();
  if (prewarm.data) void stopAtJellyfin(prewarm);
}

/** Le préchauffage de ce titre, pris par le lecteur serveur qui va le lire — une seule fois. */
export function takePrewarm(itemId: string): Prewarm | null {
  const prewarm = current ?? takeCarriedPrewarm(itemId);
  if (!prewarm || prewarm.itemId !== itemId || (prewarm.state !== "ready" && prewarm.state !== "running")) return null;
  // Une négociation ordinaire (§93) n'est reprise que par `takeOrdinaryPrewarm` : une négociation
  // allégée ne l'emporte jamais, et la laisse en place.
  if (prewarm.step === null) return null;
  prewarm.state = "used";
  current = null;
  return prewarm;
}

/** L'écart toléré entre la position préchauffée d'un relais ordinaire et celle où il reprend. */
const ORDINARY_SLACK_S = 1;

/**
 * Le préchauffage **ordinaire** de ce titre (`step: null`, le relais préparé avant une zone
 * illisible, §93), pris par le lecteur serveur qui ouvre à `resumeAt` — s'il convient : même titre,
 * même piste audio, préparé à cette position (à une seconde près). Ne convient pas : il est arrêté
 * chez Jellyfin, et la négociation se fait comme avant. Rien d'autre n'est touché : un préchauffage
 * allégé reste à `takePrewarm`.
 */
export function takeOrdinaryPrewarm(itemId: string, resumeAt: number | undefined, audioStreamIndex: number | undefined): Prewarm | null {
  const prewarm = current;
  if (!prewarm || prewarm.step !== null) return null;
  if (prewarm.state !== "ready" && prewarm.state !== "running") return null;
  const fits =
    prewarm.itemId === itemId &&
    resumeAt !== undefined &&
    Math.abs(prewarm.startSeconds - resumeAt) <= ORDINARY_SLACK_S &&
    (prewarm.audioStreamIndex ?? null) === (audioStreamIndex ?? null);
  if (!fits) {
    cancelPrewarm(prewarm);
    return null;
  }
  prewarm.state = "used";
  current = null;
  return prewarm;
}

/**
 * Le rechargement direct (WebKit, `serverReload.ts`) emporte le préchauffage prêt de ce titre : la page
 * suivante le reprend tel quel (même `PlaySessionId`, mêmes adresses), comme le relais dans la page.
 * Un préchauffage pas encore prêt ne survivrait pas au rechargement (ses requêtes meurent avec la
 * page) : il est arrêté chez Jellyfin. Ne lève jamais.
 */
export function carryPrewarmAcrossReload(itemId: string, nowMs = Date.now()): boolean {
  const prewarm = current;
  if (!prewarm || prewarm.itemId !== itemId) return false;
  // Un relais ordinaire (§93) ne se prépare jamais sur WebKit en HLS natif : s'il en restait un, il
  // ne passerait pas la page (la page suivante ne reprend qu'un palier allégé) — arrêté.
  if (prewarm.state !== "ready" || !prewarm.data || prewarm.step === null) {
    cancelPrewarm(prewarm);
    return false;
  }
  try {
    sessionStorage.setItem(
      RELOAD_CARRY_KEY,
      JSON.stringify({
        itemId,
        step: prewarm.step,
        startSeconds: prewarm.startSeconds,
        audioStreamIndex: prewarm.audioStreamIndex,
        data: prewarm.data,
        segment: prewarm.segment,
        variant: prewarm.variant,
        readyMs: prewarm.readyAt !== null ? Math.round(prewarm.readyAt - prewarm.startedAt) : null,
        at: nowMs,
      })
    );
  } catch {
    // Stockage indisponible : la page suivante renégociera — le transcodage d'ici est arrêté.
    cancelPrewarm(prewarm);
    return false;
  }
  // Passé à la page suivante : ni repris ici, ni annulé par le démontage de ce lecteur.
  prewarm.state = "used";
  current = null;
  return true;
}

/** Le préchauffage emporté par le rechargement, s'il est pour ce titre et récent — lu une seule fois. */
function takeCarriedPrewarm(itemId: string, nowMs = Date.now()): Prewarm | null {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(RELOAD_CARRY_KEY);
    if (raw) sessionStorage.removeItem(RELOAD_CARRY_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as {
      itemId?: unknown;
      step?: LighterStep;
      startSeconds?: unknown;
      audioStreamIndex?: unknown;
      data?: PrewarmedStart;
      segment?: Prewarm["segment"];
      variant?: Prewarm["variant"];
      readyMs?: unknown;
      at?: unknown;
    };
    if (!saved.data || !saved.step || typeof saved.step.targetBps !== "number" || typeof saved.startSeconds !== "number") return null;
    const prewarm: Prewarm = {
      itemId: String(saved.itemId),
      step: { targetBps: saved.step.targetBps, tier: saved.step.tier },
      startSeconds: saved.startSeconds,
      ...(typeof saved.audioStreamIndex === "number" ? { audioStreamIndex: saved.audioStreamIndex } : {}),
      state: "ready",
      startedAt: 0,
      readyAt: typeof saved.readyMs === "number" ? saved.readyMs : null,
      data: saved.data,
      segment: saved.segment ?? null,
      variant: saved.variant ?? null,
      ready: Promise.resolve(true),
      abort: new AbortController(),
      carried: true,
    };
    // Un autre titre, ou trop ancien : la séance qu'il tenait est refermée chez Jellyfin.
    if (prewarm.itemId !== itemId || typeof saved.at !== "number" || nowMs - saved.at > PREWARM_CARRY_MS || nowMs < saved.at) {
      void stopAtJellyfin(prewarm);
      return null;
    }
    return prewarm;
  } catch {
    return null;
  }
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
 *
 * Un préchauffage pris par un autre (`used`) ou abandonné (`cancelled`) n'est plus là : « aucun ». Compté
 * « en cours », il bloquait toute bascule pour le reste de la séance — la décision attendait un
 * préchauffage qu'une renégociation avait pris puis écarté (13/10/2026). `SlowLinkRunner.status` le lâche.
 */
export function prewarmStatusOf(held: { prewarm: Prewarm; cause: SwitchCause } | null | undefined, cause: SwitchCause): PrewarmStatus {
  if (!held || prewarmGone(held.prewarm)) return "none";
  if (held.cause !== cause) return "running";
  return held.prewarm.state === "ready" ? "ready" : held.prewarm.state === "failed" ? "failed" : "running";
}

/** Ce préchauffage n'est plus à celui qui le tient : pris par le lecteur serveur, ou abandonné. */
export function prewarmGone(prewarm: Prewarm): boolean {
  return prewarm.state === "used" || prewarm.state === "cancelled";
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
    ...(prewarm.step ? { mbps: Math.round(prewarm.step.targetBps / 1e5) / 10, tier: prewarm.step.tier } : { ordinary: 1 }),
    state: prewarm.state,
    ...(prewarm.variant?.codecs ? { codecs: prewarm.variant.codecs.slice(0, 40) } : {}),
    ...(prewarm.variant?.resolution ? { res: prewarm.variant.resolution } : {}),
    ...(prewarm.readyAt !== null ? { readyMs: Math.round(prewarm.readyAt - prewarm.startedAt) } : {}),
    ...(prewarm.segment ? { segment: prewarm.segment.index } : {}),
    ...(prewarm.carried ? { carried: 1 } : {}),
  };
}

/** Pour les tests. */
export function forgetPrewarm(): void {
  current = null;
  try {
    sessionStorage.removeItem(RELOAD_CARRY_KEY);
  } catch {
    /* rien */
  }
}
