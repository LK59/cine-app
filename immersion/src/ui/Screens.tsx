import { useStore, useT } from "../state/store";
import { goToLogin, leaveToLaterna } from "../lib/session";
import { ExperienceLogo } from "./Logo";
import type { Key } from "../lib/i18n";

/** Un écran plein, sobre : la marque, une phrase, une ou deux sorties. */
function Notice({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <div className="notice">
      <ExperienceLogo lit compact />
      <h1>{title}</h1>
      {detail ? <p>{detail}</p> : null}
      <div className="notice-actions">{children}</div>
    </div>
  );
}

/** Pas un ordinateur, fenêtre trop petite, ou pas de WebGL 2. */
export function Unsupported({ onRetry }: { onRetry: () => void }) {
  const t = useT();
  const why = useStore((s) => s.unsupported) ?? "pointer";
  return (
    <Notice title={t("unsupported.title")} detail={t(`unsupported.${why}` as Key)}>
      <button type="button" className="btn btn-primary" onClick={leaveToLaterna} data-testid="back">
        {t("back")}
      </button>
      {why === "screen" || why === "rotate" ? (
        <button type="button" className="btn" onClick={onRetry}>
          {t("retry")}
        </button>
      ) : null}
    </Notice>
  );
}

/** Le contexte WebGL a été repris par le navigateur. */
export function ContextLost() {
  const t = useT();
  return (
    <Notice title={t("error.context")} detail={t("error.context.detail")}>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        {t("error.reload")}
      </button>
      <button type="button" className="btn" onClick={leaveToLaterna}>
        {t("back")}
      </button>
    </Notice>
  );
}

/** La session a pris fin pendant la visite. */
export function SessionEnded() {
  const t = useT();
  return (
    <Notice title={t("error.session")} detail={t("error.session.detail")}>
      <button type="button" className="btn btn-primary" onClick={goToLogin}>
        {t("error.login")}
      </button>
    </Notice>
  );
}

/** Une erreur de rendu que rien n'a rattrapée. */
export function Crashed() {
  const t = useT();
  return (
    <Notice title={t("error.crash")}>
      <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>
        {t("error.reload")}
      </button>
      <button type="button" className="btn" onClick={leaveToLaterna}>
        {t("back")}
      </button>
    </Notice>
  );
}
