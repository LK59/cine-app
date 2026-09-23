"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { toJellyfinLanguage } from "@/lib/trackPreferences";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { Toggle } from "@/components/Toggle";
import { ADMIN_NOTIFICATION_CATEGORIES, VIEWER_NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/notifications";

/**
 * Les réglages d'un compte, écrits une fois : le panneau Compte et l'écran d'accueil s'en servent
 * tous les deux (21/09/2026). Deux écrans qui recopieraient leurs listes de langues ou de modes
 * finiraient par proposer des choix différents pour la même chose.
 */

// Les codes sous lesquels Jellyfin range ces langues — la forme terminologique de l'ISO 639-2,
// `fra` et non `fre`, vérifiée sur le serveur. Voir `toJellyfinLanguage`.
export const AUDIO_CHOICES = ["", "fra", "eng", "spa", "deu", "ita", "jpn"] as const;

// `Smart` fait partie des modes de Jellyfin et manquait ici : un compte réglé dessus voyait
// « Par défaut », c'est-à-dire le premier de la liste faute de correspondance.
export const SUBTITLE_MODES = ["Default", "Smart", "Always", "OnlyForced", "None"] as const;

/**
 * Les choix à afficher, la valeur enregistrée comprise.
 *
 * Un compte réglé sur une langue absente de cette courte liste — du russe, du coréen — ne doit
 * pas voir « peu importe » : il croirait n'avoir rien choisi, et le premier réglage qu'il
 * toucherait effacerait sa préférence. La valeur est donc ajoutée à la liste, sous son code, et
 * survit à une visite.
 */
function choicesWith(current: string | null): readonly string[] {
  if (!current || (AUDIO_CHOICES as readonly string[]).includes(current)) return AUDIO_CHOICES;
  return [...AUDIO_CHOICES, current];
}

export function LanguageSelect({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string | null;
  disabled: boolean;
  onChange: (code: string | null) => void;
}) {
  const t = useT();
  const current = toJellyfinLanguage(value);
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted">{label}</span>
      <select
        className="select"
        disabled={disabled}
        value={current ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        {choicesWith(current).map((code) => (
          <option key={code || "none"} value={code}>
            {/* Une langue hors liste s'affiche sous son code en capitales plutôt que sous une clé
                de traduction manquante : c'est laid mais juste, et ça se reconnaît. */}
            {!code
              ? t("player.account.langAny")
              : (AUDIO_CHOICES as readonly string[]).includes(code)
                ? t(`player.account.lang.${code}`)
                : code.toUpperCase()}
          </option>
        ))}
      </select>
    </label>
  );
}


/**
 * Quand afficher les sous-titres — les cinq modes de Jellyfin, dits en phrases.
 *
 * « Intelligent », « Par défaut » ne disaient pas ce qu'ils font. Les libellés disent maintenant
 * l'effet : voir `player.account.subtitleModes.*`.
 */
export function SubtitleModeSelect({
  value,
  disabled,
  onChange,
  className = "",
}: {
  value: string | null;
  disabled: boolean;
  onChange: (mode: string) => void;
  className?: string;
}) {
  const t = useT();
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs text-muted">{t("player.account.subtitleMode")}</span>
      <select className="select" disabled={disabled} value={value ?? "Default"} onChange={(e) => onChange(e.target.value)}>
        {SUBTITLE_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {t(`player.account.subtitleModes.${mode}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * Ce que chacun veut recevoir — les trois annonces d'un spectateur, et pour l'administrateur
 * celles des téléchargements.
 *
 * L'interrupteur du dessus abonne *cet appareil* ; ces choix-là appartiennent au *compte* et valent
 * sur tous ses appareils. Ils n'existaient que dans la gestion : un spectateur ne pouvait que tout
 * couper — ce qui compte depuis que « nouvel épisode », qui n'était jamais parti, part vraiment.
 * Depuis le 23/09/2026 c'est le seul endroit où ils se règlent : la gestion en avait une seconde
 * copie, avec d'autres libellés pour les mêmes choix.
 *
 * Basculé tout de suite, remis en place et dit si le serveur refuse.
 */
const CHOICE_LABELS: Record<NotificationCategory, [string, string]> = {
  "new-episode": ["player.account.notifNewEpisode", "player.account.notifNewEpisodeHint"],
  "request-available": ["player.account.notifRequest", "player.account.notifRequestHint"],
  "watchlist-available": ["player.account.notifList", "player.account.notifListHint"],
  "torrent-complete": ["player.account.notifDownloadDone", "player.account.notifDownloadDoneHint"],
  "torrent-started": ["player.account.notifDownloadStarted", "player.account.notifDownloadStartedHint"],
};

export function NotificationChoices({ admin = false }: { admin?: boolean }) {
  const t = useT();
  const toast = useToast();
  const { data, mutate } = useSWR<{ preferences: Record<NotificationCategory, boolean> }>("/api/notifications/settings", fetcher);

  async function set(category: NotificationCategory, enabled: boolean) {
    if (!data?.preferences) return;
    const before = data;
    await mutate({ preferences: { ...data.preferences, [category]: enabled } }, { revalidate: false });
    try {
      const next = (await apiAction("/api/notifications/settings", {
        method: "PUT",
        body: JSON.stringify({ preferences: { [category]: enabled } }),
      })) as { preferences: Record<NotificationCategory, boolean> };
      await mutate(next, { revalidate: false });
    } catch (error) {
      await mutate(before, { revalidate: false });
      toast.error(error instanceof Error && error.message ? error.message : t("common.error"));
    }
  }

  // Pas de préférences lisibles, pas de cases : mieux vaut rien qu'un interrupteur qui ment.
  if (!data?.preferences) return null;
  const preferences = data.preferences;
  const list = (categories: readonly NotificationCategory[]) => (
    <ul className="mt-3 flex flex-col divide-y divide-white/5 rounded-xl border border-white/10 bg-white/5 px-4">
      {categories.map((category) => {
        const [label, hint] = CHOICE_LABELS[category];
        return (
          <li key={category} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm text-white">{t(label)}</p>
              <p className="mt-0.5 text-xs text-subtle">{t(hint)}</p>
            </div>
            <Toggle checked={preferences[category] === true} onChange={(value) => void set(category, value)} ariaLabel={t(label)} />
          </li>
        );
      })}
    </ul>
  );
  return (
    <>
      {list(VIEWER_NOTIFICATION_CATEGORIES)}
      {/* Montré à l'administrateur seulement : le serveur refuse ces choix à un compte ordinaire, et
          ces annonces ne lui parviendraient jamais. */}
      {admin && (
        <>
          <p className="mt-4 text-xs font-medium uppercase tracking-wide text-subtle">{t("player.account.notifDownloads")}</p>
          {list(ADMIN_NOTIFICATION_CATEGORIES)}
        </>
      )}
    </>
  );
}

/** Le temps de verrouiller le téléphone ou de quitter l'application : au premier plan, iOS ne montre rien. */
const TEST_DELAY_S = 5;

/**
 * Envoyer une notification d'essai à ses propres appareils.
 *
 * C'est la seule façon de savoir qu'un appareil est bien abonné — l'interrupteur dit ce que le
 * navigateur a accepté, pas ce qui arrive. Il ne vivait que dans la gestion.
 */
export function NotificationTest() {
  const t = useT();
  const [countdown, setCountdown] = useState<number | null>(null);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "noDevice" | "error">("idle");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearInterval(timer.current);
  }, []);

  function start() {
    if (timer.current || state === "sending") return;
    setState("idle");
    let remaining = TEST_DELAY_S;
    setCountdown(remaining);
    timer.current = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) {
        setCountdown(remaining);
        return;
      }
      if (timer.current) clearInterval(timer.current);
      timer.current = null;
      setCountdown(null);
      setState("sending");
      fetch("/api/push/test", { method: "POST" })
        .then(async (res) => {
          const json = (await res.json().catch(() => ({}))) as { ok?: boolean };
          // 404 : aucun appareil abonné pour ce compte — l'interrupteur du dessus est à activer.
          setState(res.status === 404 ? "noDevice" : res.ok && json.ok ? "sent" : "error");
        })
        .catch(() => setState("error"));
    }, 1000);
  }

  const busy = countdown !== null || state === "sending";
  return (
    <div className="mt-3 flex items-center justify-between gap-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm text-white">{t("player.account.notifTest")}</p>
        <p className="mt-0.5 text-xs text-subtle" aria-live="polite">
          {state === "sent"
            ? t("notifications.sent")
            : state === "noDevice"
              ? t("player.account.notifTestNoDevice")
              : state === "error"
                ? t("notifications.sendError")
                : t("player.account.notifTestHint")}
        </p>
      </div>
      <button type="button" onClick={start} disabled={busy} className="btn btn-ghost btn-sm shrink-0">
        {countdown !== null
          ? t("notifications.sendingIn", { n: countdown })
          : state === "sending"
            ? t("notifications.sending")
            : t("notifications.testButton")}
      </button>
    </div>
  );
}
