/**
 * Where the live channel connects. The page's /v1 calls go through Next's rewrite, which doesn't
 * carry a WebSocket upgrade, so NEXT_PUBLIC_EVENTS_ORIGIN names the API's origin when it's on
 * another host; locally the API is on port 3000 beside the guest web's 3001. The room and singer
 * cookies belong to the host name, so it reaches either port.
 */
export function eventsOrigin(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const configured = process.env["NEXT_PUBLIC_EVENTS_ORIGIN"];
  if (configured) return configured.replace(/\/+$/, "");
  return location.port === "3001"
    ? `${scheme}://${location.hostname}:3000`
    : `${scheme}://${location.host}`;
}
