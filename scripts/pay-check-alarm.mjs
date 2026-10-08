#!/usr/bin/env node
// M8-19: the payment page check's result as an alarm-shaped message for the
// pages topic (.github/workflows/pay-page-check.yml). The API's alarm hook
// reads AlarmName, NewStateValue and "rule:<id>" in AlarmDescription
// (apps/api/src/ops/sns.ts · readAlarm): ALARM opens the pay-page-check page,
// OK clears it. Usage: node scripts/pay-check-alarm.mjs ALARM|OK <run url>
const [state, runUrl = ""] = process.argv.slice(2);
if (state !== "ALARM" && state !== "OK") {
  console.error("usage: pay-check-alarm.mjs ALARM|OK <run url>");
  process.exit(2);
}
process.stdout.write(
  JSON.stringify({
    AlarmName: "pay-page-check",
    AlarmDescription:
      `rule:pay-page-check The payment page's scripts or headers changed. ${runUrl}`.trim(),
    NewStateValue: state,
    NewStateReason:
      state === "ALARM" ? "The payment page check failed" : "The payment page check passed",
  }),
);
