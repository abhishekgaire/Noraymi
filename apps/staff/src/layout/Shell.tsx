import { useEffect, useState } from "react";
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import type { Membership } from "../api.js";
import { useVenueTime } from "../clock.js";
import { useEvents } from "../events.js";
import { roleKey, useT } from "../i18n.js";
import { menu, phoneTabs, visibleMenu } from "../navigation.js";
import { useSession } from "../session.js";
import { WaitingStrip } from "../approvals/WaitingStrip.js";
import { LanguageSwitch } from "./LanguageSwitch.js";
import { useUnreadTexts } from "./unread.js";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const entries = visibleMenu(
    { modules: membership.modules, permissions: membership.permissions },
    menu,
  );
  const unread = useUnreadTexts(membership.venue_id, membership.permissions.includes("texts.send"));
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
        if (events.some((e) => e.type === "settings.changed")) void refresh();
      }),
    [subscribe, refresh],
  );

  const onLock = () => {
    void lock().then(() => navigate("/sign-in", { replace: true }));
  };

  return (
    <div className={menuOpen ? "shell menu-open" : "shell"}>
      <a className="skip" href="#main">
        {t("shell.skipToContent")}
      </a>
      {!connected && (
        <div className="band offline" role="status">
          {t("shell.offline")}
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
                  {t(entry.labelKey)} {badge(entry.id)}
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
        <Outlet />
      </main>
      <nav className="tabs" aria-label={t("menu.title")}>
        {tabs.map((tab) => (
          <NavLink key={tab.id} to={tab.path} className="tab">
            {t(tab.labelKey)} {badge(tab.id)}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
