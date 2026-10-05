export const ADMIN_USER_KEY: "__ADMIN_USER";
export const ADMIN_HASH_KEY: "__ADMIN_PASSWORD_HASH";
export const MIN_ADMIN_PASSWORD: number;
/** `scrypt$<sel>$<hachage>`. */
export function hashAdminPassword(password: string): string;
export function verifyAdminPassword(password: string, stored: string | null | undefined): boolean;
/** Pose un nouveau mot de passe dans la base ; rend le nom du compte. */
export function resetAdminPassword(dataDir: string, password: string, user?: string): Promise<string>;
