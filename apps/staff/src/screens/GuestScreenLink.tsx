import { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { deviceOnlyApi, readDevice, type StoredDevice } from "../device.js";
import { useT } from "../i18n.js";
import { useModuleOn } from "../useModule.js";

/** How soon after a change the register tells its guest screen, and how often it says it again. */
const SETTLE_MS = 120;
const KEEP_ALIVE_MS = 60_000;

const isRegister = (d: StoredDevice | null): d is StoredDevice =>
  d !== null && (d.kind === "bar_computer" || d.kind === "front_desk");

/**
 * The register's side of the guest screen (P-18; module guest_screen): the bar POS on a bar or
 * front-desk computer says which check it has open (null: nothing, the venue's name) and whether
 * the person's unsent drinks on it show too. `nudge` changes whenever what's on the check may have
 * changed (a reload, a payment), so the screen asks again at once. Leaving the bar POS, or a
 * computer that isn't paired, clears the screen. Off, nothing is sent.
 */
export function useGuestScreen(
  venueId: string,
  showing: { readonly checkId: string | null; readonly draft: boolean },
  nudge: unknown,
): void {
  const on = useModuleOn("guest_screen");
  const [device, setDevice] = useState<StoredDevice | null>(null);
  const following = useRef(true);
  useEffect(() => {
    void readDevice().then((d) => setDevice(isRegister(d) ? d : null));
  }, []);
  const active = on && venueId !== "" && device !== null;
  const path = `/v1/venues/${venueId}/guest-screen/showing`;

  useEffect(() => {
    if (!active || !following.current) return;
    const say = () =>
      api<{ following: boolean }>("POST", path, {
        check_id: showing.checkId,
        draft: showing.draft,
      })
        .then((r) => {
          if (!r.following) following.current = false;
        })
        .catch(() => undefined);
    const soon = setTimeout(() => void say(), SETTLE_MS);
    const again = setInterval(() => void say(), KEEP_ALIVE_MS);
    return () => {
      clearTimeout(soon);
      clearInterval(again);
    };
  }, [active, path, showing.checkId, showing.draft, nudge]);

  // Leaving the bar POS (signing out, locking, another screen): the guest screen goes back to idle,
  // said as the computer itself since the person's session may already be gone.
  useEffect(() => {
    if (!active || !device) return;
    return () => {
      void deviceOnlyApi(device, "POST", path, { check_id: null }).catch(() => undefined);
    };
  }, [active, device, path]);
}

/** "Open the guest screen" on the bar POS: the guest screen in a window of its own (the second monitor). */
export function GuestScreenLink() {
  const { t } = useT();
  const on = useModuleOn("guest_screen");
  if (!on) return null;
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => window.open("/guest-screen", "west4-guest-screen")}
    >
      {t("guestScreen.openWindow")}
    </button>
  );
}
