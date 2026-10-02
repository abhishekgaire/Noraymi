/** The fake Stripe with every ticket's routes (M4-01 onward). */
import "./accounts.js";
import "./terminal.js";
import "./payments.js";
export {
  FakeStripe,
  FakeError,
  fakeId,
  signPayload,
  formDecode,
  type FakeEvent,
} from "./server.js";
