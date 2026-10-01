import type { MessageKey } from "./i18n/index.js";

/**
 * The words for an order's status (glossary · Order statuses): one set on
 * every staff screen and one on the guest's phone. Screens format the
 * params (ages, times, names) and look the key up in their catalog.
 */
export interface OrderForWords {
  readonly status: string;
  readonly cancel_reason: string | null;
  readonly decline_reason?: string | null;
}

export function guestOrderWords(order: OrderForWords): {
  key: MessageKey;
  reason: string | null;
} {
  if (order.status === "cancelled") {
    switch (order.cancel_reason) {
      case "declined":
        return { key: "orders.guest.declined", reason: order.decline_reason ?? null };
      case "alcohol_closed":
        return { key: "orders.guest.alcohol_closed", reason: null };
      case "cut_off":
        return { key: "orders.guest.cut_off", reason: null };
      default:
        return { key: "orders.guest.cancelled", reason: null };
    }
  }
  return { key: `orders.guest.${order.status}` as MessageKey, reason: null };
}

export function staffOrderWordsKey(order: OrderForWords): MessageKey {
  if (order.status === "cancelled") {
    switch (order.cancel_reason) {
      case "declined":
        return "orders.staff.declined";
      case "alcohol_closed":
        return "orders.staff.alcohol_closed";
      case "cut_off":
        return "orders.staff.cut_off";
      case "guest":
        return "orders.staff.cancelled.guest";
      default:
        return "orders.staff.cancelled.staff";
    }
  }
  return `orders.staff.${order.status}` as MessageKey;
}
