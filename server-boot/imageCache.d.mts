export function isMountPoint(dir: string, mountinfo?: string): boolean;
/** `monté` (rien fait), `lié`, `déjà lié`. */
export function linkImageCache(options: { appDir: string; dataDir: string; mountinfo?: string }): "monté" | "lié" | "déjà lié";
