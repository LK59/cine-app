// Ce qu'on peut signaler, et comment on y arrive : zone, élément, aspect, type de souci.
//
// Écrit une fois, ici, et lu des deux côtés : l'assistant « Signaler un problème » en tire ses
// écrans, la route en tire sa vérification — un chemin qui n'existe pas dans cet arbre est refusé.
// Les libellés vivent dans les dictionnaires (`report.zones.*`, `report.nodes.*`,
// `report.issues.*`), dans les quatre langues. Chaque niveau propose aussi « Autre (préciser) »,
// ajouté par l'assistant plutôt qu'écrit ici : il n'y a qu'une façon d'être « autre ».
//
// Rédigé le 24/09/2026 à partir de ce que l'application montre réellement ; l'administrateur le
// corrige au besoin. Un identifiant ajouté ici demande son libellé dans les quatre dictionnaires —
// `report-taxonomy.test.ts` le vérifie.

export type IssueSetId = "generic" | "video" | "audio" | "subtitles" | "controls" | "start" | "end" | "cast" | "pip" | "notifications" | "access";

/** Les types de souci, par famille. */
export const ISSUE_SETS: Record<IssueSetId, readonly string[]> = {
  "generic": [
    "notShown",
    "wrongDisplay",
    "wrongContent",
    "unexpected",
    "slow",
    "stuck",
    "errorMessage"
  ],
  "video": [
    "black",
    "frozen",
    "stutter",
    "blurry",
    "colors",
    "framing",
    "avsync"
  ],
  "audio": [
    "none",
    "language",
    "cuts",
    "sync",
    "sides",
    "volume",
    "trackMenu"
  ],
  "subtitles": [
    "missing",
    "language",
    "sync",
    "display",
    "stuck",
    "menu"
  ],
  "controls": [
    "noResponse",
    "seekWrong",
    "seekSlow",
    "progressBar",
    "pauseResume",
    "hidden",
    "fullscreen"
  ],
  "start": [
    "noStart",
    "slowStart",
    "wrongPosition",
    "errorMessage"
  ],
  "end": [
    "nextNotStarting",
    "wrongNext",
    "cutShort",
    "watchedState"
  ],
  "cast": [
    "noStart",
    "stuck",
    "noSound",
    "noSubtitles",
    "quality"
  ],
  "pip": [
    "noStart",
    "stuck",
    "controls",
    "position"
  ],
  "notifications": [
    "notReceived",
    "unwanted",
    "duplicate",
    "wrongContent",
    "late",
    "wrongLink"
  ],
  "access": [
    "cannotLogin",
    "loggedOut",
    "wontOpen",
    "icon",
    "update",
    "slow",
    "errorMessage"
  ]
};

export interface ReportNode {
  id: string;
  /** Les choix du niveau suivant. */
  children?: readonly ReportNode[];
  /** Les types de souci proposés une fois ce nœud atteint (hérité par ses enfants). */
  issues?: IssueSetId;
  /** Un titre de la bibliothèque est demandé à ce niveau (hérité par les enfants). */
  title?: boolean;
  /** Une idée plutôt qu'un problème : pas de type de souci. */
  suggestion?: boolean;
}

export const REPORT_ZONES: readonly ReportNode[] = [
  {
    "id": "home",
    "issues": "generic",
    "children": [
      {
        "id": "homeHero"
      },
      {
        "id": "homeResume"
      },
      {
        "id": "homeNextUp"
      },
      {
        "id": "homeRows"
      },
      {
        "id": "homeSeeAll"
      },
      {
        "id": "homeTabs"
      },
      {
        "id": "homePosters"
      },
      {
        "id": "homeScroll"
      }
    ]
  },
  {
    "id": "search",
    "issues": "generic",
    "children": [
      {
        "id": "searchField"
      },
      {
        "id": "searchResults"
      },
      {
        "id": "searchUnavailable"
      },
      {
        "id": "searchPeople"
      },
      {
        "id": "searchRequest"
      }
    ]
  },
  {
    "id": "list",
    "issues": "generic",
    "children": [
      {
        "id": "listToWatch"
      },
      {
        "id": "listRequests"
      },
      {
        "id": "listWatched"
      },
      {
        "id": "listAdd"
      }
    ]
  },
  {
    "id": "sheet",
    "issues": "generic",
    "title": true,
    "children": [
      {
        "id": "sheetPlay"
      },
      {
        "id": "sheetInfo"
      },
      {
        "id": "sheetEpisodes"
      },
      {
        "id": "sheetCast"
      },
      {
        "id": "sheetSimilar"
      },
      {
        "id": "sheetMyList"
      },
      {
        "id": "sheetWatched"
      }
    ]
  },
  {
    "id": "player",
    "title": true,
    "children": [
      {
        "id": "playerVideo",
        "issues": "video"
      },
      {
        "id": "playerAudio",
        "issues": "audio"
      },
      {
        "id": "playerSubtitles",
        "issues": "subtitles"
      },
      {
        "id": "playerControls",
        "issues": "controls"
      },
      {
        "id": "playerStart",
        "issues": "start"
      },
      {
        "id": "playerEnd",
        "issues": "end"
      },
      {
        "id": "playerBackground",
        "issues": "start"
      },
      {
        "id": "playerCast",
        "issues": "cast"
      },
      {
        "id": "playerPip",
        "issues": "pip"
      }
    ]
  },
  {
    "id": "account",
    "issues": "generic",
    "children": [
      {
        "id": "accountLanguage"
      },
      {
        "id": "accountPlayback"
      },
      {
        "id": "accountNotifications"
      },
      {
        "id": "accountPassword"
      },
      {
        "id": "accountDevices"
      },
      {
        "id": "accountReports"
      }
    ]
  },
  {
    "id": "notifications",
    "issues": "notifications",
    "children": [
      {
        "id": "notifEpisode"
      },
      {
        "id": "notifRequest"
      },
      {
        "id": "notifWatchlist"
      },
      {
        "id": "notifReport"
      }
    ]
  },
  {
    "id": "access",
    "issues": "access",
    "children": [
      {
        "id": "accessLogin"
      },
      {
        "id": "accessInstall"
      },
      {
        "id": "accessUpdate"
      }
    ]
  },
  {
    "id": "suggestion",
    "suggestion": true,
    "children": [
      {
        "id": "suggestHome"
      },
      {
        "id": "suggestSearch"
      },
      {
        "id": "suggestList"
      },
      {
        "id": "suggestSheet"
      },
      {
        "id": "suggestPlayer"
      },
      {
        "id": "suggestAccount"
      },
      {
        "id": "suggestNotifications"
      },
      {
        "id": "suggestCatalogue"
      },
      {
        "id": "suggestFeature"
      }
    ]
  },
  {
    "id": "other"
  }
];

/** L'identifiant réservé au choix « Autre (préciser) », à chaque niveau. */
export const OTHER = "other";

/** Ce qu'une personne a choisi, niveau par niveau. `*Other` porte la précision d'un « Autre ». */
export interface ReportPath {
  zone: string;
  element?: string | null;
  elementOther?: string | null;
  issue?: string | null;
  issueOther?: string | null;
}

export function zoneOf(id: string): ReportNode | null {
  return REPORT_ZONES.find((z) => z.id === id) ?? null;
}

/**
 * La famille de types de souci à proposer : celle de l'élément, sinon celle de la zone, sinon la
 * famille générale — un « Autre » dans le lecteur, qui n'a pas de famille à lui, reçoit celle-là.
 */
export function issueSetFor(zone: ReportNode, elementId: string | null | undefined): IssueSetId | null {
  if (zone.suggestion || zone.id === OTHER) return null;
  const element = zone.children?.find((c) => c.id === elementId);
  return element?.issues ?? zone.issues ?? "generic";
}

/** Un titre de la bibliothèque est-il demandé pour ce chemin ? */
export function needsTitle(zone: ReportNode): boolean {
  return zone.title === true;
}

const MAX_OTHER = 200;

/** Le chemin tient-il dans l'arbre ? `null` s'il est complet et valide, sinon ce qui manque. */
export function checkReportPath(path: ReportPath): string | null {
  const zone = zoneOf(path.zone);
  if (!zone) return "zone inconnue";
  if (zone.children?.length) {
    if (!path.element) return "élément manquant";
    if (path.element === OTHER) {
      if (!path.elementOther?.trim()) return "précision manquante pour « Autre »";
      if (path.elementOther.length > MAX_OTHER) return "précision trop longue";
    } else if (!zone.children.some((c) => c.id === path.element)) return "élément inconnu";
  }
  const set = issueSetFor(zone, path.element);
  if (set) {
    if (!path.issue) return "type de souci manquant";
    if (path.issue === OTHER) {
      if (!path.issueOther?.trim()) return "précision manquante pour « Autre »";
      if (path.issueOther.length > MAX_OTHER) return "précision trop longue";
    } else if (!ISSUE_SETS[set].includes(path.issue)) return "type de souci inconnu";
  }
  return null;
}

/** Une suggestion plutôt qu'un problème. */
export function isSuggestion(path: Pick<ReportPath, "zone">): boolean {
  return zoneOf(path.zone)?.suggestion === true;
}

/**
 * Le chemin en mots, niveau par niveau — « Lecture › Le son › Pas de son ». Une seule fonction pour
 * l'écran et pour les notifications du serveur ; `t` est le traducteur de qui lit.
 */
export function reportPathParts(path: ReportPath, t: (key: string) => string): string[] {
  const zone = zoneOf(path.zone);
  const parts = [t(`report.zones.${path.zone}`)];
  if (path.element) parts.push(path.element === OTHER ? (path.elementOther ?? "") : t(`report.nodes.${path.element}`));
  if (path.issue && zone) {
    const set = issueSetFor(zone, path.element);
    parts.push(path.issue === OTHER ? (path.issueOther ?? "") : set ? t(`report.issues.${set}.${path.issue}`) : path.issue);
  }
  return parts.filter(Boolean);
}
