import type { AppUser } from "@/domain/access";
import type { NormalizedEvent } from "@/domain/schedule";

export interface SalesMember {
  id: string;
  name: string;
  email: string;
  department: string;
  googleConnected: boolean;
  microsoftSyncEnabled: boolean;
  primaryGoogleCalendarId: string;
  microsoftUserPrincipalName: string;
}

export const demoUser: AppUser = {
  uid: "demo-viewer",
  email: "viewer@example.co.jp",
  role: "admin",
  displayName: "デモ管理者",
};

export const salesMembers: SalesMember[] = [
  {
    id: "sales-a",
    name: "田中",
    email: "tanaka@example.co.jp",
    department: "営業部",
    googleConnected: true,
    microsoftSyncEnabled: true,
    primaryGoogleCalendarId: "primary",
    microsoftUserPrincipalName: "tanaka@example.co.jp",
  },
  {
    id: "sales-b",
    name: "佐藤",
    email: "sato@example.co.jp",
    department: "営業部",
    googleConnected: true,
    microsoftSyncEnabled: true,
    primaryGoogleCalendarId: "primary",
    microsoftUserPrincipalName: "sato@example.co.jp",
  },
  {
    id: "sales-c",
    name: "鈴木",
    email: "suzuki@example.co.jp",
    department: "営業部",
    googleConnected: false,
    microsoftSyncEnabled: true,
    primaryGoogleCalendarId: "primary",
    microsoftUserPrincipalName: "suzuki@example.co.jp",
  },
];

export const demoEvents: NormalizedEvent[] = [
  {
    eventId: "google:g-100",
    source: "google",
    sourceEventId: "g-100",
    ownerUserId: "sales-a",
    ownerName: "田中",
    calendarId: "primary",
    title: "既存顧客フォロー",
    location: "名古屋",
    start: "2026-06-19T09:30:00+09:00",
    end: "2026-06-19T10:30:00+09:00",
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-06-19T00:10:00Z",
  },
  {
    eventId: "teams:m-200",
    source: "teams",
    sourceEventId: "m-200",
    ownerUserId: "sales-b",
    ownerName: "佐藤",
    calendarId: "outlook",
    title: "Teams 商談",
    location: "Microsoft Teams Meeting",
    start: "2026-06-19T11:00:00+09:00",
    end: "2026-06-19T12:00:00+09:00",
    isOnlineMeeting: true,
    visibility: "team",
    updatedAt: "2026-06-19T00:15:00Z",
  },
  {
    eventId: "microsoft:m-201",
    source: "microsoft",
    sourceEventId: "m-201",
    ownerUserId: "sales-c",
    ownerName: "鈴木",
    calendarId: "outlook",
    title: "社内ミーティング",
    location: "会議室A",
    start: "2026-06-19T14:00:00+09:00",
    end: "2026-06-19T15:00:00+09:00",
    isOnlineMeeting: false,
    visibility: "team",
    updatedAt: "2026-06-19T00:20:00Z",
  },
  {
    eventId: "google:g-101",
    source: "google",
    sourceEventId: "g-101",
    ownerUserId: "sales-a",
    ownerName: "田中",
    calendarId: "primary",
    title: "見積確認",
    location: "オンライン",
    start: "2026-06-20T10:00:00+09:00",
    end: "2026-06-20T11:00:00+09:00",
    isOnlineMeeting: true,
    visibility: "team",
    updatedAt: "2026-06-19T01:00:00Z",
  },
];
