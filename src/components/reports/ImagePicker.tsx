"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { useT } from "@/components/TranslationProvider";

/** Les formats que le serveur accepte (`IMAGE_TYPES` dans reportImages.ts) : par type et, pour les navigateurs muets, par extension. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/heic,image/heif,image/webp,image/avif,image/gif,image/bmp,image/tiff,image/jxl,.jpg,.jpeg,.png,.heic,.heif,.webp,.avif,.gif,.bmp,.tif,.tiff,.jxl";
export const MAX_PICKED = 6;

/** Une vignette, ou le nom du fichier quand ce navigateur ne sait pas l'afficher (un HEIC sur Chrome). */
function Thumb({ file, onRemove }: { file: File; onRemove: () => void }) {
  const t = useT();
  const url = useMemo(() => URL.createObjectURL(file), [file]);
  const [broken, setBroken] = useState(false);
  // Libérée quand la vignette part ou change de fichier : une adresse `blob:` retient le fichier en mémoire.
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-lg border border-white/10 bg-white/5">
      {!broken ? (
        // eslint-disable-next-line @next/next/no-img-element -- un aperçu local, jamais servi
        <img src={url} alt="" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      ) : (
        <span className="flex h-full w-full items-center justify-center p-1 text-center text-[10px] leading-tight text-muted">{file.name}</span>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={t("report.ui.removeImage")}
        className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-white"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Joindre des captures : un bouton, les vignettes, et la croix de chacune. */
export function ImagePicker({ files, onChange, max = MAX_PICKED }: { files: File[]; onChange: (files: File[]) => void; max?: number }) {
  const t = useT();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {files.map((file, i) => (
          <Thumb key={`${file.name}-${i}-${file.size}`} file={file} onRemove={() => onChange(files.filter((_, j) => j !== i))} />
        ))}
        {files.length < max && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-white/20 text-xs text-muted transition-colors hover:border-white/40 hover:text-white"
          >
            <ImagePlus size={18} />
            {t("report.ui.addImage")}
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          e.target.value = "";
          onChange([...files, ...picked].slice(0, max));
        }}
      />
      <p className="text-xs text-subtle">{t("report.ui.imagesHint", { n: max })}</p>
    </div>
  );
}
