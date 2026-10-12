import path from "node:path";
import { LOG_DIR, appendJsonLine } from "@/lib/logFile";

/**
 * `data/logs/subtitle-gen.log` — une ligne JSON par événement, tourné à 5 Mo comme les autres
 * (`logFile.ts`), lu par le panneau Activité (source `subtitleGen`).
 *
 * `start`, `first`, `seek` (avec `fastLane`), `seekFirst` (`seekToFirstMs`), `batch` (résumé périodique, pas une ligne par lot), `retry`, `pause`,
 * `refusal`, `kept`, `source`, `done`, `present`, `cleanup`. **Jamais la clé, jamais le texte des
 * sous-titres** : ce journal se lit à plusieurs, et un sous-titre est l'œuvre de quelqu'un d'autre.
 * Les champs qui pourraient en porter sont retirés ici, quoi que l'appelant passe.
 */
export const SUBTITLE_GEN_LOG = () => path.join(LOG_DIR, "subtitle-gen.log");
export const SUBTITLE_GEN_LOG_KEEP = 5;

const FORBIDDEN = new Set(["kind", "timestamp", "text", "source", "lines", "cues", "key", "apiKey", "api_key", "glossary", "prompt", "data"]);

export function logGen(kind: string, fields: Record<string, unknown>): void {
  try {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      if (FORBIDDEN.has(k)) continue;
      clean[k] = typeof v === "string" ? v.slice(0, 300) : v;
    }
    appendJsonLine(SUBTITLE_GEN_LOG(), { timestamp: new Date().toISOString(), kind, ...clean }, { keep: SUBTITLE_GEN_LOG_KEEP });
  } catch {
    /* un journal qui échoue ne doit rien arrêter */
  }
}
