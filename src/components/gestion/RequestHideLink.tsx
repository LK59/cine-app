"use client";

import Link from "next/link";
import useSWR from "swr";
import { EyeOff } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";

/**
 * Le chemin vers le masquage des demandes, montré seulement quand la fonction est là : la route
 * répond 404 sinon, et le lien ne s'affiche pas (pas d'entrée dans la navigation : c'est une option
 * propre à une installation).
 */
export function RequestHideLink() {
  const t = useT();
  const { data } = useSWR<{ enabled?: boolean; account?: string }>("/api/admin/request-hide?state=1", fetcher, { shouldRetryOnError: false, revalidateOnFocus: false });
  if (!data?.enabled) return null;
  return (
    <Link href="/jellyseerr/masquage" className="btn btn-ghost btn-sm">
      <EyeOff size={14} /> {t("requestHide.link", { account: data.account ?? "" })}
    </Link>
  );
}
