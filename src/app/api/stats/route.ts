import { NextResponse } from "next/server";
import { getDiskStats } from "@/lib/disk-stats";

export const dynamic = "force-dynamic";

export async function GET() {
  // `computing` passe au client (13/11/2026) : sans lui, la page ne savait pas que la première
  // réponse après un démarrage (-1 partout) n'était qu'une attente, et repassait deux minutes plus
  // tard — la barre du disque restait absente d'ici là. Voir `statsRefreshInterval`.
  const { moviesBytes, tvBytes, seedsBytes, disk, computing } = getDiskStats();
  return NextResponse.json({ moviesBytes, tvBytes, seedsBytes, disk, computing });
}
