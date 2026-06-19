# 営業スケジュール共有アプリ

## Purpose
営業チームの予定を、社内の他部署がMicrosoft 365アカウントで閲覧できるWebアプリとして提供する。予定の正本は各営業メンバーのGoogle Calendarを継続し、Microsoft 365/Teams予定もMicrosoft Graphから集約する。

## MVP Requirements
- 閲覧者は社内Microsoftアカウントでログインする。
- 初期対象は営業チームのみ。
- 表示する情報は日時、担当者、件名、場所、Google/Microsoft/Teams種別まで。
- 本文、参加者、会議URL、メール、チャット本文は表示・保存しない。
- 予定の作成・編集・削除はこのアプリでは行わない。
- Google Calendarは各営業メンバーがOAuthで読み取り許可する。
- Microsoft 365/Teams予定は管理者承認済みのGraph権限で読み取る。
- 同一時間帯の予定は重複排除せず両方表示する。

## Technical Stack
- Next.js App Router
- React / TypeScript
- Firebase Authentication with Microsoft provider
- Firebase Admin SDK / Firestore
- Google Calendar API
- Microsoft Graph calendarView API
- Vitest

## Architecture
- `app/`: Next.js routes and API routes.
- `src/domain/`: カレンダー正規化、権限、フィルタなどの純粋ロジック。
- `src/server/`: サーバー側認証とイベント取得。
- `src/integrations/`: Google Calendar APIとMicrosoft Graphの境界。
- `src/components/`: 閲覧画面、管理画面、連携画面。
- `docs/plans/`: 実装計画。

## Current Direction
ローカルではFirebase設定がない場合、デモ認証とデモ予定で動作する。実運用時は `.env.example` を元にFirebase、Microsoft Entra、Google OAuth、Firestoreを設定し、`ALLOW_DEMO_AUTH=false` と `USE_FIRESTORE=true` に切り替える。
