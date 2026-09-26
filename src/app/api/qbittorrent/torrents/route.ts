import { qbittorrent } from "@/lib/clients/qbittorrent";
import { publicTorrent } from "@/lib/qbittorrentPublic";
import { withErrorHandling } from "@/lib/api-helpers";

// Réduit, jamais brut : la réponse de qBittorrent porte les passkeys des trackers privés — voir
// `publicTorrent`.
export async function GET() {
  return withErrorHandling(async () => (await qbittorrent.getTorrents()).map(publicTorrent));
}
