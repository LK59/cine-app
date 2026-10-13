"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import Link from "next/link";
import { LogOut, Languages, Subtitles, KeyRound, MonitorSmartphone, LifeBuoy, Check, Copy, SlidersHorizontal, Activity, Wrench, Megaphone, Sparkles, ChevronDown, UsersRound, MessageSquareWarning, ListChecks, HardDrive, Rows3, MoveVertical } from "lucide-react";
import { fetcher } from "@/lib/swr";
import { apiAction } from "@/lib/apiAction";
import { hardNavigate, signOut } from "@/lib/signOut";
import { LOCALES, LOCALE_LABELS, getDateLocale, type Locale } from "@/lib/i18n";
import { toJellyfinLanguage } from "@/lib/trackPreferences";
import { useLocale, useT } from "@/components/TranslationProvider";
import { useErrorText } from "@/lib/useErrorText";
import { useToast } from "@/components/Toast";
import { PushToggle } from "@/components/PushToggle";
import { PlayerPanelFrame } from "./PlayerPanelFrame";
import { AppSignature } from "@/components/AppSignature";
import { useReportBadge } from "@/lib/useReportBadge";
import { cinemaNavigate } from "@/lib/cinemaRoute";
import { BenchSection } from "./BenchSection";
import { LanguageSelect, SubtitleModeSelect, NotificationChoices, NotificationTest } from "./accountControls";
import { openOnboarding } from "./onboardingEvents";
import { Toggle } from "@/components/Toggle";
import { setGuidedScroll, useGuidedScroll } from "@/lib/guidedScroll";
import { setHomeLayoutChoice, useHomeLayoutChoice } from "@/lib/useHomeLayout";
import type { PlayerPreferences } from "@/app/api/player/account/preferences/route";
import type { OtherSession } from "@/app/api/auth/sessions/route";
import { MAINTENANCE_KEY, type MaintenanceState } from "@/lib/useMaintenance";
import { clearDeviceCache, deviceCacheUsage } from "@/lib/resumeCache/clearDeviceCache";
import { fmtSize } from "@/lib/format";

/**
 * Le compte, en une feuille.
 *
 * C'est un sous-ensemble de `/parametres`, redessiné dans la langue du lecteur : rien de ce qui
 * touche à l'infrastructure, rien qui parle d'un service par son nom. Ce qui s'y ajoute est ce
 * qui manquait vraiment — changer son mot de passe, que personne ne pouvait faire depuis
 * l'application.
 */
function Section({ icon: Icon, title, children }: { icon?: React.ElementType; title?: string; children: React.ReactNode }) {
  return (
    // `py-6` debout, moins couché : cinq sections à six rems d'écart font descendre
    // « Déconnexion » très loin sur un écran de 390 px. Le filet ne sépare plus que deux sections
    // d'une même carte — la première n'en a pas (voir `Group`).
    <section className="border-t border-white/8 py-6 first:border-t-0 [@media(max-height:500px)]:py-4">
      {/* Sans titre quand la section est seule dans son groupe (Notifications) : le titre du
          groupe le dit déjà, et deux « Notifications » l'un sous l'autre se lisaient comme un
          oubli (13/10/2026). */}
      {title && Icon && (
        <h3 className="mb-4 flex items-center gap-2.5 text-sm font-semibold text-white [@media(max-height:500px)]:mb-2.5">
          <Icon size={16} className="text-subtle" />
          {title}
        </h3>
      )}
      {children}
    </section>
  );
}

/**
 * Un groupe de sections, titré en petites capitales.
 *
 * Une carte par groupe, façon Réglages d'iPhone (26/09/2026) : les sections se suivaient à plat,
 * séparées par des filets, et rien ne disait où un groupe finissait. Le titre reste au-dessus de
 * la carte ; dedans, un filet entre deux sections, jamais avant la première.
 */
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mt-9 first:mt-0 [@media(max-height:500px)]:mt-6">
      <h2 className="mb-2.5 px-1 text-xs font-medium uppercase tracking-wide text-subtle">{title}</h2>
      <div data-group-card="" className="rounded-2xl bg-white/4 px-4 ring-1 ring-inset ring-white/8 sm:px-5">{children}</div>
    </div>
  );
}

/**
 * Une ligne d'une carte : icône, titre, éventuelle aide dessous, le geste à droite.
 *
 * La forme de toute l'Aide et de l'Interface depuis le 13/10/2026 : l'Aide empilait des sections
 * titrées, des boutons pleine largeur et une carte de trois lignes posée dans la carte du groupe —
 * une boîte dans la boîte, et cinq façons de dire « ouvrir ». Toutes les lignes ont maintenant le
 * même dessin, le même filet entre elles, et la même place pour leur bouton.
 */
function Row({ icon: Icon, title, hint, children }: { icon: React.ElementType; title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div data-row="" className="flex items-center justify-between gap-4 border-t border-white/8 py-3.5 first:border-t-0">
      <div className="min-w-0">
        <p className="flex items-center gap-2.5 text-sm text-white">
          <Icon size={16} className="shrink-0 text-subtle" />
          <span className="min-w-0">{title}</span>
        </p>
        {hint && <p className="mt-0.5 pl-[26px] text-xs text-subtle">{hint}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center">{children}</div>}
    </div>
  );
}

/**
 * « Signaler un problème » — pour tout le monde. L'assistant et la liste remplacent ce panneau,
 * comme l'activité : le retour y ramène. La pastille dit qu'une réponse attend.
 */
function ReportRows() {
  const t = useT();
  const { mine } = useReportBadge();
  return (
    <>
      <Row icon={MessageSquareWarning} title={t("player.account.report")} hint={t("player.account.reportHint")}>
        <button type="button" onClick={() => cinemaNavigate({ account: false, report: "nouveau" })} className="btn btn-ghost btn-sm">
          {t("player.account.open")}
        </button>
      </Row>
      <Row icon={ListChecks} title={t("player.account.reportMine")}>
        <button type="button" onClick={() => cinemaNavigate({ account: false, report: "liste" })} className="btn btn-ghost btn-sm">
          {t("news.open")}
          {mine > 0 && <span className="rounded-full bg-accent-500 px-1.5 text-[11px] font-semibold text-white">{mine}</span>}
        </button>
      </Row>
    </>
  );
}

/**
 * Compte → Nouveautés (DECISIONS.md §73) : la page remplace ce panneau, comme les signalements, et
 * le retour y ramène. Tout ce que la fenêtre a montré, plus la liste des corrections et l'historique.
 */
function NewsRow() {
  const t = useT();
  return (
    <Row icon={Sparkles} title={t("news.title")} hint={t("news.accountHint")}>
      <button type="button" onClick={() => cinemaNavigate({ account: false, news: "1" })} className="btn btn-ghost btn-sm">
        {t("news.open")}
      </button>
    </Row>
  );
}

export function PlayerAccountPanel({ leaving, replaced, fromTab }: { leaving?: boolean; replaced?: boolean; fromTab?: boolean }) {
  const t = useT();
  const { data: me } = useSWR<{ username: string; jfUser: string | null; role: string }>("/api/auth/me", fetcher);
  // La connexion locale (celle de l'administrateur) n'a pas de compte Jellyfin derrière elle :
  // ni préférences de lecture, ni mot de passe à changer de ce côté. Le dire une fois vaut mieux
  // que trois listes déroulantes grisées sans explication.
  // Tant que la réponse n'est pas là, on suppose un compte Jellyfin — le cas de presque tout le
  // monde. Le « non » par défaut annonçait un instant « compte local » à chacun, puis la page
  // sautait quand la lecture et le mot de passe apparaissaient (23/09/2026).
  const hasJellyfin = me ? me.jfUser != null : true;
  const badge = useReportBadge();

  // Gardée : hors ligne, la déconnexion restait bloquée sur place — voir `signOut`.
  const logout = () => signOut(hardNavigate);

  return (
    <PlayerPanelFrame contentWidth="42rem"
      leaving={leaving}
      replaced={replaced}
      fromTab={fromTab}
      title={t("player.nav.account")}
      // Une majuscule à l'affichage seulement : le nom du compte, lui, reste tel que Jellyfin le
      // connaît — c'est lui qu'on tape pour se connecter.
      subtitle={displayName(me?.jfUser || me?.username)}
    >
      {/* L'ordre du 13/10/2026, décidé par Louis : les langues d'abord (celle de l'application,
          puis celles de la lecture), le compte, les notifications, l'interface, l'aide à plat,
          puis l'outillage de l'administrateur. « Se déconnecter » ferme la page, seul, là où on le
          cherche. */}
      <div className="mx-auto w-full max-w-2xl">
        <Group title={t("player.account.groups.preferences")}>
          <LanguageSection />
          {hasJellyfin && <PlaybackSection />}
        </Group>

        <Group title={t("player.account.groups.account")}>
          {hasJellyfin ? (
            <PasswordSection />
          ) : (
            <Section icon={KeyRound} title={t("player.account.password")}>
              <p className="text-sm text-muted">{t("player.account.localAccountHint")}</p>
            </Section>
          )}
          <SessionsSection />
        </Group>

        <Group title={t("player.account.notifications")}>
          <Section>
            <div className="flex flex-col gap-3 rounded-xl border border-white/10 bg-white/5 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div>
                <p className="text-sm text-white">{t("player.account.notificationsLabel")}</p>
                <p className="mt-0.5 text-xs text-subtle">{t("player.account.notificationsHint")}</p>
              </div>
              <PushToggle />
            </div>
            <NotificationChoices admin={me?.role === "admin"} />
            <NotificationTest />
          </Section>
        </Group>

        <Group title={t("player.account.display")}>
          <DisplayRows />
        </Group>

        {/* Toute l'aide au même niveau : une ligne par chose, sans section ni carte dans la carte. */}
        <Group title={t("player.account.groups.help")}>
          <NewsRow />
          <OnboardingRow />
          <StatusRow />
          <HdrFaqRow />
          <StorageRow />
          <ReportRows />
        </Group>

        {/* Montré à l'administrateur seulement : rien n'est bloqué au-delà de l'affichage — le
            proxy refuse déjà toute écriture à un compte ordinaire — mais proposer une porte qui ne
            s'ouvre pas est une promesse qu'on ne tient pas. */}
        {me?.role === "admin" && (
          <Group title={t("player.account.groups.admin")}>
            {/* L'activité des comptes, dans le cinéma et au-dessus de la gestion : c'est là qu'on
                vient le plus souvent (24/09/2026). Elle remplace ce panneau, et le retour y ramène. */}
            <Section icon={UsersRound} title={t("player.account.activity")}>
              <p className="mb-3 text-xs text-subtle">{t("player.account.activityHint")}</p>
              <button
                type="button"
                onClick={() => cinemaNavigate({ account: false, activity: "1" })}
                className="btn btn-ghost w-full justify-center sm:w-auto"
              >
                <UsersRound size={16} />
                {t("player.account.openActivity")}
                {badge.admin > 0 && <span className="rounded-full bg-accent-500 px-1.5 text-[11px] font-semibold text-white">{badge.admin}</span>}
              </button>
            </Section>
            <MaintenanceSection />
            <BenchSection />
            {/* Le banc des gestes et des matières, pour juger à l'œil sur l'appareil qu'on tient
                (04/10/2026). Il s'ouvre comme l'activité, à la place de ce panneau. */}
            <Section icon={Sparkles} title={t("player.account.animLab")}>
              <p className="mb-3 text-xs text-subtle">{t("player.account.animLabHint")}</p>
              <button
                type="button"
                onClick={() => cinemaNavigate({ account: false, activity: "animations" })}
                className="btn btn-ghost w-full justify-center sm:w-auto"
              >
                <Sparkles size={16} />
                {t("player.account.openAnimLab")}
              </button>
            </Section>
            <Section icon={SlidersHorizontal} title={t("player.nav.manage")}>
              <a href="/gestion" className="btn btn-ghost w-full justify-center sm:w-auto">
                <SlidersHorizontal size={16} />
                {t("player.account.openManage")}
              </a>
            </Section>
          </Group>
        )}

        <div className="mt-9 [@media(max-height:500px)]:mt-6">
          <button type="button" onClick={logout} className="btn btn-ghost w-full justify-center text-danger">
            <LogOut size={16} />
            {t("player.account.signOutAction")}
          </button>
        </div>

        {/* La signature, sous tout le reste : la dernière chose de la page, jamais une qu'on lit
            en cherchant un réglage (DECISIONS.md §41). Le cadre du panneau garde déjà la marge
            du bas — indicateur d'accueil et barre du téléphone compris. */}
        <AppSignature className="mt-6 text-center" />
      </div>
    </PlayerPanelFrame>
  );
}

function LanguageSection() {
  const t = useT();
  const toast = useToast();
  const { locale, setLocale } = useLocale();
  const [pending, setPending] = useState<Locale | null>(null);
  const active = pending ?? locale;

  async function apply() {
    if (!pending) return;
    // Pas de rechargement sur un refus : il ramènerait l'ancienne langue sans rien dire.
    try {
      await setLocale(pending);
    } catch {
      toast.error(t("common.error"));
      return;
    }
    // Le dictionnaire est rendu côté serveur : seul un rechargement le remplace vraiment.
    setTimeout(() => window.location.reload(), 80);
  }

  return (
    <Section icon={Languages} title={t("player.account.language")}>
      {/* Une liste déroulante, comme les réglages de lecture juste en dessous (23/09/2026). La
          grille de quatre gros boutons était la seule autre forme de réglage de la page, pour
          celui qu'on touche le moins. */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-muted">{t("player.account.appLanguage")}</span>
        <select
          className="select"
          value={active}
          onChange={(e) => {
            const l = e.target.value as Locale;
            setPending(l === locale ? null : l);
          }}
        >
          {LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
      </label>
      {pending && pending !== locale && (
        <div className="mt-4 flex items-center justify-between gap-4 rounded-xl border border-warning/20 bg-warning/10 px-4 py-3">
          <p className="text-xs text-warning">{t("settings.language.reloadNotice", { lang: LOCALE_LABELS[pending] })}</p>
          <button onClick={apply} className="btn btn-sm shrink-0 bg-warning text-black hover:bg-warning/85">
            {t("settings.language.apply")}
          </button>
        </div>
      )}
    </Section>
  );
}

/**
 * L'interface du compte : la disposition de l'accueil (`useHomeLayout.ts`, DECISIONS.md §52) et le
 * défilement guidé (`guidedScroll.ts`, §50), en deux lignes de la carte du groupe.
 *
 * « Afficher le bouton « Tous les films / séries » » a disparu le 13/10/2026 : le bouton est
 * toujours là, sur le bureau comme sur le téléphone.
 */
function DisplayRows() {
  const t = useT();
  const toast = useToast();
  const on = useGuidedScroll();
  const home = useHomeLayoutChoice();
  const fail = () => toast.error(t("common.error"));
  const fallback = home.defaults.continueHero;
  const checked = home.own.continueHero ?? fallback;
  return (
    <>
      <Row icon={Rows3} title={t("player.account.home.continueHero")} hint={t("player.account.home.continueHeroHint")}>
        <Toggle
          checked={checked}
          ariaLabel={t("player.account.home.continueHero")}
          // Revenir sur la valeur du serveur, c'est la suivre à nouveau : un compte n'a pas à
          // figer un choix qu'il n'a jamais voulu différent.
          onChange={(next) => void setHomeLayoutChoice("continueHero", next === fallback ? null : next).catch(fail)}
        />
      </Row>
      <Row icon={MoveVertical} title={t("player.account.guidedScroll")} hint={t("player.account.guidedScrollHint")}>
        <Toggle checked={on} ariaLabel={t("player.account.guidedScroll")} onChange={(next) => void setGuidedScroll(next).catch(fail)} />
      </Row>
    </>
  );
}

function PlaybackSection() {
  const t = useT();
  const errorText = useErrorText();
  const toast = useToast();
  const { data, mutate } = useSWR<PlayerPreferences>("/api/player/account/preferences", fetcher, {
    revalidateOnFocus: false,
  });
  const [saving, setSaving] = useState(false);

  async function save(patch: Partial<PlayerPreferences>) {
    if (saving) return;
    setSaving(true);
    try {
      await apiAction("/api/player/account/preferences", { method: "POST", body: JSON.stringify(patch) });
      await mutate();
      toast.success(t("player.account.saved"));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={Subtitles} title={t("player.account.playback")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <LanguageSelect
          label={t("player.account.audioLanguage")}
          value={data?.audioLanguage ?? null}
          disabled={saving || !data}
          onChange={(code) => void save({ audioLanguage: code })}
        />
        <LanguageSelect
          label={t("player.account.subtitleLanguage")}
          value={data?.subtitleLanguage ?? null}
          disabled={saving || !data}
          onChange={(code) => void save({ subtitleLanguage: code })}
        />

        <SubtitleModeSelect
          className="sm:col-span-2"
          value={data?.subtitleMode ?? null}
          disabled={saving || !data}
          onChange={(mode) => void save({ subtitleMode: mode })}
        />
      </div>
      <p className="mt-3 text-xs text-subtle">{t("player.account.playbackHint")}</p>
    </Section>
  );
}

function PasswordSection() {
  const t = useT();
  const errorText = useErrorText();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  // Replié tant qu'on ne le demande pas : trois champs toujours ouverts occupaient un écran
  // entier de téléphone pour un geste qu'on fait une fois par an (23/09/2026).
  const [open, setOpen] = useState(false);

  const mismatch = confirm.length > 0 && next !== confirm;
  const canSubmit = current.length > 0 && next.length >= 8 && !mismatch && !saving;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    try {
      await apiAction("/api/player/account/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      toast.success(t("player.account.passwordChanged"));
      setCurrent("");
      setNext("");
      setConfirm("");
      setOpen(false);
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Section icon={KeyRound} title={t("player.account.password")}>
      {!open ? (
        <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost w-full justify-center sm:w-auto">
          <KeyRound size={16} />
          {t("player.account.changePassword")}
        </button>
      ) : (
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <input
          className="input sm:col-span-2"
          type="password"
          autoComplete="current-password"
          placeholder={t("player.account.currentPassword")}
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={t("player.account.newPassword")}
          value={next}
          onChange={(e) => setNext(e.target.value)}
        />
        <input
          className="input"
          type="password"
          autoComplete="new-password"
          placeholder={t("player.account.confirmPassword")}
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {/* Dit avant d'agir : Jellyfin fait tomber tous les autres appareils du compte au changement
            de mot de passe. Sans cet avertissement, le téléphone renvoyé à la connexion deux heures
            plus tard se lisait comme une panne (07/10/2026). */}
        <p className="text-xs text-muted sm:col-span-2">{t("player.account.passwordOtherDevices")}</p>
        <div className="flex items-center gap-3 sm:col-span-2">
          <button type="submit" disabled={!canSubmit} className="btn btn-primary btn-sm">
            {saving ? t("player.account.saving") : t("player.account.changePassword")}
          </button>
          <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost btn-sm">
            {t("common.cancel")}
          </button>
          <p className="text-xs text-subtle">
            {mismatch ? t("player.account.passwordMismatch") : t("player.account.passwordRule")}
          </p>
        </div>
      </form>
      )}
    </Section>
  );
}

/**
 * Ce que l'application garde sur cet appareil, et de quoi le vider (28/09/2026) — voir
 * `clearDeviceCache`. La taille est celle que le navigateur annonce pour le site entier ; elle
 * n'apparaît pas quand il ne la donne pas. Rangé dans l'Aide depuis le 13/10/2026 : c'est un geste
 * de dépannage, pas un réglage du compte.
 */
function StorageRow() {
  const t = useT();
  const toast = useToast();
  const [usage, setUsage] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    let alive = true;
    void deviceCacheUsage().then((bytes) => {
      if (alive) setUsage(bytes);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function clear() {
    setClearing(true);
    try {
      await clearDeviceCache();
      setUsage(await deviceCacheUsage());
      toast.success(t("player.account.storageCleared"));
    } finally {
      setClearing(false);
    }
  }

  return (
    <Row
      icon={HardDrive}
      title={t("player.account.storage")}
      hint={
        <>
          {t("player.account.storageHint")}
          {usage !== null && usage > 0 && <span className="mt-0.5 block text-muted">{t("player.account.storageUsed", { size: fmtSize(usage) })}</span>}
        </>
      }
    >
      <button type="button" onClick={() => void clear()} disabled={clearing} className="btn btn-ghost btn-sm">
        {t("player.account.storageClear")}
      </button>
    </Row>
  );
}

function SessionsSection() {
  const t = useT();
  const errorText = useErrorText();
  const { locale } = useLocale();
  const toast = useToast();
  const [sessions, setSessions] = useState<OtherSession[] | null>(null);
  const [revoking, setRevoking] = useState(false);
  const count = sessions?.length ?? null;

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j != null) setSessions(j.sessions ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  async function revoke() {
    setRevoking(true);
    try {
      await apiAction("/api/auth/sessions", { method: "DELETE" });
      setSessions([]);
      toast.success(t("player.account.devicesRevoked"));
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setRevoking(false);
    }
  }

  return (
    <Section icon={MonitorSmartphone} title={t("player.account.devices")}>
      <div className="rounded-xl border border-white/10 bg-white/5 px-4 py-3.5">
        <div className="flex items-center justify-between gap-4">
          <p className="text-sm text-muted">
            {count === null
              ? t("settings.security.loading")
              : count === 0
                ? t("player.account.noOtherDevices")
                : t("player.account.otherDevices", { n: count })}
          </p>
          <button
            type="button"
            onClick={revoke}
            disabled={revoking || count === 0 || count === null}
            className="btn btn-ghost btn-sm shrink-0 text-danger"
          >
            {t("player.account.signOutOthers")}
          </button>
        </div>

        {/* Les dates, pas seulement le nombre. « 3 » ne permet ni de reconnaître une connexion
            oubliée sur un ordinateur prêté, ni de constater qu'il n'y a rien d'anormal — et elles
            étaient déjà en base. */}
        {sessions && sessions.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-white/10 pt-3">
            {sessions.map((s) => (
              <li key={s.id} className="flex items-baseline justify-between gap-3">
                {/* L'appareil d'abord : c'est ce qui dit laquelle on déconnecterait. Les sessions
                    ouvertes avant qu'on le retienne (23/09/2026) n'en ont pas. */}
                <span className="min-w-0">
                  <span className="block truncate text-sm text-muted">{s.device ?? t("player.account.unknownDevice")}</span>
                  <span className="block text-xs text-subtle">{t("player.account.sessionOpened", { date: formatDay(s.createdAt, locale) })}</span>
                </span>
                <span className="shrink-0 text-xs text-subtle">{t("player.account.sessionSeen", { date: formatDay(s.lastSeenAt, locale) })}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}

/**
 * L'écran d'accueil, à revoir quand on veut — sans toucher au marqueur du compte : c'est le bouton
 * de fin de l'accueil qui l'éteint, pas son ouverture.
 */
function OnboardingRow() {
  const t = useT();
  return (
    <Row icon={Sparkles} title={t("player.account.redoOnboarding")}>
      <button type="button" onClick={openOnboarding} className="btn btn-ghost btn-sm">
        {t("player.account.open")}
      </button>
    </Row>
  );
}

/**
 * L'état des services, pour tout le monde.
 *
 * La page est publique — c'est tout l'intérêt d'une page d'état : elle doit répondre le jour où le
 * reste ne répond plus, y compris avant d'être connecté. `from=compte` dit à la page par où l'on
 * est entré, pour que son « Retour » ramène ici et non à la connexion.
 *
 * `Link` et non `<a>` : un `<a>` nu est une navigation de document, donc le déchargement de la
 * page — et avec elle la séance de lecture, qui ne vit qu'en mémoire. Aller voir si le serveur va
 * bien coupait le film qu'on regardait, mini-lecteur compris. En navigation client, le film
 * continue pendant qu'on lit l'état des services.
 */
function StatusRow() {
  const t = useT();
  return (
    <Row icon={Activity} title={t("player.account.status")} hint={t("player.account.statusHint")}>
      <Link href="/status?from=compte" aria-label={t("player.account.openStatus")} className="btn btn-ghost btn-sm">
        {t("player.account.open")}
      </Link>
    </Row>
  );
}

/**
 * Une question fréquente, repliée sous sa ligne : elle reste là pour qui la cherche, sans occuper
 * l'écran de ceux qu'elle ne concerne pas.
 *
 * Il n'y en a qu'une pour l'instant, et elle est réelle : Firefox sous Linux n'affiche pas encore le
 * HDR correctement, les films sortent gris et délavés. Firefox sait le faire — l'option existe,
 * elle est simplement désactivée par défaut le temps que le travail se termine. Aucune détection :
 * la fiche nomme Firefox et non « votre navigateur », et quelqu'un qui la lit sur un téléphone
 * comprend en une seconde que ça ne le concerne pas.
 */
function HdrFaqRow() {
  const t = useT();
  const toast = useToast();
  const [copied, setCopied] = useState(false);

  // On ne peut pas faire un lien vers `about:config` : les navigateurs refusent d'y naviguer
  // depuis une page. Reste à copier le nom du réglage, ce qui évite de retaper trente caractères
  // sans faute — et le retour visuel, parce qu'une copie silencieuse ne se voit pas.
  async function copyPref() {
    try {
      await navigator.clipboard.writeText(FIREFOX_HDR_PREF);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error(t("player.account.help.copyFailed"));
    }
  }

  return (
    // La même ligne que les autres — même filet, même marge —, dont le chevron tient la place du
    // bouton. `details` garde le dépliage au clavier et au toucher sans rien à écrire.
    <details data-row="" className="group border-t border-white/8 py-3.5 first:border-t-0">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-4 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2.5 text-sm text-white">
          <LifeBuoy size={16} className="shrink-0 text-subtle" />
          <span className="min-w-0">{t("player.account.help.hdrTitle")}</span>
        </span>
        <ChevronDown size={16} className="shrink-0 text-subtle transition-transform group-open:rotate-180" />
      </summary>
      <div className="mt-3 pl-[26px]">
        <p className="mt-1.5 text-xs leading-5 text-muted">{t("player.account.help.hdrIntro")}</p>
        <ol className="mt-3 space-y-2 text-xs leading-5 text-muted">
          <li className="flex gap-2.5">
            <span className="shrink-0 text-subtle">1.</span>
            <span>{t("player.account.help.hdrStep1")}</span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 text-subtle">2.</span>
            <span className="min-w-0">
              {t("player.account.help.hdrStep2")}
              <span className="mt-1.5 flex flex-wrap items-center gap-2">
                <code className="break-all rounded bg-black/40 px-2 py-1 font-mono text-[11px] text-white">{FIREFOX_HDR_PREF}</code>
                <button type="button" onClick={copyPref} className="btn btn-ghost btn-sm shrink-0">
                  {copied ? <Check size={13} className="text-success" /> : <Copy size={13} />}
                  {copied ? t("player.account.help.copied") : t("player.account.help.copy")}
                </button>
              </span>
            </span>
          </li>
          <li className="flex gap-2.5">
            <span className="shrink-0 text-subtle">3.</span>
            <span>{t("player.account.help.hdrStep3")}</span>
          </li>
        </ol>
        {/* La phrase qui compte le plus : sans elle, on conclut que le lecteur est cassé. */}
        <p className="mt-3 border-t border-white/10 pt-3 text-xs leading-5 text-subtle">{t("player.account.help.hdrNote")}</p>
      </div>
    </details>
  );
}

/** Le réglage Firefox qui règle le HDR sous Linux, vérifié sur place avant d'être écrit ici. */
const FIREFOX_HDR_PREF = "gfx.color_management.hdr";


/**
 * Une date lisible, dans la langue de l'application. L'heure ne dit rien d'utile ici, le jour si.
 * Celle du navigateur s'y glissait (`undefined`) : un compte réglé en anglais lisait « 8 oct. »
 * sur un Mac français (audit du 08/10/2026).
 */
function formatDay(ms: number, locale: string): string {
  return new Date(ms).toLocaleDateString(getDateLocale(locale), { day: "numeric", month: "short" });
}

/**
 * Les deux gestes d'exploitation, réservés à l'administrateur.
 *
 * Réservés à l'affichage seulement, comme le reste de ce panneau : `src/proxy.ts` refuse déjà tout
 * POST sur `/api/` à un compte ordinaire, et cette route n'est pas dans la liste blanche des
 * écritures invitées. Ce qui est caché ici est une porte qui ne s'ouvrirait pas, pas une serrure.
 *
 * Deux boutons et non un seul interrupteur à trois états : allumer le bandeau et prévenir les
 * lecteurs en cours sont deux décisions différentes, et l'ordre entre elles appartient à celui qui
 * redéploie — on allume souvent le bandeau bien avant de prévenir que ça redémarre maintenant.
 */
function MaintenanceSection() {
  const t = useT();
  const errorText = useErrorText();
  const { locale } = useLocale();
  const toast = useToast();
  const { data, mutate } = useSWR<MaintenanceState>(MAINTENANCE_KEY, fetcher);
  const [busy, setBusy] = useState<"toggle" | "notice" | null>(null);
  const active = data?.active ?? false;

  async function send(body: { active?: boolean; notice?: true }, which: "toggle" | "notice") {
    setBusy(which);
    try {
      // `apiAction` et non `fetch` : `fetch` ne lève pas sur un 4xx, et un bouton qui se félicite
      // d'un 403 est pire que pas de bouton du tout.
      const next = (await apiAction(MAINTENANCE_KEY, { method: "POST", body: JSON.stringify(body) })) as MaintenanceState;
      // La réponse porte l'état complet : on la pose dans le cache sans redemander.
      await mutate(next, { revalidate: false });
      toast.success(
        which === "notice"
          ? t("player.account.maintenanceNoticeSent")
          : next.active
            ? t("player.account.maintenanceOnDone")
            : t("player.account.maintenanceOffDone")
      );
    } catch (err) {
      toast.error(errorText(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Section icon={Wrench} title={t("player.account.maintenance")}>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send({ active: !active }, "toggle")}
          className={`btn w-full justify-center sm:w-auto ${active ? "btn-ghost text-warning" : "btn-ghost"}`}
        >
          <Wrench size={16} />
          {active ? t("player.account.maintenanceOff") : t("player.account.maintenanceOn")}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          onClick={() => void send({ notice: true }, "notice")}
          className="btn btn-ghost w-full justify-center sm:w-auto"
        >
          <Megaphone size={16} />
          {t("player.account.maintenanceNotify")}
        </button>
      </div>
      <p className="mt-2 text-xs text-subtle">
        {active
          ? // L'heure d'extinction plutôt qu'une durée : « dans 4 heures » oblige à calculer, et
            // se périme à la seconde où on le lit. Une heure se compare d'un coup d'œil à celle
            // qu'on a sous les yeux.
            t("player.account.maintenanceHintOn", {
              time: data?.expiresAt
                ? new Date(data.expiresAt).toLocaleTimeString(getDateLocale(locale), { hour: "2-digit", minute: "2-digit" })
                : "—",
            })
          : t("player.account.maintenanceHint")}
      </p>
    </Section>
  );
}

/** « louis » → « Louis ». Sans toucher au reste : « DeLuca » reste « DeLuca ». */
function displayName(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  return name.charAt(0).toLocaleUpperCase() + name.slice(1);
}
