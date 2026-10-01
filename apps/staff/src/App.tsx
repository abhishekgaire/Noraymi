import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ClockProvider } from "./clock.js";
import { EventsProvider } from "./events.js";
import { LocaleProvider, useT } from "./i18n.js";
import { Shell } from "./layout/Shell.js";
import { homeFor, runs } from "./navigation.js";
import { Admin, AdminIndex } from "./screens/Admin.js";
import { Features } from "./screens/admin/Features.js";
import { Hours } from "./screens/admin/Hours.js";
import { Team } from "./screens/admin/Team.js";
import { Home } from "./screens/Home.js";
import { Invite } from "./screens/Invite.js";
import { NotFound } from "./screens/NotFound.js";
import { Setup } from "./screens/Setup.js";
import { SignIn } from "./screens/SignIn.js";
import { SessionProvider, useSession, type SessionState } from "./session.js";
import { isShared, readDevice } from "./device.js";
import { startHeartbeats } from "./heartbeat.js";

/** Everything a screen needs around it; tests pass a session instead of calling the API. */
export function Providers({ children, session }: { children: ReactNode; session?: SessionState }) {
  return (
    <ClockProvider>
      <SessionProvider initial={session}>
        <WithLocale>
          <EventsProvider>{children}</EventsProvider>
        </WithLocale>
      </SessionProvider>
    </ClockProvider>
  );
}

function WithLocale({ children }: { children: ReactNode }) {
  const { locale } = useSession();
  return (
    <LocaleProvider locale={locale}>
      <Title />
      <Heartbeats />
      {children}
    </LocaleProvider>
  );
}

/** A paired shared screen checks in every 30 seconds for as long as the app runs. */
function Heartbeats() {
  useEffect(() => {
    let stop: (() => void) | null = null;
    let live = true;
    void readDevice().then((device) => {
      if (live && isShared(device)) stop = startHeartbeats(device);
    });
    return () => {
      live = false;
      stop?.();
    };
  }, []);
  return null;
}

function Title() {
  const { t } = useT();
  useEffect(() => {
    document.title = t("app.staff.name");
  }, [t]);
  return null;
}

/** "/" opens the signed-in role's home (spec 10 · rule 1). */
function HomeRedirect() {
  const { state } = useSession();
  const to = state.status === "signedIn" ? homeFor(state.membership.role) : "/sign-in";
  return <Navigate to={to} replace />;
}

export function StaffRoutes() {
  return (
    <Routes>
      <Route path="/sign-in" element={<SignIn />} />
      <Route path="/invite/:token" element={<Invite />} />
      <Route element={<Shell />}>
        <Route index element={<HomeRedirect />} />
        <Route path="/tonight" element={<Home titleKey="menu.tonight" />} />
        <Route path="/bar" element={<Home titleKey="menu.barPos" />} />
        <Route path={runs.path} element={<Home titleKey={runs.labelKey} />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/admin" element={<Admin />}>
          <Route index element={<AdminIndex />} />
          <Route path="team" element={<Team />} />
          <Route path="features" element={<Features />} />
          <Route path="hours" element={<Hours />} />
        </Route>
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Providers>
        <StaffRoutes />
      </Providers>
    </BrowserRouter>
  );
}
