"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { Check, Copy, Link2, Loader2, Send, X } from "lucide-react";
import { ActionSheet } from "@/components/ActionSheet";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useToast } from "@/components/Toast";
import { useRole } from "@/lib/useRole";
import { apiAction } from "@/lib/apiAction";
import {
  SHARE_ADMIN_KEY,
  SHARE_DAYS_CHOICES,
  SHARE_DEFAULT_DAYS,
  SHARE_LABEL_MAX_CLIENT,
  SHARE_MAX_STREAMS_CLIENT,
  copyText,
  shareErrorText,
  shareUrl,
  type CreatedShareLink,
} from "@/components/share/shareClient";

/**
 * Partager un titre par un lien (DECISIONS.md §112) — le bouton de la fiche et sa fenêtre, pour
 * l'administrateur seul. Même forme que le téléchargement hors ligne (`OfflineDownloadControl`) :
 * une ligne du menu de la fiche au bureau, un bouton pleine largeur au téléphone, et une petite
 * fenêtre centrée à l'ordinateur, feuille au téléphone.
 *
 * Deux temps dans la même fenêtre : le choix (pour qui, combien de jours), puis le résultat — le lien
 * et son mot de passe, montré cette fois-ci seulement : le serveur ne le garde que haché. Le bouton
 * « Créer le lien » est donc un contenu de la fenêtre et non une de ses actions : `ActionSheet` se
 * referme après chaque action, et le mot de passe serait parti avec elle.
 */

export interface ShareTitle {
  kind: "movie" | "series";
  /** Le film ou la série chez Jellyfin. */
  itemId: string;
  radarrId?: number | null;
  sonarrId?: number | null;
  title: string;
  year?: number | null;
  posterUrl?: string | null;
}

interface Props extends ShareTitle {
  /**
   * `row` : une ligne du menu de la fiche au bureau ; `wide` : un bouton pleine largeur au téléphone ;
   * `icon` : une pastille ronde, sans texte — la place retenue (20/10/2026) : partager n'est pas un
   * geste de la fiche au même rang que Lire, et la ligne de menu en faisait trop (Louis).
   */
  variant: "row" | "wide" | "icon";
  /** Pour `icon` : la forme et la place de la pastille, posées par la fiche. */
  iconClassName?: string;
  iconStyle?: React.CSSProperties;
  /** Pour `icon` : la pastille posée sur l'image du téléphone ne doit pas saisir la fiche au doigt. */
  onPointerDown?: (e: React.PointerEvent) => void;
  rowClassName?: string;
  badgeClassName?: string;
  /** L'espacement du bouton pleine largeur dans sa colonne. */
  wideSpacing?: string;
}

/**
 * Ce titre peut-il être partagé depuis sa fiche ? Un film, s'il a un fichier : un lien vers un film
 * introuvable n'ouvrirait qu'un bouton grisé. Une série, toujours : on partage la série entière, et
 * l'épisode « À suivre » qui a perdu son fichier n'en dit rien — la fiche du téléphone cachait
 * pourtant la pastille d'une telle série, la condition du film recopiée, quand celle du bureau la
 * gardait (audit du 23/10/2026, DECISIONS.md §114.3).
 */
export function shareableFrom(kind: "movie" | "series", { jellyfinItemId, fileMissing }: { jellyfinItemId: string | null | undefined; fileMissing: boolean }): boolean {
  if (!jellyfinItemId) return false;
  return kind === "series" || !fileMissing;
}

export function ShareButton(props: Props) {
  const { isReadOnly } = useRole();
  // Présentation seulement : `proxy.ts` et `adminOnly` refusent la création à tout autre compte.
  return isReadOnly === false ? <ShareButtonOn {...props} /> : null;
}

function ShareButtonOn({ variant, rowClassName = "", badgeClassName = "", wideSpacing = "mb-2", iconClassName = "", iconStyle, onPointerDown, ...title }: Props) {
  const t = useT();
  const [open, setOpen] = useState(false);
  // Une ouverture, une fenêtre neuve : le mot de passe d'un lien déjà créé ne doit pas reparaître à
  // la suivante, ni le nom tapé pour un autre invité.
  const [generation, setGeneration] = useState(0);
  const openSheet = () => {
    setGeneration((g) => g + 1);
    setOpen(true);
  };
  const label = t("share.admin.button");
  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={openSheet}
          onPointerDown={onPointerDown}
          aria-label={label}
          title={label}
          className={iconClassName}
          style={iconStyle}
        >
          <Link2 size={16} />
        </button>
      ) : variant === "row" ? (
        <button type="button" data-detail-menu onClick={openSheet} className={rowClassName}>
          <span className={badgeClassName}>
            <Link2 size={14} />
          </span>
          <span className="text-sm font-medium">{label}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={openSheet}
          data-liquid-pan="wide"
          className={`${wideSpacing} flex w-full items-center justify-center gap-2 rounded-lg bg-white/10 px-4 py-3 text-sm font-medium text-white`}
        >
          <Link2 size={16} />
          {label}
        </button>
      )}
      <ShareSheet key={generation} open={open} onClose={() => setOpen(false)} {...title} />
    </>
  );
}

const SECTION = "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wider text-subtle";

/** La fenêtre : le choix, puis le lien créé. */
export function ShareSheet({ open, onClose, kind, itemId, radarrId, sonarrId, title, year, posterUrl }: ShareTitle & { open: boolean; onClose: () => void }) {
  const t = useT();
  const { locale } = useLocale();
  const { mutate } = useSWRConfig();
  const [label, setLabel] = useState("");
  const [days, setDays] = useState<number>(SHARE_DEFAULT_DAYS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedShareLink | null>(null);

  const name = label.trim();

  const create = async () => {
    if (busy || !name) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind,
        itemId,
        ...(kind === "movie" && radarrId != null ? { radarrId } : {}),
        ...(kind === "series" && sonarrId != null ? { sonarrId } : {}),
        label: name,
        days,
      };
      const result = (await apiAction(SHARE_ADMIN_KEY, { method: "POST", body: JSON.stringify(body) })) as CreatedShareLink;
      setCreated(result);
      // La vue Partages de l'Activité, si elle est ouverte ailleurs, apprend le nouveau lien.
      void mutate(SHARE_ADMIN_KEY);
    } catch (err) {
      setError(shareErrorText(err, t, locale));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ActionSheet
      open={open}
      onClose={onClose}
      centerOnWide
      title={year ? `${title} (${year})` : title}
      subtitle={t("share.admin.sheetTitle")}
      poster={posterUrl}
      actions={[
        created
          ? { label: t("share.admin.done"), icon: <Check size={18} />, onClick: () => {} }
          : { label: t("share.admin.close"), icon: <X size={18} />, onClick: () => {} },
      ]}
    >
      {created ? <ShareResult created={created} /> : (
        <>
          <form
            className="space-y-4 border-b border-white/10 px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
          >
            <div>
              <label htmlFor={`share-label-${itemId}`} className={`block ${SECTION}`}>
                {t("share.admin.who")}
              </label>
              <input
                id={`share-label-${itemId}`}
                type="text"
                value={label}
                maxLength={SHARE_LABEL_MAX_CLIENT}
                autoComplete="off"
                enterKeyHint="done"
                placeholder={t("share.admin.whoPlaceholder")}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full rounded-2xl bg-white/5 px-3 py-2.5 text-sm text-white outline-none placeholder:text-subtle focus:ring-1 focus:ring-white/40"
              />
            </div>
            <div>
              <p className={SECTION}>{t("share.admin.duration")}</p>
              <div role="radiogroup" aria-label={t("share.admin.duration")} className="grid grid-cols-5 gap-1.5">
                {SHARE_DAYS_CHOICES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    role="radio"
                    aria-checked={n === days}
                    aria-label={t("share.admin.daysLong", { n })}
                    onClick={() => setDays(n)}
                    className={`rounded-2xl px-2 py-2.5 text-sm tabular-nums transition-colors ${n === days ? "bg-white/15 text-white ring-1 ring-white/40" : "bg-white/5 text-muted active:bg-white/10"}`}
                  >
                    {t("share.admin.days", { n })}
                  </button>
                ))}
              </div>
            </div>
            <ul className="space-y-1 px-1 text-xs text-subtle">
              <li>{t(kind === "series" ? "share.admin.coversSeries" : "share.admin.coversMovie")}</li>
              <li>{t("share.admin.streams", { n: SHARE_MAX_STREAMS_CLIENT })}</li>
              <li>{t("share.admin.noDownload")}</li>
            </ul>
            {error && (
              <p role="alert" className="px-1 text-sm text-danger">
                {error}
              </p>
            )}
          </form>
          {/* Un contenu et non une action de la fenêtre : celles-ci la referment (voir plus haut). */}
          <div className="border-b border-white/10 py-1.5">
            <button
              type="button"
              onClick={() => void create()}
              disabled={busy || !name}
              className="flex w-full items-center gap-4 px-5 py-3.5 text-sm font-medium text-accent-400 transition-colors active:bg-white/5 disabled:opacity-40"
            >
              <span className="w-5 text-center text-muted">{busy ? <Loader2 size={18} className="animate-spin" /> : <Link2 size={18} />}</span>
              {busy ? t("share.admin.creating") : t("share.admin.create")}
            </button>
          </div>
        </>
      )}
    </ActionSheet>
  );
}

/** Le lien créé : l'adresse, le mot de passe — à envoyer par deux chemins —, et sa fin. */
function ShareResult({ created }: { created: CreatedShareLink }) {
  const t = useT();
  const { locale } = useLocale();
  const toast = useToast();
  const url = shareUrl(created.path);
  // Lu une fois : `navigator.share` ne change pas pendant la vie de la fenêtre.
  const [canShare] = useState(() => typeof navigator !== "undefined" && typeof navigator.share === "function");
  const until = new Date(created.expiresAt).toLocaleString(locale, { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit", hour12: false });

  const copy = async (text: string) => {
    if (await copyText(text)) toast.success(t("share.admin.copied"));
    else toast.error(t("share.admin.copyFailed"));
  };

  // L'adresse seule : le mot de passe voyage par un autre chemin, sinon il ne protège plus rien.
  const send = () => {
    navigator.share({ title: created.title, text: t("share.admin.shareText", { title: created.title }), url }).catch(() => {
      // Annulé par l'utilisateur, ou refusé : l'adresse reste là, à copier.
    });
  };

  return (
    <div className="space-y-4 border-b border-white/10 px-4 py-3" data-testid="share-result">
      <p className="px-1 text-sm text-white">{t("share.admin.created", { label: created.label, date: until })}</p>
      <CopyField label={t("share.admin.link")} value={url} copyLabel={t("share.admin.copyLink")} onCopy={() => void copy(url)} />
      <CopyField label={t("share.admin.password")} value={created.password} mono copyLabel={t("share.admin.copyPassword")} onCopy={() => void copy(created.password)} />
      <div className="space-y-1 px-1 text-xs">
        <p className="font-medium text-warning">{t("share.admin.once")}</p>
        <p className="text-subtle">{t("share.admin.separately")}</p>
      </div>
      {canShare && (
        <button type="button" onClick={send} className="flex w-full items-center justify-center gap-2 rounded-2xl bg-white/10 px-4 py-2.5 text-sm font-medium text-white active:bg-white/15">
          <Send size={16} />
          {t("share.admin.shareLink")}
        </button>
      )}
    </div>
  );
}

function CopyField({ label, value, copyLabel, onCopy, mono = false }: { label: string; value: string; copyLabel: string; onCopy: () => void; mono?: boolean }) {
  return (
    <div>
      <p className={SECTION}>{label}</p>
      <div className="flex items-center gap-2 rounded-2xl bg-white/5 py-1.5 pl-3 pr-1.5">
        <span className={`min-w-0 flex-1 select-all break-all text-sm text-white ${mono ? "font-mono tracking-wide" : ""}`}>{value}</span>
        <button type="button" onClick={onCopy} aria-label={copyLabel} title={copyLabel} className="shrink-0 rounded-xl p-2 text-muted transition-colors hover:text-white active:bg-white/10">
          <Copy size={16} />
        </button>
      </div>
    </div>
  );
}
