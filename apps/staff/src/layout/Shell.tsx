import type { MessageKey } from "@west4/shared";
import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { Membership } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { ConnectionBanners, useConnection } from "../connection.js";
import { banners, isOutageScreen } from "../connection-state.js";
import { roleKey, useT } from "../i18n.js";
import { menu, phoneTabs, visibleMenu } from "../navigation.js";
import { useSession } from "../session.js";
import { startTrialCapture } from "../trial-capture.js";
import { WaitingStrip } from "../approvals/WaitingStrip.js";
import { LanguageSwitch } from "./LanguageSwitch.js";
import { OfflineSync, ReadOnlyWhileOffline } from "./ReadOnly.js";
import { QueueProvider } from "../queue.js";
import { OfflineCodesSync } from "../screens/OfflineCodes.js";
import { useUnreadTexts, useWaitingOrders } from "./unread.js";

/**
 * The frame around every staff screen: the venue, the venue's time and
 * business date, who is signed in, the language, the side menu on desktop
 * (a drawer on phones) and the offline band. Signed out, it sends the person
 * to sign-in; loading and unreachable states are screens of their own.
 */
export function Shell() {
  const { t } = useT();
  const { state, refresh } = useSession();
  const location = useLocation();

  if (state.status === "loading") {
    return (
      <main className="centered" id="main">
        <p role="status">{t("shell.loading")}</p>
      </main>
    );
  }
  if (state.status === "error") {
    return (
      <main className="centered" id="main">
        <h1>{t("shell.error.cantReach")}</h1>
        <button type="button" className="primary" onClick={() => void refresh()}>
          {t("shell.error.retry")}
        </button>
      </main>
    );
  }
  if (state.status === "signedOut") {
    return <Navigate to="/sign-in" replace state={{ from: location.pathname }} />;
  }
  return <Frame membership={state.membership} name={state.me.user.name} />;
}

function Frame({ membership, name }: { membership: Membership; name: string }) {
  const { t, time, date } = useT();
  const { lock, refresh } = useSession();
  const { connected, subscribe } = useEvents();
  const navigate = useNavigate();
  const location = useLocation();
  const venueTime = useVenueTime(membership.venue.time_zone, membership.venue.day_cutover);
  // The timed staff trial's capture (M9-11): only while the person or this screen is in training.
  useEffect(
    () => (membership.training ? startTrialCapture(membership.venue_id) : undefined),
    [membership.training, membership.venue_id],
  );
  const [menuOpen, setMenuOpen] = useState(false);
  const entries = visibleMenu(
    { modules: membership.modules, permissions: membership.permissions },
    menu,
  );
  const unread = useUnreadTexts(membership.venue_id, membership.permissions.includes("texts.send"));
  const waiting = useWaitingOrders(
    membership.venue_id,
    membership.permissions.includes("orders.accept") && entries.some((e) => e.id === "barOrders"),
  );
  // "Bar orders · 2" (M3-16): every ringing and asked-to-wait order.
  const label = (id: string, key: MessageKey) =>
    id === "barOrders" && waiting > 0 ? t("menu.barOrders.count", { n: waiting }) : t(key);
  const badge = (id: string) =>
    id === "messages" && unread > 0 ? (
      <span className="badge" aria-label={t("messages.unread", { count: unread })}>
        {unread}
      </span>
    ) : null;
  const tabs = phoneTabs({
    modules: membership.modules,
    permissions: membership.permissions,
    role: membership.role,
  });

  useEffect(() => {
    document.title = `${membership.venue.name} · ${t("app.staff.name")}`;
  }, [membership.venue.name, t]);

  useEffect(() => setMenuOpen(false), [location.pathname]);

  // A module switched on or off in Admin changes the menu and the tabs at once (M2-32).
  useEffect(
    () =>
      subscribe((events) => {
        // Training mode switched in Admin → Team (M7-03) shows or hides the band at once.
        if (
          events.some((e) =>
            ["settings.changed", "membership.changed", "device.updated"].includes(e.type),
          )
        )
          void refresh();
      }),
    [subscribe, refresh],
  );

  // The Board, the bar POS and the bar orders screen show the outage banners; other screens keep
  // "Offline · reconnecting" when the live connection drops.
  const outageScreen = isOutageScreen(location.pathname);
  const connection = useConnection();
  const connectionBands = banners(connection, outageScreen);
  const showReconnecting = !outageScreen && (!connected || connection.kind === "offline");

  const onLock = () => {
    void lock().then(() => navigate("/sign-in", { replace: true }));
  };

  return (
    <div className={menuOpen ? "shell menu-open" : "shell"}>
      <a className="skip" href="#main">
        {t("shell.skipToContent")}
      </a>
      {(showReconnecting || membership.training || connectionBands.length > 0) && (
        <div className="bands">
          {/* The outage and vendor banners (M8-01; spec 09 · Outages). */}
          <ConnectionBanners outageScreen={outageScreen} />
          {showReconnecting && (
            <div className="band offline" role="status">
              {t("shell.offline")}
            </div>
          )}
          {/* Training mode (M7-03): permanent while the person or this screen is in training; no close. */}
          {membership.training && (
            <div className="band training" role="status" data-testid="training-band">
              {t("training.band")}
            </div>
          )}
        </div>
      )}
      <header className="topbar">
        <button
          type="button"
          className="icon-button menu-button"
          aria-label={menuOpen ? t("menu.close") : t("menu.open")}
          aria-expanded={menuOpen}
          aria-controls="side-menu"
          onClick={() => setMenuOpen((open) => !open)}
        >
          ☰
        </button>
        <div className="venue">{membership.venue.name}</div>
        {venueTime && (
          <div className="clock" aria-label={t("shell.now")}>
            <time dateTime={venueTime.now.toString()}>
              {time(venueTime.now, venueTime.timeZone)}
            </time>
            <span className="muted">
              {t("shell.businessDate", { date: date(venueTime.businessDate) })}
            </span>
          </div>
        )}
        <div className="who">
          {t("shell.signedInAs", { name, role: t(roleKey[membership.role]) })}
        </div>
      </header>
      <nav id="side-menu" className="side" aria-label={t("menu.title")}>
        <ul>
          {entries.map((entry) =>
            entry.id === "lock" ? (
              <li key={entry.id}>
                <button type="button" className="menu-link" onClick={onLock}>
                  {t(entry.labelKey)}
                </button>
              </li>
            ) : (
              <li key={entry.id}>
                <NavLink to={entry.path} className="menu-link">
                  {label(entry.id, entry.labelKey)} {badge(entry.id)}
                </NavLink>
              </li>
            ),
          )}
        </ul>
        <NavLink to="/setup" className="menu-link phone-only">
          {t("setup.title")}
        </NavLink>
        <LanguageSwitch />
      </nav>
      <main id="main" className="content">
        <WaitingStrip venueId={membership.venue_id} />
        {/* Offline codes (M8-04): kept on managers' and owners' phones, never on a shared computer. */}
        {(membership.role === "owner" || membership.role === "manager") &&
          typeof window !== "undefined" &&
          !window.west4 && <OfflineCodesSync venueId={membership.venue_id} />}
        <OfflineSync
          venueId={membership.venue_id}
          timeZone={membership.venue.time_zone}
          cutover={membership.venue.day_cutover}
        />
        <QueueProvider>
          <ReadOnlyWhileOffline
            active={outageScreen && connection.kind === "offline"}
            timeZone={membership.venue.time_zone}
          >
            <Outlet />
          </ReadOnlyWhileOffline>
        </QueueProvider>
      </main>
      <nav className="tabs" aria-label={t("menu.title")} data-scroll="x">
        {tabs.map((tab) => (
          <NavLink key={tab.id} to={tab.path} className="tab">
            {t(tab.labelKey)} {badge(tab.id)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
