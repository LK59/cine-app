// La ligne `kind: "lumen-test"` de startup.log : ce que la page de banc `/lumen-test` a mesuré sur un
// appareil, et ce que le serveur a vu des mêmes lectures (étape 3b de docs/remux-serveur/, §157).
//
// Pourquoi une ligne : la page lit du HLS natif, et Safari tire lui-même listes et segments — rien de ce
// qu'il fait entre deux évènements de `<video>` n'est visible de la page. Le serveur, lui, voit chaque
// segment (`playbackStats.ts`). Une ligne réunit les deux, par lecture (`s`) : le temps jusqu'à la
// première image, chaque saut et son attente, les blocages, les erreurs, les pistes audio que Safari
// annonce et ce qu'un changement de piste a fait — et, en face, les segments remis, leur construction,
// leur envoi, et quels segments Safari a demandés après chaque saut (la trace).
//
// Depuis l'étape 3c (17/11/2026), une lecture peut aussi être celle du **lecteur actuel** (Lumen dans la page :
// remux, MediaSource), jouée par la même page sur les mêmes sauts : `player: "actuel"`, sans relevé serveur (son
// `s` n'est pas une lecture de Lumen serveur), avec ce que le moteur a ouvert (`engine`). Les lignes d'une série
// portent le lecteur, la passe (`complète`, `courte`) et la graine des positions de saut ; la récapitulative, le
// tableau comparatif (`comparison`).
//
// Depuis l'étape 3f (la passe « son multiplexé », `pass: "multiplexé"`), une ligne d'essai porte aussi sa répétition
// (`rep`), la piste entendue au départ contre celle que la liste maître désigne (`audioCheck`), le débit annoncé
// (`streamMbps`), le changement de piste avec ce qu'il a fait (`applied`, `segs`), et la chronologie les arrivées
// côté page (Resource Timing : `rx`, `recv*`, `rtSegs`) ; la récapitulative, le verdict par titre (`mux`) et deux
// réponses de plus (`audioChanged`, `lipSync`).
//
// Le corps vient du navigateur : tout est relu, borné, et ce qui n'a pas la forme attendue tombe. Le
// compte vient de la session, jamais du corps ; le relevé serveur d'une lecture n'est joint que s'il
// appartient à ce compte (`lumenPlaybackStats`).

import { lumenPlaybackFields, lumenPlaybackStats, isPlaybackId } from "./playbackStats";
import { LUMEN_CUT_MODES } from "./format";

const MAX_RUNS = 12;
const MAX_SEEKS = 80;
const MAX_LOG = 150;
/** Les gels d'une lecture (« Tout enchaîner ») : au-delà de 60, la lecture est figée d'un bout à l'autre et le nombre suffit. */
const MAX_FREEZES = 60;
/** Les essais résumés d'une ligne récapitulative : la série en compte 14, la passe « son multiplexé » 24. */
const MAX_TRIALS = 30;
const PLAYERS = new Set(["serveur", "actuel"]);
// « son » manquait ici depuis la phase 2 : le champ `pass` de ses lignes était retiré à la réception.
const PASSES = new Set(["complète", "courte", "leviers", "multiplexé", "son", "codecs"]);
const ORDERS = new Set(["serveur", "actuel"]);
/** Les leviers d'un essai (`modeTag`, autoSeries.ts) : `mux`, `prep`, `fiche`, `depart-xstart`, `bw`… */
const modeOf = (v: unknown) => (typeof v === "string" && /^[a-z-]{1,40}$/.test(v) ? v : null);
/** Les cascades d'une lecture (étape 3e) : une par démarrage et par saut ; un parcours de 20 sauts plus le départ. */
const MAX_CASCADES = 24;
const cutOf = (v: unknown) => (typeof v === "string" && (LUMEN_CUT_MODES as readonly string[]).includes(v) ? v : null);
/** Une cible de segment, en secondes : un petit entier. */
const targetOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 30 ? v : null);

const num = (value: unknown, max = 1e9): number | null =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max ? Math.round(value * 1000) / 1000 : null;
const text = (value: unknown, max: number): string | null => (typeof value === "string" ? value.slice(0, max) : null);
const bool = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** Les seuls champs gardés d'un objet, chacun par sa propre règle ; les absents ne paraissent pas. */
function pick(raw: unknown, rules: Record<string, (value: unknown) => unknown>): Record<string, unknown> {
  const source = obj(raw);
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(rules)) {
    const value = rule(source[key]);
    if (value === null || value === undefined) continue;
    // Une liste vide ou un objet sans champ gardé ne dit rien : la ligne reste lisible d'un coup d'œil.
    if (Array.isArray(value) ? value.length === 0 : typeof value === "object" && Object.keys(value).length === 0) continue;
    out[key] = value;
  }
  return out;
}

const SEEK_KINDS = new Set(["-10", "+10", "+60", "hasard", "parcours", "barre", "depart"]);
const HEARD = new Set(["oui", "non"]);
const FREEZE_ENDS = new Set(["image", "saut", "masqué", "fin"]);
const TRIAL_STATUSES = new Set(["ok", "échec", "refusé", "préparé", "arrêté"]);
const DAMAGED = new Set(["oui", "non"]);
const AUDIO_CLEAN = new Set(["oui", "non", "pas-entendu"]);
const AUDIO_CHANGED = new Set(["oui", "parfois", "non", "pas-entendu"]);
const LIP_SYNC = new Set(["oui", "non-mux", "non-partout", "pas-regardé"]);
/** Une répétition de la passe « son multiplexé » : 1 à 3 (au plus 9 si la passe grandit). */
const repOf = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 9 ? v : null);
/** Une piste vue par la page ou désignée par la liste maître : `langue:étiquette`. */
const trackText = (v: unknown) => text(v, 100);
/** La piste au départ (étape 3f) : attendue, allumée, jugée, et les pistes annoncées. */
const audioCheckOf = (v: unknown) =>
  pick(v, { ok: bool, want: trackText, got: trackText, tracks: (x) => list(x, 16).map(trackText).filter((y) => y !== null) });
const oneOf = (allowed: Set<string>) => (v: unknown) => (typeof v === "string" && allowed.has(v) ? v : null);
/** Le nom d'un essai de la série (`ghosted-cra-leading`, `american-housewife-cra-600`) : minuscules, chiffres, tirets. */
const trialName = (v: unknown) => (typeof v === "string" && /^[a-z0-9-]{1,40}$/.test(v) ? v : null);
const qualityOf = (v: unknown) => pick(v, { total: (x) => num(x, 1e9), dropped: (x) => num(x, 1e9), corrupted: (x) => num(x, 1e9) });

function seekOf(raw: unknown): Record<string, unknown> {
  return pick(raw, {
    kind: (v) => (typeof v === "string" && SEEK_KINDS.has(v) ? v : null),
    from: (v) => num(v, 1e6),
    to: (v) => num(v, 1e6),
    // Du geste à `seeked`, à la première avance du temps, à `playing` ; et ce qui a manqué.
    seekedMs: (v) => num(v, 1e7),
    advanceMs: (v) => num(v, 1e7),
    playingMs: (v) => num(v, 1e7),
    landed: (v) => num(v, 1e6),
    ok: bool,
    timedOut: bool,
    waits: (v) => num(v, 1e4),
    error: (v) => text(v, 160),
  });
}

/** Le résumé de la chronologie d'un essai (`ChronoSummary`, chronology.ts) : des médianes. */
function chronoSummaryOf(raw: unknown): Record<string, unknown> {
  const ms = (v: unknown) => num(v, 1e7);
  return pick(raw, {
    aheadAdvanceS: (v) => num(v, 1e5),
    aheadSeekedS: (v) => num(v, 1e5),
    firstReqMs: ms,
    firstVideoReadyMs: ms,
    seekedToAdvanceMs: ms,
    videoAdvance: (v) => num(v, 1e4),
    readyMaxMs: ms,
    // Côté page (Resource Timing, étape 3f).
    firstVideoRecvMs: ms,
    startVideoRecvMs: ms,
    recvAdvance: (v) => num(v, 1e4),
  });
}

/**
 * La chronologie d'une lecture (étape 3e, DECISIONS §160), telle que la page l'a dessinée : l'horloge (décalage et
 * aller-retour du meilleur échange), l'échantillon de débit, ce que Resource Timing a vu des requêtes HLS, et une
 * cascade par démarrage et par saut — instants depuis le geste, avances, et deux listes de lignes courtes (`req`,
 * `ev`, format dans `chronology.ts`). Tout vient du navigateur : borné, et les lignes ne sont que du texte court.
 */
function chronoOf(raw: unknown): Record<string, unknown> {
  const ms = (v: unknown) => num(v, 1e7);
  return pick(raw, {
    clock: (v) => pick(v, { offsetMs: (x) => num(x, 1e12), rttMs: ms, samples: (x) => num(x, 100) }),
    link: (v) => pick(v, { mbps: (x) => num(x, 1e5), ms, via: oneOf(new Set(["rt", "lecture"])), MB: (x) => num(x, 100) }),
    rtLumen: (v) => num(v, 1e5),
    rtStream: (v) => num(v, 1e5),
    // Les segments reçus par la page, par rendu (`v`, `vm2`, `a3`) : au plus quelques clés courtes.
    rtSegs: (v) => {
      const out: Record<string, number> = {};
      for (const [k, x] of Object.entries(obj(v)).slice(0, 16)) {
        const n = num(x, 1e5);
        if (/^[a-z]{1,2}\d{0,4}$/.test(k) && n !== null) out[k] = n;
      }
      return out;
    },
    summary: chronoSummaryOf,
    cascades: (v) =>
      list(v, MAX_CASCADES).map((c) =>
        pick(c, {
          k: oneOf(new Set(["départ", "saut"])),
          to: (x) => num(x, 1e6),
          firstReqMs: ms,
          firstSegMs: ms,
          firstVideoReadyMs: ms,
          firstVideoSentMs: ms,
          seekedMs: ms,
          playingMs: ms,
          frameMs: ms,
          advanceMs: ms,
          aheadSeekedS: (x) => num(x, 1e5),
          aheadPlayingS: (x) => num(x, 1e5),
          aheadAdvanceS: (x) => num(x, 1e5),
          sentSeekedMB: (x) => num(x, 1e5),
          sentAdvanceMB: (x) => num(x, 1e5),
          videoSeeked: (x) => num(x, 1e4),
          videoAdvance: (x) => num(x, 1e4),
          readyMaxMs: ms,
          srvMbps: (x) => num(x, 1e6),
          firstVideoRecvMs: ms,
          recvSeeked: (x) => num(x, 1e4),
          recvAdvance: (x) => num(x, 1e4),
          recvAdvanceMB: (x) => num(x, 1e5),
          req: (x) => list(x, 48).map((y) => text(y, 80)).filter((y) => y !== null),
          ev: (x) => list(x, 60).map((y) => text(y, 60)).filter((y) => y !== null),
          rx: (x) => list(x, 48).map((y) => text(y, 80)).filter((y) => y !== null),
        })
      ),
  });
}

function runOf(raw: unknown, user: string): Record<string, unknown> {
  const run = pick(raw, {
    itemId: (v) => (typeof v === "string" && /^[0-9a-f]{32}$/i.test(v) ? v : null),
    title: (v) => text(v, 120),
    player: oneOf(PLAYERS),
    cut: cutOf,
    targetS: targetOf,
    mode: modeOf,
    startAt: (v) => num(v, 1e6),
    // Le lecteur actuel : ce que son moteur a ouvert (vidéo, piste, son copié ou réencodé), et la piste ouverte.
    engine: (v) => pick(v, { video: (x) => text(x, 80), audio: (x) => text(x, 80), sound: (x) => text(x, 80) }),
    openedAudio: (v) => num(v, 1e4),
    audio: (v) => num(v, 1e4),
    s: (v) => (isPlaybackId(v) ? v : null),
    version: (v) => text(v, 40),
    verdict: (v) =>
      pick(v, {
        ok: bool,
        reason: (x) => text(x, 40),
        detail: (x) => text(x, 120),
        segments: (x) => num(x, 1e6),
        longestS: (x) => num(x, 1e5),
        targetS: (x) => num(x, 1e5),
        craRasl: (x) => num(x, 1e6),
        verified: (x) => num(x, 1e6),
        durationS: (x) => num(x, 1e6),
      }),
    // « Tout enchaîner » : l'essai et son rang dans la série (la ligne porte aussi `auto`).
    trial: trialName,
    rank: (v) => num(v, 1e3),
    loadedMetadataMs: (v) => num(v, 1e7),
    firstFrameMs: (v) => num(v, 1e7),
    firstFrameVia: (v) => (v === "rvfc" || v === "playing" ? v : null),
    // La première image à la position de départ demandée, et la position de la toute première image (étape 3e).
    targetFrameMs: (v) => num(v, 1e7),
    firstFrameAt: (v) => num(v, 1e6),
    chrono: chronoOf,
    playedS: (v) => num(v, 1e6),
    seeks: (v) => list(v, MAX_SEEKS).map(seekOf),
    waits: (v) => pick(v, { count: (x) => num(x, 1e5), totalMs: (x) => num(x, 1e8), maxMs: (x) => num(x, 1e8) }),
    errors: (v) => list(v, 10).map((x) => text(x, 200)).filter((x) => x !== null),
    // Les images présentées (`requestVideoFrameCallback`) et les gels : la position a avancé de plus d'une seconde
    // sans image nouvelle — `at` la position de la dernière image, `ms` la durée estimée, `afterSeek` sans image
    // depuis un saut, `until` ce qui l'a fini. Sans `framesPresented`, les gels n'ont pas été cherchés.
    framesPresented: (v) => num(v, 1e8),
    freezes: (v) =>
      list(v, MAX_FREEZES).map((x) =>
        pick(x, { at: (y) => num(y, 1e6), ms: (y) => num(y, 1e8), afterSeek: bool, until: oneOf(FREEZE_ENDS) })
      ),
    audioTracks: (v) => list(v, 16).map((x) => text(x, 160)).filter((x) => x !== null),
    // Les pistes de texte de l'élément (§191, levier « sous-titres dans la liste ») : `genre:langue:étiquette:mode`.
    textTracks: (v) => list(v, 8).map((x) => text(x, 120)).filter((x) => x !== null),
    audioSwitches: (v) =>
      list(v, 12).map((x) =>
        pick(x, {
          from: (y) => text(y, 80),
          to: (y) => text(y, 80),
          // Du changement au temps qui a avancé de 0,3 s (≈ 300 ms sans coupure) ; `reloaded` : l'élément a-t-il
          // tout rechargé (`emptied`/`loadstart`) ; `waited` : un `waiting` entre-temps ; `heard` : ce que
          // l'administrateur a entendu, à la main. Les segments son demandés, eux, sont dans `srv.audioByTrack`.
          ms: (y) => num(y, 1e7),
          reloaded: bool,
          changeEvent: bool,
          waited: bool,
          heard: (y) => (typeof y === "string" && HEARD.has(y) ? y : null),
          // Le tour des pistes de la série : erreurs et gels dans les 8 s qui suivent le changement.
          errors: (y) => num(y, 1e3),
          freezes: (y) => num(y, 1e3),
          // La passe « son multiplexé » : la piste visée (numéro Matroska), allumée à la fin, et ses segments reçus.
          target: (y) => num(y, 1e4),
          applied: bool,
          segs: (y) => num(y, 1e4),
        })
      ),
    audioCheck: audioCheckOf,
    streamMbps: (v) => num(v, 1e5),
    quality: qualityOf,
    // Les compteurs de décodage à la première image, et la différence avec la fin (`quality`) : ce que l'essai a coûté.
    qualityStart: qualityOf,
    qualityDelta: qualityOf,
    end: (v) => text(v, 40),
  });
  // Le relevé serveur de la même lecture, s'il est de ce compte : `srv.*` comme les lignes du lecteur,
  // les segments son par piste, et la trace des segments remis.
  if (typeof run.s === "string") {
    const fields = lumenPlaybackFields(run.s, user);
    const stats = lumenPlaybackStats(run.s, user);
    if (stats) {
      Object.assign(run, fields);
      run["srv.audioByTrack"] = { ...stats.audioByTrack };
      run["srv.trace"] = [...stats.trace];
      run["srv.version"] = stats.version;
    }
  }
  return run;
}

/** Le résumé d'un essai dans la ligne récapitulative de « Tout enchaîner » (`TrialResult`, autoSeries.ts). */
function trialSummaryOf(raw: unknown): Record<string, unknown> {
  const count = (v: unknown) => num(v, 1e5);
  const duration = (v: unknown) => num(v, 1e8);
  return pick(raw, {
    trial: trialName,
    key: trialName,
    rank: (v) => num(v, 1e3),
    title: (v) => text(v, 120),
    player: oneOf(PLAYERS),
    cut: cutOf,
    targetS: targetOf,
    mode: modeOf,
    status: oneOf(TRIAL_STATUSES),
    reason: (v) => text(v, 120),
    firstFrameMs: duration,
    targetFrameMs: duration,
    chrono: chronoSummaryOf,
    linkMbps: (v) => num(v, 1e5),
    seeks: count,
    missed: count,
    seekMedianMs: duration,
    advanceP90Ms: duration,
    seekedMedianMs: duration,
    seekedP90Ms: duration,
    freezes: count,
    freezeMs: duration,
    errors: count,
    firstError: (v) => text(v, 200),
    waits: count,
    frames: (v) => num(v, 1e9),
    dropped: (v) => num(v, 1e9),
    corrupted: (v) => num(v, 1e9),
    audioSwitches: count,
    audioTrouble: count,
    verdicts: (v) => list(v, 4).map((x) => text(x, 200)).filter((x) => x !== null),
    // La passe « son multiplexé » (étape 3f).
    rep: repOf,
    advances: (v) => list(v, 40).map((x) => (x === null ? null : num(x, 1e8))),
    audioCheck: audioCheckOf,
    audioSwitch: (v) =>
      pick(v, { ms: duration, waited: bool, errors: count, freezes: count, applied: bool, segs: count }),
    streamMbps: (v) => num(v, 1e5),
    // La passe « changement de codec » (§185) : la reprise de chaque changement, appliqués, éléments rechargés.
    switchMs: (v) => list(v, 12).map((x) => (x === null ? null : num(x, 1e8))),
    switchApplied: count,
    switchReloaded: count,
  });
}

/** Une mesure comparée de la passe « son multiplexé » (`MuxMetric`, muxPass.ts). */
function muxMetricOf(raw: unknown): Record<string, unknown> {
  const duration = (v: unknown) => num(v, 1e8);
  const values = (v: unknown) => list(v, 9).map(duration).filter((x) => x !== null);
  return pick(raw, {
    normal: values,
    mux: values,
    medNormal: duration,
    medMux: duration,
    diffMs: duration,
    noiseMs: duration,
    separated: bool,
    kind: oneOf(new Set(["plus-rapide", "plus-lent", "minime", "bruit", "inconnu"])),
    verdict: (v) => text(v, 200),
    faster: (v) => num(v, 100),
    positions: (v) => num(v, 100),
  });
}

/** Les contrôles d'un mode (`MuxChecks`, muxPass.ts) : des compteurs et deux médianes. */
function muxChecksOf(raw: unknown): Record<string, unknown> {
  const count = (v: unknown) => num(v, 1e7);
  return pick(raw, Object.fromEntries(["trials", "ok", "errors", "freezes", "missed", "waits", "dropped", "corrupted", "audioChecked", "audioOk", "switches", "switchTrouble", "switchNotApplied", "switchMs", "switchSegs"].map((k) => [k, count])));
}

/** Le verdict de la passe « son multiplexé », par titre et sur l'ensemble (`MuxAnalysis`, muxPass.ts). */
function muxAnalysisOf(raw: unknown): Record<string, unknown> {
  const duration = (v: unknown) => num(v, 1e8);
  return pick(raw, {
    titles: (v) =>
      list(v, 8).map((t) =>
        pick(t, {
          key: trialName,
          title: (x) => text(x, 120),
          streamMbps: (x) => num(x, 1e5),
          floorMbps: (x) => num(x, 1e5),
          lowLink: (x) => num(x, 100),
          trials: (x) =>
            list(x, 12).map((r) =>
              pick(r, {
                rank: (y) => num(y, 1e3),
                rep: repOf,
                mode: oneOf(new Set(["normal", "multiplexé"])),
                status: oneOf(TRIAL_STATUSES),
                linkMbps: (y) => num(y, 1e5),
                low: bool,
                firstFrameMs: duration,
                seekedMs: duration,
                resumeMs: duration,
                startRecvMs: duration,
                audioOk: bool,
              })
            ),
          firstFrame: muxMetricOf,
          seeked: muxMetricOf,
          resume: muxMetricOf,
          checks: (x) => pick(x, { normal: muxChecksOf, multiplexé: muxChecksOf }),
          tracksSame: bool,
          regressions: (x) => list(x, 12).map((y) => text(y, 160)).filter((y) => y !== null),
        })
      ),
    overall: (v) => pick(v, { firstFrame: (x) => text(x, 200), resume: (x) => text(x, 200), regressions: (x) => text(x, 300) }),
  });
}

/** Une colonne du tableau comparatif (`ComparisonCell`, autoSeries.ts). */
function comparisonCellOf(raw: unknown): Record<string, unknown> {
  const duration = (v: unknown) => num(v, 1e8);
  const count = (v: unknown) => num(v, 1e5);
  return pick(raw, {
    status: oneOf(TRIAL_STATUSES),
    firstFrameMs: duration,
    targetFrameMs: duration,
    chrono: chronoSummaryOf,
    linkMbps: (v) => num(v, 1e5),
    seekedMedianMs: duration,
    seekedP90Ms: duration,
    advanceMedianMs: duration,
    advanceP90Ms: duration,
    seeks: count,
    missed: count,
    errors: count,
    freezes: count,
  });
}

/**
 * Le corps d'un « Envoyer les résultats », relu et borné, avec le relevé serveur de chaque lecture. Depuis
 * « Tout enchaîner » (16/11/2026), une ligne peut aussi porter `auto` — la série (`serie`, pour joindre ses
 * lignes), l'essai et son rang, ou `summary` pour la ligne récapitulative —, et celle-ci `trials` (chaque essai
 * résumé) et `answers` (les deux questions de fin : ce que la page ne voit pas).
 */
/**
 * La passe « Comme l'app » (17/11/2026, `appLikePass.ts`) : une ligne par variante — les gestes de l'hôte rejoués
 * autour d'un élément neuf, et ce que l'élément en a fait — puis un bilan (`summary`) qui nomme la cause.
 */
const APP_LIKE_OUTCOMES = new Set(["image", "erreur", "délai", "refusé", "arrêté"]);
const appLikeVariantName = (v: unknown) => (typeof v === "string" && /^[a-zé+-]{1,24}$/.test(v) ? v : null);
function appLikeOf(v: unknown): Record<string, unknown> {
  return pick(v, {
    summary: bool,
    itemId: (x) => (typeof x === "string" && /^[0-9a-f]{32}$/i.test(x) ? x : null),
    title: (x) => text(x, 120),
    rank: (x) => num(x, 100),
    of: (x) => num(x, 100),
    variant: appLikeVariantName,
    levers: (x) => (typeof x === "string" && /^[a-zé,]{1,60}$/.test(x) ? x : null),
    outcome: oneOf(APP_LIKE_OUTCOMES),
    ms: (x) => num(x, 1e6),
    via: oneOf(new Set(["rvfc", "loadeddata"])),
    code: (x) => num(x, 100),
    message: (x) => text(x, 200),
    play: (x) => text(x, 40),
    readyState: (x) => num(x, 10),
    networkState: (x) => num(x, 10),
    seen: (x) => text(x, 600),
    tracks: (x) => num(x, 100),
    s: (x) => (isPlaybackId(x) ? x : null),
    cause: (x) => text(x, 240),
    stopped: bool,
    elapsedS: (x) => num(x, 1e5),
    results: (x) =>
      list(x, 20).map((r) => pick(r, { variant: appLikeVariantName, outcome: oneOf(APP_LIKE_OUTCOMES), ms: (y) => num(y, 1e6), code: (y) => num(y, 100) })),
  });
}

export function lumenTestReport(body: Record<string, unknown>, user: string): Record<string, unknown> {
  return {
    ...pick(body, {
      auto: (v) =>
        pick(v, {
          serie: (x) => (typeof x === "string" && /^[0-9a-f]{6,24}$/.test(x) ? x : null),
          trial: trialName,
          rank: (x) => num(x, 1e3),
          of: (x) => num(x, 1e3),
          status: oneOf(TRIAL_STATUSES),
          player: oneOf(PLAYERS),
          pass: oneOf(PASSES),
          order: oneOf(ORDERS),
          mode: modeOf,
          seed: (x) => (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 2 ** 32 ? x : null),
          rep: repOf,
          summary: bool,
          done: (x) => num(x, 1e3),
          elapsedS: (x) => num(x, 1e6),
          stopped: bool,
        }),
      trials: (v) => list(v, MAX_TRIALS).map(trialSummaryOf),
      comparison: (v) =>
        list(v, MAX_TRIALS).map((row) =>
          pick(row, { key: trialName, title: (x) => text(x, 120), targetS: targetOf, mode: modeOf, serveur: comparisonCellOf, actuel: comparisonCellOf })
        ),
      answers: (v) =>
        pick(v, { damaged: oneOf(DAMAGED), damagedTitle: (x) => text(x, 120), audioClean: oneOf(AUDIO_CLEAN), audioChanged: oneOf(AUDIO_CHANGED), lipSync: oneOf(LIP_SYNC) }),
      mux: muxAnalysisOf,
      appLike: appLikeOf,
    }),
    build: text(body.build, 40),
    env: pick(body.env, {
      userAgent: (v) => text(v, 300),
      standalone: bool,
      hlsNative: (v) => text(v, 20),
      managedMediaSource: bool,
      screen: (v) => text(v, 40),
    }),
    runs: list(body.runs, MAX_RUNS).map((run) => runOf(run, user)),
    log: list(body.log, MAX_LOG)
      .map((line) => text(line, 200))
      .filter((line): line is string => line !== null),
  };
}
