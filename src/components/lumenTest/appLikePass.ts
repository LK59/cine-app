/**
 * La passe « Comme l'app » de `/lumen-test` (17/11/2026, docs/remux-serveur/README.md « Le refus code 4 dans l'app »).
 *
 * Sur l'iPhone de l'administrateur, chaque lecture réelle par Lumen serveur dans l'application (`LumenServerHost`) est
 * refusée par l'élément avant toute image (code 4, 0,2 à 0,5 s après l'adresse posée ; Safari lit la liste maître, la
 * liste vidéo, la liste maître encore, et rien d'autre), alors que cette page lit les mêmes listes sans faute, sur le
 * même appareil et la même version de format. Ce qui sépare les deux, c'est ce que l'hôte fait **autour** de
 * l'élément. La passe rejoue chacun de ces gestes sur un titre, un élément neuf par variante, seul puis tous ensemble
 * puis tous sauf un — de quoi nommer le geste fautif, ou dire que ce n'est aucun d'eux (le document du cinéma).
 *
 * Les leviers, tels que l'hôte les fait :
 * - `fetch` : la page lit la liste maître elle-même juste avant que l'élément ne la demande (le lien menu ↔
 *   `audioTracks`, `parseMasterAudio`) — la requête part avant le rendu qui pose l'adresse ;
 * - `preload` : `preload="auto"` (levier 1 de l'étape 3e) ;
 * - `attrs` : `autoplay`, `x-webkit-airplay="allow"`, et `load()` appelé après `src =` ;
 * - `tracks` : les `<track kind="subtitles">` du titre, les adresses que l'hôte construit (`pistes` → `serverTracks`),
 *   posés avant l'adresse comme React les insère avant l'effet ;
 * - `tv` : l'adresse munie du laissez-passer d'une Apple TV (`eligibility` `tv=1`, §186).
 *
 * Une variante finit à la première image (`requestVideoFrameCallback`, ou `loadeddata`), à une erreur de l'élément
 * (code et message), ou au bout de 15 s. Le son reste allumé comme dans l'hôte ; si iOS refuse `play()` sans geste,
 * l'élément est rendu muet et relancé (noté `play: "muet"`) — un refus de lecture automatique n'est pas un code 4.
 */

import { lumenRequestsSeen } from "@/components/player/lumen/lumenLog";

export const APP_LIKE_LEVERS = ["fetch", "preload", "attrs", "tracks", "tv"] as const;
export type AppLikeLever = (typeof APP_LIKE_LEVERS)[number];

/** Le titre de la passe par défaut : l'un des cinq refusés sur l'iPhone le 17/11 au matin. */
export const APP_LIKE_DEFAULT = { itemId: "80b2edc0cc145182f3db3c18969871c8", title: "Ted Lasso S01E08" } as const;

export const APP_LIKE_TIMEOUT_MS = 15_000;
/** Entre deux variantes : le démon média d'iOS libère la séance HLS d'avant de façon asynchrone. */
export const APP_LIKE_PAUSE_MS = 1500;

export interface AppLikeVariant {
  name: string;
  levers: AppLikeLever[];
}

/**
 * L'ordre : le témoin (ce que fait la page de banc), chaque levier seul, tous ensemble (ce que fait l'hôte), tous sauf
 * un, puis le témoin de nouveau — s'il échoue alors qu'il passait au début, c'est la page elle-même qui a changé en
 * cours de passe (un refus qui en entraîne d'autres), et les variantes d'après ne disent plus rien.
 */
export function appLikeVariants(): AppLikeVariant[] {
  const all = [...APP_LIKE_LEVERS];
  return [
    { name: "témoin", levers: [] },
    ...all.map((lever) => ({ name: `+${lever}`, levers: [lever] })),
    { name: "tout", levers: all },
    ...all.map((lever) => ({ name: `tout-${lever}`, levers: all.filter((l) => l !== lever) })),
    { name: "témoin-fin", levers: [] },
  ];
}

export type AppLikeOutcome = "image" | "erreur" | "délai" | "refusé" | "arrêté";

export interface AppLikeResult {
  variant: string;
  levers: string;
  outcome: AppLikeOutcome;
  /** L'adresse posée → la première image ou l'erreur (ms). */
  ms?: number;
  via?: "rvfc" | "loadeddata";
  code?: number;
  message?: string;
  /** `play()` : `ok`, `muet` (refusé puis relancé muet), ou le nom de l'erreur. */
  play?: string;
  readyState?: number;
  networkState?: number;
  /** Ce que Safari a demandé pour cette variante (Resource Timing, `lumenRequestsSeen`). */
  seen?: string;
  tracks?: number;
  s: string;
}

/**
 * Ce que la passe établit, en une phrase. Les règles, dans l'ordre :
 * le témoin échoue → le titre ou l'appareil, pas l'application ; le témoin de fin échoue après un témoin réussi → la
 * page a changé en cours de passe ; un levier qui échoue seul → la cause ; sinon, si « tout » échoue, les leviers
 * dont le retrait le fait passer sont nécessaires (une combinaison) ; « tout » qui passe → rien de ce qui est
 * reproduit ici : le document du cinéma.
 */
export function appLikeCause(results: readonly AppLikeResult[]): string {
  const by = new Map(results.map((r) => [r.variant, r]));
  const failed = (name: string) => {
    const r = by.get(name);
    return r !== undefined && (r.outcome === "erreur" || r.outcome === "délai");
  };
  const passed = (name: string) => by.get(name)?.outcome === "image";
  if (failed("témoin")) return "le témoin échoue : le titre ou l'appareil, pas ce que fait l'application";
  if (!passed("témoin")) return "témoin sans verdict : passe à refaire";
  if (failed("témoin-fin")) return "le témoin de fin échoue : la page a changé en cours de passe, les variantes d'après le premier refus ne disent rien";
  const alone = APP_LIKE_LEVERS.filter((lever) => failed(`+${lever}`));
  if (alone.length) return `cause : ${alone.join(" + ")} (échoue seul)`;
  if (failed("tout")) {
    const needed = APP_LIKE_LEVERS.filter((lever) => passed(`tout-${lever}`));
    return needed.length ? `cause : la combinaison ; nécessaire : ${needed.join(", ")}` : "« tout » échoue, aucun retrait seul ne le répare : combinaison de plusieurs leviers";
  }
  if (passed("tout")) return "tout passe : rien de ce que l'hôte fait autour de l'élément — le document du cinéma (ce qui y tourne)";
  return "sans verdict : passe à refaire";
}

/** Un identifiant de lecture neuf par variante : le serveur et Resource Timing les séparent. */
export function appLikePlaybackId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return `al${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface AppLikeSubtitle {
  url: string;
  language?: string | null;
  label: string;
}

type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (callback: () => void) => number };

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Une variante : un élément neuf dans `host`, les leviers posés comme l'hôte les pose, un verdict, l'élément rendu. */
export async function runAppLikeVariant(opts: {
  itemId: string;
  variant: AppLikeVariant;
  host: HTMLElement;
  subtitles: readonly AppLikeSubtitle[];
  stopped: () => boolean;
  timeoutMs?: number;
}): Promise<AppLikeResult> {
  const on = new Set(opts.variant.levers);
  const s = appLikePlaybackId();
  const base = { variant: opts.variant.name, levers: opts.variant.levers.join(",") || "aucun", s };
  // Le verdict comme l'hôte le demande (`fetchVerdict`) : sans découpe imposée, la piste par défaut, `tv=1` en levier.
  let master: string;
  try {
    const params = new URLSearchParams({ s, wait: "8000" });
    if (on.has("tv")) params.set("tv", "1");
    const res = await fetch(`/api/lumen/${opts.itemId}/eligibility?${params}`, { signal: AbortSignal.timeout(14_000) });
    const verdict = (await res.json().catch(() => null)) as { ok?: boolean; master?: string; reason?: string } | null;
    if (!res.ok || !verdict?.ok || !verdict.master) return { ...base, outcome: "refusé", message: `éligibilité : HTTP ${res.status}${verdict?.reason ? ` ${verdict.reason}` : ""}` };
    master = verdict.master;
  } catch (error) {
    return { ...base, outcome: "refusé", message: `éligibilité : ${error instanceof Error ? error.message : "réseau"}`.slice(0, 160) };
  }
  if (opts.stopped()) return { ...base, outcome: "arrêté" };

  const video = document.createElement("video") as FrameVideo;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.className = "aspect-video w-full rounded bg-black";
  video.preload = on.has("preload") ? "auto" : "none";
  if (on.has("attrs")) {
    video.autoplay = true;
    video.setAttribute("x-webkit-airplay", "allow");
  }
  if (on.has("tracks")) {
    for (const st of opts.subtitles) {
      const track = document.createElement("track");
      track.kind = "subtitles";
      track.src = st.url;
      if (st.language) track.srclang = st.language;
      track.label = st.label;
      video.appendChild(track);
    }
  }
  opts.host.appendChild(video);

  const result: AppLikeResult = { ...base, outcome: "délai", ...(on.has("tracks") ? { tracks: opts.subtitles.length } : {}) };
  let srcAt = 0;
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  let over = false;
  const finish = (outcome: AppLikeOutcome, extra: Partial<AppLikeResult> = {}) => {
    if (over) return;
    over = true;
    Object.assign(result, { outcome, ms: Math.round(performance.now() - srcAt), ...extra });
    settle();
  };
  const onError = () => finish("erreur", { code: video.error?.code ?? 0, ...(video.error?.message ? { message: video.error.message.slice(0, 200) } : {}) });
  const onData = () => finish("image", { via: "loadeddata" });
  video.addEventListener("error", onError);
  video.addEventListener("loadeddata", onData);
  video.requestVideoFrameCallback?.(() => finish("image", { via: "rvfc" }));

  // La page lit la liste maître avant le rendu qui pose l'adresse (`LumenServerHost`, ouverture) : même ordre ici.
  if (on.has("fetch")) {
    void fetch(master, { signal: AbortSignal.timeout(10_000) })
      .then((res) => res.text())
      .catch(() => "");
    await wait(0);
  }
  srcAt = performance.now();
  video.src = master;
  if (on.has("attrs")) video.load();
  const play = async () => {
    try {
      await video.play();
      result.play = "ok";
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "erreur";
      if (name !== "NotAllowedError" || over) {
        result.play = name;
        return;
      }
      // Une lecture automatique refusée (pas de geste depuis l'appui) : muet, comme le permet iOS.
      video.muted = true;
      try {
        await video.play();
        result.play = "muet";
      } catch (again) {
        result.play = again instanceof DOMException ? `muet:${again.name}` : "muet:erreur";
      }
    }
  };
  void play();
  const timer = setTimeout(() => finish("délai"), opts.timeoutMs ?? APP_LIKE_TIMEOUT_MS);
  const stopPoll = setInterval(() => {
    if (opts.stopped()) finish("arrêté");
  }, 250);
  await settled;
  clearTimeout(timer);
  clearInterval(stopPoll);
  result.readyState = video.readyState;
  result.networkState = video.networkState;
  // Ce que Safari a demandé après coup aussi (une liste relue juste après le refus).
  await wait(500);
  const seen = lumenRequestsSeen(s);
  if (seen) result.seen = seen;
  video.removeEventListener("error", onError);
  video.removeEventListener("loadeddata", onData);
  try {
    video.pause();
    video.removeAttribute("src");
    video.load();
  } catch {
    // Déjà rendu.
  }
  video.remove();
  return result;
}

/** Une ligne lisible pour le journal de la page. */
export function appLikeLine(r: AppLikeResult): string {
  const head = `${r.variant} (${r.levers})`;
  const what =
    r.outcome === "image"
      ? `image en ${r.ms} ms (${r.via})`
      : r.outcome === "erreur"
        ? `ERREUR code ${r.code}${r.message ? ` ${r.message}` : ""} après ${r.ms} ms`
        : r.outcome === "délai"
          ? `rien en ${Math.round((r.ms ?? 0) / 1000)} s (readyState ${r.readyState}, networkState ${r.networkState})`
          : `${r.outcome}${r.message ? ` : ${r.message}` : ""}`;
  return `comme l'app · ${head} : ${what}${r.play && r.play !== "ok" ? ` · play ${r.play}` : ""}${r.seen ? ` · vu : ${r.seen}` : ""}`;
}
