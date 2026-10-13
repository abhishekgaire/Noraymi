import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { checkLanIp, lanRoutes, parseLanPorts, type LanRoute } from "./lan.js";

/**
 * `pnpm --filter @west4/api lan:proxy` (scripts/demo-start.sh --lan starts it): each app's
 * loopback port, put on the laptop's Wi-Fi address over HTTPS with the local CA's certificate,
 * WebSockets included. The Host header passes through untouched (the pay host is told apart by
 * it). A plain HTTP page on the setup port hands
 * out the CA's certificate (never its key) so each bar PC and phone can trust it once.
 *
 *   LAN_IP       the Wi-Fi address to listen on
 *   LAN_CERT     the server certificate (PEM) for that address
 *   LAN_KEY      its private key (PEM)
 *   LAN_CA       the CA's certificate (PEM), for the setup page
 *   LAN_PORTS    optional: api,guest,pay,staff,setup (lan.ts)
 * Local practice nights only: it never runs in staging or production.
 */
const env = process.env;
if ((env["WEST4_ENV"] ?? "local") !== "local") throw new Error("lan:proxy is local only");
const ip = checkLanIp(env["LAN_IP"] ?? "");
const cert = readFileSync(need("LAN_CERT"));
const key = readFileSync(need("LAN_KEY"));
const ca = readFileSync(need("LAN_CA"));
const ports = parseLanPorts(env["LAN_PORTS"]);
const routes = lanRoutes(ports);

function need(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

function forward(route: LanRoute, req: http.IncomingMessage, res: http.ServerResponse) {
  const headers = { ...req.headers };
  headers["x-forwarded-proto"] = "https";
  headers["x-forwarded-for"] = req.socket.remoteAddress ?? "";
  const upstream = http.request(
    { host: "127.0.0.1", port: route.target, method: req.method, path: req.url, headers },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.rawHeaders);
      answer.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`The laptop's ${route.name} isn't answering yet. Wait a moment and reload.\n`);
  });
  req.pipe(upstream);
}

function forwardUpgrade(
  route: LanRoute,
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
) {
  const upstream = net.connect(route.target, "127.0.0.1", () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push("X-Forwarded-Proto: https", `X-Forwarded-For: ${socket.remoteAddress ?? ""}`);
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", close);
  socket.on("error", close);
}

function listen(route: LanRoute): Promise<void> {
  const tls = https.createServer({ cert, key }, (req, res) => forward(route, req, res));
  tls.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) =>
    forwardUpgrade(route, req, socket, head),
  );
  return new Promise((resolve, reject) => {
    tls.once("error", reject);
    tls.listen(route.listen, ip, () => resolve());
  });
}

function setupPage(): Promise<void> {
  const port = ports.setup;
  const staff = `https://${ip}:${ports.staff}`;
  const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>West 4 practice night</title>
<style>body{font:17px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}a.b{display:inline-block;padding:.8rem 1.2rem;background:#222;color:#fff;border-radius:8px;text-decoration:none}li{margin:.4rem 0}</style>
<h1>West 4 practice night</h1>
<p>Step 1 on every bar PC and phone, once: download the laptop's certificate and trust it.</p>
<p><a class="b" href="/west4-practice-ca.crt">Download the certificate</a></p>
<ul>
<li><b>Windows:</b> open the file, Install Certificate, Current User, "Place all certificates in the following store", Browse, <i>Trusted Root Certification Authorities</i>, Next, Finish, Yes.</li>
<li><b>iPhone:</b> Allow the download, then Settings, Profile Downloaded, Install. Then Settings, General, About, Certificate Trust Settings: turn on "West 4 practice night CA".</li>
<li><b>Android:</b> Settings, Security, More security settings, Encryption &amp; credentials, Install a certificate, CA certificate, pick the file.</li>
</ul>
<p>Step 2: the staff app is <a href="${staff}">${staff}</a> (the desktop app's server address).</p>`;
  const server = http.createServer((req, res) => {
    if (req.url === "/west4-practice-ca.crt") {
      res.writeHead(200, {
        "content-type": "application/x-x509-ca-cert",
        "content-disposition": 'attachment; filename="west4-practice-ca.crt"',
      });
      return void res.end(ca);
    }
    res.writeHead(req.url === "/" ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, ip, () => resolve());
  });
}

try {
  await Promise.all([...routes.map(listen), setupPage()]);
} catch (error) {
  console.error(`lan:proxy: can't listen on ${ip}: ${(error as Error).message}`);
  process.exit(1);
}
console.warn(
  `lan:proxy on ${ip}: ${routes.map((r) => `${r.name} https://${ip}:${r.listen}`).join(", ")}`,
);
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
