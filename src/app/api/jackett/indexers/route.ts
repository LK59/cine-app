import { jackett } from "@/lib/clients/jackett";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => jackett.getIndexers());
}
