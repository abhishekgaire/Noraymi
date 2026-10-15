import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiCallError, api, setManagerPinPrompt, type ManagerPinAsk } from "./api.js";
import { firstApprover } from "./approvals/PinApproval.js";

/**
 * U-08: with approvals by a manager's PIN at the register, a write that answers approval_pending
 * opens the dialog where it was asked; the screen then gets what was decided.
 */
const pending = {
  status: "approval_pending",
  approval_id: "a1",
  waiting_for: { user_id: "andy", name: "Andy C." },
  decided_with: "pin",
};
const answering = (body: unknown) =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(body), { status: 202 })),
  );
const path = "/v1/venues/v1/checks/c1/lines/7/void";

afterEach(() => {
  setManagerPinPrompt(null);
  vi.unstubAllGlobals();
});

describe("the manager's PIN where the approval is asked (U-08)", () => {
  it("approved: the screen gets it as done, with nobody to wait for", async () => {
    answering(pending);
    const asked: ManagerPinAsk[] = [];
    setManagerPinPrompt(async (ask) => {
      asked.push(ask);
      return { status: "approved", message: "Approved by Andy C." };
    });
    await expect(api("POST", path, { reason: "x", made: false })).resolves.toMatchObject({
      status: "approved",
      approval_id: "a1",
      waiting_for: null,
    });
    expect(asked).toEqual([{ venueId: "v1", approvalId: "a1", routedTo: "andy" }]);
  });

  it("declined: the call is refused in the staff's words", async () => {
    answering(pending);
    setManagerPinPrompt(async () => ({ status: "declined", message: "Declined by Andy C." }));
    const err = await api("POST", path, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiCallError);
    expect(err).toMatchObject({ code: "approval_declined", message: "Declined by Andy C." });
  });

  it("Later: the answer is unchanged, still pending", async () => {
    answering(pending);
    setManagerPinPrompt(async () => null);
    await expect(api("POST", path, {})).resolves.toEqual(pending);
  });

  it("phone approvals and reads never open it", async () => {
    const prompt = vi.fn(async () => null);
    setManagerPinPrompt(prompt);
    answering({ ...pending, decided_with: "phone" });
    await api("POST", path, {});
    answering(pending);
    await api("GET", "/v1/venues/v1/approvals");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("one level down (a fault's pause): rewritten in place", async () => {
    answering({ fault_id: "f1", pause: pending });
    setManagerPinPrompt(async () => ({ status: "approved", message: "" }));
    await expect(api("POST", "/v1/venues/v1/rooms/r9/faults", {})).resolves.toMatchObject({
      fault_id: "f1",
      pause: { status: "approved", waiting_for: null },
    });
  });

  it("picks the manager on the clock: the routed one if on it, else anyone on it, else the first", () => {
    const abhishek = { user_id: "abhishek", name: "Abhishek G.", on_clock: false };
    const andy = { user_id: "andy", name: "Andy C.", on_clock: true };
    const sam = { user_id: "sam", name: "Sam K.", on_clock: true };
    expect(firstApprover([abhishek, andy], "abhishek")).toBe("andy");
    expect(firstApprover([abhishek, andy, sam], "sam")).toBe("sam");
    expect(firstApprover([abhishek, { ...andy, on_clock: false }], null)).toBe("abhishek");
    expect(firstApprover([], null)).toBe("");
  });
});
