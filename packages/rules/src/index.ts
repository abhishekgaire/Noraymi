// Pure money and time rules, tested against seed/money-cases.json.
export { Temporal } from "@west4/shared";
export { businessDate, nextBusinessDate, wallClock, parseCutover } from "./time.js";
export type { BusinessDateResult } from "./time.js";
export { openBusinessDate, postingBusinessDate, latePosting } from "./posting.js";
export type { LatePosting } from "./posting.js";
export {
  checkSetting,
  checkHours,
  checkPay,
  checkLanguages,
  checkSafety,
  checkDeposit,
  checkPos,
  checkTabs,
  checkBarMode,
  IN_PERSON_CARD_COST_PCT,
} from "./settings-checks.js";
export type { CheckContext } from "./settings-checks.js";
export { hoursFor, openNow } from "./hours.js";
export { googleHours } from "./google-hours.js";
export type { GoogleHours } from "./google-hours.js";
export type { Closure, VenueTime, BusinessDateHours } from "./hours.js";
export { roomTime, roomTimeBetween } from "./room-time.js";
export type { Segment, RoomTime } from "./room-time.js";
export { hourlyRateAt, hourlyCentsFor, minGuestsOn, billableGuestsOn } from "./rates.js";
export type { HourlyRate, RateKind, RoomForRate, VenueTime as RateVenueTime } from "./rates.js";
export { tabSoFar } from "./tab.js";
export type { TabLine, SessionSoFar, TabSoFar } from "./tab.js";
export { deposit } from "./deposit.js";
export type { Deposit } from "./deposit.js";
export { roundToStep } from "./room-time.js";
export type { BillingStep } from "./room-time.js";
export { bandAt, rateAt, bandBoundaries, segmentsFor } from "./bands.js";
export type { Band, Billing, BandChoice, SessionSegment, SessionEvent } from "./bands.js";
export {
  assignmentOrder,
  bookingSpan,
  canExtend,
  chooseRoom,
  freeRoomsFor,
  freeUntil,
} from "./assignment.js";
export type { AssignmentRefusal, BlockSpan, RoomForAssignment } from "./assignment.js";
export { bookingGrid, resolveStart, zoneName, GRID_STEP_MIN } from "./booking-grid.js";
export { cutoffWords, refundCutoffAt } from "./booking-cutoff.js";
export { changedCutoff, depositChange } from "./deposit-change.js";
export type { DepositChange } from "./deposit-change.js";
export { cancelOutcome, noShowOutcome } from "./cancel-outcome.js";
export type { LateCancel, NoShow } from "./cancel-outcome.js";
export type { GridSlot, StartRefusal } from "./booking-grid.js";
export { sessionClock, STAY_ON_STOPS_BEFORE_CLOSE_MIN } from "./session-clock.js";
export type { ClockSegment, SessionClock, Tile } from "./session-clock.js";
export { compMinutesCents, reasonOnly } from "./reason-only.js";
export type { ReasonOnlyAnswer, ReasonOnlyLimits } from "./reason-only.js";
export { routeApproval } from "./approvals.js";
export type { Person as ApprovalPerson } from "./approvals.js";
export { smsKeyword } from "./sms-keywords.js";
export { alcoholStateAt, alcoholWindow, clearOutDue, windowClose } from "./alcohol-window.js";
export type { AlcoholVenue, AlcoholWindow } from "./alcohol-window.js";
export { promotionChecks } from "./promotions.js";
export type {
  Promotable,
  PromoMenu,
  PromoMenuItem,
  PromotionRefusal,
  PromotionRefusalCode,
} from "./promotions.js";
export { orderStep, pickUpStep, ORDER_STATUSES, ORDER_STEPS } from "./orders.js";
export type { OrderStatus, OrderStep, PickUpResult, StepResult } from "./orders.js";
export * from "./check-totals.js";
export * from "./package-lines.js";
export * from "./cash.js";
export * from "./site.js";
export * from "./policy.js";
export * from "./quote.js";
export * from "./tips.js";
export * from "./hold-expiry.js";
export * from "./hold.js";
export * from "./song-queue.js";
export { shiftMinutes, splitShifts, dutiesFor, DUTIES, PUNCH_KINDS } from "./shifts.js";
export type { Duty, Punch, PunchKind, ShiftMinutes } from "./shifts.js";
export { zReportGratuity } from "./z-report.js";
export type { ZCheck, ZGratuity } from "./z-report.js";
export { checkCount, drawerTotals, moveSign } from "./drawer.js";
export type {
  CountCheck,
  DrawerMove,
  DrawerMoveKind,
  DrawerTotals,
  SecondCounter,
} from "./drawer.js";
export { poolMinutes, poolShares } from "./tip-pool.js";
export type {
  LeftOut,
  PoolInput,
  PoolMethod,
  PoolResult,
  PoolShare,
  PoolWorker,
} from "./tip-pool.js";
export { salesReport } from "./night-report.js";
export type { ReportLine, SalesReport } from "./night-report.js";
export {
  ACCOUNTS,
  isBalanced,
  journalCsv,
  nightJournal,
  openingJournal,
  payoutJournal,
} from "./journal.js";
export type { Account, Journal, JournalLine, NightJournalInput, NightMoney } from "./journal.js";
export { payrollCsv, payrollRows } from "./payroll.js";
export type { PayrollRow, PayrollShift } from "./payroll.js";
export { taxQuarterOf } from "./tax-quarter.js";
export type { TaxQuarter } from "./tax-quarter.js";
export {
  checkOfflineCode,
  normalizeOfflineCode,
  offlineCodeAt,
  offlineSecretFingerprint,
  printedOfflineCodes,
  queueModeEndsAt,
  upcomingOfflineCodes,
  OFFLINE_CODE_DIGITS,
  OFFLINE_CODE_SKEW_STEPS,
  OFFLINE_CODE_STEP_SECONDS,
  OFFLINE_CODES_AHEAD_HOURS,
  PRINTED_CODE_DIGITS,
  PRINTED_CODES_PER_NIGHT,
  QUEUE_MODE_HOURS,
} from "./offline-codes.js";
export type { Hmac, OfflineCodeCheck, OfflineCodeScope, UpcomingCode } from "./offline-codes.js";
export { PLAN_GRACE_DAYS, adminReadOnlyFrom, planState } from "./plan-billing.js";
export type { PlanState } from "./plan-billing.js";
export {
  MARKETING_FROM,
  MARKETING_UNTIL,
  marketingWindow,
  recipientZones,
} from "./marketing-window.js";
export type { MarketingWindowCheck } from "./marketing-window.js";
export {
  MIC_COMMAND_TTL_MS,
  MIC_POLL_MS,
  acceptMicCommand,
  micCommandSigningString,
  micDesired,
  outletPower,
} from "./mic-outlet.js";
export type {
  CommandRejection,
  MicCommand,
  MicPower,
  MicReason,
  OutletMemory,
} from "./mic-outlet.js";
export * from "./money-audit.js";
export * from "./oncall-coverage.js";
export * from "./gate-streak.js";
export { pastLastOrder } from "./kitchen-last-order.js";
