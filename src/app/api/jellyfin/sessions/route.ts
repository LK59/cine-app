import { jellyfin } from "@/lib/clients/jellyfin";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => jellyfin.getSessions());
}
