"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { useT } from "@/components/TranslationProvider";

/**
 * L'état de la version allégée de Lumen serveur (`lumenServer/light/`), sous sa carte de la Configuration → Lecture :
 * l'encodeur et le iGPU détectés (ffmpeg, pilote VAAPI) ou pourquoi pas — sans eux, la liste maître reste celle d'avant
 * —, et ce que le serveur a encodé depuis son démarrage. Lu de `/api/admin/lumen-light` (administrateur seul), relu
 * toutes les 30 s tant que la page est ouverte.
 */
interface Status {
  audience: "off" | "admins" | "tous";
  encoder: { available: true; version: string; driver: string } | { available: false; reason: string };
  stats: { built: number; ram: number; disk: number; failed: number; running: number; queued: number };
}

export function LumenLightStatus() {
  const t = useT();
  const { data } = useSWR<Status>("/api/admin/lumen-light", fetcher, { refreshInterval: 30_000 });
  if (!data) return null;
  const ok = data.encoder.available;
  return (
    <section className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 sm:p-5" data-lumen-light-status="">
      <p className={`text-sm font-medium ${ok ? "text-success" : "text-warning"}`}>
        {data.encoder.available ? t("config.lumenLight.detected", { version: data.encoder.version, driver: data.encoder.driver }) : t("config.lumenLight.unavailable", { reason: data.encoder.reason })}
      </p>
      {ok && (
        <p className="mt-2 text-xs text-subtle">
          {t("config.lumenLight.now", { built: data.stats.built, kept: data.stats.ram + data.stats.disk, failed: data.stats.failed, running: data.stats.running, queued: data.stats.queued })}
        </p>
      )}
    </section>
  );
}
