"use client";

import useSWR from "swr";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { toJellyfinLanguage } from "@/lib/trackPreferences";
import { useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { Toggle } from "@/components/Toggle";
import { VIEWER_NOTIFICATION_CATEGORIES, type NotificationCategory } from "@/lib/notifications";

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
      <span className="text-xs text-slate-400">{label}</span>
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
      <span className="text-xs text-slate-400">{t("player.account.subtitleMode")}</span>
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
 * Ce que chacun veut recevoir — les trois annonces d'un spectateur.
 *
 * L'interrupteur du dessus abonne *cet appareil* ; ces choix-là appartiennent au *compte* et valent
 * sur tous ses appareils. Ils n'existaient que dans la gestion : un spectateur ne pouvait que tout
 * couper — ce qui compte depuis que « nouvel épisode », qui n'était jamais parti, part vraiment.
 *
 * Basculé tout de suite, remis en place et dit si le serveur refuse.
 */
const CHOICE_LABELS: Record<(typeof VIEWER_NOTIFICATION_CATEGORIES)[number], [string, string]> = {
  "new-episode": ["player.account.notifNewEpisode", "player.account.notifNewEpisodeHint"],
  "request-available": ["player.account.notifRequest", "player.account.notifRequestHint"],
  "watchlist-available": ["player.account.notifList", "player.account.notifListHint"],
};

export function NotificationChoices() {
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
  return (
    <ul className="mt-3 flex flex-col divide-y divide-white/5 rounded-xl border border-white/10 bg-white/5 px-4">
      {VIEWER_NOTIFICATION_CATEGORIES.map((category) => {
        const [label, hint] = CHOICE_LABELS[category];
        return (
          <li key={category} className="flex items-center justify-between gap-4 py-3">
            <div>
              <p className="text-sm text-white">{t(label)}</p>
              <p className="mt-0.5 text-xs text-slate-500">{t(hint)}</p>
            </div>
            <Toggle checked={data.preferences[category] === true} onChange={(value) => void set(category, value)} ariaLabel={t(label)} />
          </li>
        );
      })}
    </ul>
  );
}
