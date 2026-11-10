import { serveImmersionFile } from "@/lib/immersionFiles";

/**
 * Les fichiers du mode « Immersion » (code, textures, modèles) — voir `src/lib/immersionFiles.ts`.
 * Sous `/api/` pour que le service worker n'y touche pas ; derrière le proxy, donc une session.
 */
export async function GET(req: Request, props: { params: Promise<{ path: string[] }> }) {
  const { path } = await props.params;
  return serveImmersionFile(req, path);
}
