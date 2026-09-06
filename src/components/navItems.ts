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
  Telescope,
  BarChart2,
  Bookmark,
  Clock,
  Sparkles,
  Activity,
  Settings,
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

/**
 * Une seule description de la navigation, pour les deux coquilles.
 *
 * Le téléphone et le bureau tenaient chacun leur liste, et elles avaient divergé : Films et
 * Séries en 7ᵉ et 8ᵉ position d'un côté, en 2ᵉ et 3ᵉ de l'autre ; Timeline avant Calendrier ici,
 * après là ; et Paramètres au milieu de la liste du bureau, sans que rien ne l'explique. Les
 * deux lisent maintenant les mêmes groupes, dans le même ordre.
 */
export const NAV_GROUPS: { titleKey: string; items: NavItem[] }[] = [
  {
    titleKey: "nav.sections.library",
    items: [
      { href: "/gestion", navKey: "nav.overview", icon: LayoutDashboard },
      { href: "/radarr", navKey: "nav.radarr", icon: Film, service: "radarr" },
      { href: "/sonarr", navKey: "nav.sonarr", icon: Tv, service: "sonarr" },
      { href: "/watchlist", navKey: "nav.watchlist", icon: Bookmark },
    ],
  },
  {
    titleKey: "nav.sections.content",
    items: [
      { href: "/discover", navKey: "nav.discover", icon: Telescope, service: "tmdb" },
      { href: "/recommendations", navKey: "nav.recommendations", icon: Sparkles, service: "tmdb" },
      { href: "/calendar", navKey: "nav.calendar", icon: CalendarDays },
      { href: "/timeline", navKey: "nav.timeline", icon: Clock },
      { href: "/stats", navKey: "nav.stats", icon: BarChart2 },
    ],
  },
  {
    titleKey: "nav.sections.manage",
    items: [
      { href: "/qbittorrent", navKey: "nav.qbittorrent", icon: Download, service: "qbittorrent" },
      { href: "/bazarr", navKey: "nav.bazarr", icon: Captions, service: "bazarr" },
      { href: "/jackett", navKey: "nav.jackett", icon: Search, service: "jackett" },
      { href: "/jellyfin", navKey: "nav.jellyfin", icon: PlayCircle, service: "jellyfin" },
      { href: "/jellyseerr", navKey: "nav.jellyseerr", icon: ListChecks, service: "jellyseerr" },
      { href: "/health", navKey: "nav.health", icon: Activity },
      // Dernier, comme partout ailleurs : c'est là qu'on va le chercher, pas au milieu.
      { href: "/parametres", navKey: "nav.settings", icon: Settings },
    ],
  },
];

/** La barre du bas sur téléphone — les quatre destinations qui portent tout le reste. */
export const NAV_BAR_HREFS = ["/gestion", "/radarr", "/sonarr", "/watchlist"];

export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((group) => group.items);
