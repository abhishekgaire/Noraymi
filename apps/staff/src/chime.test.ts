import { describe, expect, it, vi } from "vitest";
import type { SocketLike } from "@west4/shared";
import { chimeDecision, muteChime, startRingWatch } from "./chime.js";

class FakeSocket implements SocketLike {
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  closed = false;
  constructor(readonly url: string) {}
  send(): void {}
  close(): void {
    this.closed = true;
  }
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

const order = (id: string, placedMs: number) => ({
  id,
  placed_at: new Date(placedMs).toISOString(),
});

describe("the bar's chime", () => {
  it("chimes for a new order, not again for the same one, and once a minute while one has waited 2 minutes", () => {
    const state = { heard: new Set<string>(), lastRepeat: 0 };
    const t0 = Date.parse("2026-09-25T22:41:00-04:00");
    expect(chimeDecision([order("o1", t0)], state, t0)).toBe(true);
    expect(chimeDecision([order("o1", t0)], state, t0 + 5_000)).toBe(false);
    expect(chimeDecision([order("o1", t0)], state, t0 + 120_000)).toBe(true);
    expect(chimeDecision([order("o1", t0)], state, t0 + 150_000)).toBe(false);
    expect(chimeDecision([order("o1", t0)], state, t0 + 180_000)).toBe(true);
  });

  it("Mute silences it for 60 seconds", () => {
    const state = { heard: new Set<string>(), lastRepeat: 0 };
    const t0 = Date.now();
    muteChime(60, t0);
    expect(chimeDecision([order("o9", t0)], state, t0 + 1_000)).toBe(false);
    expect(chimeDecision([order("o9", t0), order("o10", t0)], state, t0 + 61_000)).toBe(true);
  });
});

describe("the bar rings on the live channel (M8-18)", () => {
  it("a ringing or asked-to-wait order checks at once, without waiting for the 5-second poll", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let checks = 0;
    const stop = startRingWatch({
      url: "ws://bar/v1/venues/v/events?locked=1",
      connect: (u) => {
        const s = new FakeSocket(u);
        sockets.push(s);
        return s;
      },
      onRing: () => (checks += 1),
    });
    const s = sockets[0]!;
    expect(s.url).toBe("ws://bar/v1/venues/v/events?locked=1");
    s.onopen?.({});
    s.receive({ type: "hello", server_time: "2026-09-25T22:41:00-04:00", seq: 10 });
    s.receive({ seq: 11, type: "room.call", id: "c1", entity_version: 0, at: "x" });
    vi.advanceTimersByTime(0);
    expect(checks).toBe(0);
    s.receive({ seq: 12, type: "order.ringing", id: "o1", entity_version: 0, at: "x" });
    vi.advanceTimersByTime(0);
    expect(checks).toBe(1);
    s.receive({ seq: 13, type: "order.held", id: "o2", entity_version: 0, at: "x" });
    vi.advanceTimersByTime(0);
    expect(checks).toBe(2);
    // The channel lost its place: check everything.
    s.receive({ type: "refetch" });
    vi.advanceTimersByTime(0);
    expect(checks).toBe(3);
    stop();
    expect(s.closed).toBe(true);
    vi.useRealTimers();
  });
});
