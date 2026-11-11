import { useEffect, useState } from "react";
import type { Key } from "../lib/i18n";
import type { Look } from "../../../salons/src/tv";
import { connect, createRoom, disconnect, inviteLink, joinRoom, leaveRoom, listRooms, probeSalons, readLook, setLook } from "../net/salons";
import { defaultLook, LOOK_COLORS, LOOK_HATS } from "../world/avatarLook";
import { useStore, useT } from "../state/store";

const ERRORS: Record<string, Key> = {
  "no-room": "salons.err.no-room",
  full: "salons.err.full",
  "too-many-rooms": "salons.err.too-many-rooms",
  rate: "salons.err.rate",
  "title-refused": "salons.err.title-refused",
  "bad-ticket": "salons.err.bad-ticket",
  "game-running": "salons.err.game-running",
};

/**
 * « Mon avatar » (étape 5) : couleur, chapeau, écharpe, lunettes. Chaque choix part tout de suite (gardé pour le
 * compte, montré aux autres) ; sans choix, l'avatar est celui que l'identifiant donne chez tous.
 */
function AvatarEditor({ look, onChange }: { look: Look; onChange: (look: Look) => void }) {
  const t = useT();
  const [color, hat, scarf, glasses] = look;
  return (
    <div className="avatar-editor" data-testid="avatar-editor">
      <h3 className="salons-sub">{t("salons.avatar")}</h3>
      <div className="avatar-row" role="group" aria-label={t("salons.avatar.color")}>
        <span>{t("salons.avatar.color")}</span>
        {LOOK_COLORS.map((c, i) => (
          <button key={c} type="button" className={`swatch${i === color ? " is-on" : ""}`} style={{ background: c }} aria-label={`${t("salons.avatar.color")} ${i + 1}`} aria-pressed={i === color} onClick={() => onChange([i, hat, scarf, glasses])} data-testid={`avatar-color-${i}`} />
        ))}
      </div>
      <div className="avatar-row" role="group" aria-label={t("salons.avatar.hat")}>
        <span>{t("salons.avatar.hat")}</span>
        {Array.from({ length: LOOK_HATS }, (_, i) => (
          <button key={i} type="button" className={`chip${i === hat ? " chip-on" : ""}`} aria-pressed={i === hat} onClick={() => onChange([color, i, scarf, glasses])} data-testid={`avatar-hat-${i}`}>
            {t(`salons.hat.${i}` as Key)}
          </button>
        ))}
      </div>
      <div className="avatar-row" role="group" aria-label={t("salons.avatar.scarf")}>
        <span>{t("salons.avatar.scarf")}</span>
        <button type="button" className={`chip${scarf < 0 ? " chip-on" : ""}`} aria-pressed={scarf < 0} onClick={() => onChange([color, hat, -1, glasses])}>
          {t("salons.scarf.none")}
        </button>
        {LOOK_COLORS.map((c, i) => (
          <button key={c} type="button" className={`swatch${i === scarf ? " is-on" : ""}`} style={{ background: c }} aria-label={`${t("salons.avatar.scarf")} ${i + 1}`} aria-pressed={i === scarf} onClick={() => onChange([color, hat, i, glasses])} />
        ))}
      </div>
      <div className="avatar-row" role="group" aria-label={t("salons.avatar.glasses")}>
        <span>{t("salons.avatar.glasses")}</span>
        {[0, 1].map((i) => (
          <button key={i} type="button" className={`chip${i === glasses ? " chip-on" : ""}`} aria-pressed={i === glasses} onClick={() => onChange([color, hat, scarf, i])} data-testid={`avatar-glasses-${i}`}>
            {t(`salons.glasses.${i}` as Key)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * « À plusieurs », dans le menu pause : les salons publics, en créer un (public ou privé), en rejoindre un par son
 * code ; dans un salon, son code d'invitation et qui est là.
 *
 * Rien n'est demandé au serveur avant d'ouvrir cet écran : le chargement du chalet ne connaît pas les salons (le
 * pare-feu compte les adresses d'un chargement — scénario 15). Sans service, l'écran le dit, et le chalet reste
 * solitaire, jeux compris.
 */
export function Salons() {
  const t = useT();
  const net = useStore((s) => s.net);
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);

  // À l'ouverture : savoir si le jeu à plusieurs est pour nous, et si oui se connecter et lister les salons publics.
  useEffect(() => {
    void probeSalons().then((available) => {
      if (!available) return;
      void connect();
      listRooms();
      readLook();
    });
  }, []);

  if (net.status === "checking") return <p className="salons-note">{t("salons.checking")}</p>;
  if (net.status === "unavailable") return <p className="salons-note" data-testid="salons-unavailable">{t("salons.unavailable")}</p>;

  const busy = net.status === "connecting" || net.status === "reconnecting";
  const error = net.error ? t(ERRORS[net.error] ?? "salons.err.other") : null;
  const look = net.look ?? defaultLook(net.you?.id ?? "");
  const editor = net.status === "online" ? <AvatarEditor look={look} onChange={setLook} /> : null;

  if (net.room) {
    const room = net.room;
    return (
      <div className="salons" data-testid="salons-room">
        <div className="salons-head">
          <strong className="salons-name">{room.name}</strong>
          <span className="salons-tag">{room.visibility === "private" ? t("salons.private") : t("salons.publicTag")}</span>
        </div>
        <p className="salons-code">
          {t("salons.code")} : <code data-testid="salons-code">{room.code}</code>
          <button
            type="button"
            className="chip"
            data-testid="salons-invite"
            onClick={() => {
              void navigator.clipboard?.writeText(inviteLink(room.code)).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? t("salons.invite.copied") : t("salons.invite")}
          </button>
        </p>
        {busy ? <p className="salons-note">{t("salons.reconnecting")}</p> : null}
        <h3 className="salons-sub">
          {t("salons.members")} · {room.members.length}
        </h3>
        <ul className="salons-members" data-testid="salons-members">
          {room.members.map((m) => (
            <li key={m.id} className={m.away ? "is-away" : undefined}>
              {m.name}
              {m.id === net.you?.id ? <span className="salons-tag">{t("salons.you")}</span> : null}
              {m.away ? <span className="salons-tag">{t("salons.away")}</span> : null}
            </li>
          ))}
        </ul>
        {error ? <p className="salons-error" data-testid="salons-error">{error}</p> : null}
        {editor}
        <div className="salons-actions">
          <button type="button" className="btn" onClick={leaveRoom} data-testid="salons-leave">
            {t("salons.leave")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="salons" data-testid="salons-lobby">
      {busy ? <p className="salons-note">{net.status === "connecting" ? t("salons.connecting") : t("salons.reconnecting")}</p> : null}
      <div className="salons-actions">
        <button type="button" className="btn btn-primary" onClick={() => createRoom("public")} disabled={busy} data-testid="salons-create-public">
          {t("salons.createPublic")}
        </button>
        <button type="button" className="btn" onClick={() => createRoom("private")} disabled={busy} data-testid="salons-create-private">
          {t("salons.createPrivate")}
        </button>
      </div>
      <form
        className="salons-join"
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) joinRoom(code);
        }}
      >
        <label>
          <span className="sr-only">{t("salons.codeLabel")}</span>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase().slice(0, 6))}
            placeholder={t("salons.codeLabel")}
            autoComplete="off"
            spellCheck={false}
            maxLength={6}
            data-testid="salons-code-input"
          />
        </label>
        <button type="submit" className="btn" disabled={busy || code.trim().length !== 6} data-testid="salons-join">
          {t("salons.join")}
        </button>
      </form>
      {error ? <p className="salons-error" data-testid="salons-error">{error}</p> : null}
      <div className="salons-head">
        <h3 className="salons-sub">{t("salons.public")}</h3>
        <button type="button" className="chip" onClick={listRooms} disabled={busy}>
          {t("salons.refresh")}
        </button>
      </div>
      {net.publicRooms.length ? (
        <ul className="salons-list" data-testid="salons-public">
          {net.publicRooms.map((r) => (
            <li key={r.code}>
              <button type="button" className="salons-room" onClick={() => joinRoom(r.code)} disabled={busy || r.count >= r.max}>
                <span className="salons-room-main">
                  <span>{r.name}</span>
                  <span className="salons-room-who">
                    {r.names.join(", ")}
                    {r.activity ? ` · ${t(r.activity === "tv" ? "salons.activity.tv" : "salons.activity.quiz")}` : ""}
                  </span>
                </span>
                <span className="tabular">
                  {r.count}/{r.max}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="salons-note">{t("salons.none")}</p>
      )}
      {editor}
      {net.status === "online" ? (
        <div className="salons-actions">
          <button type="button" className="btn btn-quiet" onClick={disconnect} data-testid="salons-solo">
            {t("salons.solo")}
          </button>
        </div>
      ) : null}
    </div>
  );
}
