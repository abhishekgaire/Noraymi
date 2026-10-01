import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { routeApproval } from "./approvals.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const moneyCases = JSON.parse(
  readFileSync(path.resolve(here, "../../../seed/money-cases.json"), "utf8"),
) as {
  cases: {
    id: string;
    group: string;
    inputs: { requester: string; manager_on_duty: string; owner: string };
    expected: { routed_to: string };
  }[];
};

const people = {
  abhishek: "owner",
  andy: "manager",
  maya: "bartender",
  diego: "front_desk",
} as const;
const roster = Object.entries(people).map(([id, role]) => ({ id, role }));

/** M2-15 (spec 02 · Approvals), written before the code. */
describe("routeApproval · the seed's approvals group", () => {
  const group = moneyCases.cases.filter((c) => c.group === "approvals");
  it("has the 3 cases", () => expect(group).toHaveLength(3));
  for (const c of group) {
    it(c.id, () => {
      expect(
        routeApproval({
          requester: c.inputs.requester,
          managerOnDuty: c.inputs.manager_on_duty,
          people: roster,
        }),
      ).toBe(c.expected.routed_to);
    });
  }
});

describe("routeApproval", () => {
  it("the owner's own requests go to a manager", () => {
    expect(routeApproval({ requester: "abhishek", managerOnDuty: "andy", people: roster })).toBe(
      "andy",
    );
    expect(routeApproval({ requester: "abhishek", managerOnDuty: null, people: roster })).toBe(
      "andy",
    );
  });
  it("with nobody on duty, staff requests go to a manager, then the owner", () => {
    expect(routeApproval({ requester: "diego", managerOnDuty: null, people: roster })).toBe("andy");
    expect(
      routeApproval({
        requester: "diego",
        managerOnDuty: null,
        people: roster.filter((p) => p.id !== "andy"),
      }),
    ).toBe("abhishek");
  });
  it("the manager on duty's own requests go to another manager before the owner", () => {
    const two = [...roster, { id: "kai", role: "manager" }];
    expect(routeApproval({ requester: "andy", managerOnDuty: "andy", people: two })).toBe("kai");
  });
  it("nobody approves their own request: with no one else, there's no approver", () => {
    expect(
      routeApproval({
        requester: "abhishek",
        managerOnDuty: null,
        people: [{ id: "abhishek", role: "owner" }],
      }),
    ).toBeNull();
  });
});
