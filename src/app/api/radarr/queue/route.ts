import { radarr } from "@/lib/clients/radarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => radarr.getQueue());
}
