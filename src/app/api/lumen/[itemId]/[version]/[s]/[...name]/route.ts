import type { NextRequest } from "next/server";
import { serveLumenName } from "@/lib/lumenServer/serve";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ itemId: string; version: string; s: string; name: string[] }> };

/**
 * Lumen serveur en HLS (DECISIONS.md §156) : la liste maître, les listes média, les init et les
 * segments d'un élément — `master.m3u8?audio=N`, `v.m3u8`, `a3.m3u8`, `init-v.mp4`, `init-a3.mp4`,
 * `v/12.m4s`, `a3/12.m4s`. Administrateur seul, revérifié par `serveLumenName` (`lumenAccess`) et pas
 * seulement par le proxy (`ADMIN_ONLY_READS`). Tout le reste est dans `src/lib/lumenServer/serve.ts`.
 */
export async function GET(req: NextRequest, { params }: Params) {
  return serveLumenName(req, await params);
}
