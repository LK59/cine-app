"use client";

export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="inline-flex items-center gap-2 text-sm text-slate-300"
    >
      <span
        className={`relative inline-block h-5 w-9 shrink-0 rounded-full border border-white/10 backdrop-blur-xs transition-colors ${
          checked ? "bg-accent-600/80" : "bg-slate-700/60"
        }`}
      >
        <span
          className={`absolute left-0.5 top-0.5 h-3.5 w-3.5 rounded-full bg-white transition-transform ${
            checked ? "translate-x-4" : "translate-x-0"
          }`}
        />
      </span>
      {label}
    </button>
  );
}
