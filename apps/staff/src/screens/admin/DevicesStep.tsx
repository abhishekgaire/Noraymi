import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import type { MessageKey } from "@west4/shared";
import { api } from "../../api.js";
import { useT } from "../../i18n.js";
import { useSession } from "../../session.js";
import { GoLive } from "./GoLive.js";

/**
 * Set up your venue's step 12, devices and checks (O-13; spec 17 · Step details 12). Pairing and
 * reader registration are Admin → Printers & devices' own flows (M1-15, M3-13, M3-14, M4-02), so
 * the step lists what's paired, read from the same rows, and links there. The song system is
 * "None" until a partnership exists. The go-live checklist (M4-29) runs here for every venue:
 * the merchant category read from Stripe, and each manager's Stripe Dashboard login and Tap to Pay
 * phone. The wizard's checklist and Finish setup follow below it.
 */
interface Reader {
  readonly id: string;
  readonly label: string;
  readonly online: boolean;
}
interface Device {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly station?: string | null;
  readonly revoked_at: string | null;
}
interface Drawer {
  readonly id: string;
  readonly name: string;
  readonly printer: string | null;
}
interface Paired {
  readonly readers: readonly Reader[];
  readonly devices: readonly Device[];
  readonly drawers: readonly Drawer[];
}

export function DevicesStep({
  missing,
  onSaved,
}: {
  missing: readonly string[];
  onSaved: () => void;
}) {
  const { t } = useT();
  const { state } = useSession();
  const venueId = state.status === "signedIn" ? state.membership.venue_id : "";
  const [paired, setPaired] = useState<Paired | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    if (!venueId) return;
    setFailed(false);
    try {
      const [r, d, w] = await Promise.all([
        api<{ readers: Reader[] }>("GET", `/v1/venues/${venueId}/readers`),
        api<{ devices: Device[] }>("GET", `/v1/venues/${venueId}/devices`),
        api<{ drawers: Drawer[] }>("GET", `/v1/venues/${venueId}/drawers`),
      ]);
      setPaired({ readers: r.readers, devices: d.devices, drawers: w.drawers });
    } catch {
      setFailed(true);
    }
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const live = paired?.devices.filter((d) => !d.revoked_at) ?? [];
  const printers = live.filter((d) => d.kind === "printer" && d.station !== "kitchen");
  // The kitchen's printer, of any kind: cabled to a bar computer, on the network or a cloud printer (W-04).
  const kitchenPrinters = live.filter((d) => d.kind === "printer" && d.station === "kitchen");
  const badgeReaders = live.filter((d) => d.kind === "nfc_reader");
  const drawerOn = (printer: string) => paired?.drawers.find((d) => d.printer === printer);

  return (
    <div className="setup-card setup-form">
      <p className="muted small">{t("onboarding.devices.intro")}</p>
      <section aria-labelledby="setup-paired-h">
        <h3 id="setup-paired-h">{t("onboarding.devices.paired")}</h3>
        {failed && (
          <div className="error" role="alert">
            <p>{t("shell.error.cantReach")}</p>
            <button type="button" className="secondary" onClick={() => void load()}>
              {t("shell.error.retry")}
            </button>
          </div>
        )}
        {paired === null ? (
          !failed && <p role="status">{t("shell.loading")}</p>
        ) : (
          <ul className="list" aria-label={t("onboarding.devices.paired")}>
            <li>
              <strong>{t("onboarding.devices.readers")}</strong>
              {paired.readers.length === 0 ? (
                <span className="muted">{t("onboarding.devices.none")}</span>
              ) : (
                <span>{paired.readers.map((r) => r.label).join(", ")}</span>
              )}
            </li>
            <li>
              <strong>{t("onboarding.devices.printers")}</strong>
              {printers.length === 0 ? (
                <span className="muted">{t("onboarding.devices.none")}</span>
              ) : (
                <span>
                  {printers
                    .map((p) => {
                      const drawer = drawerOn(p.name);
                      return drawer
                        ? t("onboarding.devices.printerWithDrawer", {
                            printer: p.name,
                            drawer: drawer.name,
                          })
                        : p.name;
                    })
                    .join(", ")}
                </span>
              )}
            </li>
            <li>
              <strong>{t("onboarding.devices.kitchenPrinter")}</strong>
              {kitchenPrinters.length === 0 ? (
                <span className="muted">{t("onboarding.devices.kitchenPrinter.none")}</span>
              ) : (
                <span>{kitchenPrinters.map((p) => p.name).join(", ")}</span>
              )}
            </li>
            <li>
              <strong>{t("onboarding.devices.badgeReaders")}</strong>
              {badgeReaders.length === 0 ? (
                <span className="muted">{t("onboarding.devices.optional")}</span>
              ) : (
                <span>{badgeReaders.map((b) => b.name).join(", ")}</span>
              )}
            </li>
            <li>
              <strong>{t("onboarding.devices.songSystem")}</strong>
              <span className="muted">{t("onboarding.devices.songSystem.none")}</span>
            </li>
          </ul>
        )}
        <Link to="/admin/devices" className="button secondary">
          {t("onboarding.openSection", { section: t("admin.section.devices") })}
        </Link>
      </section>
      {missing.length > 0 && (
        <>
          <h3>{t("onboarding.stillNeeded")}</h3>
          <ul>
            {missing.map((m) => (
              <li key={m}>{t(`onboarding.missing.${m}` as MessageKey)}</li>
            ))}
          </ul>
        </>
      )}
      {venueId && <GoLive venueId={venueId} onChange={onSaved} />}
    </div>
  );
}
