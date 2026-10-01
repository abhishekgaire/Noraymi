// Pure money and time rules, tested against seed/money-cases.json.
export { Temporal } from "@west4/shared";
export { businessDate, wallClock, parseCutover } from "./time.js";
export type { BusinessDateResult } from "./time.js";
export {
  checkSetting,
  checkHours,
  checkPay,
  checkLanguages,
  checkSafety,
  IN_PERSON_CARD_COST_PCT,
} from "./settings-checks.js";
export type { CheckContext } from "./settings-checks.js";
export { hoursFor, openNow } from "./hours.js";
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
export type { GridSlot, StartRefusal } from "./booking-grid.js";
