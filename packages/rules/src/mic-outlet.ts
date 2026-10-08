/**
 * The mic power trial (M8-23; spec 11 · Mic power trial; D83). Our own
 * switched outlet on one room's wireless-mic receiver, never the song player.
 *
 * The server's side: on while the trial room has an open session (from
 * check-in until close-out; cleaning comes after close-out), off otherwise.
 *
 * The outlet's side (what its firmware must do, and what the emulated outlet
 * in our tests does): it powers OFF only while it holds a fresh, signed off
 * command from us. A command it can't verify, one for another outlet, one no
 * newer than the last it accepted, or one past its time to live is ignored,
 * and with no fresh command it powers ON, so an outage never silences a room.
 */
export type MicPower = "on" | "off";
export type MicReason = "session_open" | "no_session" | "trial_off";

/** How long a command holds (cautious default: a minute, so a lost server means mics back within one). */
export const MIC_COMMAND_TTL_MS = 60_000;
/** How often the outlet asks: four times a command's life, so one lost answer never lets it lapse. */
export const MIC_POLL_MS = 15_000;

/** What the server tells the outlet. */
export function micDesired(args: {
  /** The room the venue's trial flag names, or null when the trial is off. */
  readonly trialRoomId: string | null;
  /** The room the outlet is paired to. */
  readonly outletRoomId: string | null;
  readonly sessionOpen: boolean;
}): { readonly state: MicPower; readonly reason: MicReason } {
  // Trial off (or the outlet isn't the trial room's): leave the mics on, as without us.
  if (!args.trialRoomId || args.outletRoomId !== args.trialRoomId)
    return { state: "on", reason: "trial_off" };
  return args.sessionOpen
    ? { state: "on", reason: "session_open" }
    : { state: "off", reason: "no_session" };
}

export interface MicCommand {
  readonly deviceId: string;
  readonly state: MicPower;
  readonly issuedAtMs: number;
  readonly ttlMs: number;
}

/** The exact bytes the server signs and the outlet verifies. */
export function micCommandSigningString(c: MicCommand): string {
  return ["west4-mic-outlet-v1", c.deviceId, c.state, String(c.issuedAtMs), String(c.ttlMs)].join(
    "\n",
  );
}

/** What the outlet keeps: the last command it accepted, and when it got it by its own clock. */
export interface OutletMemory {
  readonly command: MicCommand;
  readonly receivedAtMs: number;
}

export type CommandRejection = "bad_signature" | "other_outlet" | "replayed" | "ttl_too_long";

/** The outlet taking a command: the new memory, or why it ignored it (keeping the old). */
export function acceptMicCommand(
  memory: OutletMemory | null,
  command: MicCommand,
  args: { readonly deviceId: string; readonly signatureValid: boolean; readonly nowMs: number },
): { readonly memory: OutletMemory | null; readonly rejected?: CommandRejection } {
  if (!args.signatureValid) return { memory, rejected: "bad_signature" };
  if (command.deviceId !== args.deviceId) return { memory, rejected: "other_outlet" };
  if (command.ttlMs <= 0 || command.ttlMs > MIC_COMMAND_TTL_MS)
    return { memory, rejected: "ttl_too_long" };
  if (memory && command.issuedAtMs <= memory.command.issuedAtMs)
    return { memory, rejected: "replayed" };
  return { memory: { command, receivedAtMs: args.nowMs } };
}

/** The outlet's power now: off only on a fresh off command; on otherwise. */
export function outletPower(memory: OutletMemory | null, nowMs: number): MicPower {
  if (!memory || memory.command.state !== "off") return "on";
  const age = nowMs - memory.receivedAtMs;
  return age >= 0 && age < memory.command.ttlMs ? "off" : "on";
}
