import path from "node:path";
import { LOG_DIR } from "@/lib/logFile";

/**
 * Le journal du banc d'essai (`data/logs/bench.log`) : un film par ligne, puis une ligne `run`.
 * Écrit par la route du banc, relu par elle et par la page d'activité de l'administrateur — d'où
 * sa place ici plutôt que dans la route : les deux doivent parler du même fichier et du même
 * nombre d'archives.
 */
export const BENCH_LOG = () => path.join(LOG_DIR, "bench.log");
/** Dix archives depuis le 24/09/2026 (deux avant) ; la route n'en relit que les dernières. */
export const BENCH_LOG_KEEP = 10;
/** Ce que la route relit pour l'historique des séries : les trois dernières générations, comme avant. */
export const BENCH_LOG_READ = 3;
