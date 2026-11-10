import { useStore, useT } from "../state/store";
import type { QualityChoice } from "../lib/settings";
import type { Key } from "../lib/i18n";

const QUALITIES: QualityChoice[] = ["auto", "low", "medium", "high", "ultra"];

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (value: number) => void; format: (value: number) => string }) {
  return (
    <label className="setting">
      <span className="setting-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="setting-value tabular">{format(value)}</span>
    </label>
  );
}

function Toggle({ label, hint, value, onChange, testId }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void; testId?: string }) {
  return (
    <button type="button" className="setting setting-toggle" role="switch" aria-checked={value} onClick={() => onChange(!value)} data-testid={testId}>
      <span className="setting-label">
        {label}
        {hint ? <small>{hint}</small> : null}
      </span>
      <span className={`switch${value ? " is-on" : ""}`} aria-hidden />
    </button>
  );
}

/** Les réglages : la qualité du rendu, le son, le regard, la conversion HDR. Appliqués et gardés aussitôt. */
export function Settings() {
  const t = useT();
  const settings = useStore((s) => s.settings);
  const update = useStore((s) => s.updateSettings);
  const percent = (v: number) => `${Math.round(v * 100)} %`;

  return (
    <div className="settings" data-testid="settings">
      <div className="setting setting-block">
        <span className="setting-label">
          {t("settings.quality")}
          <small>{t("settings.quality.hint")}</small>
        </span>
        <div className="segmented" role="radiogroup">
          {QUALITIES.map((q) => (
            <button key={q} type="button" role="radio" aria-checked={settings.quality === q} className={settings.quality === q ? "is-on" : ""} onClick={() => update({ quality: q })} data-testid={`quality-${q}`}>
              {t(`quality.${q}` as Key)}
            </button>
          ))}
        </div>
      </div>
      <Toggle label={t("settings.supersampling")} hint={t("settings.supersampling.hint")} value={settings.supersampling} onChange={(supersampling) => update({ supersampling })} testId="setting-supersampling" />
      <Slider label={t("settings.volume")} value={settings.volume} min={0} max={1} step={0.01} onChange={(volume) => update({ volume })} format={percent} />
      <Toggle label={t("settings.spatial")} hint={t("settings.spatial.hint")} value={settings.spatial} onChange={(spatial) => update({ spatial })} />
      <Slider label={t("settings.reverb")} value={settings.reverb} min={0} max={1} step={0.01} onChange={(reverb) => update({ reverb })} format={percent} />
      <Slider label={t("settings.sensitivity")} value={settings.sensitivity} min={0.2} max={3} step={0.05} onChange={(sensitivity) => update({ sensitivity })} format={(v) => `× ${v.toFixed(2)}`} />
      <Slider label={t("settings.fov")} value={settings.fov} min={50} max={100} step={1} onChange={(fov) => update({ fov })} format={(v) => `${v}°`} />
      <Toggle label={t("settings.hdr")} hint={t("settings.hdr.hint")} value={settings.hdrToSdr} onChange={(hdrToSdr) => update({ hdrToSdr })} testId="setting-hdr" />
      <Toggle label={t("settings.fps")} value={settings.showFps} onChange={(showFps) => update({ showFps })} testId="setting-fps" />
    </div>
  );
}
