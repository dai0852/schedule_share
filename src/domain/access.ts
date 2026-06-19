export type UserRole = "viewer" | "sales_member" | "admin";

export interface AppUser {
  uid: string;
  email: string;
  role: UserRole;
  displayName?: string;
}

export interface RoleCapabilities {
  canViewTeamSchedule: boolean;
  canManageMembers: boolean;
  canConnectGoogleCalendar: boolean;
  canEditSourceEvents: boolean;
}

export function isAllowedCorporateEmail(
  email: string | null | undefined,
  allowedDomains: string[],
): boolean {
  if (!email) return false;
  const domain = email.split("@")[1]?.toLowerCase();
  return Boolean(domain && allowedDomains.map((item) => item.toLowerCase()).includes(domain));
}

export function canManage(user: AppUser): boolean {
  return user.role === "admin";
}

export function getRoleCapabilities(role: UserRole): RoleCapabilities {
  return {
    canViewTeamSchedule: true,
    canManageMembers: role === "admin",
    canConnectGoogleCalendar: role === "sales_member" || role === "admin",
    canEditSourceEvents: false,
  };
}

export function parseAllowedDomains(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter(Boolean);
}
