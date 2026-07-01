export type PrincipalRole = "admin" | "operator" | "viewer";

export interface AuthContext {
  principalId: string;
  roles: PrincipalRole[];
}

export const anonymousAuthContext: AuthContext = {
  principalId: "anonymous",
  roles: ["viewer"]
};

export function hasRole(context: AuthContext, role: PrincipalRole): boolean {
  return context.roles.includes(role);
}
