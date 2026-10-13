import {
  LayoutDashboard,
  Film,
  Tv,
  Captions,
  Search,
  Download,
  PlayCircle,
  ListChecks,
  CalendarDays,
  BarChart2,
  PackageCheck,
  Activity,
  PlugZap,
  Clapperboard,
  Languages,
  UserPlus,
  KeyRound,
  Container,
} from "lucide-react";
import type { ServiceKey } from "@/lib/services";

export interface NavItem {
  href: string;
  navKey: string;
  icon: React.ElementType;
  /**
   * Le service dont cette page dépend entièrement.
   *
   * Absent quand la page tient toute seule — la vue d'ensemble, les listes locales, les réglages.
   * Présent, il permet à la navigation d'estomper une entrée dont la page ne pourra rien montrer,
   * plutôt que d'y envoyer quelqu'un chercher une panne qui n'existe pas.
   */
  service?: ServiceKey;
}

export type NavPartKey = "infrastructure" | "configuration";

export interface NavGroup {
  /** La partie de la gestion (DECISIONS.md §81) : ce qui tourne, ou comment c'est réglé. */
  part: NavPartKey;
  /** Un sous-intitulé dans la partie ; absent pour le premier groupe, que l'intitulé de la partie nomme déjà. */
  titleKey?: string;
  items: NavItem[];
}

/**
 * Une seule description de la navigation, pour les deux coquilles.
 *
 * Le téléphone et le bureau tenaient chacun leur liste, et elles avaient divergé : Films et
 * Séries en 7ᵉ et 8ᵉ position d'un côté, en 2ᵉ et 3ᵉ de l'autre ; Timeline avant Calendrier ici,
 * après là ; et Paramètres au milieu de la liste du bureau, sans que rien ne l'explique. Les
 * deux lisent maintenant les mêmes groupes, dans le même ordre.
 *
 * Deux parties depuis le 13/10/2026 (DECISIONS.md §81) : « Infrastructure » — ce qui tourne, à
 * regarder et à piloter — puis « Configuration » — comment l'installation est réglée. Avant, les
 * réglages tenaient en une entrée « Paramètres » perdue au bout d'une liste de seize pages, et
 * mêlaient la langue de l'administrateur, sa couleur d'accent et ses sessions (ce qui est à lui,
 * donc au panneau Compte du cinéma) aux adresses des services (ce qui est à l'installation).
 *
 * « Imports » est l'ancienne « Activité récente » (`/timeline`) : ce que Radarr et Sonarr ont
 * récupéré et importé. Renommée parce que « Activité » est, dans le cinéma, le panneau de
 * l'administrateur sur les comptes et les séances — deux pages du même nom, deux sujets.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    part: "infrastructure",
    items: [
      { href: "/gestion", navKey: "nav.overview", icon: LayoutDashboard },
      { href: "/radarr", navKey: "nav.radarr", icon: Film, service: "radarr" },
      { href: "/sonarr", navKey: "nav.sonarr", icon: Tv, service: "sonarr" },
      { href: "/qbittorrent", navKey: "nav.qbittorrent", icon: Download, service: "qbittorrent" },
      { href: "/calendar", navKey: "nav.calendar", icon: CalendarDays },
      { href: "/stats", navKey: "nav.stats", icon: BarChart2 },
      { href: "/timeline", navKey: "nav.timeline", icon: PackageCheck },
    ],
  },
  {
    part: "infrastructure",
    titleKey: "nav.sections.services",
    items: [
      { href: "/bazarr", navKey: "nav.bazarr", icon: Captions, service: "bazarr" },
      { href: "/jackett", navKey: "nav.jackett", icon: Search, service: "jackett" },
      { href: "/jellyfin", navKey: "nav.jellyfin", icon: PlayCircle, service: "jellyfin" },
      { href: "/jellyseerr", navKey: "nav.jellyseerr", icon: ListChecks, service: "jellyseerr" },
      { href: "/health", navKey: "nav.health", icon: Activity },
    ],
  },
  {
    part: "configuration",
    // Dans l'ordre où l'on règle une installation : les services d'abord, ce qui exige de toucher
    // au compose en dernier — c'est la seule page qui ne se règle pas d'ici.
    items: [
      { href: "/parametres", navKey: "nav.config.connections", icon: PlugZap },
      { href: "/parametres/lecture", navKey: "nav.config.playback", icon: Clapperboard },
      { href: "/parametres/sous-titres", navKey: "nav.config.subtitles", icon: Languages },
      { href: "/parametres/comptes", navKey: "nav.config.accounts", icon: UserPlus },
      { href: "/parametres/administration", navKey: "nav.config.admin", icon: KeyRound },
      { href: "/parametres/deploiement", navKey: "nav.config.deployment", icon: Container },
    ],
  },
];

/** La barre du bas sur téléphone — les quatre destinations qui portent tout le reste. */
// La quatrième place était « À voir », partie au cinéma le 21/09/2026 avec la page qui la
// portait : les téléchargements sont ce qu'on vient le plus souvent regarder d'ici.
export const NAV_BAR_HREFS = ["/gestion", "/radarr", "/sonarr", "/qbittorrent"];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);

/** Les deux parties, dans l'ordre, chacune avec ses groupes — ce que les deux coquilles dessinent. */
export const NAV_PARTS: { key: NavPartKey; titleKey: string; groups: NavGroup[] }[] = (["infrastructure", "configuration"] as const).map(
  (key) => ({ key, titleKey: `nav.parts.${key}`, groups: NAV_GROUPS.filter((g) => g.part === key) }),
);

/**
 * L'entrée active : la plus longue adresse qui contient la page courante. `/parametres` ne doit pas
 * rester allumée sous `/parametres/lecture`, et `/radarr` doit l'être sous `/radarr/12`.
 */
export function activeNavHref(pathname: string): string | null {
  let best: string | null = null;
  for (const { href } of NAV_ITEMS) {
    if (pathname === href || pathname.startsWith(href + "/")) {
      if (!best || href.length > best.length) best = href;
    }
  }
  return best;
}

/** Le pont vers le cinéma, en tête de la navigation, et le lien discret vers le Compte. */
export const CINEMA_HREF = "/";
export const ACCOUNT_PREFERENCES_HREF = "/#compte=1";
