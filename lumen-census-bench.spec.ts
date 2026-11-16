// Recensement de l'éligibilité à Lumen serveur (étape 3b, DECISIONS.md §157) — sauté sans LUMEN_CENSUS.
//
// La question : sous la découpe `idr` (la règle, §155), les HEVC à GOP ouvert — défaut de x265, une CRA
// suivie de RASL à presque chaque image clé — n'ont presque plus de point de coupe, et leurs segments
// dépassent 30 s (`segment-trop-long`). Quelle part de la bibliothèque est réellement servable, et
// combien le deviendrait une découpe qui coupe aussi sur les CRA (`cra`) ? Ce banc passe chaque fichier
// d'un échantillon par **le même code que la route** — `buildLumenIndex` (le lecteur d'index léger, la
// vérification des clés, la découpe, le son) puis `lumenEligibility` avec la piste par défaut du fichier
// (`defaultAudioTrack`) —, une fois par découpe, sur le même fichier.
//
//   docker run --rm --name lumen-recensement --cpus 2 -m 2g -v "$PWD":/app -v /mnt/media/video:/media:ro \
//     -v <sorties>:/out -w /app -e LUMEN_CENSUS=/out/echantillon.tsv -e LUMEN_CENSUS_OUT=/out/recensement.jsonl \
//     [-e LUMEN_CENSUS_BUDGET_S=420] node:26-alpine npx vitest run lumen-census-bench.spec.ts
//
// LUMEN_CENSUS : une ligne par fichier, `id<TAB>strate<TAB>chemin<TAB>étiquette`. Les fichiers déjà dans
// LUMEN_CENSUS_OUT sont sautés : le recensement se fait par lots, avec des pauses (la lecture d'un index
// à froid coûte 2 à 25 s sur le disque à plateaux partagé avec X-Ray et les spectateurs), et chaque lot
// s'arrête de commencer un fichier au-delà de LUMEN_CENSUS_BUDGET_S. Un fichier à la fois.
//
// La seconde découpe relit le même fichier juste après la première : ses lectures tombent presque toutes
// dans le cache de pages, son temps n'est pas un temps à froid (seul celui de `idr` l'est, à peu près).
//
// LUMEN_CENSUS_CUTS (`idr,cra` par défaut) : les découpes à passer — `cra` seule pour un recensement du son
// (§159), qui ne dépend pas de la découpe. Chaque ligne porte aussi, pour chaque piste audio, son codec, son
// refus et ses réparations (`sbr-explicite`, `silence-devant`, `silence-derriere`).
import { describe, it } from "vitest";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { FileByteSource } from "@/lib/lumenServer/fileSource";
import { buildLumenIndex } from "@/lib/lumenServer/lumenIndex";
import { defaultAudioTrack, lumenEligibility } from "@/lib/lumenServer/eligibility";
import type { LumenCutMode, LumenIndex } from "@/lib/lumenServer/format";
import { dolbyVisionInfo } from "@/lib/webcodecs/codecConfig";

const LIST = process.env.LUMEN_CENSUS;
const OUT = process.env.LUMEN_CENSUS_OUT ?? "/out/recensement.jsonl";
const BUDGET_MS = Number(process.env.LUMEN_CENSUS_BUDGET_S ?? 420) * 1000;
/** La source de `jobs.ts` pour un index : petits morceaux, d'en-tête en en-tête. */
const INDEX_SOURCE = { chunkSize: 16 * 1024, chunks: 64 };
const CUTS = (process.env.LUMEN_CENSUS_CUTS ?? "idr,cra").split(",").filter((c): c is "idr" | "cra" => c === "idr" || c === "cra");

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/** Ce qu'une découpe a donné, pour la ligne du fichier. */
function cutSummary(index: LumenIndex, ms: number) {
  const durations = index.segments.map((s) => (s.endUs - s.startUs) / 1e6);
  const audioTrack = defaultAudioTrack(index);
  const verdict = lumenEligibility(index, audioTrack);
  return {
    ok: verdict.ok,
    reason: verdict.ok ? null : verdict.reason,
    detail: verdict.ok ? null : (verdict.detail ?? null),
    // Le refus du fichier seul (vidéo, découpe), sans celui de la piste : ce que la découpe change.
    fileRefusal: index.refusal?.reason ?? null,
    segments: index.segments.length,
    longestS: round(Math.max(0, ...durations), 2),
    medianS: round(median(durations), 2),
    over30: durations.filter((d) => d > 30).length,
    keys: index.keys,
    ms: Math.round(ms),
    reads: index.cost.reads,
    MB: round(index.cost.bytes / 1048576),
  };
}

describe.skipIf(!LIST)("recensement de l'éligibilité à Lumen serveur", () => {
  it(
    "passe chaque fichier par l'index et lumenEligibility, sous idr puis cra",
    async () => {
      const began = Date.now();
      const done = new Set<string>();
      if (existsSync(OUT)) {
        for (const line of readFileSync(OUT, "utf8").split("\n")) {
          try {
            done.add((JSON.parse(line) as { id: string }).id);
          } catch {
            /* ligne vide ou coupée par un arrêt */
          }
        }
      }
      const rows = readFileSync(LIST!, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [id, stratum, path, label] = line.split("\t");
          return { id, stratum, path, label };
        });
      let processed = 0;
      for (const row of rows) {
        if (done.has(row.id)) continue;
        if (Date.now() - began > BUDGET_MS) break;
        const line: Record<string, unknown> = { id: row.id, stratum: row.stratum, label: row.label, path: row.path };
        try {
          const results: Partial<Record<LumenCutMode, ReturnType<typeof cutSummary>>> = {};
          let first: LumenIndex | null = null;
          for (const cut of CUTS) {
            const source = await FileByteSource.open(row.path, INDEX_SOURCE);
            try {
              const t0 = performance.now();
              const index = await buildLumenIndex(source, source.identity, { cut });
              results[cut] = cutSummary(index, performance.now() - t0);
              first ??= index;
            } finally {
              source.close();
            }
          }
          const index = first!;
          const audioTrack = defaultAudioTrack(index);
          const dv = index.video?.dolbyVision ? dolbyVisionInfo(index.video.dolbyVision.record) : null;
          Object.assign(line, {
            size: index.identity.size,
            container: index.container,
            video: index.video?.codecId ?? null,
            width: index.video?.width ?? null,
            dvProfile: dv?.profile ?? null,
            durationS: round(index.durationUs / 1e6),
            audio: {
              tracks: index.audio.length,
              defaultTrack: audioTrack,
              defaultCodec: index.audio.find((a) => a.number === audioTrack)?.codecId ?? null,
              defaultChannels: index.audio.find((a) => a.number === audioTrack)?.channels ?? null,
              defaultRefusal: index.audio.find((a) => a.number === audioTrack)?.refusal?.reason ?? null,
              servable: index.audio.filter((a) => !a.refusal).length,
              hlsChannels: index.audio.find((a) => a.number === audioTrack)?.signal?.channels ?? null,
              all: index.audio.map((a) => ({
                number: a.number,
                codec: a.codecId,
                channels: a.channels,
                rate: a.sampleRate,
                refusal: a.refusal?.reason ?? null,
                detail: a.refusal?.detail ?? null,
                ...(a.codecId === "A_AAC" && a.codecPrivate ? { asc: Buffer.from(a.codecPrivate).toString("hex") } : {}),
                repairs: [...(a.configuration ? ["sbr-explicite"] : []), ...(a.silence?.leadUntilUs != null ? ["silence-devant"] : []), ...(a.silence?.tailFromUs != null ? ["silence-derriere"] : [])],
              })),
            },
            idr: results.idr,
            cra: results.cra,
          });
        } catch (error) {
          line.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
        }
        line.at = new Date().toISOString();
        appendFileSync(OUT, `${JSON.stringify(line)}\n`);
        processed += 1;
      }
      console.log(`[recensement] ${processed} fichiers en ${Math.round((Date.now() - began) / 1000)} s, ${done.size + processed}/${rows.length} faits`);
    },
    // Le budget, plus le dernier fichier commencé (deux index à froid d'un film 4K : ~60 s au pire).
    BUDGET_MS + 180_000
  );
});
