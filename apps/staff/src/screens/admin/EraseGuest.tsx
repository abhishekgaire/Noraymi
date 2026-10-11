import { useState } from "react";
import { api, ApiCallError } from "../../api.js";
import { useT } from "../../i18n.js";

interface Found {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly email: string | null;
  readonly upcoming_bookings: number;
}

/**
 * Admin → Texts · Erase a guest (D104; Security and data retention · Erasing a guest): the owner or
 * a manager finds the guest by their exact phone or email, then erases them after a confirmation.
 * A guest with a booking still ahead gets a second, plainer confirmation, because the booking keeps
 * going without a name or number. The erase itself is `POST /guests/{g}/erase`.
 */
export function EraseGuest({ venueId }: { venueId: string }) {
  const { t } = useT();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<readonly Found[] | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  const find = async () => {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setNote(null);
    setConfirming(null);
    try {
      const param = q.includes("@") ? "email" : "phone";
      const r = await api<{ guests: Found[] }>(
        "GET",
        `/v1/venues/${venueId}/guests?${param}=${encodeURIComponent(q)}`,
      );
      setFound(r.guests);
    } catch (e) {
      setFound(null);
      setNote({
        text:
          e instanceof ApiCallError && e.code === "invalid_request"
            ? t("eraseGuest.badQuery")
            : t("shell.error.cantReach"),
        error: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const erase = async (guest: Found) => {
    setBusy(true);
    try {
      await api("POST", `/v1/venues/${venueId}/guests/${guest.id}/erase`, {
        confirm_upcoming: guest.upcoming_bookings > 0,
      });
      setFound((list) => list?.filter((g) => g.id !== guest.id) ?? null);
      setConfirming(null);
      setNote({ text: t("eraseGuest.done"), error: false });
    } catch {
      setNote({ text: t("eraseGuest.failed"), error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="erase-guest">
      <h3 id="erase-guest">{t("eraseGuest.title")}</h3>
      <p className="small muted">{t("eraseGuest.hint")}</p>
      <form
        className="invite-fields"
        onSubmit={(e) => {
          e.preventDefault();
          void find();
        }}
      >
        <label>
          <span>{t("eraseGuest.query")}</span>
          <input
            aria-label={t("eraseGuest.query")}
            value={query}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <button type="submit" className="secondary" disabled={busy || query.trim() === ""}>
          {t("eraseGuest.find")}
        </button>
      </form>
      {found !== null && found.length === 0 && <p className="muted">{t("eraseGuest.none")}</p>}
      {found !== null && found.length > 0 && (
        <ul className="erase-guest-list">
          {found.map((g) => (
            <li key={g.id}>
              <strong>{g.name || t("eraseGuest.noName")}</strong>{" "}
              <span className="small muted">{[g.phone, g.email].filter(Boolean).join(" · ")}</span>
              {g.upcoming_bookings > 0 && (
                <p className="small">{t("eraseGuest.upcoming", { count: g.upcoming_bookings })}</p>
              )}
              {confirming !== g.id ? (
                <button
                  type="button"
                  className="secondary danger"
                  disabled={busy}
                  onClick={() => setConfirming(g.id)}
                >
                  {t("eraseGuest.erase")}
                </button>
              ) : (
                <p className="notice" role="alertdialog">
                  {g.upcoming_bookings > 0
                    ? t("eraseGuest.confirmUpcoming", {
                        name: g.name,
                        count: g.upcoming_bookings,
                      })
                    : t("eraseGuest.confirm", { name: g.name })}
                  <button
                    type="button"
                    className="primary danger"
                    disabled={busy}
                    onClick={() => void erase(g)}
                  >
                    {t("eraseGuest.confirmButton")}
                  </button>
                  <button type="button" className="secondary" onClick={() => setConfirming(null)}>
                    {t("eraseGuest.cancel")}
                  </button>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      {note && (
        <p className={note.error ? "error" : "small"} role={note.error ? "alert" : "status"}>
          {note.text}
        </p>
      )}
    </div>
  );
}
