import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "営業スケジュール共有",
  description: "Google CalendarとTeams会議を含むMicrosoft 365のOutlook予定を社内向けに集約する閲覧専用アプリ",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
