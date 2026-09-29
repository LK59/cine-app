/**
 * Les règles qui refusent un démarrage forgeable vivent dans `server-boot/startupChecks.mjs`, et
 * nulle part ailleurs : `boot.mjs` les applique avant d'importer le serveur (sans quoi un refus
 * laissait le conteneur « Up » en répondant 500, audit du 29/09/2026), `instrumentation.ts` les
 * réapplique pour `next dev`, qui ne passe pas par `boot.mjs`. Ce module n'est qu'un point d'entrée
 * sous l'alias `@/`.
 */
export {
  PLACEHOLDER_SECRETS,
  PLACEHOLDER_PASSWORDS,
  MIN_SECRET_LENGTH,
  sessionSecretProblem,
  adminPasswordProblem,
  startupRefusal,
} from "../../server-boot/startupChecks.mjs";
