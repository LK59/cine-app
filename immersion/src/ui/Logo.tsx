/**
 * La marque du mode : la lanterne de Laterna — le L, son faisceau or, le triangle de lecture — et
 * sous elle « Laterna Experience ». Les mêmes formes que l'icône de l'application
 * (`tools/brand/icon.svg`), animées : le L se dresse, le faisceau s'allume, puis les mots.
 *
 * `lit` allume la lanterne ; tant qu'il est faux, seul le L attend dans le noir.
 */
export function ExperienceLogo({ lit, compact = false }: { lit: boolean; compact?: boolean }) {
  return (
    <div className={`xp-logo${lit ? " is-lit" : ""}${compact ? " is-compact" : ""}`} role="img" aria-label="Laterna Experience">
      <svg className="xp-mark" viewBox="117 98 310 310" aria-hidden focusable="false">
        <defs>
          <linearGradient id="xp-beam" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.92" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0.14" />
          </linearGradient>
          <radialGradient id="xp-glow" cx="30%" cy="62%" r="70%">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </radialGradient>
          <mask id="xp-cut">
            <rect x="117" y="98" width="310" height="310" fill="#fff" />
            <path d="M318 282 L318 342 L366 312 Z" fill="#000" />
          </mask>
        </defs>
        <ellipse className="xp-halo" cx="260" cy="312" rx="190" ry="130" fill="url(#xp-glow)" />
        <g mask="url(#xp-cut)">
          <polygon className="xp-beam" points="168,290 408,222 408,402 168,346" fill="url(#xp-beam)" />
        </g>
        <rect className="xp-stem" x="136" y="104" width="60" height="242" rx="18" fill="#f5f5f4" />
      </svg>
      <div className="xp-words" aria-hidden>
        <span className="xp-name">Laterna</span>
        <span className="xp-sub">Experience</span>
      </div>
    </div>
  );
}
