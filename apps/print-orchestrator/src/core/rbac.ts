import { AuthorizationError } from "./errors";
import type { AuthContext, PrincipalRole } from "./auth";

export function requireRole(context: AuthContext, role: PrincipalRole): void {
  if (!context.roles.includes(role)) {
    throw new AuthorizationError(`Missing required role: ${role}`);
  }
}
