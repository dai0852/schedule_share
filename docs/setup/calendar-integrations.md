# カレンダー連携・本番運用セットアップ

この文書は、営業スケジュール共有アプリを `schedule-share-4ff0e` で本番運用するための管理者向け手順です。Microsoft 365、個人Google Calendar、Firebase App Hosting、Firestore、Cloud Schedulerを順番に設定します。

設定変更には、Microsoft Entra管理者、Exchange Online管理者、Google Cloud/Firebaseプロジェクト管理者の権限が必要です。権限を持つ担当者が異なる場合は、秘密値そのものを渡さず、各担当者が自分の管理画面で入力してください。

## 最初に確認すること

この文書にある `<...>` は説明用の記号です。実行・入力する前に、山括弧を含めて自分の環境の値へ置換してください。本番の `<APP_HOSTING_DOMAIN>` には会社が所有するカスタムドメインのホスト名、たとえば `schedule.example.co.jp` を使います。Firebaseが発行する `*.hosted.app` はTestingまたは開発確認に限定し、本番のOAuthホームページ、プライバシーポリシー、リダイレクトURIには使いません。

秘密値はGit、Markdown、チャット、メール、スクリーンショット、Issue、PR、シェル履歴へ残さないでください。特に次の値は秘密です。

- Microsoftログイン用アプリとMicrosoft同期用アプリのクライアントシークレット
- Google OAuthクライアントシークレット
- `GOOGLE_TOKEN_ENCRYPTION_KEY`
- `SYNC_JOB_SECRET`
- ローカル開発用のFirebaseサービスアカウントJSONまたは秘密鍵

本番構成の要点は次のとおりです。

- 閲覧者は、許可済み社内ドメインのMicrosoft 365アカウントでFirebase Authenticationへログインします。他部署のアカウントも閲覧者として利用できます。
- 管理者が営業メンバーを事前登録します。
- Microsoft予定は、サーバー用EntraアプリとExchange Online Application RBACで、営業メールボックスだけを読み取ります。
- Google予定は、登録済みの営業メンバー本人が個人Googleアカウントで一度だけ読み取り同意します。
- Cloud Schedulerが5分間隔で同期APIを呼び、Firestoreへ正規化済み予定を保存します。
- 本文、参加者、添付、会議参加URLは取得・保存・返却しません。非公開予定は「予定あり」として扱います。

## 0. 本番カスタムドメインを先に準備する

Google OAuthを本番公開する前に、会社が所有するカスタムドメインをApp Hostingへ接続します。アプリ本体、Google OAuth関連URL、公開ポリシーページはこのHTTPS originを基準にします。FirebaseのMicrosoft認証ハンドラーは後述の別ドメインです。

### 0-1. App Hostingへ会社ドメインを接続する

1. Firebase Consoleで `schedule-share-4ff0e` → `App Hosting` → 対象バックエンド → `Settings` → `Add custom domain` を開きます。
2. `<APP_HOSTING_DOMAIN>` にする会社所有ドメインを入力します。
3. 画面に表示されたDNSレコードだけを、会社ドメインのDNS管理画面へ登録します。既存サイトを移行する場合は、Firebaseの `Migrate a domain` の順序に従い、先にTLS接続を準備してからトラフィックを切り替えます。
4. App HostingのDomains画面が `Connected` になり、ブラウザで `https://<APP_HOSTING_DOMAIN>/` を証明書警告なしで開けるまで待ちます。DNS反映とSSL発行には最大24時間程度かかる場合があります。
5. FirebaseがSSL検証用に指定したDNSレコードは、接続後も削除しません。

公式のDNSレコード、移行順序、SSL状態は[App Hostingカスタムドメイン手順](https://firebase.google.com/docs/app-hosting/custom-domain)で確認してください。

### 0-2. ドメイン所有権とGoogle OAuth公開ページを準備する

1. Google Cloudプロジェクト `schedule-share-4ff0e` のOwnerまたはEditorと同じGoogleアカウントでGoogle Search Consoleを開き、会社ドメインの所有権を確認します。
2. Google Auth Platform → `Branding` のAuthorized domainsへ、検証済みの会社ドメインを登録します。
3. ログインなしで閲覧できる本番ホームページを会社ドメイン上に公開します。ログイン画面だけではなく、アプリ名、会社名、営業予定を読み取り専用で共有する目的、問い合わせ先を説明します。
4. 同じ会社ドメイン上にプライバシーポリシーを公開し、ホームページからリンクします。OAuth同意画面にも同じURLを登録します。
5. プライバシーポリシーと画面内説明に、Google Calendarの読み取り、暗号化refresh tokenの保存、5分同期、保存しない情報、接続解除・データ削除の問い合わせ方法を明記します。
6. Google接続ボタンがGoogleのブランドガイドラインに沿っていることを確認します。

ホームページとプライバシーポリシーが未公開、会社ドメインのSearch Console検証が未完了、またはデータ利用説明が現行実装と一致しない間は、Google Auth Platformを本番公開・検証申請しません。Googleの[検証要件](https://support.google.com/cloud/answer/13464321)と[ホームページ要件](https://support.google.com/cloud/answer/13807376)を申請前に確認します。

### 0-3. リダイレクトを安全な順序で切り替える

カスタムドメインのDNSとSSLが `Connected` になった後、次の順序で切り替えます。

1. Firebase Authentication → `設定` → `承認済みドメイン` に `<APP_HOSTING_DOMAIN>` を追加します。
2. Google OAuth WebクライアントのAuthorized redirect URIsへ、既存URIを残したまま `https://<APP_HOSTING_DOMAIN>/api/google/oauth/callback` を追加します。
3. `GOOGLE_OAUTH_REDIRECT_URI` を同じカスタムoriginのURLへ変更し、App Hostingをrolloutします。
4. 必ず `https://<APP_HOSTING_DOMAIN>/` からGoogleを新規接続し、コールバック、refresh token保存、手動同期まで成功することを確認します。
5. Google Auth PlatformのAuthorized domains、ホームページ、プライバシーポリシーを同じ会社ドメインへ揃え、必要な検証を完了します。
6. 新しいフローの確認後にだけ、Google OAuthクライアントから旧 `*.hosted.app` リダイレクトURIを削除します。

旧URIを先に削除すると、rollout前の画面や進行中のOAuthが失敗します。カスタムoriginへ揃える対象は、アプリ本体、Googleコールバック、Firebase Authenticationの承認済みドメインです。Microsoftログイン用のFirebaseハンドラーは次節の別URLであり、Googleコールバックとは統合しません。

## リダイレクトURLを混同しない

この構成には用途の異なる2つのリダイレクトURLがあります。

| 用途 | 登録先 | URL |
| --- | --- | --- |
| Microsoft 365でアプリへログイン | Microsoft Entraのログイン用アプリ | `https://<FIREBASE_AUTH_DOMAIN>/__/auth/handler` |
| 個人Google Calendarを接続 | Google Auth PlatformのWebクライアント | `https://<APP_HOSTING_DOMAIN>/api/google/oauth/callback`。本番は会社所有カスタムドメイン |

`<FIREBASE_AUTH_DOMAIN>` は `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` と同じ値です。現在のpopupログイン構成では通常 `schedule-share-4ff0e.firebaseapp.com` を使い、Entraへ `https://schedule-share-4ff0e.firebaseapp.com/__/auth/handler` を登録します。App HostingのカスタムドメインをそのままFirebase Authの `authDomain` に変更しても、App Hostingが `__/auth/*` を自動配信するとは限りません。変更する場合はFirebase公式のリバースプロキシ等を別途実装・検証してから切り替えます。FirebaseのMicrosoftプロバイダーは `__/auth/handler`、Google Calendarはアプリ自身の `/api/google/oauth/callback` を使います。Google側へFirebaseのハンドラーを登録したり、Entra側へGoogleのコールバックを登録したりしないでください。[FirebaseのMicrosoft認証公式手順](https://firebase.google.com/docs/auth/web/microsoft-oauth)と[認証リダイレクトの公式注意事項](https://firebase.google.com/docs/auth/web/redirect-best-practices)で役割を確認できます。

## 1. Microsoft 365ログイン用アプリを確認する

### 1-1. 同期用アプリとは分離する

ログイン用アプリとカレンダー同期用アプリは、別のEntraアプリ登録にすることを推奨します。

- ログイン用アプリ: Firebase Authenticationがユーザーを対話的にログインさせるために使用します。
- 同期用アプリ: App Hostingのサーバーがclient credentialsでMicrosoft Graphを呼ぶために使用します。

分離すると、ログイン用シークレットとサーバー用シークレットの保管場所、失効範囲、権限監査を分けられます。現行実装も `NEXT_PUBLIC_MICROSOFT_TENANT_ID` と、サーバー専用の `MICROSOFT_TENANT_ID` / `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` を分けています。既存アプリを兼用することも技術的には可能ですが、対話ログイン用アプリへサーバー権限を追加するため監査が難しくなります。新規本番構成では分離してください。

### 1-2. ログイン用アプリをシングルテナントにする

1. [Microsoft Entra管理センター](https://entra.microsoft.com/)を開きます。
2. 対象の会社テナントへ切り替えます。
3. `Entra ID` → `アプリの登録` → ログイン用アプリを開きます。未作成の場合は `新規登録` を選びます。
4. `サポートされているアカウントの種類` は「この組織ディレクトリのみに含まれるアカウント（シングル テナント）」を選びます。
5. `認証` → `プラットフォームを追加` → `Web` で、次を登録します。

   ```text
   https://<FIREBASE_AUTH_DOMAIN>/__/auth/handler
   ```

6. `概要` で `アプリケーション（クライアント）ID` と `ディレクトリ（テナント）ID` を確認します。

シングルテナントは、同じ会社テナントのユーザーだけを対象にする設定です。Microsoftの[アプリ登録公式手順](https://learn.microsoft.com/en-us/entra/identity-platform/quickstart-register-app)も、組織内利用ではシングルテナントを案内しています。

### 1-3. Firebase Authenticationへ登録する

1. Firebase Consoleで `schedule-share-4ff0e` を開きます。
2. `Authentication` → `ログイン方法` → `Microsoft` を有効にします。
3. ログイン用アプリのクライアントIDとクライアントシークレットを入力します。
4. 保存します。
5. `Authentication` → `設定` → `承認済みドメイン` に、実際にブラウザで開くApp Hostingドメインまたはカスタムドメインを追加します。
6. ローカル確認が必要な場合だけ `localhost` を残します。LAN内IPアドレスは本番用途へ追加しません。

ログイン用アプリのシークレットは会社承認済みのパスワードマネージャーまたはsecret vaultに保管し、そこからFirebase ConsoleのMicrosoftプロバイダー設定へ管理者が手入力します。チャット、シェル、`.env.local`、App Hostingの `MICROSOFT_CLIENT_SECRET` は経由せず、同期用secretへ流用しません。App Hostingの公開URLを変更した場合は、Firebaseの承認済みドメインも見直してください。

### 1-4. ログイン用シークレットの期限と交換手順を登録する

Entraでログイン用クライアントシークレットを作成した日に、アプリ所有者を2名以上登録し、secret名、credentialの識別情報またはversion、期限、所有者、交換責任者を組織の運用台帳へ記録します。`Value` は台帳へ記録せず、会社承認済みのパスワードマネージャーまたはsecret vaultだけに保管します。期限30日前に担当者と代替担当者へ通知されるようにし、Microsoft Entraの `Renew expiring application credentials` の推奨事項も定期確認します。Microsoftは、期限30日以内のアプリ資格情報をこの推奨事項の対象とし、新資格情報の検証後に旧資格情報を削除する順序を案内しています。[Microsoft Entraの期限前更新の推奨事項](https://learn.microsoft.com/en-us/entra/identity/monitoring-health/recommendation-renew-expiring-application-credential)と[アプリ所有者の管理](https://learn.microsoft.com/en-us/entra/identity-platform/security-best-practices-for-app-registration#app-ownership-configuration)を参照してください。

交換時は次の順序を守ります。ここで扱うのはFirebase AuthenticationのMicrosoftログイン用secretであり、後述の同期用 `MICROSOFT_CLIENT_SECRET` とは別物です。

1. Entraのログイン用アプリで、旧secretを残したまま新しいclient secretを作成します。作成直後に一度だけ表示される `Value`を会社承認済みvaultへすぐに保存します。`Secret ID`は認証値ではありません。Entraは画面移動後に `Value`を再表示せず、Firebase Consoleの保存済み欄も値をマスクするため、旧 `Value` は交換完了までvaultから削除しません。
2. Firebase Consoleの `Authentication` → `ログイン方法` → `Microsoft` を開き、クライアントシークレット欄を新しい `Value` へ更新して保存します。Firebaseはこのclient ID/secretでMicrosoftの認可コードを交換します。[Firebase Microsoft認証の公式手順](https://firebase.google.com/docs/auth/web/microsoft-oauth)
3. 現在のセッションを再利用しないブラウザのプライベートウィンドウで、会社Microsoft 365アカウントの新規ログインを完了します。
4. ログイン後にFirebase ID tokenが発行され、通常の認証付きAPIを利用できることを画面操作で確認します。token本体はDevTools、ログ、作業記録へ貼り付けません。
5. 成功を確認した後にだけ、Entraから旧credentialを削除し、vaultの旧 `Value` エントリーも組織の安全な削除方法で破棄します。新 `Value` は次回ローテーションのrollbackに必要なため、vaultで保持します。交換日時、担当者、Entraのcredential識別情報、新規ログインとAPI確認の成否を監査記録へ残しますが、`Value`やID tokenは記録しません。

新secretでログインできない場合は旧credentialとvaultの旧 `Value` を削除せず、Firebase Microsoftプロバイダー設定をvaultの旧 `Value` へ戻して保存します。旧設定で復旧したことを確認するまで、新credentialと新 `Value` も削除しません。原因調査後に再利用するか、Entraの新credentialと対応するvaultエントリーを組織の手順で破棄して別の新secretを発行するかを決めます。client secretの `Value`が作成直後しか表示されないことと有効期限は、[Microsoft Entraのアプリ資格情報手順](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)で確認できます。

## 2. Microsoft Graph同期用アプリを作成する

### 2-1. サーバー用アプリを登録する

1. Microsoft Entra管理センターで `Entra ID` → `アプリの登録` → `新規登録` を開きます。
2. 名前は用途が分かるものにします。例: `営業スケジュール共有 Server`。
3. アカウントの種類は「この組織ディレクトリのみに含まれるアカウント（シングル テナント）」を選びます。
4. リダイレクトURIは設定せず登録します。client credentialsでは対話リダイレクトを使いません。
5. `概要` から次を記録します。これらは識別子でありシークレットではありませんが、公開ドキュメントへ不要に載せないでください。

   - ディレクトリ（テナント）ID → `MICROSOFT_TENANT_ID`
   - アプリケーション（クライアント）ID → `MICROSOFT_CLIENT_ID`

### 2-2. クライアントシークレットを作成する

1. サーバー用アプリで `証明書とシークレット` → `クライアント シークレット` → `新しいクライアント シークレット` を選びます。
2. 用途と期限が分かる説明を入力し、組織のローテーション方針に合う短い期限を選びます。
3. 作成直後に表示される `値` を、パスワードマネージャーまたはApp Hosting Secret Managerへ移します。`シークレットID` ではなく `値` を使います。
4. 値を確認した画面を撮影せず、Git管理ファイルへ貼り付けません。

Microsoftは証明書またはフェデレーション資格情報を、クライアントシークレットより強い方式として推奨しています。現行実装は `MICROSOFT_CLIENT_SECRET` を使用するため、ここではSecret Managerへの保管、短い有効期限、期限前ローテーションを必須とします。将来、証明書対応を実装した段階で移行してください。[Microsoft Entraの資格情報管理](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-credentials)

### 2-3. Entraのテナント全体Graph権限を付けない

サーバー用アプリの `APIのアクセス許可` では、テナント全体のMicrosoft Graph `Calendars.Read` アプリケーション権限を追加・同意しません。カレンダー権限は次のExchange Online Application RBACだけで付与します。

既にGraphのアプリケーション権限が付いている場合は、Exchange RBACの許可・拒否テストを完了した後、アプリ登録から権限定義を削除し、エンタープライズアプリ側の既存の管理者同意も取り消します。MicrosoftのApplication RBAC公式資料では、Entraの組織全体権限とExchange RBAC権限は加算され、組織全体権限が残るとRBACのメールボックス範囲を迂回できると明記されています。[Exchange Online Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

このアプリへ書き込み権限を付けないでください。予定の作成、更新、削除は本アプリの要件外です。

## 3. Exchange Online Application RBACで営業メールボックスだけを許可する

MicrosoftのApplication RBACは、アプリ、読み取りロール、対象メールボックスの管理スコープを結び付けます。従来のApplication Access Policyではなく、現在推奨されているApplication RBACを使います。

### 3-1. 営業メールボックス用グループを作る

1. Exchange管理センターで、メールが有効なセキュリティグループを1つ作成します。例: `ScheduleShare-Sales-Mailboxes`。
2. 同期対象の営業メンバーのメールボックスを、グループの直接メンバーとして追加します。
3. 他部署の閲覧者はこのグループへ追加しません。閲覧者であることと、予定を共有する営業メンバーであることは別です。
4. 入退社・異動時は、アプリ管理画面の営業メンバー登録と、このグループの直接メンバーを両方更新します。

ネストされたグループのメンバーはApplication RBACの対象になりません。必ず直接メンバーにします。Microsoft 365グループや配布リストもスコープに利用できますが、この手順では役割が明確なメール有効セキュリティグループに統一します。

### 3-2. Exchange Online PowerShellへ接続する

PowerShell 7で実行します。`<EXCHANGE_ADMIN_UPN>` はExchange管理権限を持つ自分の会社アカウントへ置換します。パスワードをコマンドへ書かず、表示されるMicrosoftログイン画面で対話認証します。

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Import-Module ExchangeOnlineManagement
Connect-ExchangeOnline -UserPrincipalName "<EXCHANGE_ADMIN_UPN>"
```

接続方法と必要モジュールは[Exchange Online PowerShell公式手順](https://learn.microsoft.com/en-us/powershell/exchange/connect-to-exchange-online-powershell)で確認できます。

### 3-3. Object IDを正しく取得する

Microsoft Entra管理センターで `Entra ID` → `エンタープライズ アプリケーション` → サーバー用アプリ → `概要` を開きます。次の2つを確認します。

- `アプリケーション ID`: Entraアプリ登録の `アプリケーション（クライアント）ID` と同じ値です。
- `オブジェクト ID`: このテナント内のサービスプリンシパルのObject IDです。

`New-ServicePrincipal -ObjectId` へ渡すのは、**エンタープライズ アプリケーション側のオブジェクトID**です。`アプリの登録` 画面に表示されるアプリケーションオブジェクトのObject IDとは異なります。Microsoft公式もこの取り違えを明示的に警告しています。[Exchange Online Application RBAC](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

### 3-4. サービスプリンシパル、管理スコープ、読み取りロールを作る

以下を1行ずつPowerShellへ貼り付けて実行します。識別子、グループメールアドレス、表示名は自分の値へ置換します。シークレットはこの操作で使いません。

```powershell
$appId = "<SERVER_APP_CLIENT_ID>"
$servicePrincipalObjectId = "<ENTERPRISE_APP_OBJECT_ID>"
$scopeGroup = "<SALES_SCOPE_GROUP_EMAIL>"
$scopeName = "ScheduleShare-Sales-Mailboxes"

New-ServicePrincipal -AppId $appId -ObjectId $servicePrincipalObjectId -DisplayName "ScheduleShare Calendar Sync"

$scopeGroupDn = (Get-DistributionGroup -Identity $scopeGroup).DistinguishedName
New-ManagementScope -Name $scopeName -RecipientRestrictionFilter "MemberOfGroup -eq '$scopeGroupDn'"

New-ManagementRoleAssignment -Name "ScheduleShare-CalendarsRead-Sales" -App $servicePrincipalObjectId -Role "Application Calendars.Read" -CustomResourceScope $scopeName
```

付与するロールは `Application Calendars.Read` だけです。このロールは、ユーザーなしでカレンダー予定を読み取るApplication権限に対応します。[Application RBACの対応ロール一覧](https://learn.microsoft.com/en-us/exchange/permissions-exo/application-rbac)

### 3-5. 許可対象と対象外をテストする

`<REGISTERED_SALES_MAILBOX>` はグループの直接メンバーで、アプリ管理画面へ登録する営業メールボックスへ置換します。`<OUTSIDE_SCOPE_MAILBOX>` はグループ外にある検証用メールボックスへ置換します。

```powershell
Test-ServicePrincipalAuthorization -Identity $servicePrincipalObjectId -Resource "<REGISTERED_SALES_MAILBOX>" | Where-Object RoleName -eq "Application Calendars.Read" | Format-Table

Test-ServicePrincipalAuthorization -Identity $servicePrincipalObjectId -Resource "<OUTSIDE_SCOPE_MAILBOX>" | Where-Object RoleName -eq "Application Calendars.Read" | Format-Table
```

確認結果は次のとおりです。

- 登録営業メールボックス: `InScope` が `True`
- スコープ外メールボックス: `InScope` が `False`

このコマンドはExchange RBACの割り当てだけを検証し、Entraで別途付与された権限を含みません。したがって、次の実Graphテストも必須です。[Test-ServicePrincipalAuthorization公式リファレンス](https://learn.microsoft.com/en-us/powershell/module/exchangepowershell/test-serviceprincipalauthorization)

### 3-6. Graph実アクセスを本文・URL非表示でテストする

次の例はmacOS/Linuxのターミナルで実行します。入力したクライアントシークレット、取得したアクセストークン、Graphレスポンス本文を画面へ出しません。`jq` と `curl` が必要です。

```bash
(
  set -eu
  set +x
  umask 077

  SECRET_FILE=
  CURL_CONFIG=

  cleanup_graph_test() {
    trap - EXIT HUP INT TERM
    [ -z "${SECRET_FILE:-}" ] || rm -f -- "$SECRET_FILE"
    [ -z "${CURL_CONFIG:-}" ] || rm -f -- "$CURL_CONFIG"
    unset ACCESS_TOKEN CLIENT_SECRET TOKEN_RESPONSE SECRET_FILE CURL_CONFIG \
      TENANT_ID CLIENT_ID START_ISO END_ISO MAILBOX_ENCODED
  }
  trap cleanup_graph_test EXIT
  trap 'cleanup_graph_test; exit 129' HUP
  trap 'cleanup_graph_test; exit 130' INT
  trap 'cleanup_graph_test; exit 143' TERM

  SECRET_FILE="$(mktemp "${TMPDIR:-/tmp}/schedule-share-graph-secret.XXXXXX")"
  CURL_CONFIG="$(mktemp "${TMPDIR:-/tmp}/schedule-share-graph-curl.XXXXXX")"
  chmod 600 "$SECRET_FILE" "$CURL_CONFIG"

  printf 'Tenant ID: '
  IFS= read -r TENANT_ID
  printf 'Server app client ID: '
  IFS= read -r CLIENT_ID
  printf 'Server app client secret: '
  IFS= read -rs CLIENT_SECRET
  printf '\n'
  printf '%s' "$CLIENT_SECRET" > "$SECRET_FILE"
  unset CLIENT_SECRET

  TOKEN_RESPONSE="$(curl --disable --silent --show-error --fail \
    --request POST \
    --header 'Content-Type: application/x-www-form-urlencoded' \
    --data-urlencode "client_id=${CLIENT_ID}" \
    --data-urlencode "client_secret@${SECRET_FILE}" \
    --data-urlencode 'scope=https://graph.microsoft.com/.default' \
    --data-urlencode 'grant_type=client_credentials' \
    "https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token")"

  ACCESS_TOKEN="$(printf '%s' "$TOKEN_RESPONSE" | jq -er '.access_token')"
  unset TOKEN_RESPONSE
  printf 'header = "Authorization: Bearer %s"\n' "$ACCESS_TOKEN" > "$CURL_CONFIG"

  START_ISO="$(node -p 'new Date(Date.now() - 86400000).toISOString()')"
  END_ISO="$(node -p 'new Date(Date.now() + 86400000).toISOString()')"

  graph_calendar_status() {
    MAILBOX_ENCODED="$(jq -rn --arg value "$1" '$value|@uri')"
    curl --disable --config "$CURL_CONFIG" \
      --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
      --get \
      --header 'Prefer: outlook.timezone="Tokyo Standard Time"' \
      --data-urlencode "startDateTime=${START_ISO}" \
      --data-urlencode "endDateTime=${END_ISO}" \
      --data-urlencode '$top=1' \
      --data-urlencode '$select=id,start,end' \
      "https://graph.microsoft.com/v1.0/users/${MAILBOX_ENCODED}/calendarView"
  }

  graph_calendar_status "<REGISTERED_SALES_MAILBOX>"
  graph_calendar_status "<OUTSIDE_SCOPE_MAILBOX>"
)
```

期待値は、登録営業メールボックスが `200`、スコープ外メールボックスが `403` です。レスポンスは `/dev/null` へ捨てるため、件名、本文、場所、会議URLは表示されません。スコープ外でも `200` になる場合は、Entraにテナント全体のGraph権限または旧Application Access Policyが残っていないかを確認し、解消するまで本番同期を開始しません。

Application RBACの変更はGraph実アクセスへ反映されるまで30分から2時間かかる場合があります。`Test-ServicePrincipalAuthorization` はこのキャッシュを迂回します。直後にGraphだけ失敗する場合は権限を広げず、反映を待って再試験してください。Graphの `calendarView` エンドポイントと必要権限は[Microsoft Graph公式リファレンス](https://learn.microsoft.com/en-us/graph/api/user-list-calendarview)で確認できます。

作業終了後はExchange Online PowerShellを切断します。

```powershell
Disconnect-ExchangeOnline -Confirm:$false
```

## 4. Google Calendar OAuthを設定する

### 4-1. Google Calendar APIを有効にする

1. Google Cloud Consoleで `schedule-share-4ff0e` を選択します。
2. `APIとサービス` → `ライブラリ` を開きます。
3. `Google Calendar API` を検索して `有効にする` を選びます。

Google Calendar APIは利用前にCloudプロジェクトで有効化する必要があります。[Google Calendar API公式クイックスタート](https://developers.google.com/workspace/calendar/api/quickstart/js)

### 4-2. OAuth同意画面をExternalで作る

営業メンバーは会社Google Workspaceではなく個人Googleアカウントも接続するため、Audienceは `External` にします。`Internal` ではCloudプロジェクトの組織外にある個人Googleアカウントが接続できません。

1. Google Cloud Consoleで `Google Auth Platform` → `Branding` を開き、アプリ名、サポートメール、連絡先を登録します。
2. `Audience` で `External` を選びます。
3. `Data Access` で、実装が要求する次の3スコープだけを登録します。

   ```text
   openid
   email
   https://www.googleapis.com/auth/calendar.readonly
   ```

4. カレンダーの書き込みスコープは追加しません。
5. 公開状態が `Testing` の間は `Test users` に、接続確認を行う営業メンバーの個人Googleアカウントを追加します。

ExternalのTestingでは、テストユーザーの承認は同意から7日で期限切れになり、`access_type=offline` で発行されたrefresh tokenも期限切れになります。`openid`、email、profile相当だけを要求する場合には7日失効の例外がありますが、本アプリは `calendar.readonly` も要求するため、その例外を前提にできません。Testingのまま「一度だけ接続」を本番保証にせず、継続運用前にAudienceを `In production` へ移し、必要な検証を完了してください。[Google Auth PlatformのAudience公式説明](https://support.google.com/cloud/answer/15549945)

本番公開・検証申請前に、次をすべて確認します。

- Authorized domainがSearch Consoleで所有権確認済みの会社ドメインである。
- ホームページはログインなしで表示でき、アプリ機能とGoogleデータの利用目的を説明している。
- 同じ会社ドメイン上のプライバシーポリシーをホームページとOAuth同意画面の両方から参照できる。
- 要求スコープは `openid`、`email`、`https://www.googleapis.com/auth/calendar.readonly` の3つだけで、画面の説明と一致する。
- `calendar.readonly` が必要な理由を、登録営業メンバー本人の予定を共有画面へ読み取り表示するため、と具体的に説明できる。
- refresh tokenをサーバー側で暗号化保存し、予定本文、参加者、添付、会議参加URLを取得・保存しない実装と説明が一致する。
- Googleが確認用アカウント、操作手順、デモ動画等を要求した場合に、安全な検証用データで提出できる。

検証申請の入力項目と公開準備は[Google OAuthアプリの検証申請](https://support.google.com/cloud/answer/13461325)で確認します。

### 4-3. WebアプリケーションOAuthクライアントを作る

1. `Google Auth Platform` → `Clients` → `Create Client` を開きます。
2. Application typeは `Web application` を選びます。
3. 名前は用途が分かるものにします。例: `営業スケジュール共有 Web`。
4. `Authorized redirect URIs` に次のHTTPS URLを登録します。

   ```text
   https://<APP_HOSTING_DOMAIN>/api/google/oauth/callback
   ```

5. 末尾のスラッシュを追加しません。スキーム、ホスト、ポート、パスまで `GOOGLE_OAUTH_REDIRECT_URI` と完全一致させます。
6. 作成後、クライアントIDとクライアントシークレットを安全な場所へ移します。

このOAuthはサーバー側Webアプリケーションフローです。Authorized JavaScript originsではなくAuthorized redirect URIsへ登録します。GoogleはリダイレクトURIの完全一致を要求し、シークレットをソースツリー外へ保管するよう案内しています。[Google OAuth Web Server公式手順](https://developers.google.com/identity/protocols/oauth2/web-server)

現行実装は `access_type=offline` を使い、5分同期時に利用するrefresh tokenを取得します。Googleの公式説明でも、ユーザー不在の定期処理にはoffline accessが必要です。

### 4-4. Google refresh token暗号鍵を作る

`GOOGLE_TOKEN_ENCRYPTION_KEY` は32バイトのランダム値をBase64化したものです。次のコマンドは値を画面へ表示せず、権限を制限した一時ファイル経由でApp Hosting Secret Managerへ渡します。`<APP_HOSTING_REGION>` を自分のバックエンドのリージョンへ置換してください。

```bash
(
  set -eu
  set +x
  umask 077

  TMP_FILE=

  cleanup_google_key() {
    trap - EXIT HUP INT TERM
    [ -z "${TMP_FILE:-}" ] || rm -f -- "$TMP_FILE"
    unset TMP_FILE
  }
  trap cleanup_google_key EXIT
  trap 'cleanup_google_key; exit 129' HUP
  trap 'cleanup_google_key; exit 130' INT
  trap 'cleanup_google_key; exit 143' TERM

  TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/schedule-share-google-key.XXXXXX")"
  chmod 600 "$TMP_FILE"

  openssl rand -base64 32 | tr -d '\n' > "$TMP_FILE"
  firebase apphosting:secrets:set GOOGLE_TOKEN_ENCRYPTION_KEY \
    --data-file "$TMP_FILE" \
    --project schedule-share-4ff0e \
    --location "<APP_HOSTING_REGION>"
  firebase apphosting:secrets:describe GOOGLE_TOKEN_ENCRYPTION_KEY \
    --project schedule-share-4ff0e
)
```

`describe` が新しいsecret versionのメタデータを返すとsubshellが終了し、`EXIT`トラップがローカル一時コピーを削除します。コマンド失敗や `HUP` / `INT` / `TERM` で中断した場合も削除します。Secret Managerの値は残ります。CLIがApp Hostingバックエンドへのアクセス許可と `apphosting.yaml` への参照追加を確認した場合は、対象バックエンド名を確認してから承認します。値そのものをYAMLへ書かないでください。`--data-file` はシークレットをコマンド引数へ展開せずCLIへ渡します。[Firebase App Hostingのsecret設定](https://firebase.google.com/docs/app-hosting/configure)と[Firebase CLIリファレンス](https://firebase.google.com/docs/cli)で現行syntaxを確認できます。

この鍵を変更すると、既にFirestoreへ保存したGoogle refresh tokenを復号できなくなります。現行実装は旧鍵との同時復号を行わないため、鍵のローテーション時は全営業メンバーのGoogle再接続が必要です。

### 4-5. OAuth state用Firestore TTLを有効にする

OAuth開始時の一時レコードは `oauthStates` コレクションへ保存され、`expiresAt` はFirestoreのDate/Timestamp型です。アプリ自身も10分の期限と一度だけの消費を検証します。TTLは期限切れレコードの後片付けであり、認証の安全性をTTL削除時刻へ依存させません。

Google Cloud Consoleで設定する場合:

1. `schedule-share-4ff0e` のFirestoreデータベースを開きます。
2. `Time-to-live` → `Create policy` を選びます。
3. Collection groupに `oauthStates`、Timestamp fieldに `expiresAt` を入力します。
4. Expiration offsetは `0` のまま作成します。
5. Statusが有効になるまで待ちます。

CLIで設定する場合は、プロジェクトとデータベースを明示します。

```bash
gcloud firestore fields ttls update expiresAt \
  --collection-group=oauthStates \
  --database='(default)' \
  --enable-ttl \
  --project=schedule-share-4ff0e

gcloud firestore fields ttls list \
  --collection-group=oauthStates \
  --database='(default)' \
  --project=schedule-share-4ff0e
```

TTLの有効化には10分以上かかる場合があり、期限到達後の削除も即時ではなく通常24時間以内です。[Firestore TTL公式手順](https://firebase.google.com/docs/firestore/ttl)

## 5. App Hostingの環境変数とシークレットを設定する

### 5-1. 本番バックエンドを確認する

プロジェクトルートで次を実行します。Firebaseのプロジェクト操作には必ず `--project schedule-share-4ff0e` を付けます。

```bash
firebase apphosting:backends:list --project schedule-share-4ff0e
```

結果によって次のように進めます。

- 0件: シークレット設定とrolloutへ進みません。App Hostingバックエンドが必要です。新規作成は課金、公開先、Git連携を変更するため、管理者の明示承認後にFirebase Consoleを使うか、次の形式で作成します。

  ```bash
  firebase apphosting:backends:create \
    --backend "<NEW_BACKEND_ID>" \
    --primary-region "<APP_HOSTING_REGION>" \
    --root-dir . \
    --project schedule-share-4ff0e
  ```

- 1件: そのIDを使い、次のコマンドでリージョン、公開URL、リポジトリ、ブランチ、サービスアカウントを確認します。
- 複数件: 各IDへ次のコマンドを実行し、会社カスタムドメイン、接続リポジトリ、live branchが一致する1件を選びます。名前だけで推測しません。

```bash
firebase apphosting:backends:get "<APP_HOSTING_BACKEND_ID>" \
  --project schedule-share-4ff0e
```

確認した値を以降の `<APP_HOSTING_BACKEND_ID>`、`<APP_HOSTING_REGION>`、`<APP_HOSTING_DOMAIN>` へ使います。`<APP_HOSTING_DOMAIN>` は0章で接続済みの会社カスタムドメインです。

### 5-2. `apphosting.yaml` の有無を安全に確認する

リポジトリルートで `apphosting.yaml` を確認します。既存ファイルがある場合は上書きせず、Git差分とFirebase Consoleの対象バックエンド設定を先に確認します。

```bash
if [ -f apphosting.yaml ]; then
  ls -l apphosting.yaml
  git diff -- apphosting.yaml
else
  printf '%s\n' 'apphosting.yaml はまだありません'
fi
```

ファイルがない場合は、対象バックエンドを5-1で確定した後にだけ、次を対話実行できます。

```bash
firebase init apphosting --project schedule-share-4ff0e
```

既存バックエンドがあるのに新規バックエンド作成を提案された場合、またはプロジェクト、リポジトリ、root directoryが一致しない場合は `Ctrl+C` で中止します。初期化が作成・変更した `firebase.json`、`.firebaserc`、`apphosting.yaml` は必ずGit差分で確認し、既存設定を消していないことを確かめます。

対話初期化を使わず、レビュー済みのテンプレートを手動でリポジトリルートへ作成しても構いません。現在のリポジトリにはバックエンドID、リージョン、Console環境変数の実値がないため、この作業では実 `apphosting.yaml` を自動作成しません。5-5のテンプレートを、既存バックエンドとConsole設定を確認した管理者が追加します。

### 5-3. サーバー専用シークレットを登録し、対象バックエンドへ明示許可する

次のコマンドを1つずつ実行します。値をコマンドライン引数へ書かず、CLIの入力または権限を600へ制限した一時ファイルの `--data-file` で登録します。ターミナル出力、シェル履歴、チャット、スクリーンショットへ値を残しません。

```bash
firebase apphosting:secrets:set MICROSOFT_TENANT_ID --project schedule-share-4ff0e --location "<APP_HOSTING_REGION>"
firebase apphosting:secrets:set MICROSOFT_CLIENT_ID --project schedule-share-4ff0e --location "<APP_HOSTING_REGION>"
firebase apphosting:secrets:set MICROSOFT_CLIENT_SECRET --project schedule-share-4ff0e --location "<APP_HOSTING_REGION>"
firebase apphosting:secrets:set GOOGLE_CLIENT_ID --project schedule-share-4ff0e --location "<APP_HOSTING_REGION>"
firebase apphosting:secrets:set GOOGLE_CLIENT_SECRET --project schedule-share-4ff0e --location "<APP_HOSTING_REGION>"
```

`GOOGLE_TOKEN_ENCRYPTION_KEY` は前節の権限を制限した一時ファイル経由で登録します。`SYNC_JOB_SECRET` はCloud Scheduler設定と同じ値にするため、次節で一度だけ生成します。

新規secret作成時の自動確認や、既存secretへ新versionを追加した際の過去の許可状態に依存せず、対象バックエンドへ明示的にアクセスを付与します。

```bash
firebase apphosting:secrets:grantaccess MICROSOFT_TENANT_ID --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
firebase apphosting:secrets:grantaccess MICROSOFT_CLIENT_ID --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
firebase apphosting:secrets:grantaccess MICROSOFT_CLIENT_SECRET --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
firebase apphosting:secrets:grantaccess GOOGLE_CLIENT_ID --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
firebase apphosting:secrets:grantaccess GOOGLE_CLIENT_SECRET --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
firebase apphosting:secrets:grantaccess GOOGLE_TOKEN_ENCRYPTION_KEY --backend "<APP_HOSTING_BACKEND_ID>" --location "<APP_HOSTING_REGION>" --project schedule-share-4ff0e
```

Secretのメタデータは値を表示せず確認できます。

```bash
firebase apphosting:secrets:describe MICROSOFT_CLIENT_SECRET --project schedule-share-4ff0e
firebase apphosting:secrets:describe GOOGLE_CLIENT_SECRET --project schedule-share-4ff0e
firebase apphosting:secrets:describe GOOGLE_TOKEN_ENCRYPTION_KEY --project schedule-share-4ff0e
```

各secretで新しい有効versionがあることを確認します。Firebase Consoleの対象バックエンドとSecret ManagerのPermissionsで、5-1で確認したバックエンドサービスアカウントにSecret Accessor相当の許可があることも確認します。別バックエンドや個人アカウントへ広いアクセスを付けません。App Hosting公式の[secret設定とgrantaccess](https://firebase.google.com/docs/app-hosting/configure)に従います。

### 5-4. 公開設定とサーバー設定を分離する

`apphosting.yaml` またはFirebase Consoleの `App Hosting` → 対象バックエンド → `Settings` → `Environment` で、`.env.example` と同じ変数名を設定します。

ブラウザへ組み込まれる設定:

- `NEXT_PUBLIC_FIREBASE_API_KEY`
- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`
- `NEXT_PUBLIC_FIREBASE_PROJECT_ID`
- `NEXT_PUBLIC_FIREBASE_APP_ID`
- `NEXT_PUBLIC_MICROSOFT_TENANT_ID`

これらはブラウザで参照可能なFirebase設定です。App HostingではBuild時にも利用できるようにします。`NEXT_PUBLIC_` にシークレットを入れません。

サーバーのみで使う通常設定:

- `GOOGLE_OAUTH_REDIRECT_URI=https://<APP_HOSTING_DOMAIN>/api/google/oauth/callback`
- `FIREBASE_PROJECT_ID=schedule-share-4ff0e`
- `ALLOWED_EMAIL_DOMAINS=<COMPANY_EMAIL_DOMAIN>`
- `ADMIN_EMAILS=<ADMIN_EMAIL_ADDRESS_LIST>`
- `DEFAULT_USER_ROLE=viewer`
- `ALLOW_DEMO_AUTH=false`
- `USE_FIRESTORE=true`

`ADMIN_EMAILS` が複数ある場合はカンマ区切りです。会社ドメインと管理者メールアドレスは小文字で登録します。

App Hosting本番では、Firebaseが用意するバックエンドサービスアカウントとApplication Default Credentials（ADC）を使用します。`FIREBASE_PROJECT_ID` を設定し、`GOOGLE_APPLICATION_CREDENTIALS`、`FIREBASE_CLIENT_EMAIL`、`FIREBASE_PRIVATE_KEY` は設定しません。App HostingはAdmin SDKをADCで初期化できるサービスアカウントを作成します。[App HostingとFirebase Admin SDKの公式説明](https://firebase.google.com/docs/app-hosting/about-app-hosting)

ローカル開発では、Git管理外かつリポジトリ外へ保存したサービスアカウントJSONをApplication Default Credentialsとして使う方法を推奨します。たとえば `/Users/<MAC_USERNAME>/.config/firebase/<SERVICE_ACCOUNT_FILE>.json` へ保存し、所有者だけが読める権限にして、`.env.local` に次を設定します。

```dotenv
FIREBASE_PROJECT_ID=schedule-share-4ff0e
GOOGLE_APPLICATION_CREDENTIALS=/Users/<MAC_USERNAME>/.config/firebase/<SERVICE_ACCOUNT_FILE>.json
```

JSONファイルをプロジェクト内、Downloadsへ置いたまま、OneDrive共有フォルダ、チャットへ保存しません。実ファイル名、JSON本文、秘密鍵をスクリーンショットへ含めません。

inline証明書は、JSONを使えないローカル開発時だけのfallbackです。`.env.local` へ `FIREBASE_CLIENT_EMAIL` と `FIREBASE_PRIVATE_KEY` を必ず対で設定します。private keyはdouble quote内の1行で、改行を実改行ではなく文字列 `\n` として保存します。現行コードは初期化時にこの `\n` を改行へ戻します。

```dotenv
FIREBASE_PROJECT_ID=schedule-share-4ff0e
FIREBASE_CLIENT_EMAIL=<SERVICE_ACCOUNT_EMAIL>
FIREBASE_PRIVATE_KEY="<PRIVATE_KEY_WITH_LITERAL_BACKSLASH_N>"
```

これは書式だけを示すplaceholderです。実際の鍵を文書、Git、チャット、コマンドライン、シェル履歴へ貼り付けません。`.env.local` はGit管理対象外であることを `git status --short` でも確認します。片方だけのinline設定はアプリが拒否します。

### 5-5. secret参照だけがYAMLにあることを確認する

CLIの案内で `apphosting.yaml` へsecret参照を追加した場合、次のように `secret:` が秘密名を参照し、`value:` に秘密値が入っていないことを確認します。

```yaml
env:
  - variable: MICROSOFT_TENANT_ID
    secret: MICROSOFT_TENANT_ID
    availability:
      - RUNTIME
  - variable: MICROSOFT_CLIENT_ID
    secret: MICROSOFT_CLIENT_ID
    availability:
      - RUNTIME
  - variable: MICROSOFT_CLIENT_SECRET
    secret: MICROSOFT_CLIENT_SECRET
    availability:
      - RUNTIME
  - variable: GOOGLE_CLIENT_ID
    secret: GOOGLE_CLIENT_ID
    availability:
      - RUNTIME
  - variable: GOOGLE_CLIENT_SECRET
    secret: GOOGLE_CLIENT_SECRET
    availability:
      - RUNTIME
  - variable: GOOGLE_TOKEN_ENCRYPTION_KEY
    secret: GOOGLE_TOKEN_ENCRYPTION_KEY
    availability:
      - RUNTIME
  - variable: SYNC_JOB_SECRET
    secret: SYNC_JOB_SECRET
    availability:
      - RUNTIME
```

実際のファイルへは既存設定を保持したまま必要な項目だけ追加します。App Hostingの環境変数・secret変更は次のrolloutから有効です。[App Hosting環境設定](https://firebase.google.com/docs/app-hosting/configure)

Firebase Consoleの `App Hosting` → 5-1で確定したバックエンド → `Settings` → `Environment` も一覧確認します。同じ変数名がConsoleとYAMLの両方にある場合、Consoleの値がYAMLより優先されます。古いConsole値がsecret参照や本番フラグを上書きしていないか比較し、不要と確認できた重複だけをConsoleから削除します。削除前に変数名、由来、現在のrolloutを記録しますが、秘密値そのものは出力・記録しません。

### 5-6. rolloutして設定を反映・検証する

設定を含む意図したGitコミットが対象ブランチにあることを確認してから、Firebase Consoleの `App Hosting` → 対象バックエンド → `Rollouts` → `Create rollout` で、そのコミットを明示してrolloutします。CLIを使う場合は次の形式です。

```bash
firebase apphosting:rollouts:create "<APP_HOSTING_BACKEND_ID>" \
  --project schedule-share-4ff0e \
  --git-commit "<REVIEWED_GIT_COMMIT_SHA>"
```

rollout履歴でBuildとReleaseが成功したことを確認します。続けて次を確認します。

1. rolloutが意図したバックエンドID、リージョン、Git SHAを使用している。
2. `apphosting.yaml` はsecret名だけを参照し、秘密値を含まない。
3. 対象バックエンドのサービスアカウントだけが必要なsecretを参照できる。
4. rolloutが新しいsecret versionを取り込み、管理画面の手動同期でMicrosoftとGoogleが成功する。
5. Google callbackが会社カスタムoriginへ戻り、内部同期APIは不正な `x-sync-secret` を401で拒否する。

失敗ログへ環境変数、secret versionの値、リクエストヘッダー、providerレスポンス全体を追加出力しないでください。App Hostingの[rollout公式手順](https://firebase.google.com/docs/app-hosting/rollouts)も、コミットを指定した手動rolloutを案内しています。

## 6. Cloud Schedulerを5分間隔で設定する

### 6-1. 同期用secretを一度だけ生成する

`SYNC_JOB_SECRET` は32文字以上、256文字以下の印字可能ASCIIで、カンマを含まない必要があります。次の例は64文字のBase64値を、権限を制限した一時ファイルへ保存します。値を画面へ表示したり、CLI引数へ展開したりしません。ブロックはScheduler設定と手動確認が終わるまで待機するため、このターミナルを開いたまま6-2と3を進めてください。

```bash
(
  set -eu
  set +x
  umask 077

  TMP_FILE=
  CLIPBOARD_USED=false

  cleanup_sync_secret() {
    trap - EXIT HUP INT TERM
    if [ "${CLIPBOARD_USED:-false}" = true ] && command -v pbcopy >/dev/null 2>&1; then
      pbcopy </dev/null
    fi
    [ -z "${TMP_FILE:-}" ] || rm -f -- "$TMP_FILE"
    unset TMP_FILE CLIPBOARD_USED
  }
  trap cleanup_sync_secret EXIT
  trap 'cleanup_sync_secret; exit 129' HUP
  trap 'cleanup_sync_secret; exit 130' INT
  trap 'cleanup_sync_secret; exit 143' TERM

  TMP_FILE="$(mktemp "${TMPDIR:-/tmp}/schedule-share-sync-secret.XXXXXX")"
  chmod 600 "$TMP_FILE"

  openssl rand -base64 48 | tr -d '\n' > "$TMP_FILE"
  firebase apphosting:secrets:set SYNC_JOB_SECRET \
    --data-file "$TMP_FILE" \
    --project schedule-share-4ff0e \
    --location "<APP_HOSTING_REGION>"
  firebase apphosting:secrets:grantaccess SYNC_JOB_SECRET \
    --backend "<APP_HOSTING_BACKEND_ID>" \
    --location "<APP_HOSTING_REGION>" \
    --project schedule-share-4ff0e

  printf '%s\n' 'App Hostingへの登録が完了しました。'
  printf '%s\n' 'apphosting.yamlのsecret参照とrollout成功を確認し、Cloud SchedulerのValue欄を開いてください。'
  printf '%s\n' 'コピー直前にEnterを押してください。'
  IFS= read -r _
  if ! command -v pbcopy >/dev/null 2>&1; then
    printf '%s\n' 'pbcopyが利用できないため中止します。Macのターミナルで再実行してください。' >&2
    exit 1
  fi
  CLIPBOARD_USED=true
  pbcopy < "$TMP_FILE"
  printf '%s\n' 'Value欄へ貼り付け、貼り付け完了後にこのターミナルでEnterを押してください。'
  IFS= read -r _
  pbcopy </dev/null
  CLIPBOARD_USED=false
  printf '%s\n' 'クリップボードを空にしました。Schedulerを保存し、Force runの2xx確認後にEnterを押してください。'
  IFS= read -r _
)
```

App Hosting側へsecret参照を追加してrolloutし、rollout成功後に次のScheduler設定へ進みます。コピーは利用者がEnterを押して明示的に開始し、貼り付け後のEnterでmacOSのクリップボードを空にします。さらに最後のEnter、コマンド失敗、または割り込みのどれで終了しても、trapが一時ファイルと使用中のクリップボードを後始末します。一時ファイル削除後は同じ値を手元から復元できないため、Force run確認前に最後のEnterを押さないでください。[Firebase CLIリファレンス](https://firebase.google.com/docs/cli)は `apphosting:secrets:set` の `--data-file` と、バックエンド・リージョンを指定する `apphosting:secrets:grantaccess` を案内しています。

### 6-2. Cloud Consoleでジョブを作る

ヘッダー値を `gcloud --headers=...` に直接書くとシェル履歴へ残るため、初回はGoogle Cloud Consoleで設定します。

重要: `x-sync-secret` はCloud Schedulerのjob resourceにHTTP header値として保存されます。JobのGet/List APIはHTTP targetのheader名と値を含むresourceを返し、`roles/cloudscheduler.viewer`、Project Viewer、Cloud Scheduler Job Runnerなど `cloudscheduler.jobs.fullView` を含む権限の利用者は閲覧できる可能性があります。Secret Managerと同等の秘匿保存ではありません。Cloud Schedulerの閲覧権限を運用担当者の最小人数へ限定し、jobのJSON、`gcloud scheduler jobs describe` の出力、Console画面をチャット、Issue、ログ保存先へ共有しません。[Cloud Scheduler Job resource](https://cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs)と[Cloud Scheduler IAM権限](https://cloud.google.com/iam/docs/roles-permissions/cloudscheduler)で確認できます。

1. Google Cloud Consoleでプロジェクト `schedule-share-4ff0e` を確認します。
2. `Cloud Scheduler` → `Create job` を選びます。
3. Nameは `schedule-share-calendar-sync`、RegionはApp Hostingに近い利用可能リージョンを選びます。
4. Frequencyへ `*/5 * * * *` を入力します。
5. Timezoneは `Asia/Tokyo` を選びます。
6. Target typeは `HTTP` を選びます。
7. URLへ次を入力します。

   ```text
   https://<APP_HOSTING_DOMAIN>/api/internal/sync/calendars
   ```

8. HTTP methodは `POST` を選びます。
9. HTTP headersへ次を追加します。

   - Name: `x-sync-secret`
   - Value: 6-1の待機中のターミナルでEnterを押し、その後にクリップボードから貼り付けた値

   値は6-1のブロックが、利用者のEnter後にだけコピーします。Value欄へ貼り付けたらすぐにターミナルへ戻ってEnterを押し、クリップボードを空にします。クリップボード履歴アプリを使用している場合は、秘密値の記録を保存しないよう事前に停止します。

10. Bodyは空のままにします。
11. Retryは次を設定します。

    - Max retry attempts: `2`
    - Max retry duration: `240s`
    - Min backoff duration: `30s`
    - Max backoff duration: `60s`
    - Attempt deadline: `240s`

12. 作成内容を再確認して保存します。

Cloud Schedulerは失敗またはタイムアウト時にretry設定に従います。前回実行が完了していない間は次の定期実行が重なることを避け、アプリ側もFirestoreの同期リースで多重実行を防ぎます。5分cron、タイムゾーン、HTTP method、header、retryの公式仕様は[Cloud Schedulerジョブ作成手順](https://cloud.google.com/scheduler/docs/creating)と[`gcloud scheduler jobs create http` リファレンス](https://cloud.google.com/sdk/gcloud/reference/scheduler/jobs/create/http)で確認できます。

### 6-3. 手動実行で確認する

1. アプリへ管理者のMicrosoft 365アカウントでログインします。
2. 管理画面で営業メンバーを登録します。MicrosoftメールアドレスはExchangeスコープの直接メンバーと一致させます。
3. 登録営業メンバー本人が `Googleカレンダー接続` 画面から個人Googleアカウントを接続します。
4. 管理画面の手動同期を実行し、MicrosoftとGoogleが別々に成功・失敗表示されることを確認します。
5. Cloud Schedulerで `Force run` を実行します。
6. Schedulerの実行結果が2xxであることと、アプリの同期時刻が更新されることを確認します。
7. カレンダーの日・週・月表示で、登録メンバーの予定が表示されることを確認します。
8. 本文、参加者、添付、会議参加URLが画面、Firestore、ログに出ていないことを確認します。
9. 6-1のターミナルへ戻り、最後のEnterを押します。trapが一時ファイルと残留クリップボードを後始末します。

内部同期APIの成功レスポンスは `status`、`members`、`succeededProviders`、`failedProviders`、`skippedProviders` の件数だけです。イベント本文やトークンは返しません。ログへリクエストヘッダー、providerレスポンス本文、Firestoreの暗号化tokenを出さないでください。

6-1のtrapが削除するのはローカルの一時コピーだけです。App Hosting Secret ManagerとCloud Schedulerの設定は残ります。

### 6-4. SchedulerのIAMと監査ログを確認する

1. Google Cloud Console → `IAM` で、Project Viewer、Cloud Scheduler Viewer、Cloud Scheduler Admin、Cloud Scheduler Job Runner、Support User等を棚卸しします。
2. `cloudscheduler.jobs.fullView` を持つ必要がない人・グループから該当ロールを外し、ジョブ編集者と実行者を必要最小限にします。組み込みロールが広すぎる場合は、組織のIAM管理者が必要権限だけのcustom roleをレビューします。
3. Cloud Audit Logsで `cloudscheduler.googleapis.com` のAdmin Activityを確認し、Create、Update、Pause、Resume、Runを誰がいつ行ったか監査します。
4. 組織方針に合わせ、GetJob/ListJobsのData Access監査ログも有効化して閲覧を追跡します。Data Accessログの保存先自体も最小権限にします。
5. `x-sync-secret` の値は実行ログへ記録しません。監査ではジョブ名、操作、操作者、時刻、結果だけを扱います。

Cloud Schedulerの[監査ログ公式リファレンス](https://cloud.google.com/scheduler/docs/audit-logging)では、Get/ListはData Access、Create/Update/Pause/Resume/RunはAdmin Activityとして案内されています。誤ったIAM付与、job詳細出力の共有、スクリーンショット、端末ログ等でheader値が露出した可能性がある場合は、影響確認を待たず8章の順序で `SYNC_JOB_SECRET` をローテーションします。

## 7. Firestore rulesと5つの複合インデックスを安全に反映する

この節のコマンドは実際に本番Firestoreのrules/indexesを変更します。差分レビューと明示的な承認が終わるまで実行しません。Firebase CLIのrules deployはConsole上のrulesを上書きします。[Firebase CLI公式リファレンス](https://firebase.google.com/docs/cli)

### 7-1. Firebase CLI認証と対象プロジェクトを確認する

プロジェクトを暗黙のactive aliasへ保存・推測せず、すべてのFirebaseプロジェクト操作に `--project schedule-share-4ff0e` を付けます。

```bash
firebase login:list --project schedule-share-4ff0e
firebase projects:list --project schedule-share-4ff0e
```

出力に `schedule-share-4ff0e` があり、自分が意図したGoogleアカウントでログインしていることを確認します。

CLIが期限切れ認証を報告した場合だけ、利用者本人が次を対話実行します。これはプロジェクト変更ではなくFirebase CLI認証の更新なので、`--project` を付けない例外です。ブラウザで自分のGoogleアカウントを選び、認証コードやcredentialを他者へ渡しません。

```bash
firebase login --reauth
```

再認証後、もう一度 `firebase projects:list --project schedule-share-4ff0e` で確認します。ログインを自動化したり、アクセストークンを環境変数へ手入力したりしません。

### 7-2. デプロイ前のindexを比較する

現在の本番indexを表示します。

```bash
firebase firestore:indexes --project schedule-share-4ff0e
```

出力とリポジトリの `firestore.indexes.json` を比較します。アプリが必要とする複合indexは次の5つです。すべてCollection scope、各フィールドはAscendingです。

1. `events`: `startEpochMs`, `endEpochMs`
2. `events`: `ownerUserId`, `startEpochMs`, `endEpochMs`
3. `events`: `source`, `startEpochMs`, `endEpochMs`
4. `events`: `ownerUserId`, `source`, `startEpochMs`, `endEpochMs`
5. `salesMembers`: `active`, `displayName`

本番にローカルファイルにないindexがある場合、それを不要と推測して削除しません。どの既存アプリ・クエリが使うかを確認し、削除の必要性を別途レビューします。FirestoreはCLIでindexを書き出し・一覧表示できることを[Firestore index定義公式資料](https://firebase.google.com/docs/reference/firestore/indexes)で案内しています。

### 7-3. rulesを確認する

`firestore.rules` は、ブラウザやモバイルのFirestoreクライアントからの直接read/writeをすべて拒否します。閲覧・管理・同期はNext.jsのサーバーAPIを通り、Firebase Admin SDKがFirestoreへアクセスします。

```text
allow read, write: if false;
```

Admin SDKなどのサーバークライアントはSecurity Rulesを迂回し、Application Default CredentialsとIAMで認可されます。したがって、App Hostingバックエンドのサービスアカウントだけへ必要最小限のFirestore IAMを付け、一般ユーザーへFirestore IAMを付けません。[Firestore server accessとIAMの公式説明](https://firebase.google.com/docs/firestore/security/insecure-rules)

### 7-4. rules/indexesだけをデプロイする

対象が `schedule-share-4ff0e` であることを再確認し、`--force` を付けずに実行します。

```bash
firebase deploy \
  --only firestore:rules,firestore:indexes \
  --project schedule-share-4ff0e
```

既存indexの削除を確認するプロンプトが出た場合は `N` または `Ctrl+C` で中止します。そのindexを使うクエリ、削除の必要性、影響をレビューし、利用者が明示的に承認するまでは削除しません。

### 7-5. デプロイ後に5つを再確認する

```bash
firebase firestore:indexes --project schedule-share-4ff0e
```

前記5つのindexが存在し、作成中のものは最終的にReadyになることを確認します。その後、管理画面の手動同期と、日・週・月の各表示でクエリエラーがないことを確認します。

## 8. シークレットをローテーションする

### Microsoft同期用シークレット

1. Entraで旧secretを残したまま新しいclient secretを作ります。
2. 5-3に記載した `MICROSOFT_CLIENT_SECRET` のset手順を、`--project schedule-share-4ff0e` と `--location "<APP_HOSTING_REGION>"` を省略せず再実行して新versionを登録します。
3. 5-3の `apphosting:secrets:grantaccess` を対象バックエンド・リージョン指定で再確認します。
4. App Hostingをrolloutします。
5. 管理画面の手動同期でMicrosoftだけを確認し、登録営業メールボックスが成功、スコープ外が拒否されることを確認します。
6. 問題がないことを確認してからEntraの旧secretを削除し、Secret Managerの旧versionを無効化します。

旧secretを先に削除すると、rollout完了までMicrosoft同期が停止します。

### Google OAuthクライアントシークレット

1. Google Auth Platformで、新旧secretが重複利用できる方式かを現在の管理画面で確認します。
2. 重複可能なら新secretを発行し、App Hostingへ登録、対象バックエンドへgrantaccess、rollout、新規接続と既存token refreshを確認してから旧secretを失効し、Secret Managerの旧versionを無効化します。
3. 重複不可なら同期のメンテナンス時間を設け、Google側変更、App Hosting secret更新、grantaccess、rollout、再接続確認を連続して行います。

### Google token暗号鍵

現行実装では複数鍵を同時利用できません。鍵を変更する前にメンテナンス時間を通知し、既存接続を切断してから新鍵を設定・rolloutし、全営業メンバーにGoogle再接続を依頼します。Firestore内の暗号化refresh tokenや鍵を復号確認目的でログへ出しません。

### Scheduler共有secret

同期APIは新旧2値を同時に受け付けません。App Hostingの新値反映からScheduler header更新まで、旧headerが401になる短い不一致時間が必ず生じるため、ジョブを停止して次の順番で管理します。

1. Cloud Schedulerジョブを一時停止します。
2. 6-1のtrap付きブロックを再実行し、新しいBase64 secretを生成します。このブロックがApp Hostingの `SYNC_JOB_SECRET` 新version登録と、5-1で確定したバックエンドへの `apphosting:secrets:grantaccess` まで実行するため、別のset/grantaccessコマンドは実行しません。ブロックが待機している間に以下を順番に実施します。
3. Secret Managerの新versionが有効で、`apphosting.yaml` が `SYNC_JOB_SECRET` のsecret名だけを参照し、対象バックエンドのサービスアカウントだけに必要なアクセスがあることを、値を表示せず確認します。
4. App Hostingをrolloutし、管理画面の手動同期でMicrosoftとGoogleの取得を確認します。この時点で旧Scheduler headerは新アプリに拒否されます。
5. 6-1の待機中ターミナルで明示的にコピーを開始し、Cloud Schedulerの `x-sync-secret` をCloud Consoleで新値へ更新します。CLI引数へ値を書きません。
6. `Force run` で2xxと件数だけの応答を確認します。
7. 6-1のターミナルで最後のEnterを押し、trapで一時ファイルとクリップボードを後始末します。
8. 定期ジョブを再開します。
9. Secret Managerで旧versionを無効化し、旧値がアプリに受け付けられないことを確認します。組織の保持期間後に旧versionを破棄します。
10. Cloud SchedulerのAdmin Activity監査ログでPause、Update、Run、Resumeの操作者・時刻・結果を確認します。job resourceやheaderをログ・作業記録へコピーしません。

誤付与または出力流出時は、同じ順序で即時ローテーションし、Cloud Scheduler IAMから不要な `cloudscheduler.jobs.fullView` 保有者を外します。旧secretは新rollout後にアプリ側で無効になり、Secret Managerの旧version無効化で保管側も使用不能にします。

## 9. 最終確認チェックリスト

- Microsoftログイン用と同期用のEntraアプリが分離され、両方ともシングルテナントである。
- Microsoftログイン用アプリに複数のownerがおり、secretの期限、交換責任者、30日前通知、Firebaseプロバイダーでの交換・ロールバック手順が運用台帳にある。台帳はメタデータだけを持ち、現行と交換中の `Value` は会社承認済みvaultだけに保管されている。
- 本番アプリ、Google OAuth callback、Firebase承認済みドメインが、Search Consoleで所有確認済みの会社カスタムドメインへ揃っている。
- 公開ホームページとプライバシーポリシーが同じ会社ドメインにあり、Googleデータ利用と読み取り専用scopeを説明している。
- Firebase Microsoftプロバイダーのリダイレクトは `https://<FIREBASE_AUTH_DOMAIN>/__/auth/handler` である。
- Google OAuthのリダイレクトは `https://<APP_HOSTING_DOMAIN>/api/google/oauth/callback` である。
- Exchange Onlineの付与ロールは `Application Calendars.Read` だけである。
- Entraにテナント全体のGraphカレンダー権限が残っていない。
- `Test-ServicePrincipalAuthorization` は営業メールボックスでTrue、対象外でFalseである。
- Graph実アクセスは営業メールボックスで200、対象外で403である。
- Googleのスコープは `openid`、`email`、`calendar.readonly` だけである。
- External/Testing中の営業GoogleアカウントはTest usersへ登録され、継続運用前に公開・検証方針が完了している。
- `oauthStates.expiresAt` のFirestore TTLが有効である。
- App Hosting本番はFirebase Admin JSON鍵を使わず、バックエンドサービスアカウントのADCを使う。
- 対象バックエンドID・リージョンを確定し、secret参照、grantaccess、Consoleの重複env、rollout後のversionを確認した。
- `ALLOW_DEMO_AUTH=false`、`USE_FIRESTORE=true` である。
- Cloud Schedulerは `*/5 * * * *`、`Asia/Tokyo`、POST、`x-sync-secret` である。
- Cloud SchedulerのfullView権限は最小化され、job詳細・header値を出力共有せず、Admin Activityと必要なData Access監査ログを確認できる。
- Firestore rulesは直接クライアントアクセスを拒否し、必要な複合indexが5つReadyである。
- 管理者、営業メンバー、他部署閲覧者の各アカウントで期待する画面と権限を確認した。
- 本文、参加者、添付、会議参加URL、token、secretが画面・Firestore・ログ・Gitへ出ていない。
