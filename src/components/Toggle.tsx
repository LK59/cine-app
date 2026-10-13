"use client";

export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
  /** Le nom de l'interrupteur quand l'intitulé est écrit à côté, et non dedans. */
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-muted"
    >
      <span
        className={`relative inline-block h-5 w-9 shrink-0 rounded-full border border-white/10 backdrop-blur-xs transition-colors ${
          checked ? "bg-accent-600" : "bg-white/10"
        }`}
      >
        {/* Activé, le rail est blanc (accent neutre, 13/10/2026) : la pastille passe au noir, sans
            quoi elle disparaissait dans son rail. */}
        <span
          className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full transition-[transform,background-color] ${
            checked ? "translate-x-4 bg-ink" : "translate-x-0 bg-white"
          }`}
        />
      </span>
      {label}
    </button>
  );
}
