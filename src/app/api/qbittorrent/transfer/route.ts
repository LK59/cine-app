import { qbittorrent } from "@/lib/clients/qbittorrent";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => qbittorrent.getTransferInfo());
}
