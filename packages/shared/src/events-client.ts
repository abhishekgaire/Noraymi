/**
 * The screens' event client (spec 08 · Live events): one WebSocket per
 * screen, refetches grouped for 250 ms, reconnects backed off with jitter,
 * and the last seq remembered so a reconnect asks for what it missed.
 * Runtime-agnostic: the browser's WebSocket or `ws` in Node is passed in.
 */
export interface WireEvent {
  readonly seq: number;
  readonly type: string;
  readonly id: string;
  readonly entity_version: number;
  readonly at: string;
}

export interface SocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface EventClientOptions {
  /** Builds the socket URL; the client appends ?after= when it has a seq. */
  readonly url: string;
  readonly connect: (url: string) => SocketLike;
  /** Called once per group of events, at most every groupMs, with the types and ids to refetch. */
  readonly onRefetch: (events: readonly WireEvent[]) => void;
  /** The server said the client's seq is too old: reload everything. */
  readonly onFullRefetch: () => void;
  readonly onHello?: (hello: { server_time: string; seq: number }) => void;
  readonly groupMs?: number;
  readonly minBackoffMs?: number;
  readonly maxBackoffMs?: number;
  readonly random?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}

export class EventClient {
  private socket: SocketLike | undefined;
  private pending: WireEvent[] = [];
  private groupTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private stopped = false;
  /** The last seq seen: an event's seq, or the server's cursor frames. */
  lastSeq: number | undefined;

  constructor(private readonly options: EventClientOptions) {}

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.clear(this.reconnectTimer);
    this.clear(this.groupTimer);
    this.socket?.close(1000, "bye");
    this.socket = undefined;
  }

  /** The delay before reconnect attempt n: doubles from 500 ms to 30 s, ±25% jitter. */
  backoffMs(attempt: number): number {
    const min = this.options.minBackoffMs ?? 500;
    const max = this.options.maxBackoffMs ?? 30_000;
    const base = Math.min(max, min * 2 ** Math.max(0, attempt - 1));
    const jitter = 1 + ((this.options.random ?? Math.random)() * 2 - 1) * 0.25;
    return Math.round(Math.min(max, base * jitter));
  }

  private open(): void {
    const url =
      this.lastSeq === undefined
        ? this.options.url
        : `${this.options.url}${this.options.url.includes("?") ? "&" : "?"}after=${this.lastSeq}`;
    const socket = this.options.connect(url);
    this.socket = socket;
    socket.onopen = () => {
      this.attempts = 0;
    };
    socket.onmessage = (ev) => this.handle(String(ev.data));
    socket.onclose = () => this.scheduleReconnect();
    socket.onerror = () => {
      /* onclose follows */
    };
  }

  private handle(data: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      typeof frame["type"] === "string" &&
      typeof frame["seq"] === "number" &&
      typeof frame["id"] === "string"
    ) {
      const event = frame as unknown as WireEvent;
      this.lastSeq = Math.max(this.lastSeq ?? 0, event.seq);
      this.pending.push(event);
      this.groupTimer ??= (this.options.setTimeout ?? setTimeout)(
        () => this.flush(),
        this.options.groupMs ?? 250,
      );
      return;
    }
    switch (frame["type"]) {
      case "hello": {
        const seq = typeof frame["seq"] === "number" ? frame["seq"] : 0;
        if (this.lastSeq === undefined) this.lastSeq = seq;
        this.options.onHello?.({ server_time: String(frame["server_time"]), seq });
        return;
      }
      case "caught_up":
        if (typeof frame["seq"] === "number")
          this.lastSeq = Math.max(this.lastSeq ?? 0, frame["seq"]);
        return;
      case "refetch":
        this.pending = [];
        this.options.onFullRefetch();
        return;
      case "reconnect":
        this.socket?.close(1000, "reconnect");
        return;
      default:
        return;
    }
  }

  private flush(): void {
    this.groupTimer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (batch.length > 0) this.options.onRefetch(batch);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.attempts += 1;
    this.reconnectTimer = (this.options.setTimeout ?? setTimeout)(
      () => this.open(),
      this.backoffMs(this.attempts),
    );
  }

  private clear(timer: ReturnType<typeof setTimeout> | undefined): void {
    if (timer !== undefined) (this.options.clearTimeout ?? clearTimeout)(timer);
  }
}
