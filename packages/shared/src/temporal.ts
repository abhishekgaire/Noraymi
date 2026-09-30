// The one pinned Temporal polyfill (Money rules 2). Every app and the server
// import Temporal from here, never from "temporal-polyfill" directly, so the
// whole system resolves wall-clock times with the same code.
export { Temporal } from "temporal-polyfill";
