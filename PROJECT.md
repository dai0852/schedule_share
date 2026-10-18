# 営業スケジュール共有アプリ

## Purpose
営業チームの予定を、社内の他部署がMicrosoft 365アカウントで閲覧できるWebアプリとして提供する。予定の正本は各営業メンバーのGoogle Calendarを継続し、Microsoft 365/Teams予定もMicrosoft Graphから集約する。

## MVP Requirements
- 閲覧者は社内Microsoftアカウントでログインする。
- 初期対象は営業チームのみ。
- 表示する情報は日時、担当者、件名、場所、Google/Microsoft種別まで。
- 本文、参加者、会議URL、メール、チャット本文は表示・保存しない。
- 予定の作成・編集・削除はこのアプリでは行わない。
- Google Calendarは各営業メンバーがOAuthで読み取り許可する。
- Teams会議を含むMicrosoft 365のOutlook予定は、管理者承認済みのGraph権限で読み取る。
- 同一時間帯の予定は重複排除せず両方表示する。
- 予定は月カレンダーを初期表示とし、表示期間を前後または今日へ移動できる。スマホでは月全体と選択日の予定一覧を画面幅内で表示する。
- PCでは担当表示にも切り替えられ、営業メンバーを行、1週間の日付を列にして予定を横方向に比較できる。
- 表示する担当者は複数選択でき、選択変更は取得済み予定へ即時反映する。
- 担当者アイコンはMicrosoft 365のプロフィール写真を使用し、未設定・取得失敗時はイニシャルへ戻す。

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

Googleカレンダーの接続・解除と管理者コンソールへの画面導線は、activeな共有対象メンバーとして事前登録されたMicrosoftアカウントだけに表示する。Googleアカウントを変更する場合は既存接続を解除してから新しいアカウントで再接続する。管理者コンソールでは氏名・部署・Microsoftメールアドレス・利用状態・Microsoft同期状態を変更でき、メンバー削除時はGoogle接続、同期状態、OAuth途中状態、保存済み予定、メール索引も削除する。

Cloud Schedulerは5分間隔で内部同期APIを呼び、GoogleとMicrosoftをメンバー・予定元ごとに独立して同期する。一方の予定元が失敗しても他方の成功を保持し、全ページ取得に成功した予定元だけFirestoreを差し替える。既存予定と表示・索引内容が同じ場合は再書き込みせず、追加・変更された予定だけをupsertし、取得結果から消えた予定だけを削除する。予定の正本は各providerであり、アプリは読み取り専用の共有ビューを提供する。本文、参加者、添付、会議参加URLは取得・保存・返却せず、非公開予定は件名を「予定あり」、場所を空欄にする。

閲覧APIはFirebase IDトークン、Microsoftプロバイダー、許可済み社内ドメインを検証する。同じ会社の他部署ユーザーは閲覧者として利用できるが、共有対象メンバーや管理者には自動昇格しない。Firestoreのクライアントrulesはすべて拒否し、Next.jsサーバーだけがAdmin SDKとIAMでアクセスする。本番のApp Hostingは組み込みサービスアカウントのApplication Default Credentialsを使用し、サービスアカウントJSONを配置しない。

閲覧画面は月カレンダーを初期表示とし、選択日の予定を直下に全件表示する。760px以下では月のマスに日付・件数・担当者色を表示し、横スクロールせず月全体を見渡せる。PCでは月の各日に最大3件の時刻・担当者・件名を表示し、日付や「ほか」件数から当日の全件一覧を選択できる。PCには既存の1週間の担当者表への切替を残し、スマホ幅へ縮めた場合は月表示へ戻す。初期選択は今日で、月送りは移動先の1日（今月なら今日）を選択し、月外日付を押すとその月へ移動する。同じ月内の日付変更と担当者選択は取得済み予定へ即時反映し、再取得しない。担当者選択とその他操作はカレンダー・一覧の後に初期閉じのアコーディオンで配置する。APIと `NormalizedEvent` の公開契約は変更しない。月全体の取得がサーバーエラーになる場合は最大6週に分割して再取得し、すべて成功した場合だけ表示する。各応答は既存の1000件・8MiB・構造検証を維持し、週境界で重複取得した同一eventIdだけ統合する。

予定の配色は `ownerUserId` から決まる担当者単位とし、Google・Microsoft・過去のTeams予定を同じ担当者色で表示する。月表示・選択日の一覧・担当者表・担当者選択で色を共用し、氏名も併記する。メイン画面では予定元フィルターや予定元ラベルを表示せず、すべての予定元をまとめて閲覧する。詳細画面ではGoogle／Microsoftの予定元を確認できる。Microsoft Graphの予定はTeams会議かどうかにかかわらず「Microsoft」と表示し、過去の `teams` sourceもMicrosoft表示として読み取り互換を維持する。次回のMicrosoft同期で `microsoft` sourceへ置き換える。予定は重複排除せず、終日を先頭に開始時刻順で並べ、日またぎは継続方向を表示する。

担当者アイコンは、事前登録済みactiveメンバーのMicrosoft 365プロフィール写真をGraphの固定48×48エンドポイントからサーバー経由で取得する。写真データはFirestoreへ保存せず、Firebase認証済み画面へprivate cacheで返す。画面は5分ごとに再取得し、写真未設定・権限不足・上流失敗時はイニシャルを表示する。client credentialsのGraph token、メンバーのMicrosoftメールアドレスはブラウザへ返さない。

本番公開originは会社が所有しSearch Consoleで確認済みのApp Hostingカスタムドメインとする。Google OAuth callback、公開ホームページ、プライバシーポリシー、Firebase Authenticationの承認済みドメインをこの会社ドメインへ揃え、Firebase発行の `*.hosted.app` はTesting・開発確認に限定する。App Hostingのsecretは対象バックエンドとリージョンを明示してアクセスを付与し、Consoleが同名YAML変数を上書きしていないことを監査する。Cloud Schedulerの `x-sync-secret` はjob閲覧権限から見える可能性があるため、fullView権限を最小化し、監査と即時ローテーション手順を維持する。

デモ認証は非本番で `ALLOW_DEMO_AUTH=true` を明示したローカル確認時だけ使用する。本番では環境変数が誤って `true` でもデモ認証を無効化し、`ALLOW_DEMO_AUTH=false`、`USE_FIRESTORE=true` とする。Firebase設定不足時にデモ認証へ自動切替しない。未認証時は専用ログイン画面だけを表示し、認証後にカレンダー操作画面へ切り替える。画面デザインは `design.md`、本番設定と安全なデプロイ手順は `docs/setup/calendar-integrations.md` に従う。

App HostingバックエンドはFirebaseプロジェクト `schedule-share-4ff0e` の `schedule-share`、リージョンは `asia-east1`、live branchは `main` とする。初期確認URLは `https://schedule-share--schedule-share-4ff0e.asia-east1.hosted.app`。会社所有カスタムドメインの接続が完了するまでは、このURLを公開前の動作確認にだけ使用する。`apphosting.yaml` にはSecret Managerの秘密名だけを記録し、秘密値、ローカルの `.env.local`、サービスアカウントJSONはGitへ含めない。
