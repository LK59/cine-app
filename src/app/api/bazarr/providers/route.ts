import { bazarr } from "@/lib/clients/bazarr";
import { withErrorHandling } from "@/lib/api-helpers";

export async function GET() {
  return withErrorHandling(() => bazarr.getProviders());
}
