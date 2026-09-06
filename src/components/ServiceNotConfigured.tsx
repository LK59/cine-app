"use client";

import { PlugZap } from "lucide-react";
import { useT } from "@/components/TranslationProvider";
import { SERVICE_ENV, type ServiceKey } from "@/lib/services";

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
      <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-slate-500 ring-1 ring-white/10">
        <PlugZap size={22} />
      </span>
      <p className="text-sm text-slate-300">{t("services.notConfigured", { name })}</p>
      <p className="max-w-md text-xs leading-6 text-slate-500">{t("services.notConfiguredHint")}</p>
      <code className="rounded bg-black/40 px-3 py-2 font-mono text-[11px] leading-6 text-slate-300">
        {SERVICE_ENV[service].join("\n")}
      </code>
    </div>
  );
}
