import { Temporal } from "@west4/shared";

/**
 * The monthly failover test (M8-02; spec 09 · Router: "Its failover is tested
 * every month"). Due a calendar month after the last test's business date,
 * and at once when there's never been one.
 */
export function failoverDue(
  lastBusinessDate: string | null,
  today: Temporal.PlainDate,
): { readonly due: boolean; readonly dueOn: string | null } {
  if (lastBusinessDate === null) return { due: true, dueOn: null };
  const dueOn = Temporal.PlainDate.from(lastBusinessDate).add({ months: 1 });
  return { due: Temporal.PlainDate.compare(today, dueOn) >= 0, dueOn: dueOn.toString() };
}
