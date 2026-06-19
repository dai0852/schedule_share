# MVP Implementation Plan

## Summary
営業チームのGoogle Calendar予定とMicrosoft 365/Teams予定を集約し、社内Microsoftログイン済みユーザーに閲覧専用で表示する。

## Implemented Scope
- Next.js App Router project scaffold.
- Microsoftログイン前提のクライアント認証境界。
- Firebase Admin ID token検証と社内ドメイン制限。
- Google Calendar / Microsoft Graphイベントの正規化。
- Firestore保存済みイベントまたはデモイベントからの閲覧API。
- 日/週表示、担当者フィルタ、ソース種別表示。
- 管理者向けメンバー状態画面。
- Google Calendar接続導線。

## Deferred Production Work
- Google OAuth callbackでrefresh tokenを安全に保存する処理。
- Cloud Scheduler / Cloud Functionsによる数分間隔の同期ジョブ。
- Microsoft Graphアプリ権限のadmin consentとアクセストークン取得。
- Firestore Security Rulesと複合インデックス。
- 実メンバー管理の永続化UI。

## Verification
- Domain behavior is covered by Vitest tests.
- Build/type/lint should be run after implementation changes.
