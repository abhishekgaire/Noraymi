/**
 * Where an approval goes (M2-15; spec 02 · Approvals). To the manager on
 * duty. The manager on duty's own requests go to another manager or the
 * owner (Andy's go to Abhishek); the owner's go to a manager. Nobody
 * approves their own request.
 */
export interface Person {
  readonly id: string;
  readonly role: string;
}

export function routeApproval(input: {
  readonly requester: string;
  readonly managerOnDuty: string | null;
  readonly people: readonly Person[];
}): string | null {
  const others = input.people.filter((p) => p.id !== input.requester);
  const managers = others.filter((p) => p.role === "manager");
  const owners = others.filter((p) => p.role === "owner");
  if (input.managerOnDuty && input.managerOnDuty !== input.requester) return input.managerOnDuty;
  const requester = input.people.find((p) => p.id === input.requester);
  if (requester?.role === "owner") return managers[0]?.id ?? owners[0]?.id ?? null;
  // The manager on duty asking, or nobody on duty: another manager, then the owner.
  return managers[0]?.id ?? owners[0]?.id ?? null;
}
