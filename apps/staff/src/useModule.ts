import type { ModuleId } from "@west4/shared";
import { useSession } from "./session.js";

/** Whether a module is on at the signed-in venue (D124's switches read it on screens). */
export function useModuleOn(id: ModuleId): boolean {
  const { state } = useSession();
  return state.status === "signedIn" && (state.membership.modules ?? {})[id] === "on";
}
