import { demoBadgeUid, encodeSun, tagFileReadKey, venueBadgeKeys } from "@west4/db";

/**
 * A fake NTAG 424 DNA badge for tests and the demo (M1-25): it holds the keys
 * a real tag would be personalised with, derived the same way the server
 * derives them, and answers each "tap" with a fresh SUN message and a higher
 * read counter. M1-30's fake reader drives these for the desktop app.
 */

/** What the reader hands the API: the tag's two URL parameters. */
export interface BadgeTap {
  readonly picc_data: string;
  readonly cmac: string;
}

const wire = (sun: { piccData: string; cmac: string }): BadgeTap => ({
  picc_data: sun.piccData,
  cmac: sun.cmac,
});

export class FakeBadge {
  counter = 0;
  readonly uid: Buffer;
  private readonly metaRead: Buffer;
  private readonly fileRead: Buffer;

  constructor(args: {
    secret: Buffer;
    venueId: string;
    uid?: Buffer;
    badgeId?: string;
    keyVersion?: number;
  }) {
    this.uid = args.uid ?? demoBadgeUid(args.badgeId ?? "badge");
    const keys = venueBadgeKeys(args.secret, args.venueId, args.keyVersion ?? 1);
    this.metaRead = keys.metaRead;
    this.fileRead = tagFileReadKey(keys.master, this.uid);
  }

  /** One read: the counter goes up and the tag answers. */
  tap(): BadgeTap {
    this.counter += 1;
    return wire(
      encodeSun({
        metaRead: this.metaRead,
        fileRead: this.fileRead,
        uid: this.uid,
        counter: this.counter,
      }),
    );
  }

  /** A cloned tag: the right UID and counter under another tag's key. */
  static copyOf(badge: FakeBadge, otherKey: Buffer): BadgeTap {
    return wire(
      encodeSun({
        metaRead: badge.metaRead,
        fileRead: otherKey,
        uid: badge.uid,
        counter: badge.counter + 1,
      }),
    );
  }
}
