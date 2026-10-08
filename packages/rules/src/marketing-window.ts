import type { Temporal } from "@west4/shared";

/**
 * When a marketing text may go (M8-22; spec 11 · Consent and timing): only
 * between 8 AM and 9 PM in the recipient's time zone, taken from the area
 * code and checked against the venue's, which is how the TCPA and GBL §399-z
 * measure it. An area code that spans zones counts every zone it spans, and
 * the send must fit the window in all of them and in the venue's zone too. An
 * area code we can't place is refused: the cautious answer.
 */
export const MARKETING_FROM = "08:00";
export const MARKETING_UNTIL = "21:00";

const E = "America/New_York";
const C = "America/Chicago";
const M = "America/Denver";
const AZ = "America/Phoenix";
const P = "America/Los_Angeles";
const AK = ["America/Anchorage", "America/Adak"];
const HI = "Pacific/Honolulu";
const AST = "America/Puerto_Rico";

/** US area codes (NANP, +1) by the zone or zones their numbers sit in. */
const ZONES: ReadonlyArray<readonly [string, readonly string[]]> = [
  // Eastern only
  [
    "201 202 203 207 212 215 216 220 223 227 229 234 239 240 248 252 260 267 272 276 283 301 302 304 305 313 315 317 321 324 326 330 332 336 339 347 351 352 363 380 386 401 404 407 410 412 413 419 434 436 440 443 445 463 470 472 475 478 484 502 508 513 516 517 518 540 551 561 567 570 571 582 585 586 603 606 607 609 610 614 616 617 631 640 645 646 656 667 678 679 680 681 686 689 703 704 706 716 717 718 724 727 728 732 734 740 743 754 757 762 765 770 771 772 774 781 786 802 803 804 810 813 814 826 828 835 838 839 843 845 848 854 856 857 859 860 862 863 864 865 878 904 908 910 912 914 917 919 929 934 937 941 943 947 948 954 959 973 978 980 984 989",
    [E],
  ],
  // Eastern and Central (state lines and split counties)
  ["270 364 334 423 448 574 812 850 906 930 931", [E, C]],
  // Central only
  [
    "205 210 214 217 218 219 224 225 228 251 254 256 262 274 281 309 312 314 316 318 319 320 325 327 331 337 346 353 361 409 414 417 430 447 464 469 479 501 504 507 512 515 534 539 557 563 572 573 580 601 608 612 615 618 629 630 636 641 651 659 660 662 682 708 712 713 715 726 730 731 737 763 769 773 779 815 816 817 830 832 847 861 870 872 901 903 913 918 920 936 938 940 945 952 956 972 975 979 985",
    [C],
  ],
  // Central and Mountain
  ["308 432 605 620 701 785", [C, M]],
  // Mountain only
  ["303 307 385 406 435 505 575 719 720 801 915 970 983", [M]],
  // Arizona (no daylight saving; the Navajo Nation keeps it)
  ["480 520 602 623", [AZ]],
  ["928", [AZ, M]],
  // Mountain and Pacific
  ["208 458 541 775 986", [M, P]],
  // Pacific only
  [
    "206 209 213 253 279 310 323 341 350 360 369 408 415 424 425 442 503 509 510 530 559 562 564 619 626 628 650 657 661 669 702 707 714 725 747 760 805 818 820 831 840 858 909 916 925 949 951 971",
    [P],
  ],
  ["907", AK],
  ["808", [HI]],
  ["340 787 939", [AST]],
];

const BY_CODE: ReadonlyMap<string, readonly string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const [codes, zones] of ZONES)
    for (const code of codes.split(" ")) {
      map.set(code, [...new Set([...(map.get(code) ?? []), ...zones])]);
    }
  return map;
})();

/** The zones a +1 number's area code spans, or null when we can't place it. */
export function recipientZones(phoneE164: string): readonly string[] | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(phoneE164);
  return m ? (BY_CODE.get(m[1]!) ?? null) : null;
}

export type MarketingWindowCheck =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "unknown_area" | "outside_hours";
      readonly zone?: string;
    };

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether a marketing text to `phoneE164` may go at `now` from a venue in `venueTimeZone`. */
export function marketingWindow(
  now: Temporal.Instant,
  phoneE164: string,
  venueTimeZone: string,
): MarketingWindowCheck {
  const zones = recipientZones(phoneE164);
  if (!zones) return { ok: false, reason: "unknown_area" };
  const from = minutes(MARKETING_FROM);
  const until = minutes(MARKETING_UNTIL);
  for (const zone of [...zones, venueTimeZone]) {
    const local = now.toZonedDateTimeISO(zone);
    const at = local.hour * 60 + local.minute;
    if (at < from || at >= until) return { ok: false, reason: "outside_hours", zone };
  }
  return { ok: true };
}
