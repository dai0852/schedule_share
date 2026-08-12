export type GoogleConnectionStatus = "not_connected" | "connected" | "reconnect_required";

export interface SalesMemberRecord {
  id: string;
  displayName: string;
  department: string;
  microsoftEmail: string;
  active: boolean;
  microsoftSyncEnabled: boolean;
  googleConnectionStatus: GoogleConnectionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSalesMember {
  id: string;
  displayName: string;
  department: string;
}

export function normalizeMicrosoftEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function toPublicMember(member: SalesMemberRecord): PublicSalesMember {
  return {
    id: member.id,
    displayName: member.displayName,
    department: member.department,
  };
}
