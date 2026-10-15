import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, ApiCallError } from "../api.js";
import { useConnection } from "../connection.js";
import { useEvents } from "../events.js";
import { useT } from "../i18n.js";
import { Dialog, useSheetDialog } from "../layout/Dialog.js";

/**
 * No sale in the bar POS top bar (U-07; D133; spec 10 · Top bar): one tap opens the reason chips,
 * a second tap on Change or Wrong tender opens this station's drawer (Other… asks for the words
 * first). The drawer is the one the server says this screen is paired to (`here` on
 * `GET /drawers`), never a guess: with no paired drawer, or none open, or a role that can't work
 * it, there is no button. The no-sale route is the drawer screen's own, so its rules stay on the
 * server: a reason, the PIN again while the owner ticks it (P-10, answered by the shell's PIN
 * dialog), the audit row and the Staff actions count (P-09). Offline the drawer is locked, and
 * the button says so.
 */
interface DrawerHere {
  readonly id: string;
  readonly name: string;
  readonly can_count: boolean;
  readonly here: boolean;
  readonly sessions: readonly { readonly id: string; readonly state: string }[];
}

const CHIPS = ["noSale.reason.change", "noSale.reason.wrongTender"] as const;

export function NoSaleButton({ venueId }: { venueId: string }) {
  const { t } = useT();
  const { subscribe, connected } = useEvents();
  const connection = useConnection();
  const offline = !connected || connection.kind === "offline";
  // This screen's drawer and its open session, as the server last said; kept while offline.
  const [drawer, setDrawer] = useState<{ name: string; sessionId: string } | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ drawers: readonly DrawerHere[] }>(
        "GET",
        `/v1/venues/${venueId}/drawers`,
      );
      const d = r.drawers.find((x) => x.here && x.can_count);
      const s = d?.sessions.find((x) => x.state === "open");
      setDrawer(d && s ? { name: d.name, sessionId: s.id } : null);
    } catch {
      // Keep what we had: offline, the button stays and says the drawer is locked.
    }
  }, [venueId]);
  useEffect(() => void load(), [load]);
  useEffect(
    () =>
      subscribe((events) => {
        if (events.length === 0 || events.some((e) => e.type === "drawer.updated")) void load();
      }),
    [subscribe, load],
  );
  useEffect(() => {
    if (!said) return;
    const id = setTimeout(() => setSaid(null), 6000);
    return () => clearTimeout(id);
  }, [said]);

  if (!drawer) return null;

  const send = async (reason: string) => {
    setOpen(false);
    setBusy(true);
    setSaid(null);
    try {
      await api(
        "POST",
        `/v1/venues/${venueId}/drawer-sessions/${drawer.sessionId}/no-sale`,
        { reason },
        { idempotencyKey: `no_sale-${drawer.sessionId}-${Date.now()}` },
      );
      setSaid({ ok: true, text: t("noSale.done", { drawer: drawer.name, reason }) });
    } catch (e) {
      // Cancel on the PIN dialog leaves the drawer shut, and says nothing more.
      if (e instanceof ApiCallError && e.code === "pin_again_required") return;
      setSaid({ ok: false, text: t("drawer.moveFailed") });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="secondary no-sale-button"
        disabled={offline || busy}
        title={offline ? t("noSale.offline") : undefined}
        onClick={() => {
          setSaid(null);
          setOpen(true);
        }}
      >
        {t("drawer.noSale")}
      </button>
      {offline && (
        <span className="small muted" role="status">
          {t("noSale.offline")}
        </span>
      )}
      {!offline && said && (
        <span className={said.ok ? "small" : "small error"} role={said.ok ? "status" : "alert"}>
          {said.text}
        </span>
      )}
      {open &&
        !offline &&
        createPortal(
          <Dialog onClose={() => setOpen(false)}>
            <NoSaleSheet
              drawerName={drawer.name}
              onPick={(reason) => void send(reason)}
              onCancel={() => setOpen(false)}
            />
          </Dialog>,
          document.body,
        )}
    </>
  );
}

function NoSaleSheet({
  drawerName,
  onPick,
  onCancel,
}: {
  drawerName: string;
  onPick: (reason: string) => void;
  onCancel: () => void;
}) {
  const { t } = useT();
  const title = t("noSale.title", { drawer: drawerName });
  const sheet = useSheetDialog(title);
  const [other, setOther] = useState<string | null>(null);
  return (
    <form
      className="sheet no-sale-sheet"
      {...sheet.root}
      onSubmit={(e) => {
        e.preventDefault();
        if (other !== null && other.trim() !== "") onPick(other.trim());
      }}
    >
      <h2 {...sheet.title}>{title}</h2>
      <p className="small">{t("noSale.why")}</p>
      <div className="chips" role="group" aria-label={t("noSale.why")}>
        {CHIPS.map((k) => (
          <button key={k} type="button" onClick={() => onPick(t(k))}>
            {t(k)}
          </button>
        ))}
        <button
          type="button"
          className="secondary"
          aria-pressed={other !== null}
          onClick={() => setOther((o) => (o === null ? "" : o))}
        >
          {t("noSale.reason.other")}
        </button>
      </div>
      {other !== null && (
        <label>
          <span>{t("drawer.reason")}</span>
          <input
            autoFocus
            maxLength={200}
            aria-label={t("drawer.reason")}
            value={other}
            onChange={(e) => setOther(e.target.value)}
          />
        </label>
      )}
      <div className="actions">
        {other !== null && (
          <button type="submit" className="primary" disabled={other.trim() === ""}>
            {t("drawer.openIt")}
          </button>
        )}
        <button type="button" className="secondary" onClick={onCancel}>
          {t("drawer.cancel")}
        </button>
      </div>
    </form>
  );
}
