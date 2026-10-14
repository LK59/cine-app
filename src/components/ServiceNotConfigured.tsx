"use client";

import { PlugZap } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { SERVICE_ENV, type ServiceKey } from "@/lib/services";
import { useConfiguredServices } from "@/lib/useConfiguredServices";

/**
 * Un service qui n'est pas branché n'est pas un service en panne.
 *
 * La page échouait comme si quelque chose s'était cassé — un bandeau rouge, un message d'erreur
 * réseau — alors qu'il manquait seulement une clé dans `.env`. Ça envoie chercher une panne là où
 * il n'y a qu'une configuration, et ça laisse croire que l'installation est abîmée.
 *
 * Elle dit donc ce qu'il en est, et exactement quoi poser pour que ça marche. Les noms des
 * variables viennent d'une seule liste, partagée avec le serveur, pour qu'ils ne dérivent pas.
 */
export function ServiceNotConfigured({ service }: { service: ServiceKey }) {
  const t = useT();
  const name = t(`nav.${service}`);
  return (
    <div className="card flex flex-col items-center gap-3 p-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-subtle ring-1 ring-white/10">
        <PlugZap size={22} />
      </span>
      <p className="text-sm text-muted">{t("services.notConfigured", { name })}</p>
      <p className="max-w-md text-xs leading-6 text-subtle">{t("services.notConfiguredHint")}</p>
      <code className="rounded bg-black/40 px-3 py-2 font-mono text-[11px] leading-6 text-muted">
        {SERVICE_ENV[service].join("\n")}
      </code>
    </div>
  );
}

/**
 * Une ligne au-dessus d'une page qui tient sans ces services mais en montre moins : le calendrier sans
 * Radarr ni Sonarr garde les sorties de TMDB, les statistiques de la bibliothèque restent vides
 * (14/10/2026, §89). Rien si tout est branché — et rien avant la réponse (`isConfigured` dit « oui »
 * tant qu'il ne sait pas), pour ne jamais faire clignoter un avertissement à tort.
 */
export function NotConfiguredNote({ services }: { services: ServiceKey[] }) {
  const t = useT();
  const { isConfigured } = useConfiguredServices();
  const missing = services.filter((s) => !isConfigured(s));
  if (missing.length === 0) return null;
  return (
    <p className="mb-4 flex items-center gap-2 rounded-xl bg-white/4 px-4 py-2.5 text-xs text-subtle" data-testid="not-configured-note">
      <PlugZap size={14} className="shrink-0" />
      {t("services.notConfiguredNote", { names: missing.map((s) => SERVICE_LABEL[s]).join(", ") })}
    </p>
  );
}

const SERVICE_LABEL: Record<ServiceKey, string> = {
  radarr: "Radarr",
  sonarr: "Sonarr",
  bazarr: "Bazarr",
  jackett: "Jackett",
  jellyfin: "Jellyfin",
  jellyseerr: "Jellyseerr",
  qbittorrent: "qBittorrent",
  tmdb: "TMDB",
};
