"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import qrcode from "qrcode-generator";
import { EventClient, signDeviceSocketPath, t, type SocketLike } from "@west4/shared";
import { eventsOrigin } from "../live";
import { pairTablet, readTablet, tabletApi, type TabletDevice } from "../tablet/device";

/**
 * The Up next TV (M6-22; screens N28; Devices, printing and offline · Up next display): paired once
 * with an Up next TV code from Admin → Devices, then who's singing now, the next
 * `barMode.upNextCount` singers and a QR code that opens the queue page. It follows
 * `song_queue.updated` on a channel that carries nothing else, and shows names only: the API never
 * sends it a phone number.
 */
interface Display {
  readonly venue_id: string;
  readonly venue_name: string;
  readonly slug: string;
  readonly open: boolean;
  readonly singing: { singer: string; title: string; artist: string | null } | null;
  readonly up_next: readonly { place: number; singer: string }[];
}

const DB = "west4-tv" as const;
/** A missed event still shows within this long. */
const REFRESH_MS = 15_000;

/**
 * A browser can't put headers on a WebSocket, so the TV signs the socket's URL with its key (the
 * same four values as query parameters, its nonce spent once) before each connection.
 */
function signedSocket(device: TabletDevice, url: string): SocketLike {
  let ws: WebSocket | undefined;
  let closed = false;
  const proxy: SocketLike = {
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: (data) => ws?.send(data),
    close: (code, reason) => {
      closed = true;
      ws?.close(code, reason);
    },
  };
  const u = new URL(url);
  void signDeviceSocketPath({
    deviceId: device.deviceId,
    privateKey: device.privateKey,
    path: `${u.pathname}${u.search}`,
  })
    .then((path) => {
      if (closed) return;
      ws = new WebSocket(`${u.protocol}//${u.host}${path}`);
      ws.onopen = (e) => proxy.onopen?.(e);
      ws.onmessage = (e) => proxy.onmessage?.(e);
      ws.onclose = (e) => proxy.onclose?.(e);
      ws.onerror = (e) => proxy.onerror?.(e);
    })
    .catch(() => proxy.onclose?.(null));
  return proxy;
}

/** The join QR code as SVG squares; it opens the queue page on this guest web. */
function JoinQr({ url }: { url: string }) {
  const cells = useMemo(() => {
    const qr = qrcode(0, "M");
    qr.addData(url);
    qr.make();
    const n = qr.getModuleCount();
    const dark: { x: number; y: number }[] = [];
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (qr.isDark(y, x)) dark.push({ x, y });
    return { n, dark };
  }, [url]);
  return (
    <svg
      className="tv-qr"
      viewBox={`-4 -4 ${cells.n + 8} ${cells.n + 8}`}
      role="img"
      aria-label={t("en", "upNextTv.join")}
      data-url={url}
    >
      <rect x={-4} y={-4} width={cells.n + 8} height={cells.n + 8} fill="#fff" />
      {cells.dark.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width={1.02} height={1.02} fill="#000" />
      ))}
    </svg>
  );
}

export function UpNextTv() {
  const [device, setDevice] = useState<TabletDevice | null | undefined>(undefined);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [display, setDisplay] = useState<Display | null>(null);
  const [off, setOff] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void readTablet(DB).then(setDevice);
  }, []);
  const api = useMemo(() => (device ? tabletApi(device) : undefined), [device]);

  const load = useCallback(async () => {
    if (!api || !device) return null;
    const r = await api(`/v1/venues/${device.venueId}/up-next`).catch(() => null);
    if (!r) {
      setFailed(true);
      return null;
    }
    if (r.status === 404) {
      setOff(true);
      setFailed(false);
      return null;
    }
    if (!r.ok) {
      setFailed(true);
      return null;
    }
    const d = (await r.json()) as Display;
    setOff(false);
    setFailed(false);
    setDisplay(d);
    return d;
  }, [api, device]);

  useEffect(() => {
    if (!device) return;
    void load();
    const client = new EventClient({
      url: `${eventsOrigin()}/v1/venues/${device.venueId}/events`,
      connect: (url) => signedSocket(device, url),
      onRefetch: () => void load(),
      onFullRefetch: () => void load(),
      maxBackoffMs: 60_000,
    });
    client.start();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      clearInterval(timer);
      client.stop();
    };
  }, [device, load]);

  const pair = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const r = await pairTablet(code, "up_next_display", DB);
    if (r === "wrong_kind") setError(t("en", "upNextTv.pair.wrongKind"));
    else if (r === "refused") setError(t("en", "tablet.pair.failed"));
    else setDevice(r);
  };

  if (device === undefined) return <main className="guest" aria-busy="true" />;
  if (!device)
    return (
      <main className="guest">
        <h1>{t("en", "upNextTv.pair.title")}</h1>
        <form onSubmit={(e) => void pair(e)}>
          <label>
            {t("en", "tablet.pair.code")}
            <input
              value={code}
              autoComplete="off"
              required
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <button type="submit">{t("en", "tablet.pair.submit")}</button>
        </form>
      </main>
    );

  const joinUrl =
    display && typeof location !== "undefined"
      ? `${location.origin}/v/${encodeURIComponent(display.slug)}/sing`
      : null;
  return (
    <main className="tv">
      {failed && (
        <p className="tv-notice" role="status">
          {t("en", "guestSing.failed")}
        </p>
      )}
      {off || (display && !display.open) ? (
        <p className="tv-off" role="status">
          {t("en", "guestSing.off")}
        </p>
      ) : null}
      {display && !off && (
        <div className="tv-grid">
          <section className="tv-queue" aria-labelledby="tv-now">
            <h1 id="tv-now">{t("en", "guestSing.nowSinging")}</h1>
            {display.singing ? (
              <p className="tv-singing">
                <strong>{display.singing.singer}</strong>
                <span>
                  {display.singing.artist
                    ? t("en", "guestSing.songLine", {
                        title: display.singing.title,
                        artist: display.singing.artist,
                      })
                    : display.singing.title}
                </span>
              </p>
            ) : (
              <p className="tv-singing">{t("en", "guestSing.nobody")}</p>
            )}
            {display.up_next.length > 0 && (
              <>
                <h2>{t("en", "guestSing.upNext")}</h2>
                <ol className="tv-next">
                  {display.up_next.map((s) => (
                    <li key={s.place}>{s.singer}</li>
                  ))}
                </ol>
              </>
            )}
          </section>
          {display.open && joinUrl && (
            <aside className="tv-join">
              <JoinQr url={joinUrl} />
              <p className="tv-join-title">{t("en", "upNextTv.join")}</p>
              <p>{t("en", "upNextTv.joinLead")}</p>
            </aside>
          )}
        </div>
      )}
    </main>
  );
}
