import websocket from "@fastify/websocket";
import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { Relay, Tail, toWire, type StampedEvent } from "@west4/db";
import { formatInZone, type Clock } from "@west4/shared";
import { route } from "./conventions.js";
import { visibleTo, type Subscription } from "./event-filter.js";

export interface EventsOptions {
  readonly clock: Clock;
  readonly timeZone: string;
  readonly pollMs?: number;
  /** Deploys drain sockets slowly: close them spread over this many ms. */
  readonly drainMs?: number;
}

interface Socket {
  readonly ws: WebSocket;
  readonly sub: Subscription;
  /** The last seq of this venue this socket has been told about (sent or filtered), for the client's cursor. */
  lastSeq: number;
}

/**
 * The live WebSocket (M1-09): GET /v1/venues/:venueId/events, one per
 * screen, filtered to what its principal may see. Frames:
 *   hello      { type: "hello", server_time, seq }          on open
 *   event      { seq, type, id, entity_version, at }        exactly five fields
 *   caught_up  { type: "caught_up", seq }                   after a replay
 *   refetch    { type: "refetch" }                          the client's seq is older than what's kept
 *   reconnect  { type: "reconnect" }                        this container is draining
 */
export const eventsPlugin = fp(async (app: FastifyInstance, options: EventsOptions) => {
  await app.register(websocket, {
    // Our onClose has already drained sockets politely; whatever is left (for
    // example an upgrade refused with 403 before the plugin tagged it) is cut,
    // or close() would wait for it forever.
    preClose: function (done) {
      for (const client of this.websocketServer.clients) client.terminate();
      this.websocketServer.close(() => done());
    },
  });
  const sockets = new Set<Socket>();

  const deliver = (events: StampedEvent[]): void => {
    for (const event of events) {
      for (const socket of sockets) {
        if (event.venue_id !== socket.sub.venueId) continue;
        const seq = Number(event.seq);
        if (seq <= socket.lastSeq) continue;
        socket.lastSeq = seq;
        if (visibleTo(socket.sub, event)) send(socket.ws, toWire(event));
      }
    }
  };

  const relay = new Relay(app.db.pool, {
    pollMs: options.pollMs ?? 1000,
    log: (l) => app.log.warn(l),
  });
  const tail = new Tail(app.db.pool, deliver, {
    pollMs: options.pollMs ?? 1000,
    log: (l) => app.log.warn(l),
  });
  /** Revoking a device: its sockets close at once (4401), and its next request is refused by the authenticator. */
  const closeSocketsFor = (deviceId: string): void => {
    for (const socket of sockets) {
      if (socket.sub.principal.kind === "device" && socket.sub.principal.deviceId === deviceId) {
        send(socket.ws, { type: "revoked" });
        socket.ws.close(4401, "revoked");
        sockets.delete(socket);
      }
    }
  };
  app.decorate("events", { relay, tail, sockets, closeSocketsFor });

  app.addHook("onReady", async () => {
    relay.start();
    await tail.start();
  });
  app.addHook("onClose", async () => {
    // Drain slowly: tell each socket to reconnect elsewhere, spread over drainMs.
    const list = [...sockets];
    const gap = list.length > 1 ? (options.drainMs ?? 5000) / (list.length - 1) : 0;
    for (const [i, socket] of list.entries()) {
      setTimeout(
        () => {
          send(socket.ws, { type: "reconnect" });
          socket.ws.close(1012, "restarting");
        },
        Math.round(i * gap),
      );
    }
    await new Promise((r) =>
      setTimeout(r, list.length > 0 ? Math.min(options.drainMs ?? 5000, 5000) : 0),
    );
    await tail.stop();
    await relay.stop();
  });

  app.register(async (scope) => {
    scope.get<{
      Params: { venueId: string };
      Querystring: { after?: string; locked?: string; room?: string };
    }>(
      "/v1/venues/:venueId/events",
      {
        websocket: true,
        config: route({
          principals: [
            "owner_manager",
            "staff",
            "shared_device",
            "room_tablet",
            "guest_room",
            "singer",
            "up_next_display",
            "support",
          ],
          module: "core",
          rateLimit: false,
          websocket: true,
        }),
      },
      async (ws, request) => {
        if (request.forbidden) {
          ws.close(4403, "forbidden");
          return;
        }
        const principal = request.principal;
        const boundRoom =
          principal.kind === "device" && principal.deviceKind === "room_tablet"
            ? request.query.room
            : principal.kind === "guest"
              ? principal.id
              : undefined;
        const sub: Subscription = {
          principal,
          venueId: request.params.venueId,
          locked: request.query.locked === "1",
          roomId: boundRoom,
        };
        const bounds = await request.inVenue(
          async (c) =>
            (
              await c.query<{ oldest_seq: string | null; latest_seq: string | null }>(
                "select * from venue_events_bounds($1)",
                [sub.venueId],
              )
            ).rows[0],
        );
        const latest = Number(bounds?.latest_seq ?? 0);
        const socket: Socket = { ws, sub, lastSeq: latest };
        send(ws, {
          type: "hello",
          server_time: formatInZone(options.clock.now(), options.timeZone),
          seq: latest,
        });

        // Catch up a reconnecting screen.
        const after = request.query.after === undefined ? undefined : Number(request.query.after);
        if (after !== undefined && Number.isFinite(after)) {
          const oldest =
            bounds?.oldest_seq === null || bounds?.oldest_seq === undefined
              ? null
              : Number(bounds.oldest_seq);
          if (oldest !== null && after < oldest - 1) {
            send(ws, { type: "refetch" });
          } else if (after < latest) {
            const missed = await request.inVenue(
              async (c) =>
                (
                  await c.query<StampedEvent>("select * from venue_events_after($1, $2, 1000)", [
                    sub.venueId,
                    after,
                  ])
                ).rows,
            );
            for (const event of missed) {
              if (visibleTo(sub, { ...event, venue_id: sub.venueId })) send(ws, toWire(event));
            }
          }
          send(ws, { type: "caught_up", seq: latest });
        }
        sockets.add(socket);
        ws.on("close", () => sockets.delete(socket));
        ws.on("error", () => sockets.delete(socket));
      },
    );
  });
});

declare module "fastify" {
  interface FastifyInstance {
    events: {
      relay: Relay;
      tail: Tail;
      sockets: Set<unknown>;
      closeSocketsFor: (deviceId: string) => void;
    };
  }
}

function send(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
}
