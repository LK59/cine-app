/** Le fichier des secrets générés au premier lancement. */
export function secretsFile(dataDir: string): string;
/** Pose dans l'environnement les secrets manquants (générés au besoin) ; rend leurs noms. */
export function applyFirstRunSecrets(dataDir: string, env?: Record<string, string | undefined>): Promise<string[]>;
