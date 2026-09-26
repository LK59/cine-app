import { NextRequest, NextResponse } from "next/server";
import { qbittorrent } from "@/lib/clients/qbittorrent";
import { withErrorHandling } from "@/lib/api-helpers";

/**
 * Une empreinte de torrent, v1 (SHA-1, 40) ou v2 (SHA-256, 64), et rien d'autre.
 *
 * Le segment partait tel quel dans `hashes=` : qBittorrent y lit `all` comme « tous les
 * torrents » et `|` comme séparateur — un DELETE sur `/api/qbittorrent/torrents/all` vidait
 * le client entier, fichiers compris avec `deleteFiles=true` (26/09/2026). La page n'envoie
 * jamais qu'une empreinte à la fois, celle qu'elle a lue dans la liste.
 */
const TORRENT_HASH = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function badHash() {
  return NextResponse.json({ error: "Empreinte de torrent invalide" }, { status: 400 });
}

export async function POST(req: NextRequest, props: { params: Promise<{ hash: string }> }) {
  const params = await props.params;
  if (!TORRENT_HASH.test(params.hash)) return badHash();
  const body = await req.json().catch(() => null);
  const action = body?.action;
  if (action === "pause") return withErrorHandling(() => qbittorrent.pause([params.hash]));
  if (action === "resume") return withErrorHandling(() => qbittorrent.resume([params.hash]));
  return NextResponse.json({ error: "Action inconnue" }, { status: 400 });
}

export async function DELETE(req: NextRequest, props: { params: Promise<{ hash: string }> }) {
  const params = await props.params;
  if (!TORRENT_HASH.test(params.hash)) return badHash();
  const deleteFiles = req.nextUrl.searchParams.get("deleteFiles") === "true";
  return withErrorHandling(() => qbittorrent.remove([params.hash], deleteFiles));
}
