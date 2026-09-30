import { describe, expect, it, vi } from "vitest";
import { EventClient, type SocketLike } from "./events-client.js";

class FakeSocket implements SocketLike {
  static last: FakeSocket | undefined;
  static urls: string[] = [];
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  sent: string[] = [];
  closed = false;
  constructor(readonly url: string) {
    FakeSocket.last = this;
    FakeSocket.urls.push(url);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.onclose?.({});
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

describe("EventClient", () => {
  it("groups refetches for 250 ms and remembers the last seq", () => {
    vi.useFakeTimers();
    const refetches: unknown[] = [];
    const client = new EventClient({
      url: "ws://x/v1/venues/v/events",
      connect: (u) => new FakeSocket(u),
      onRefetch: (b) => refetches.push(b),
      onFullRefetch: () => {},
    });
    client.start();
    const s = FakeSocket.last!;
    s.onopen?.({});
    s.receive({ type: "hello", server_time: "2026-09-25T22:41:00-04:00", seq: 10 });
    s.receive({ seq: 11, type: "order.ringing", id: "o1", entity_version: 1, at: "x" });
    s.receive({ seq: 12, type: "order.ringing", id: "o2", entity_version: 1, at: "x" });
    expect(refetches).toHaveLength(0);
    vi.advanceTimersByTime(249);
    expect(refetches).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(refetches).toHaveLength(1);
    expect((refetches[0] as unknown[]).length).toBe(2);
    expect(client.lastSeq).toBe(12);
    // A reconnect asks for what it missed, and a refetch frame reloads everything.
    let full = 0;
    const c2 = new EventClient({
      url: "ws://x/e",
      connect: (u) => new FakeSocket(u),
      onRefetch: () => {},
      onFullRefetch: () => (full += 1),
      random: () => 0.5,
    });
    c2.start();
    FakeSocket.last!.receive({ type: "hello", server_time: "t", seq: 5 });
    FakeSocket.last!.close();
    vi.advanceTimersByTime(600);
    expect(FakeSocket.urls[FakeSocket.urls.length - 1]).toBe("ws://x/e?after=5");
    FakeSocket.last!.receive({ type: "refetch" });
    expect(full).toBe(1);
    client.stop();
    c2.stop();
    vi.useRealTimers();
  });

  it("backs off reconnects with jitter, from 500 ms up to 30 s", () => {
    const client = new EventClient({
      url: "ws://x",
      connect: (u) => new FakeSocket(u),
      onRefetch: () => {},
      onFullRefetch: () => {},
      random: () => 0.5,
    });
    expect(client.backoffMs(1)).toBe(500);
    expect(client.backoffMs(2)).toBe(1000);
    expect(client.backoffMs(7)).toBe(30_000);
    const jittered = new EventClient({
      url: "ws://x",
      connect: (u) => new FakeSocket(u),
      onRefetch: () => {},
      onFullRefetch: () => {},
      random: () => 0,
    });
    expect(jittered.backoffMs(1)).toBe(375);
    const high = new EventClient({
      url: "ws://x",
      connect: (u) => new FakeSocket(u),
      onRefetch: () => {},
      onFullRefetch: () => {},
      random: () => 1,
    });
    expect(high.backoffMs(1)).toBe(625);
  });
});
