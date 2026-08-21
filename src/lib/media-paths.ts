/** Filesystem layout used by the disk/storage stats scanners (disk-stats.ts,
 *  storage-scan.ts). All paths default to the container-internal layout
 *  documented in the README (mirrors Radarr's /movies, Sonarr's /tv), but can
 *  be overridden individually via env vars for setups with a different layout. */

export const MEDIA_ROOT = process.env.MEDIA_ROOT || "/mnt/media/video";

export const MOVIES_PATH = process.env.MOVIES_PATH || `${MEDIA_ROOT}/movies`;
export const TV_PATH = process.env.TV_PATH || `${MEDIA_ROOT}/tv`;
export const SEEDS_PATH = process.env.SEEDS_PATH || `${MEDIA_ROOT}/downloads/seeds`;
export const SEED_MOVIES_PATH = process.env.SEED_MOVIES_PATH || `${SEEDS_PATH}/movies`;
export const SEED_TV_PATH = process.env.SEED_TV_PATH || `${SEEDS_PATH}/tv`;
export const CROSS_SEED_PATH = process.env.CROSS_SEED_PATH || `${SEEDS_PATH}/cross-seed-links`;
