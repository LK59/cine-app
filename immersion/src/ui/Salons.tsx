import { useEffect, useState } from "react";
import type { Key } from "../lib/i18n";
import { connect, createRoom, disconnect, joinRoom, leaveRoom, listRooms, probeSalons } from "../net/salons";
import { useStore, useT } from "../state/store";

const ERRORS: Record<string, Key> = {
  "no-room": "salons.err.no-room",
  full: "salons.err.full",
  "too-many-rooms": "salons.err.too-many-rooms",
  rate: "salons.err.rate",
};

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

  // À l'ouverture : savoir si le jeu à plusieurs est pour nous, et si oui se connecter et lister les salons publics.
  useEffect(() => {
    void probeSalons().then((available) => {
      if (!available) return;
      void connect();
      listRooms();
    });
  }, []);

  if (net.status === "checking") return <p className="salons-note">{t("salons.checking")}</p>;
  if (net.status === "unavailable") return <p className="salons-note" data-testid="salons-unavailable">{t("salons.unavailable")}</p>;

  const busy = net.status === "connecting" || net.status === "reconnecting";
  const error = net.error ? t(ERRORS[net.error] ?? "salons.err.other") : null;

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
        {error ? <p className="salons-error">{error}</p> : null}
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
                <span>{r.name}</span>
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
