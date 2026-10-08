# Mic power trial, one room (M8-23, K1)

Until Playbox signs an agreement, nothing stops a party singing after close-out. The trial puts **our own** switched outlet on **one** room's wireless-mic receiver: on from check-in, off from close-out (cleaning comes after it). It's off by default and is not part of the go-live gate; M8-24 doesn't wait for it.

**Never:** plug the song player, its screen or anything of Playbox's into the outlet; open, probe or reverse-engineer Playbox's equipment or software.

## Before it starts (both required)

- [ ] **West 4's written approval** of the trial, naming the room. Keep the email or signed note.
- [ ] **Playbox's answer** on whether an outlet on the mic receiver affects their equipment warranty. If it does, or they don't answer, the trial doesn't start.

## The outlet

Pick one only if it does all of these (ask the maker in writing):

- It powers **on** by itself when it loses contact with us or loses power, and on start-up.
- It switches **off** only on a command signed with our key (Ed25519), which it pins once at pairing from `GET /v1/devices/mic-outlet/key`, and only while the command is fresh: it drops any command older than the last it took, for another outlet, or past its time to live (60 seconds).
- It asks `POST /v1/devices/mic-outlet/command` about every 15 seconds and sends heartbeats like any device, both signed with its own device key.
- It is rated for the mic receiver's power draw (read the receiver's label; don't guess).

The rule its firmware must follow is in `packages/rules/src/mic-outlet.ts` (`acceptMicCommand`, `outletPower`), and the emulated outlet in `apps/api/src/devices/mic-outlet.int.test.ts` runs it against our API.

## Set it up

1. Pair the outlet in Admin → Printers & devices as a **Mic power outlet**, assigned to the trial room. It shows online like any device.
2. Plug the room's mic receiver, and nothing else, into it.
3. Turn the trial on for that room: the `rooms` setting's `micPowerTrialRoomId` set to the room's id (through Save and publish; there is no screen for it). Clearing it ends the trial, and the outlet is told "on" from then on.

## Checks on the first night (a manager, with the room empty)

- [ ] Room free: within 15 seconds the mics go dead.
- [ ] Check a party in: the mics come back within 15 seconds.
- [ ] Close the room out: the mics go dead.
- [ ] Unplug the venue's internet (or the outlet's network): within about a minute the mics come back on by themselves.
- [ ] The song player never lost power at any point.

## The trial log

Every change in what we tell the outlet is a row in `mic_outlet_switches` (on or off, and why: `session_open`, `no_session`, `trial_off`), next to the device's heartbeats. Note any complaint from guests or staff with its time so it can be matched to the log.
