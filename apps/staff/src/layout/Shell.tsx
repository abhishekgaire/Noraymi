import { inMenuOrder, stateOf, type MessageKey } from "@west4/shared";
import { useEffect, useMemo, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { Membership } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { ConnectionBanners, useConnection } from "../connection.js";
import { banners, isOutageScreen } from "../connection-state.js";
import { roleKey, useT } from "../i18n.js";
import { menu, phoneMore, phoneTabs, visibleMenu } from "../navigation.js";
import { useSession } from "../session.js";
import { startTrialCapture } from "../trial-capture.js";
import { WaitingStrip } from "../approvals/WaitingStrip.js";
import { LanguageSwitch } from "./LanguageSwitch.js";
import { TopBarContext } from "./TopBar.js";
import { OfflineSync, ReadOnlyWhileOffline } from "./ReadOnly.js";
import { QueueProvider } from "../queue.js";
import { OfflineCodesSync } from "../screens/OfflineCodes.js";
import { useUnreadTexts, useWaitingOrders } from "./unread.js";
import { Bell } from "./Bell.js";
import { TimeUpStrip, useTimeUp } from "../room-sound.js";

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
  return (
    <Frame membership={state.membership} name={state.me.user.name} userId={state.me.user.id} />
  );
}

function Frame({
  membership,
  name,
  userId,
}: {
  membership: Membership;
  name: string;
  userId: string;
}) {
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
  // A screen's own header items (V-04) land in the top bar's slot; one that shows who is working it
  // (the bar POS's staff chip) takes the place of the signed-in line.
  const [slotNode, setSlotNode] = useState<HTMLElement | null>(null);
  const [ownWho, setOwnWho] = useState(false);
  const topBar = useMemo(() => ({ node: slotNode, setOwnWho }), [slotNode]);
  // What this person may open, in the venue's order (P-13).
  const entries = inMenuOrder(
    visibleMenu(
      {
        modules: membership.modules,
        permissions: membership.permissions,
        adminSections: membership.admin_sections ?? [],
      },
      menu,
    ),
    membership.menu_order,
  );
  const unread = useUnreadTexts(membership.venue_id, membership.permissions.includes("texts.send"));
  const waiting = useWaitingOrders(
    membership.venue_id,
    membership.permissions.includes("orders.accept") && entries.some((e) => e.id === "barOrders"),
  );
  // One bell for everything waiting (P-11): each list only where the menu and its badges show it.
  const bellOn = stateOf(membership.modules, "bell") !== "off";
  const barOrdersShown = entries.some((e) => e.id === "barOrders");
  const bellReach = useMemo(
    () => ({
      approvals: membership.permissions.includes("approvals.decide"),
      rooms:
        stateOf(membership.modules, "rooms") !== "off" &&
        membership.permissions.includes("guests.checkin"),
      orders: membership.permissions.includes("orders.accept") && barOrdersShown,
      texts:
        membership.permissions.includes("texts.send") &&
        stateOf(membership.modules, "guest_texts") !== "off",
      print: membership.permissions.includes("pos.use"),
    }),
    [membership.permissions, membership.modules, barOrdersShown],
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
  // The phone (U-19): at most four bottom tabs from the role's row, then More, the ☰ list of
  // everything else (nothing in both).
  const phone = {
    modules: membership.modules,
    permissions: membership.permissions,
    adminSections: membership.admin_sections ?? [],
    role: membership.role,
    menuOrder: membership.menu_order,
  };
  const tabs = phoneTabs(phone);
  const more = phoneMore(phone);
  // What's waiting under More shows on the More tab, so nothing new hides behind it.
  const moreWaiting =
    (more.some((m) => m.id === "messages") ? unread : 0) +
    (more.some((m) => m.id === "barOrders") ? waiting : 0);
  const onLock = () => {
    void lock().then(() => navigate("/sign-in", { replace: true }));
  };
  const item = (entry: { id: string; labelKey: MessageKey; path: string }) =>
    entry.id === "lock" ? (
      <li key={entry.path}>
        <button type="button" className="menu-link" onClick={onLock}>
          {t(entry.labelKey)}
        </button>
      </li>
    ) : (
      <li key={entry.path}>
        <NavLink to={entry.path} className="menu-link">
          {label(entry.id, entry.labelKey)} {badge(entry.id)}
        </NavLink>
      </li>
    );

  useEffect(() => {
    document.title = `${membership.venue.name} · ${t("app.staff.name")}`;
  }, [membership.venue.name, t]);

  useEffect(() => setMenuOpen(false), [location.pathname]);
  // Esc closes More's list on a phone with a keyboard.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

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
  // The "Time's up" strip (P-05; U-18): in the bands, on every signed-in screen.
  const timeUp = useTimeUp();

  return (
    <TopBarContext.Provider value={topBar}>
      <div className={menuOpen ? "shell menu-open" : "shell"}>
        <a className="skip" href="#main">
          {t("shell.skipToContent")}
        </a>
        {(showReconnecting ||
          membership.training ||
          connectionBands.length > 0 ||
          timeUp.length > 0) && (
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
            <TimeUpStrip />
          </div>
        )}
        <header className="topbar">
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
          <div className="screen-slot" ref={setSlotNode} />
          {bellOn && (
            <Bell
              venueId={membership.venue_id}
              userId={userId}
              timeZone={membership.venue.time_zone}
              reach={bellReach}
            />
          )}
          {!ownWho && (
            <div className="who">
              {t("shell.signedInAs", { name, role: t(roleKey[membership.role]) })}
            </div>
          )}
        </header>
        <nav id="side-menu" className="side" aria-label={t("menu.title")}>
          {/* The desktop's side menu, and on a phone More's list (U-19): only what isn't a tab. */}
          <ul className="side-desktop">{entries.map(item)}</ul>
          <ul className="side-phone">{more.map(item)}</ul>
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
        <nav className="tabs" aria-label={t("menu.title")}>
          {tabs.map((tab) => (
            <NavLink key={tab.id} to={tab.path} className="tab">
              {t(tab.labelKey)} {badge(tab.id)}
            </NavLink>
          ))}
          <button
            type="button"
            className={menuOpen ? "tab more active" : "tab more"}
            aria-expanded={menuOpen}
            aria-controls="side-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span> {t("tabs.more")}
            {moreWaiting > 0 && (
              <span className="badge" aria-label={t("tabs.more.waiting", { count: moreWaiting })}>
                {moreWaiting}
              </span>
            )}
          </button>
        </nav>
      </div>
    </TopBarContext.Provider>
  );
}
