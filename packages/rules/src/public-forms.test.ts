import { describe, expect, it } from "vitest";
import { PUBLIC_FORM_DEFAULTS } from "@west4/shared";
import { dailyLimitHit, formLimits } from "./public-forms.js";

// The public forms' daily limits (M2-27, D109): counts are today's uses before this one.
const waitlist = { perPhone: 3, perIp: 50, perDevice: 5 };

describe("the public forms' daily limits", () => {
  it("the defaults: waitlist 3 a phone, 5 a device, 50 an IP; phone codes 5, 10 and 30", () => {
    expect(PUBLIC_FORM_DEFAULTS.waitlist).toEqual(waitlist);
    expect(PUBLIC_FORM_DEFAULTS.phoneCode).toEqual({ perPhone: 5, perIp: 30, perDevice: 10 });
  });

  it("a form the venue hasn't set reads its default; a set one reads the venue's", () => {
    expect(formLimits(null, "waitlist")).toEqual(waitlist);
    expect(formLimits({}, "phoneCode")).toEqual(PUBLIC_FORM_DEFAULTS.phoneCode);
    const own = { perPhone: 1, perIp: 2, perDevice: 3 };
    expect(formLimits({ waitlist: own }, "waitlist")).toEqual(own);
    expect(formLimits({ waitlist: own }, "phoneCode")).toEqual(PUBLIC_FORM_DEFAULTS.phoneCode);
  });

  it("each limit at its edge: the last allowed use passes, the next is refused", () => {
    expect(dailyLimitHit({ phone: 2, ip: 0, device: 0 }, waitlist)).toBeNull();
    expect(dailyLimitHit({ phone: 3, ip: 0, device: 0 }, waitlist)).toBe("phone");
    expect(dailyLimitHit({ phone: 0, ip: 0, device: 4 }, waitlist)).toBeNull();
    expect(dailyLimitHit({ phone: 0, ip: 0, device: 5 }, waitlist)).toBe("device");
    expect(dailyLimitHit({ phone: 0, ip: 49, device: 0 }, waitlist)).toBeNull();
    expect(dailyLimitHit({ phone: 0, ip: 50, device: 0 }, waitlist)).toBe("ip");
  });

  it("the phone's limit is named first, then the device's, then the IP address's", () => {
    expect(dailyLimitHit({ phone: 3, ip: 50, device: 5 }, waitlist)).toBe("phone");
    expect(dailyLimitHit({ phone: 0, ip: 50, device: 5 }, waitlist)).toBe("device");
  });

  it("what the request can't name is never over: no phone yet, no device cookie", () => {
    expect(dailyLimitHit({ phone: null, ip: 0, device: null }, waitlist)).toBeNull();
    expect(dailyLimitHit({ phone: null, ip: 50, device: null }, waitlist)).toBe("ip");
  });
});
