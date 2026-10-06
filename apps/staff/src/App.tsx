import { useEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { ClockProvider } from "./clock.js";
import { EventsProvider } from "./events.js";
import { LocaleProvider, useT } from "./i18n.js";
import { Shell } from "./layout/Shell.js";
import { homeFor, runs } from "./navigation.js";
import { Admin, AdminIndex } from "./screens/Admin.js";
import { Devices } from "./screens/admin/Devices.js";
import { Features } from "./screens/admin/Features.js";
import { Hours } from "./screens/admin/Hours.js";
import { Rooms } from "./screens/admin/Rooms.js";
import { Menu } from "./screens/admin/Menu.js";
import { BarOrders } from "./screens/BarOrders.js";
import { SongQueue } from "./screens/SongQueue.js";
import { Runs } from "./screens/Runs.js";
import { ChimeLoop } from "./chime.js";
import { Phone } from "./screens/admin/Phone.js";
import { Website } from "./screens/admin/Website.js";
import { Deposits } from "./screens/admin/Deposits.js";
import { BarMode } from "./screens/admin/BarMode.js";
import { BarPos } from "./screens/admin/BarPos.js";
import { Rail } from "./screens/Rail.js";
import { Payments } from "./screens/admin/Payments.js";
import { DisputesScreen } from "./screens/admin/Disputes.js";
import { CardFee } from "./screens/admin/CardFee.js";
import { Connections } from "./screens/admin/Connections.js";
import { Texts } from "./screens/admin/Texts.js";
import { Safety } from "./screens/admin/Safety.js";
import { CashDrawers } from "./screens/admin/CashDrawers.js";
import { AlertsRules } from "./screens/admin/AlertsRules.js";
import { Team } from "./screens/admin/Team.js";
import { Tonight } from "./screens/Tonight.js";
import { Invite } from "./screens/Invite.js";
import { NotFound } from "./screens/NotFound.js";
import { Setup } from "./screens/Setup.js";
import { SignIn } from "./screens/SignIn.js";
import { Approvals } from "./screens/Approvals.js";
import { TipsToEnter } from "./screens/TipsToEnter.js";
import { CloseTheNight } from "./screens/CloseTheNight.js";
import { Calls } from "./screens/Calls.js";
import { Messages } from "./screens/Messages.js";
import { Waitlist } from "./screens/Waitlist.js";
import { RoomScreen } from "./screens/RoomScreen.js";
import { PhoneTonight } from "./screens/PhoneTonight.js";
import { Calendar } from "./screens/Calendar.js";
import { TimeClock } from "./screens/TimeClock.js";
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
      <ChimeLoop />
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
        <Route path="/tonight" element={<Tonight />} />
        <Route path="/bar" element={<Rail />} />
        <Route path="/bar-orders" element={<BarOrders />} />
        <Route path="/song-queue" element={<SongQueue />} />
        <Route path={runs.path} element={<Runs />} />
        <Route path="/setup" element={<Setup />} />
        <Route path="/approvals" element={<Approvals />} />
        <Route path="/tips" element={<TipsToEnter />} />
        <Route path="/close-the-night" element={<CloseTheNight />} />
        <Route path="/calls" element={<Calls />} />
        <Route path="/messages" element={<Messages />} />
        <Route path="/waitlist" element={<Waitlist />} />
        <Route path="/room/:roomId" element={<RoomScreen />} />
        <Route path="/today" element={<PhoneTonight />} />
        <Route path="/calendar" element={<Calendar />} />
        <Route path="/clock" element={<TimeClock />} />
        <Route path="/admin" element={<Admin />}>
          <Route index element={<AdminIndex />} />
          <Route path="team" element={<Team />} />
          <Route path="features" element={<Features />} />
          <Route path="hours" element={<Hours />} />
          <Route path="devices" element={<Devices />} />
          <Route path="cash-drawers" element={<CashDrawers />} />
          <Route path="rooms" element={<Rooms />} />
          <Route path="menu" element={<Menu />} />
          <Route path="phone" element={<Phone />} />
          <Route path="website" element={<Website />} />
          <Route path="deposits" element={<Deposits />} />
          <Route path="bar-pos" element={<BarPos />} />
          <Route path="bar-mode" element={<BarMode />} />
          <Route path="texts" element={<Texts />} />
          <Route path="safety" element={<Safety />} />
          <Route path="alerts" element={<AlertsRules />} />
          <Route path="payments" element={<Payments />} />
          <Route path="disputes" element={<DisputesScreen />} />
          <Route path="card-fee" element={<CardFee />} />
          <Route path="connections" element={<Connections />} />
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
