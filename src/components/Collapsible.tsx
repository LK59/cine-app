"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";

export function Collapsible({
  title,
  icon,
  defaultOpen = true,
  badge,
  children,
  className = "",
}: {
  title: string;
  icon?: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className={className}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="mb-2 flex w-full items-center gap-2 text-left text-sm font-semibold text-white"
      >
        {icon}
        <span className="flex-1">{title}</span>
        {badge !== undefined && (
          <span className="text-xs font-normal text-slate-500">({badge})</span>
        )}
        <ChevronDown
          size={15}
          className={`shrink-0 text-slate-500 transition-transform duration-200 ${open ? "" : "-rotate-90"}`}
        />
      </button>
      {open && children}
    </div>
  );
}
