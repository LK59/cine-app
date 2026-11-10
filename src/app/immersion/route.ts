import { serveImmersionFile } from "@/lib/immersionFiles";

/**
 * La page du mode « Immersion » — voir `src/lib/immersionFiles.ts`.
 *
 * Une route et non une page de l'application : ce qu'elle rend est le `index.html` d'un autre
 * projet, tel quel. Le proxy la traite comme n'importe quelle page (sans session : la connexion),
 * et la politique de sécurité générale s'y applique (`next.config.js`).
 */
export async function GET(req: Request) {
  return serveImmersionFile(req, ["index.html"], { html: true });
}
