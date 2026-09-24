// La frise d'une séance : où en était le film, instant par instant.
//
// Le journal ne dit pas la position à chaque seconde ; il la dit à chaque événement — l'ouverture,
// les deux bouts d'un saut, un blocage, une reconstruction, un changement de piste, l'arrêt. La
// frise relie ces points connus par des droites, sans rien inventer entre eux : une pente plus
// douce que le temps qui passe, c'est une pause ou une attente ; un palier, c'est que rien n'a
// avancé. Un saut est un trait vertical, suivi du temps qu'il a fallu pour y arriver.
//
// Écrit une fois ici, pour les deux écrans qui la montrent : la séance, et le signalement qui la cite.

export interface FrisePoint {
  /** Millisecondes depuis l'ouverture. */
  t: number;
  /** Position dans le film, en secondes. */
  pos: number;
}

export type FriseMarkKind = "start" | "stop" | "stall" | "rebuild" | "error" | "fallback" | "audio" | "background";

export interface FriseMark extends FrisePoint {
  kind: FriseMarkKind;
  /** Le motif, pour l'infobulle. */
  label: string;
}

export interface FriseModel {
  /** Durée de la séance, en ms. */
  duration: number;
  /** Haut de l'axe des positions, en secondes : la durée du film si on la connaît. */
  top: number;
  /** Morceaux de lecture reliant les positions connues ; un saut coupe le tracé. */
  runs: FrisePoint[][];
  /** Les sauts : de `from` vers `to`, demandés à `t`, arrivés `took` ms plus tard. */
  jumps: { t: number; from: number; to: number; took: number }[];
  /** Les intervalles où l'on attendait (saut, blocage) ou où l'application était cachée. */
  bands: { from: number; to: number; kind: "wait" | "background" }[];
  marks: FriseMark[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * `lines` : les lignes complètes de la séance, dans l'ordre. `runtime` : la durée du film en
 * secondes, quand le serveur média la connaît — sinon l'axe s'arrête un peu au-dessus de la plus
 * grande position vue.
 */
export function friseModel(lines: Record<string, unknown>[], start: number, runtime: number | null = null): FriseModel {
  const runs: FrisePoint[][] = [[]];
  const jumps: FriseModel["jumps"] = [];
  const bands: FriseModel["bands"] = [];
  const marks: FriseMark[] = [];
  let last = 0;
  let maxPos = 0;

  const at = (line: Record<string, unknown>) => Math.max(0, (Date.parse(text(line.timestamp)) || start) - start);
  const push = (p: FrisePoint) => {
    runs[runs.length - 1].push(p);
    maxPos = Math.max(maxPos, p.pos);
  };

  for (const line of lines) {
    const t = at(line);
    last = Math.max(last, t);
    const kind = text(line.kind);
    const reason = text(line.reason) || text(line.message) || text(line.why);
    switch (kind) {
      case "start": {
        const pos = num(line.at) ?? 0;
        // Une reconstruction réécrit `start` : ce n'est pas une nouvelle ouverture.
        if (num(line.rebuild)) push({ t, pos });
        else {
          push({ t, pos });
          marks.push({ t, pos, kind: "start", label: reason });
        }
        break;
      }
      case "seek": {
        const from = num(line.from);
        const to = num(line.landedAt) ?? num(line.to);
        if (from === null || to === null) break;
        const took = Math.max(0, num(line.tookMs) ?? 0);
        const asked = Math.max(0, t - took);
        push({ t: asked, pos: from });
        jumps.push({ t: asked, from, to, took });
        if (took > 0) bands.push({ from: asked, to: t, kind: "wait" });
        runs.push([]);
        push({ t, pos: to });
        break;
      }
      case "stall": {
        const pos = num(line.position);
        if (pos === null) break;
        const stalled = num(line.stalledMs) ?? 5000;
        bands.push({ from: Math.max(0, t - stalled), to: t, kind: "wait" });
        push({ t, pos });
        marks.push({ t, pos, kind: "stall", label: `${Math.round(stalled / 1000)} s` });
        break;
      }
      case "rebuild": {
        const pos = num(line.position) ?? num(line.at);
        const hidden = num(line.hiddenMs);
        if (hidden !== null) bands.push({ from: Math.max(0, t - hidden), to: t, kind: "background" });
        if (pos === null) break;
        push({ t, pos });
        marks.push({ t, pos, kind: hidden !== null ? "background" : "rebuild", label: reason });
        break;
      }
      case "audio": {
        const pos = num(line.at);
        if (pos === null) break;
        push({ t, pos });
        marks.push({ t, pos, kind: "audio", label: `${text(line.from)} → ${text(line.to)}` });
        break;
      }
      case "error":
      case "fallback": {
        const previous = runs[runs.length - 1].at(-1)?.pos ?? 0;
        marks.push({ t, pos: previous, kind, label: reason });
        break;
      }
      case "stop": {
        const pos = num(line.at);
        if (pos === null) break;
        push({ t, pos });
        marks.push({ t, pos, kind: "stop", label: text(line.why) });
        break;
      }
    }
  }

  const top = runtime && runtime > maxPos ? runtime : Math.max(60, maxPos * 1.08);
  return {
    duration: Math.max(last, 1000),
    top,
    runs: runs.filter((r) => r.length > 0).map((r) => r.sort((a, b) => a.t - b.t)),
    jumps,
    bands,
    marks,
  };
}
