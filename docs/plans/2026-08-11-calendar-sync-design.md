# Google・Microsoftカレンダー定期同期 設計

## 1. 目的

管理者が事前登録した営業メンバーのGoogle CalendarとMicrosoft 365カレンダーを、読み取り専用でFirestoreへ定期同期する。社内の閲覧者はMicrosoft 365でログインし、統合された予定を日・週・月表示で閲覧する。

## 2. 対象範囲

### 対象

- 管理者による営業メンバーの事前登録
- 登録済み営業メンバーによるGoogle Calendarのセルフサービス接続
- Microsoft Graphのアプリ権限を使ったMicrosoft 365予定の取得
- Google Calendar APIを使った個人Googleカレンダー予定の取得
- 5分間隔のFirestore同期
- 同期状態と再接続状態の管理者画面表示
- 既存の予定APIと日・週・月表示への統合

### 対象外

- 予定の作成、編集、削除
- 予定本文、参加者、添付ファイル、会議参加URLの取得・保存・表示
- 未登録社員によるGoogle Calendar接続
- Google Workspaceのドメインワイドデリゲーション
- MicrosoftメールやTeamsチャットの取得

## 3. 利用者と権限

### 閲覧者

- 許可済み社内ドメインのMicrosoft 365アカウントでログインする。
- Firestoreへ同期済みの営業予定を閲覧できる。
- Google Calendarの接続操作やメンバー管理はできない。
- デモ認証は非本番かつ`ALLOW_DEMO_AUTH=true`を明示した場合だけ許可し、本番では環境変数の誤設定があっても必ずFirebase IDトークンを検証する。

### 営業メンバー

- 管理者が事前登録したMicrosoftメールアドレスと、ログイン中のMicrosoftメールアドレスが一致する必要がある。
- 初回だけ自分の個人Googleアカウントでログインし、カレンダー読み取りを許可する。
- Google接続の解除と再接続ができる。
- 接続処理を現在のMicrosoftログインユーザーに固定し、別の営業メンバーの登録へGoogleアカウントを接続できないようにする。本人がOAuth画面で選択したGoogleアカウントのメールアドレスは、管理者画面で確認できるようにする。

### 管理者

- 営業メンバーを登録、有効化、無効化できる。
- MicrosoftとGoogleの接続状態、最終同期日時、直近エラーを確認できる。
- 手動同期を実行できる。

## 4. ユーザーフロー

### Google Calendar初回接続

1. 営業メンバーがMicrosoft 365でアプリへログインする。
2. サーバーが登録済み営業メンバーか確認する。
3. 登録済みかつ未接続の場合だけ「Googleカレンダーを接続」を表示する。
4. ボタン押下後、サーバーがCSRF対策用の一時的な`state`を生成し、Google OAuth画面へリダイレクトする。
5. 本人が個人Googleアカウントでログインし、`calendar.readonly`を許可する。
6. コールバックで`state`とMicrosoftログイン状態を再検証する。
7. 認可コードをサーバー側でアクセストークンと更新用トークンへ交換する。
8. Googleアカウント識別子とメインカレンダーを自動取得し、更新用トークンを暗号化してFirestoreへ保存する。
9. Next.jsのレスポンス後処理`after()`へ、そのメンバーだけを対象にした初回同期を登録する。
10. 初回同期をHTTPレスポンスで待たず、`google=connected&sync=pending`で直ちに接続画面へ戻す。同期失敗時も接続は維持し、次回定期同期で再試行する。
11. 次回以降はMicrosoftログインだけで利用できる。

Google OAuth画面での初回ログインと同意は省略できない。アプリ内でのメールアドレスやカレンダーIDの手入力は不要とする。

### 閲覧

1. 閲覧者がMicrosoft 365でログインする。
2. 予定APIがFirebase IDトークン、Microsoftプロバイダー、許可ドメインを検証する。
3. Firestoreへ同期済みの予定を期間、担当者、予定元で絞り込んで返す。
4. クライアントが日・週・月表示へ描画する。

## 5. システム構成

### 管理API

- `GET /api/admin/members`: 営業メンバー一覧と接続状態を返す。
- `POST /api/admin/members`: Microsoftメールアドレス、表示名、部署を登録する。
- `PATCH /api/admin/members/:id`: 有効・無効や表示情報を更新する。
- `POST /api/admin/sync`: 管理者による手動同期を開始する。

すべてFirebase IDトークンを検証し、`ADMIN_EMAILS`に含まれる管理者だけを許可する。

### Google OAuth API

- `POST /api/google/oauth/start`: ログインユーザーと事前登録を検証し、Google OAuth開始URLを返す。
- `GET /api/google/oauth/callback`: `state`を検証し、コード交換、暗号化保存後に`after()`へ初回同期を登録し、`sync=pending`へ即時リダイレクトする。
- `DELETE /api/google/connection`: 本人のGoogle接続を無効化し、保存済み更新用トークンを削除する。

OAuthスコープは次だけを使用する。

- `openid`
- `email`
- `https://www.googleapis.com/auth/calendar.readonly`

`access_type=offline`を指定し、更新用トークンを取得する。クライアントシークレットと更新用トークンはブラウザへ返さない。

### Microsoft Graph取得

- Microsoft Entraの同一テナントに登録したサーバー用資格情報から、client credentialsフローでアプリトークンを取得する。
- Exchange OnlineのApplication RBACで、対象メールボックスを営業メンバーの範囲に制限する。
- 登録済みメンバーのMicrosoftメールアドレスを使い、`/users/{userPrincipalName}/calendarView`を取得する。
- 権限は読み取り専用とし、書き込み権限は追加しない。
- `$select`でID、件名、開始、終了、場所、終日・キャンセル状態、オンライン会議種別、公開区分だけを取得する。本文、参加者、添付、会議URLは取得しない。
- `calendarView`では`lastModifiedDateTime`が`$select`に対応しないため取得対象に含めず、Microsoft予定の`updatedAt`には同期実行単位で固定した検証済みRFC 3339時刻`syncedAt`を使用する。
- `@odata.nextLink`はMicrosoft Graphが返すopaque URLとして追跡し、`$skip`と`$skiptoken`の両方を許容する。ただしHTTPSの`graph.microsoft.com`、同一API version・同一ユーザー・同一`calendarView`パスに限定し、期間変更、機密fieldの`$select`、未知queryは拒否する。
- Microsoft終日予定はstart/endがどちらもmidnightで、`timeZone`が大文字小文字を含め完全一致する場合だけ受理する。時間指定予定はstart/endで異なる有効タイムゾーンを許容し、それぞれを正規化して比較する。

### 定期同期

- Cloud Schedulerから5分間隔で`POST /api/internal/sync/calendars`を呼び出す。
- 同期APIはSecret Managerで管理した`SYNC_JOB_SECRET`を検証する。
- 同期対象期間は実行日時の30日前から180日後までとする。
- 有効な営業メンバーごとにMicrosoft予定を取得する。
- Google接続済みメンバーだけGoogle予定を取得する。
- 各APIのページネーションを最後まで処理する。
- Googleアクセストークンが期限切れの場合は、暗号化保存した更新用トークンからサーバー側で更新する。
- メンバー単位・予定元単位で失敗を分離し、一部失敗でも他メンバーの同期を継続する。
- 全メンバー同期は最大3メンバーの並行実行に制限し、Microsoft app tokenは同期run内で共有する。
- 同期結果をFirestoreへ一括反映し、同期対象期間内で取得結果から消えた予定を削除する。

同期処理の`provider`は`google | microsoft`とする。画面表示用の`source`は既存どおり`google | microsoft | teams`とし、Microsoft providerの差し替えでは`microsoft`と`teams`の両方を同じ成功単位として扱う。

## 6. Firestoreデータモデル

### `salesMembers/{memberId}`

- `displayName`: 表示名
- `department`: 部署
- `microsoftEmail`: 正規化済みMicrosoftメールアドレス
- `active`: 同期・表示対象か
- `microsoftSyncEnabled`: Microsoft同期の有効状態
- `googleConnectionStatus`: `not_connected | connected | reconnect_required`
- `createdAt`
- `updatedAt`

`memberId`はサーバー側でUUIDとして生成し、Microsoftメールアドレスやそのハッシュを公開IDに使用しない。

### `memberEmailIndex/{sha256(normalizedEmail)}`

- `memberId`: UUIDのメンバーID
- `microsoftEmail`: 正規化済みMicrosoftメールアドレス

この非公開コレクションをメール一意性の索引にする。メンバー作成では、索引の存在確認、`salesMembers`へのUUID文書作成、索引作成を一つのFirestoreトランザクションで行う。クライアントSDKからの読み書きは拒否する。

### `calendarConnections/{memberId}`

- `googleSubject`: Googleアカウントの不変識別子
- `revision`: 接続・再接続ごとにサーバー生成する競合検出用UUID（公開APIには返さない）
- `googleEmail`: 接続状態確認用メールアドレス
- `calendarId`: 初期値`primary`
- `encryptedRefreshToken`: AES-256-GCMで暗号化した更新用トークン
- `tokenIv`
- `tokenAuthTag`
- `connectedAt`
- `updatedAt`

このコレクションはAdmin SDKからのみ操作する。クライアントSDKからの読み書きをFirestore Security Rulesで拒否する。

接続の保存は接続文書の保存と`salesMembers.googleConnectionStatus`の`connected`への更新を、接続の削除は接続文書の削除と`not_connected`への更新を、それぞれ一つのFirestoreトランザクションで行う。`reconnect_required`への遷移は失効時の専用サーバー操作だけが行い、同じfenced transactionでGoogleの安全な`syncStatus`エラーも保存する。lockまたは接続`revision`の不一致、Firestore障害時は両方をロールバックし、非原子的なfallbackは行わない。接続あり・なしと矛盾する状態を汎用更新APIでは作らない。

### `oauthStates/{stateHash}`

- `memberId`
- `expiresAt`
- `createdAt`

Google OAuth開始時に作成し、コールバック時にトランザクションで一度だけ消費する。平文の`state`は保存しない。期限切れデータはFirestore TTLで削除する。

### `events/{eventId}`

公開予定は既存の`NormalizedEvent`を維持し、Firestore文書だけに期間検索用の内部epochを追加する。

- `eventId`
- `source`: `google | microsoft | teams`
- `sourceEventId`
- `ownerUserId`
- `ownerName`
- `calendarId`
- `title`
- `location`
- `start`
- `end`
- `isOnlineMeeting`
- `visibility`
- `updatedAt`
- `startEpochMs`: stale判定用の内部開始epoch（公開APIには返さない）
- `endEpochMs`: stale判定用の内部終了epoch（公開APIには返さない）

RFC 3339の日時は絶対時刻としてepochへ変換する。日付だけの`YYYY-MM-DD`は厳格に妥当性を検証し、Asia/Tokyo（UTC+09:00）の午前0時として変換する。終日予定の`end`は排他的境界であり、この変換を開始・終了の順序検証、保存、overlap検証、stale検索で共通利用する。start/endの一方だけが日付形式となる混在入力はstore境界でfail-closedに拒否し、終日・時間指定のどちらも同値または逆転した境界を保存しない。

予定データ内の`eventId`は予定元、メンバーID、予定元イベントIDから決定的に生成する。Firestore document IDにはrawの予定元イベントIDを直接使わず、その`eventId`をSHA-256で固定長hexへ変換して使用し、`/`などのpath文字、過大ID、メンバー間の衝突を防ぐ。

予定閲覧APIのepoch overlap queryに合わせ、`events`には次の4種類の複合インデックスを用意する。等価条件を先頭、複数の不等価条件を`startEpochMs`、`endEpochMs`の順に置く。

- `startEpochMs ASC`, `endEpochMs ASC`
- `ownerUserId ASC`, `startEpochMs ASC`, `endEpochMs ASC`
- `source ASC`, `startEpochMs ASC`, `endEpochMs ASC`
- `ownerUserId ASC`, `source ASC`, `startEpochMs ASC`, `endEpochMs ASC`

同期時のstale予定検索は`ownerUserId == memberId`に加え、Googleでは`source in [google]`、Microsoftでは`source in [microsoft, teams]`を使うため、4番目のインデックスを閲覧APIと共有する。`source ==`と`source in`の両方で同じfield順を維持し、全件collection scanへfallbackしない。

### `syncStatus/{memberId_provider}`

- `memberId`
- `provider`: `google | microsoft`
- `status`: `success | error | running`
- `lastStartedAt`
- `lastSucceededAt`
- `lastErrorCode`
- `lastErrorMessage`
- `updatedAt`

同期状態に保存するエラーはallowlist済みの`lastErrorCode`と対応する固定メッセージだけに限定する。未知エラーは汎用`sync_failed`へ変換し、上流の`error.message`、アクセストークン、更新用トークンを保存・管理APIへ返さない。

### `syncLocks/calendar-sync`

- `ownerId`: 実行固有ID。解放中は`null`
- `fence`: 取得ごとに増加する世代番号
- `expiresAt`
- `updatedAt`

定期同期と手動同期の重複実行を防ぐ。leaseは60秒ごとにheartbeatで延長し、期限切れロックは次の同期がトランザクションで置き換えられる。予定・同期状態・Google再接続状態の全書き込みは、同じトランザクション内で`ownerId + fence + expiresAt`を再検証する。Google書き込みは接続`revision`も再検証し、切断・再接続後の旧runが新しい接続や予定を上書きしない。正常解放時もlock文書は削除せず、単調増加する`fence`を保持したまま`ownerId: null`と期限切れ`expiresAt`へ更新する。旧runのreleaseは新しいowner/fenceと一致しないため何も変更しない。

## 7. 予定データとプライバシー

- 非公開予定は件名を`予定あり`、場所を空文字へ置換する。
- 本文、参加者、メールアドレス一覧、添付ファイル、Google Meet・Teams参加URLを保存しない。
- MicrosoftとGoogleに同じ時間の予定があっても、自動的に重複排除しない。
- GoogleとMicrosoftのAPIレスポンス全体をログへ出さない。
- 更新用トークン、クライアントシークレット、暗号化鍵はGitへ追加しない。
- `NEXT_PUBLIC_`にはブラウザへ公開してよい設定だけを置く。

## 8. エラー処理

- Google更新用トークンが失効した場合は`reconnect_required`へ変更し、本人に再接続を案内する。
- Microsoftの権限不足は管理画面に`permission_denied`として表示する。
- APIの一時障害やレート制限は同期を失敗として記録し、次回の定期同期で再試行する。
- 同期処理が重複起動した場合はFirestoreロックで二重実行を防止する。
- 同期処理中に一部の予定元が失敗しても、直前に同期済みの予定は削除しない。
- 全件取得に成功したメンバー・予定元だけ、取得結果に存在しない古い予定を削除する。
- 同期ロックの取得時に実行固有の`ownerId`と単調増加する`fence`を持つ`SyncLease`を返す。解放時は同じleaseの場合だけ`ownerId: null`へ更新し、lock文書とfenceは保持する。期限切れロックを次の実行が取得した後、古い実行は新しいlockを変更しない。
- 予定差し替えは、各fenced transactionを最大400操作かつ推定シリアライズ量7 MiB以下に分割する。推定量は文書pathとJSON payloadのUTF-8 byte数に、protobuf・index更新を見込む安全係数と固定overheadを加える。deleteも検索時に検証済みの既存保存文書を保持し、削除される文書本体とindex entryのサイズを同じ保守的な係数で見積もる。文書データが取得不能または内部fieldが不正なら削除せずfail-closedにする。単一操作が上限を超える場合は書き込み前に拒否する。全upsertを先に完了し、その後に同じ制限でstale予定を削除する。upsert途中の失敗では削除を開始せず、削除途中の失敗ではfresh予定を保持してstale予定が余分に残る側へ倒す。次回同期で再試行する。

## 9. UI変更

### 営業メンバー

- 未接続時：「Googleカレンダーを接続」
- 接続中：「Googleへ移動しています…」
- 接続済み：接続Googleアカウント、最終同期日時、「再接続」「接続解除」
- 要再接続：エラー説明と「Googleカレンダーを再接続」

### 管理者

- メンバー追加フォーム
- Microsoft同期状態
- Google接続状態
- 最終成功日時
- 直近エラー
- メンバーの有効・無効
- 手動同期ボタン

### 閲覧者

- 既存の日・週・月表示を維持する。
- Google、Microsoft、Teamsの予定元ラベルを維持する。
- 同期処理や接続トークンの情報は表示しない。

## 10. 必要な環境変数

- `MICROSOFT_TENANT_ID`
- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URI`
- `GOOGLE_TOKEN_ENCRYPTION_KEY`
- `SYNC_JOB_SECRET`
- 既存のFirebase Admin設定
- `USE_FIRESTORE=true`

秘密値はFirebase App HostingまたはGoogle Cloud Secret Managerで管理する。

## 11. 検証方針

### 自動テスト

- 未登録ユーザーがGoogle OAuthを開始すると403になる。
- 登録済みユーザーだけGoogle OAuthを開始できる。
- OAuth `state`不一致を拒否する。
- Google認可コード交換と更新用トークン暗号化を検証する。
- Microsoft client credentialsトークン取得を検証する。
- GoogleとMicrosoftのページネーションを検証する。
- 一部同期失敗時に成功済みデータを誤削除しない。
- lease期限切れ・新runによる奪取後に、旧runが予定、同期状態、接続状態を書き込めず、新lockも解放できない。
- Google切断・再接続・token rotation後に旧revisionの同期結果が保存されない。
- Googleトークン失効時の`reconnect_required`と安全な同期エラーが同じtransactionで更新され、失敗時には両方がロールバックされる。
- 最大3メンバーの並行制限とrun単位のMicrosoft app token共有を検証する。
- Asia/Tokyo基準の終日・境界予定を含むepoch overlap queryが範囲外履歴を読まず、内部epochを公開APIへ返さない。
- 400操作または推定7 MiBの先に到達した時点でupsert・deleteを分割し、各transactionが両方の上限以下であることを検証する。
- OAuth callbackが未完了の初回同期を待たず、安全な`sync=pending`へ戻る。
- 非公開予定の件名と場所がマスクされる。
- 閲覧APIがFirestoreの統合予定を返す。
- 管理APIが管理者以外を拒否する。

### 実環境確認

- 登録済み営業メンバーが入力なしでGoogle接続を完了できる。
- 5分間隔の同期でMicrosoftとGoogleの予定が反映される。
- Google接続解除後に再接続案内が表示される。
- 未登録社員にはGoogle接続ボタンが表示されない。
- 本文、参加者、会議URLがFirestoreとAPIレスポンスへ含まれない。

## 12. 完了条件

- 管理者が営業メンバーを事前登録できる。
- 登録済み営業メンバーがGoogleログインと同意だけで接続できる。
- Microsoft側は個人設定なしで予定を取得できる。
- GoogleとMicrosoftの予定が5分間隔でFirestoreへ同期される。
- 認証済み閲覧者が統合予定を日・週・月表示で閲覧できる。
- 予定取得権限が読み取り専用に限定される。
- 自動テスト、TypeScript型チェック、本番ビルドが成功する。
