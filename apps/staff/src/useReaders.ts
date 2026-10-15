import { useEffect, useState } from "react";
import { api } from "./api.js";
import { readDevice } from "./device.js";

/**
 * The venue's registered Stripe readers, this screen's station first (U-01; spec 07 · What staff see
 * during a card payment). `readers` is null while loading; a venue with none (Sing Sing, the outside
 * card machine) gets an empty list, and the paying screens then show no reader panel at all.
 */
export interface StationReader {
  readonly id: string;
  readonly label: string;
  readonly registered: boolean;
  readonly online: boolean;
  readonly station: "bar" | "front_desk";
}

export interface ReaderList {
  readonly readers: readonly StationReader[] | null;
  readonly failed: boolean;
}

/** `given`: a list the screen already read, so it isn't read twice. */
export function useReaders(venueId: string, given?: ReaderList): ReaderList {
  const [readers, setReaders] = useState<readonly StationReader[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (given || !venueId) return;
    let live = true;
    void (async () => {
      const [list, device] = await Promise.all([
        api<{ readers: StationReader[] }>("GET", `/v1/venues/${venueId}/readers`),
        readDevice().catch(() => null),
      ]);
      const mine = device?.kind === "bar_computer" ? "bar" : "front_desk";
      if (live)
        setReaders(
          list.readers
            .filter((r) => r.registered)
            .sort((a, b) => Number(b.station === mine) - Number(a.station === mine)),
        );
    })().catch(() => {
      if (live) setFailed(true);
    });
    return () => {
      live = false;
    };
  }, [venueId, given]);
  return given ?? { readers, failed };
}

/**
 * Whether to offer the reader: once the list has readers, or couldn't be read (the reader panel then
 * says so). Not while it loads, so a reader button never shows and then vanishes where there are none.
 */
export const hasReaders = (r: ReaderList) =>
  r.failed || (r.readers !== null && r.readers.length > 0);
