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
- 予定はGoogleカレンダー型の日・週・月表示で閲覧でき、表示期間を前後または今日へ移動できる。

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
- `docs/setup/`: Microsoft、Google、Firebase、定期同期の管理者向け設定手順。
- `design.md`: studio-csaスタイルのデザインシステム。

## Current Direction

本番では、管理者が共有対象の営業メンバーを事前登録する。登録済み営業メンバーは会社のMicrosoft 365アカウントで本人確認した後、個人Googleアカウントへ一度だけOAuth同意する。Microsoft 365予定はサーバー用Entraアプリのclient credentialsで取得し、Exchange Online Application RBACの `Application Calendars.Read` を営業メールボックスの管理スコープだけへ割り当てる。Googleは `calendar.readonly` だけを使用し、暗号化したrefresh tokenをサーバー専用Firestoreコレクションへ保存する。

Cloud Schedulerは5分間隔で内部同期APIを呼び、GoogleとMicrosoftをメンバー・予定元ごとに独立して同期する。一方の予定元が失敗しても他方の成功を保持し、全ページ取得に成功した予定元だけFirestoreを差し替える。予定の正本は各providerであり、アプリは読み取り専用の共有ビューを提供する。本文、参加者、添付、会議参加URLは取得・保存・返却せず、非公開予定は件名を「予定あり」、場所を空欄にする。

閲覧APIはFirebase IDトークン、Microsoftプロバイダー、許可済み社内ドメインを検証する。同じ会社の他部署ユーザーは閲覧者として利用できるが、共有対象メンバーや管理者には自動昇格しない。Firestoreのクライアントrulesはすべて拒否し、Next.jsサーバーだけがAdmin SDKとIAMでアクセスする。本番のApp Hostingは組み込みサービスアカウントのApplication Default Credentialsを使用し、サービスアカウントJSONを配置しない。

本番公開originは会社が所有しSearch Consoleで確認済みのApp Hostingカスタムドメインとする。Google OAuth callback、公開ホームページ、プライバシーポリシー、Firebase Authenticationの承認済みドメインをこの会社ドメインへ揃え、Firebase発行の `*.hosted.app` はTesting・開発確認に限定する。App Hostingのsecretは対象バックエンドとリージョンを明示してアクセスを付与し、Consoleが同名YAML変数を上書きしていないことを監査する。Cloud Schedulerの `x-sync-secret` はjob閲覧権限から見える可能性があるため、fullView権限を最小化し、監査と即時ローテーション手順を維持する。

デモ認証は非本番で `ALLOW_DEMO_AUTH=true` を明示したローカル確認時だけ使用する。本番では環境変数が誤って `true` でもデモ認証を無効化し、`ALLOW_DEMO_AUTH=false`、`USE_FIRESTORE=true` とする。Firebase設定不足時にデモ認証へ自動切替しない。未認証時は専用ログイン画面だけを表示し、認証後にカレンダー操作画面へ切り替える。画面デザインは `design.md`、本番設定と安全なデプロイ手順は `docs/setup/calendar-integrations.md` に従う。

App HostingバックエンドはFirebaseプロジェクト `schedule-share-4ff0e` の `schedule-share`、リージョンは `asia-east1`、live branchは `main` とする。初期確認URLは `https://schedule-share--schedule-share-4ff0e.asia-east1.hosted.app`。会社所有カスタムドメインの接続が完了するまでは、このURLを公開前の動作確認にだけ使用する。`apphosting.yaml` にはSecret Managerの秘密名だけを記録し、秘密値、ローカルの `.env.local`、サービスアカウントJSONはGitへ含めない。
