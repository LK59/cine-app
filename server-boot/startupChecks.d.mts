export const PLACEHOLDER_SECRETS: Set<string>;
export const PLACEHOLDER_PASSWORDS: Set<string>;
export const MIN_SECRET_LENGTH: number;
export function sessionSecretProblem(secret: string): string | null;
export function adminPasswordProblem(password: string): string | null;
export function startupRefusal(values: { sessionSecret: string; adminPassword: string }): string | null;
export function dataDirProblem(dataDir: string): string | null;
