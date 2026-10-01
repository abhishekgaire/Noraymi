import { describe, expect, it } from "vitest";
import { smsKeyword } from "./sms-keywords.js";

describe("opt-out and help wording (M2-23)", () => {
  it.each([
    "STOP",
    "stop",
    " Stop. ",
    "STOPALL",
    "UNSUBSCRIBE",
    "CANCEL",
    "END",
    "QUIT",
    "opt out",
    "please stop texting me",
    "Stop texting me!",
    "stop sending me texts",
    "pls stop messaging me",
    "don't text me anymore",
    "do not text me",
    "unsubscribe me",
    "remove me from your list",
    "take me off your list",
  ])("%j is an opt-out", (body) => {
    expect(smsKeyword(body)).toBe("stop");
  });

  it.each([
    "running 15 late",
    "can we bring a cake?",
    "cancel my booking for saturday",
    "we'll stop by at 10",
    "the music stopped in room 9",
    "end time is 11?",
    "don't stop the music",
    "",
  ])("%j is not", (body) => {
    expect(smsKeyword(body)).toBeNull();
  });

  it.each(["HELP", "help", "Help?", "INFO"])("%j asks for help", (body) => {
    expect(smsKeyword(body)).toBe("help");
  });
});
