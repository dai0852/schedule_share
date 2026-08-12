# Google・Microsoftカレンダー定期同期 Implementation Plan

実装項目はチェックボックス（`- [ ]`）で管理し、各工程の検証結果を記録する。

**Goal:** 管理者が事前登録した営業メンバーの個人Google CalendarとMicrosoft 365予定を、読み取り専用で5分間隔にFirestoreへ同期し、既存の日・週・月画面へ統合表示する。

**Architecture:** Microsoft予定はサーバーがclient credentialsでGraphへアクセスし、Exchange Online Application RBACで対象メールボックスを営業メンバーに限定する。Google予定は登録済み営業メンバーが初回だけOAuth同意し、暗号化したrefresh tokenをサーバー専用Firestoreコレクションへ保存する。定期同期はGoogle/Microsoftをメンバー単位・予定元単位で分離実行し、全件取得に成功した単位だけFirestoreの予定を入れ替える。

**Tech Stack:** Next.js App Router、React 19、TypeScript、Firebase Authentication、Firebase Admin SDK、Firestore、Google Calendar API、Microsoft Graph、Node.js `crypto`、Vitest、Cloud Scheduler

---

## Strategic assumptions and corrections

- 現在の`src/integrations/*`はAPI境界だけで、OAuthコード交換、refresh token管理、Graph app token取得、ページネーション、同期処理が未実装である。
- 現在の`AdminMembers`と`salesMembers`はデモデータであり、本番の事前登録を成立させるにはFirestoreを正本に変更する必要がある。
- Google OAuthのブラウザ遷移へFirebase IDトークンを自動付与できないため、開始APIは認証済み`POST`でURLを発行し、コールバックはFirestoreの一回限りのOAuth stateで元の営業メンバーを識別する。
- Google/Microsoftのレスポンス全体は保存しない。APIのfields/selectを絞り、本文、参加者、添付、会議参加URLを取得対象から外す。
- 同期が一部失敗したときに予定を空にしない。全ページ取得に成功した`memberId + source`だけ差し替える。
- 現在の作業ツリーにはログイン画面変更が未コミットで存在する。実装開始前にテストを通し、ユーザー承認後に既存PRへ反映するか、新しい同期用ブランチへ切り分ける。

## File responsibility map

### Domain

- `src/domain/member.ts`: 営業メンバー、接続状態、公開用メンバー情報の型と入力正規化。
- `src/domain/member.test.ts`: メール正規化、入力検証、公開フィールドのテスト。
- `src/domain/schedule.ts`: 安定イベントID、URLを含む場所の除去、非公開予定マスク。
- `src/domain/schedule.test.ts`: Google/Microsoft正規化の回帰テスト。

### Server and persistence

- `src/server/memberStore.ts`: Firestoreの`salesMembers`、`calendarConnections`、`syncStatus`境界。
- `src/server/memberStore.test.ts`: Firestore依存をモックした重複・権限・状態更新テスト。
- `src/server/tokenCrypto.ts`: Google refresh tokenのAES-256-GCM暗号化・復号。
- `src/server/tokenCrypto.test.ts`: 往復、改ざん、鍵長のテスト。
- `src/server/googleConnection.ts`: OAuth state作成・消費、コード交換、userinfo、接続保存。
- `src/server/googleConnection.test.ts`: state、登録済み判定、トークン応答のテスト。
- `src/server/calendarSync.ts`: メンバー単位のGoogle/Microsoft同期とFirestore差し替え。
- `src/server/calendarSync.test.ts`: 一部失敗、削除防止、成功時差し替えのテスト。
- `src/server/syncAuth.ts`: Cloud Scheduler秘密値の定数時間比較。
- `src/server/syncAuth.test.ts`: 未設定、長さ違い、不一致、一致のテスト。

### Integrations

- `src/integrations/googleCalendar.ts`: OAuth URL、token refresh、fields制限、予定ページネーション。
- `src/integrations/googleCalendar.test.ts`: URL、fields、ページネーション、失効トークンのテスト。
- `src/integrations/microsoftGraph.ts`: client credentials、Graph calendarViewページネーション。
- `src/integrations/microsoftGraph.test.ts`: token request、select、nextLink、APIエラーのテスト。

### API routes

- `app/api/admin/members/route.ts`: 管理者向け一覧・追加。
- `app/api/admin/members/[memberId]/route.ts`: 管理者向け更新。
- `app/api/admin/sync/route.ts`: 管理者向け手動同期。
- `app/api/members/route.ts`: 閲覧者向け担当者一覧。メールや接続秘密情報は返さない。
- `app/api/me/calendar-connection/route.ts`: ログイン本人の登録・Google接続状態。
- `app/api/google/oauth/start/route.ts`: 認証済みOAuth開始URL発行。
- `app/api/google/oauth/callback/route.ts`: Googleコールバックと初回同期。
- `app/api/google/connection/route.ts`: 本人による接続解除。
- `app/api/internal/sync/calendars/route.ts`: Cloud Scheduler専用同期入口。

### UI

- `src/components/AdminMembers.tsx`: Firestore正本の登録・有効化・同期状態UI。
- `src/components/AdminMembers.test.tsx`: 管理者操作のUIテスト。
- `src/components/GoogleConnectPanel.tsx`: 本人の接続・再接続・解除UI。
- `src/components/GoogleConnectPanel.test.tsx`: 未登録、未接続、接続済み、要再接続UI。
- `src/components/ScheduleApp.tsx`: Firestore由来の担当者一覧取得。
- `src/components/ScheduleApp.test.tsx`: メンバー取得と予定フィルタの回帰テスト。
- `app/admin/page.tsx`: デモ初期データ依存を削除。
- `app/connect/page.tsx`: セルフサービス接続画面を維持。

### Operations and documentation

- `.env.example`: サーバー専用OAuth、暗号化鍵、同期秘密値を追加。
- `firestore.rules`: クライアントから全コレクションを拒否し、Admin SDK経由だけにする。
- `firestore.indexes.json`: 予定期間・担当者・予定元の複合インデックス。
- `firebase.json`: Firestore rules/indexesの参照。
- `docs/setup/calendar-integrations.md`: Entra、Exchange App RBAC、Google OAuth、Cloud Schedulerの設定手順。
- `PROJECT.md`: 定期同期を現在方針へ反映。

---

### Task 0: Establish a safe implementation baseline

**Files:**
- Verify: `PROJECT.md`
- Verify: `design.md`
- Verify: `src/components/LoginScreen.tsx`
- Verify: `src/components/ScheduleApp.tsx`

- [ ] **Step 1: Inspect the active branch and all existing changes**

Run:

```bash
git status --short --branch
git diff --check
git diff --stat
```

Expected: `codex/auth-hardening`にログイン画面・デザイン・本仕様書・本計画書だけが表示され、`.env.local`や秘密鍵JSONが差分へ含まれない。

- [ ] **Step 2: Run the baseline verification**

Run:

```bash
npm test
npx tsc --noEmit
npm run build
```

Expected: テスト、型チェック、ビルドがすべて終了コード0。

- [ ] **Step 3: Decide the Git checkpoint before feature edits**

既存のログイン画面変更を既存Draft PRへ追加する場合は、ユーザーからコミット・Pushの明示承認を得てから次を実行する。

```bash
git add PROJECT.md app/globals.css app/page.tsx design.md src/components/LoginScreen.tsx src/components/ScheduleApp.tsx src/components/ScheduleApp.test.tsx docs/plans
git commit -m "Add dedicated Microsoft login experience"
git push
```

Expected: 同期実装を始める時点で、既存UI変更との境界がコミットとして追跡できる。承認がない場合はコミットせず、同じ作業ツリーで差分を厳密に維持する。

---

### Task 1: Add the member domain model and safe event normalization

**Files:**
- Create: `src/domain/member.ts`
- Create: `src/domain/member.test.ts`
- Modify: `src/domain/schedule.ts`
- Modify: `src/domain/schedule.test.ts`

- [ ] **Step 1: Write failing member and event privacy tests**

Create tests for the exact public/member shapes and deterministic event IDs:

```ts
import { describe, expect, it } from "vitest";
import { normalizeMicrosoftEmail, toPublicMember } from "@/domain/member";

describe("member domain", () => {
  it("normalizes the Microsoft email used for allow-list matching", () => {
    expect(normalizeMicrosoftEmail(" Sales@Example.CO.JP ")).toBe("sales@example.co.jp");
  });

  it("does not expose Google identity or token fields to viewers", () => {
    expect(toPublicMember({
      id: "member-1",
      displayName: "田中",
      department: "営業部",
      microsoftEmail: "tanaka@example.co.jp",
      active: true,
      microsoftSyncEnabled: true,
      googleConnectionStatus: "connected",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
    })).toEqual({ id: "member-1", displayName: "田中", department: "営業部" });
  });
});
```

Add schedule assertions:

```ts
expect(mapped.eventId).toBe("microsoft:member-1:event-1");
expect(mapped.location).toBe("");
expect(mapped.isOnlineMeeting).toBe(true);
```

Use a source event whose location is `https://teams.microsoft.com/l/meetup-join/...`.

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
npx vitest run src/domain/member.test.ts src/domain/schedule.test.ts
```

Expected: FAIL because `member.ts`, deterministic owner-scoped IDs, and URL sanitization do not exist.

- [ ] **Step 3: Implement the domain types and minimal helpers**

Define:

```ts
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
  return { id: member.id, displayName: member.displayName, department: member.department };
}
```

Change normalized event IDs to `${source}:${owner.ownerUserId}:${sourceEventId}`. Add `sanitizeLocation()` that returns an empty string when the location contains an `http://` or `https://` URL. Keep private events masked as `予定あり`.

- [ ] **Step 4: Run focused and full domain tests**

Run:

```bash
npx vitest run src/domain/member.test.ts src/domain/schedule.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only with Git authorization**

```bash
git add src/domain/member.ts src/domain/member.test.ts src/domain/schedule.ts src/domain/schedule.test.ts
git commit -m "Add calendar member domain model"
```

---

### Task 2: Implement the Firestore member repository

**Files:**
- Create: `src/server/memberStore.ts`
- Create: `src/server/memberStore.test.ts`

- [ ] **Step 1: Write failing repository tests with a fake Firestore boundary**

Test these behaviors:

```ts
it("rejects a duplicate normalized Microsoft email", async () => {
  await expect(store.createMember({
    displayName: "田中",
    department: "営業部",
    microsoftEmail: " TANAKA@example.co.jp ",
  })).rejects.toThrow("このMicrosoftメールアドレスは登録済みです。");
});

it("finds only an active member for Google self-service connection", async () => {
  expect(await store.findActiveMemberByMicrosoftEmail("tanaka@example.co.jp"))
    .toMatchObject({ id: "member-1", active: true });
});
```

Also cover list and update validation, UUID public IDs that expose neither email nor its hash, a private email-index transaction that rejects concurrent normalized duplicates, and active-member lookup through that index. Cover runtime decoding failures for member, index, connection, and sync-status data; connection save/delete atomicity with status changes and rollback; reconnect-required's dedicated transition; sync-status undefined-to-null normalization and error-message truncation; and a fake Firestore boundary that rejects recursive `undefined` values.

- [ ] **Step 2: Run the test and confirm RED**

```bash
npx vitest run src/server/memberStore.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 3: Implement a focused repository API**

Expose this interface and default Firestore implementation:

```ts
export interface MemberStore {
  listMembers(): Promise<SalesMemberRecord[]>;
  createMember(input: CreateMemberInput): Promise<SalesMemberRecord>;
  updateMember(memberId: string, input: UpdateMemberInput): Promise<SalesMemberRecord>;
  findActiveMemberByMicrosoftEmail(email: string): Promise<SalesMemberRecord | null>;
  getConnection(memberId: string): Promise<CalendarConnectionRecord | null>;
  saveConnection(record: CalendarConnectionRecord): Promise<void>;
  deleteConnection(memberId: string): Promise<void>;
  saveSyncStatus(status: SyncStatusRecord): Promise<void>;
  getSyncStatuses(memberId?: string): Promise<SyncStatusRecord[]>;
}
```

Use Admin SDK only. Create public member IDs with `crypto.randomUUID()`. Use the private `memberEmailIndex/{sha256(normalizedEmail)}` document for duplicate detection; transactionally check that index, create the UUID member document, and create the index record together. Decode every Firestore record at runtime before using it, including document-ID consistency, required types, unions, and ISO timestamps. Normalize optional sync-status fields to `null` before storage so no `undefined` reaches Firestore, and sanitize stored error messages to one line with a 500-character limit.

Save/delete a Google connection and its corresponding `googleConnectionStatus` transition in the same transaction. Only these operations set `connected` or `not_connected`. Task 9 adds the fenced, revision-aware atomic reconnect-failure operation after the synchronization lease types exist.

- [ ] **Step 4: Run the repository tests**

```bash
npx vitest run src/server/memberStore.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only with Git authorization**

```bash
git add src/server/memberStore.ts src/server/memberStore.test.ts
git commit -m "Add Firestore calendar member store"
```

---

### Task 3: Replace the demo admin member API and UI

**Files:**
- Modify: `app/api/admin/members/route.ts`
- Create: `app/api/admin/members/[memberId]/route.ts`
- Create: `app/api/members/route.ts`
- Modify: `src/components/AdminMembers.tsx`
- Create: `src/components/AdminMembers.test.tsx`
- Modify: `app/admin/page.tsx`

- [ ] **Step 1: Write failing admin UI and input validation tests**

Cover an administrator adding a member and a duplicate API error:

```tsx
render(<AdminMembers />);
fireEvent.change(screen.getByLabelText("氏名"), { target: { value: "田中" } });
fireEvent.change(screen.getByLabelText("Microsoftメールアドレス"), {
  target: { value: "tanaka@example.co.jp" },
});
fireEvent.click(screen.getByRole("button", { name: "営業メンバーを追加" }));
expect(await screen.findByText("田中")).toBeInTheDocument();
```

Add pure route input validation for empty name, malformed email, and missing department.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/components/AdminMembers.test.tsx
```

Expected: FAIL because the component still requires demo props and has no form.

- [ ] **Step 3: Implement authenticated admin routes**

Use `requireAppUser()` and `canManage()` for every admin method. POST accepts only:

```ts
interface CreateMemberBody {
  displayName: string;
  department: string;
  microsoftEmail: string;
}
```

PATCH accepts `displayName`, `department`, `active`, and `microsoftSyncEnabled`. Never accept Google token fields from the browser. Add `GET /api/members` that returns `toPublicMember()` for active members only.

- [ ] **Step 4: Implement the admin UI**

On mount, obtain the Firebase ID token and fetch `/api/admin/members`. Add the registration form, active toggle, Microsoft status, Google status, last sync, and latest error. Remove `salesMembers` from `app/admin/page.tsx`.

- [ ] **Step 5: Run focused tests and type check**

```bash
npx vitest run src/components/AdminMembers.test.tsx src/server/memberStore.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit only with Git authorization**

```bash
git add app/api/admin/members app/api/members src/components/AdminMembers.tsx src/components/AdminMembers.test.tsx app/admin/page.tsx
git commit -m "Add persistent sales member administration"
```

---

### Task 4: Encrypt Google refresh tokens

**Files:**
- Create: `src/server/tokenCrypto.ts`
- Create: `src/server/tokenCrypto.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing encryption tests**

```ts
it("round-trips a refresh token without storing plaintext", () => {
  const encrypted = encryptSecret("refresh-token", key);
  expect(encrypted.ciphertext).not.toContain("refresh-token");
  expect(decryptSecret(encrypted, key)).toBe("refresh-token");
});

it("rejects modified ciphertext", () => {
  const encrypted = encryptSecret("refresh-token", key);
  expect(() => decryptSecret({ ...encrypted, ciphertext: "AAAA" }, key)).toThrow();
});
```

Use a fixed 32-byte test key encoded as base64.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/server/tokenCrypto.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement AES-256-GCM**

Return only base64 strings:

```ts
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
}
```

Decode `GOOGLE_TOKEN_ENCRYPTION_KEY` as base64 and require exactly 32 bytes. Use a random 12-byte IV per encryption. Do not log plaintext or the encryption key.

- [ ] **Step 4: Run focused tests**

```bash
npx vitest run src/server/tokenCrypto.test.ts
```

Expected: PASS, including modified tag/ciphertext rejection.

- [ ] **Step 5: Document the environment variable without a value**

Add:

```dotenv
GOOGLE_TOKEN_ENCRYPTION_KEY=
```

Do not add a generated key to the repository.

- [ ] **Step 6: Commit only with Git authorization**

```bash
git add src/server/tokenCrypto.ts src/server/tokenCrypto.test.ts .env.example
git commit -m "Encrypt stored Google refresh tokens"
```

---

### Task 5: Complete Google OAuth self-service connection

**Files:**
- Modify: `src/integrations/googleCalendar.ts`
- Create: `src/integrations/googleCalendar.test.ts`
- Create: `src/server/googleConnection.ts`
- Create: `src/server/googleConnection.test.ts`
- Create: `app/api/google/oauth/start/route.ts`
- Create: `app/api/google/oauth/callback/route.ts`
- Create: `app/api/google/connection/route.ts`
- Create: `app/api/me/calendar-connection/route.ts`

- [ ] **Step 1: Write failing OAuth URL and state tests**

Assert the authorization URL contains exactly the required scopes and offline access:

```ts
expect(url.searchParams.get("scope")?.split(" ").sort()).toEqual([
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "openid",
].sort());
expect(url.searchParams.get("access_type")).toBe("offline");
expect(url.searchParams.get("include_granted_scopes")).toBe("true");
expect(url.searchParams.get("state")).toBe("one-time-state");
```

Test that an unregistered Microsoft email is rejected before an OAuth URL is issued, expired state is rejected, and state can be consumed only once.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/integrations/googleCalendar.test.ts src/server/googleConnection.test.ts
```

Expected: FAIL because state storage and code exchange do not exist.

- [ ] **Step 3: Implement OAuth state and code exchange**

`createGoogleOAuthStart(user)` must:

1. Find an active member by `user.email`.
2. Generate 32 random bytes as state.
3. Store only a SHA-256 hash in `oauthStates` with member ID and 10-minute expiration.
4. Return the authorization URL.

`completeGoogleOAuth(code, state)` must:

1. Hash and transactionally consume the state document.
2. POST the code to `https://oauth2.googleapis.com/token`.
3. Require `access_token` and `refresh_token` for a first connection.
4. Fetch `https://openidconnect.googleapis.com/v1/userinfo`.
5. Encrypt the refresh token.
6. Save the connection against the member ID from state.
7. Set status to `connected`.

- [ ] **Step 4: Implement the routes**

- POST start: Firebase ID token required; returns `{ authorizationUrl }`.
- GET callback: validates query parameters and completes connection. Task 9で同期サービスを追加した後、Next.js `after()`へ対象メンバーの初回同期を登録し、`/connect?google=connected&sync=pending`へ即時リダイレクトする。
- GET me: returns only registration status, Google email, connection status, and last sync.
- DELETE connection: authenticated member only; deletes encrypted token and marks `not_connected`.

Never return refresh/access tokens.

- [ ] **Step 5: Run focused tests and type check**

```bash
npx vitest run src/integrations/googleCalendar.test.ts src/server/googleConnection.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit only with Git authorization**

```bash
git add src/integrations/googleCalendar.ts src/integrations/googleCalendar.test.ts src/server/googleConnection.ts src/server/googleConnection.test.ts app/api/google app/api/me
git commit -m "Add self-service Google Calendar connection"
```

---

### Task 6: Build the Google connection UI

**Files:**
- Modify: `src/components/GoogleConnectPanel.tsx`
- Create: `src/components/GoogleConnectPanel.test.tsx`
- Modify: `app/connect/page.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Write failing state-driven UI tests**

Cover all four states:

```tsx
expect(await screen.findByText("営業メンバーとして登録されていません")).toBeInTheDocument();
expect(screen.queryByRole("button", { name: "Googleカレンダーを接続" })).not.toBeInTheDocument();
```

```tsx
expect(await screen.findByRole("button", { name: "Googleカレンダーを接続" })).toBeEnabled();
```

```tsx
expect(await screen.findByText("personal@gmail.com")).toBeInTheDocument();
expect(screen.getByRole("button", { name: "接続解除" })).toBeEnabled();
```

```tsx
expect(await screen.findByRole("button", { name: "Googleカレンダーを再接続" })).toBeEnabled();
```

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/components/GoogleConnectPanel.test.tsx
```

Expected: FAIL because the component only checks a public client ID.

- [ ] **Step 3: Implement the self-service UI**

Fetch `/api/me/calendar-connection` with the Firebase ID token. On connect/reconnect, POST `/api/google/oauth/start`, then call `window.location.assign(authorizationUrl)`. Disable the button while starting OAuth. On disconnect, require a confirmation UI and call DELETE.

Keep the existing `design.md` visual language: CSA Green, black thin borders, pill buttons, 40px major card radius, grid background.

- [ ] **Step 4: Run UI tests and type check**

```bash
npx vitest run src/components/GoogleConnectPanel.test.tsx
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Commit only with Git authorization**

```bash
git add src/components/GoogleConnectPanel.tsx src/components/GoogleConnectPanel.test.tsx app/connect/page.tsx app/globals.css
git commit -m "Add Google Calendar connection onboarding"
```

---

### Task 7: Fetch all Google events without sensitive fields

**Files:**
- Modify: `src/integrations/googleCalendar.ts`
- Modify: `src/integrations/googleCalendar.test.ts`

- [ ] **Step 1: Write failing refresh and pagination tests**

Mock two event pages and assert the second call uses `pageToken`. Assert `fields` is exactly limited to pagination and safe event properties:

```text
nextPageToken,items(id,summary,location,visibility,start(date,dateTime),end(date,dateTime),updated,conferenceData(conferenceSolution(key(type))))
```

Assert the URL does not request `description`, `attendees`, `attachments`, `hangoutLink`, `conferenceData.entryPoints`, or meeting URLs.

Test token refresh POST parameters: `client_id`, `client_secret`, `refresh_token`, `grant_type=refresh_token`.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/integrations/googleCalendar.test.ts
```

Expected: FAIL because current implementation returns one page and does not refresh tokens.

- [ ] **Step 3: Implement refresh and complete pagination**

Add:

```ts
export async function refreshGoogleAccessToken(refreshToken: string): Promise<string>;
export async function fetchAllGoogleEvents(params: GoogleFetchParams): Promise<NormalizedEvent[]>;
```

Use `singleEvents=true`, `orderBy=startTime`, `timeMin`, `timeMax`, `maxResults=2500`, `timeZone=Asia/Tokyo`, and the safe `fields` projection. Continue until `nextPageToken` is absent.

- [ ] **Step 4: Run focused tests**

```bash
npx vitest run src/integrations/googleCalendar.test.ts src/domain/schedule.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit only with Git authorization**

```bash
git add src/integrations/googleCalendar.ts src/integrations/googleCalendar.test.ts src/domain/schedule.ts src/domain/schedule.test.ts
git commit -m "Fetch paginated Google calendar events safely"
```

---

### Task 8: Obtain Microsoft app tokens and fetch all Graph events

**Files:**
- Modify: `src/integrations/microsoftGraph.ts`
- Create: `src/integrations/microsoftGraph.test.ts`
- Modify: `.env.example`

- [ ] **Step 1: Write failing client credentials and pagination tests**

Assert the token request uses the tenant-specific endpoint and `.default` scope:

```ts
expect(tokenUrl).toBe(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`);
expect(body.get("scope")).toBe("https://graph.microsoft.com/.default");
expect(body.get("grant_type")).toBe("client_credentials");
```

Mock two Graph pages and assert `@odata.nextLink` is followed for both `$skip` and `$skiptoken`. Assert `$select` excludes `body`, `attendees`, `onlineMeeting`, join URLs, and the calendarView-unsupported `lastModifiedDateTime`.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/integrations/microsoftGraph.test.ts
```

Expected: FAIL because app token acquisition and nextLink pagination do not exist.

- [ ] **Step 3: Implement token acquisition and complete pagination**

Add:

```ts
export async function getMicrosoftAppAccessToken(): Promise<string>;
export async function fetchAllMicrosoftCalendarView(params: MicrosoftFetchParams): Promise<NormalizedEvent[]>;
```

Use a tenant-specific endpoint, client ID, server-only secret, `.default`, and client credentials. Follow the opaque next link only when it remains on HTTPS `graph.microsoft.com` and the exact same user calendarView resource; accept Microsoft Graph's `$skip` or `$skiptoken` paging while rejecting changed windows, sensitive selects, and unknown query keys. Keep the existing Tokyo timezone preference.

`MicrosoftFetchParams` must include a validated RFC 3339 `syncedAt`. Because `calendarView` does not support selecting `lastModifiedDateTime`, use that fixed per-run value for every normalized Microsoft event's `updatedAt`; do not remove `$select` or substitute the event start time.

- [ ] **Step 4: Add server-only environment names**

```dotenv
MICROSOFT_TENANT_ID=
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
```

Do not prefix the client secret with `NEXT_PUBLIC_`.

- [ ] **Step 5: Run tests and type check**

```bash
npx vitest run src/integrations/microsoftGraph.test.ts src/domain/schedule.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit only with Git authorization**

```bash
git add src/integrations/microsoftGraph.ts src/integrations/microsoftGraph.test.ts .env.example
git commit -m "Add Microsoft Graph calendar reader"
```

---

### Task 9: Implement failure-safe Firestore synchronization

**Files:**
- Create: `src/server/calendarSync.ts`
- Create: `src/server/calendarSync.test.ts`
- Create: `src/server/googleOAuthCallback.ts`
- Create: `src/server/events.test.ts`
- Modify: `src/server/memberStore.ts`
- Modify: `src/server/memberStore.test.ts`
- Modify: `src/server/googleConnection.ts`
- Modify: `src/server/googleConnection.test.ts`
- Modify: `src/server/googleRoutes.test.ts`
- Modify: `src/server/memberAdmin.ts`
- Modify: `src/server/memberAdmin.test.ts`
- Modify: `src/server/events.ts`
- Modify: `app/api/google/oauth/callback/route.ts`
- Modify: `src/components/GoogleConnectPanel.tsx`
- Modify: `src/components/GoogleConnectPanel.test.tsx`
- Modify: `docs/plans/2026-08-11-calendar-sync-design.md`
- Modify: `docs/plans/2026-08-11-calendar-sync-implementation.md`

- [ ] **Step 1: Write failing synchronization behavior tests**

Use dependency injection for fetchers and persistence. Cover:

```ts
it("replaces only a source that completed every page", async () => {
  googleFetcher.mockRejectedValue(new Error("rate_limited"));
  microsoftFetcher.mockResolvedValue([microsoftEvent]);
  await syncMember(member, range, dependencies);
  expect(store.replaceProviderEvents).toHaveBeenCalledWith(
    member.id,
    "microsoft",
    range,
    [microsoftEvent],
    expect.objectContaining({ lease: expect.anything() }),
  );
  expect(store.replaceProviderEvents).not.toHaveBeenCalledWith(
    member.id,
    "google",
    expect.anything(),
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});
```

Also test Google reconnect-required handling, disabled Microsoft sync, inactive member exclusion, deterministic time range, sync status redaction, SHA-256 Firestore document IDs, and the administrator-visible error allowlist. Mutation tests must prove raw provider event IDs containing `/` never become document paths and raw thrown messages never reach Firestore or the admin DTO. Add race tests for lease expiry/takeover, old-run release, heartbeat cleanup, Google disconnect/reconnect/token rotation, and tests for three-member concurrency, shared Microsoft app-token failure isolation, Asia/Tokyo date-only overlap boundaries/all-day events, response-after scheduling, and non-public internal fields. Prove reconnect-required member/status updates roll back together, and prove upsert/delete transaction chunks stay at or below both 400 operations and the 7 MiB conservative byte estimate.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/server/calendarSync.test.ts
```

Expected: FAIL because the sync service does not exist.

- [ ] **Step 3: Implement the synchronization boundary**

Expose:

```ts
export async function syncAllCalendars(options?: { now?: Date; memberId?: string }): Promise<SyncSummary>;
export async function syncMemberCalendars(member: SalesMemberRecord, range: SyncRange): Promise<MemberSyncSummary>;
```

Compute range as 30 days before through 180 days after `now`. Acquire a Firestore transaction lease with a monotonic fence, renew it by heartbeat, and revalidate the lease in every persistence transaction. Fetch Google and Microsoft independently using `Promise.allSettled`, with at most three members in flight and one shared Microsoft app-token promise per run. Replace events in fenced transactions of at most 400 writes and an estimated serialized size of at most 7 MiB. Estimate UTF-8 document path and JSON payload bytes with conservative protobuf/index overhead; reject an individual operation that exceeds the cap. For stale deletes, retain the fully runtime-validated stored document returned by the overlap query and include the deleted document plus index-entry estimate rather than path bytes alone. Missing/unavailable/corrupt query data fails closed before deletion. Delete stale events only after the corresponding source fetch completed successfully, applying the same operation/byte caps to deletes.

Pass one RFC 3339 `syncedAt` derived from the sync run's fixed `now` into every Microsoft fetch so all normalized Microsoft events in that run share the same truthful persistence timestamp.

When Google's token endpoint returns `invalid_grant`, the integration maps it to the allowlisted `reconnect_required`; atomically update the member connection state and safe Google sync-status error in one fenced, expected-revision transaction. On transaction, lock, or revision failure update neither record and do not use a non-atomic fallback. Delete no events, and never include token contents in the error record. Persist only allowlisted sync error codes and fixed safe messages; map unknown exceptions to generic `sync_failed` instead of persisting `error.message`.

- [ ] **Step 4: Add Firestore replacement methods**

Add:

```ts
interface SyncLease {
  ownerId: string;
  fence: number;
}

interface SyncWriteGuard {
  lease: SyncLease;
  now(): Date;
}

replaceProviderEvents(
  memberId: string,
  provider: SyncProvider,
  range: SyncRange,
  events: NormalizedEvent[],
  guard: SyncWriteGuard,
  expectedRevision?: string,
): Promise<void>;
saveSyncStatus(status: SyncStatusRecord, guard: SyncWriteGuard, expectedRevision?: string): Promise<void>;
saveGoogleReconnectFailure(
  status: SyncStatusRecord,
  guard: SyncWriteGuard,
  expectedRevision: string,
): Promise<void>;
acquireSyncLock(now: Date): Promise<SyncLease | null>;
renewSyncLock(lease: SyncLease, now: Date): Promise<void>;
releaseSyncLock(lease: SyncLease): Promise<void>;
```

Define `SyncProvider` as `"google" | "microsoft"`. Lock acquisition transactionally increments a persistent monotonic `fence`; heartbeat renews only the matching `ownerId + fence` before expiry. Every event/status/reconnect write revalidates `ownerId + fence + expiresAt` inside the same Firestore transaction, taking a fresh guard time for each transaction. Release preserves the lock document and fence while setting `ownerId: null` and an expired `expiresAt`; an old lease can neither release nor write through a newer fence.

Google synchronization captures the connection's server-generated UUID `revision`. Google event replacement, success/error status, and reconnect-required updates also verify `expectedRevision` in their write transaction. Disconnect, reconnect, or token rotation therefore invalidates results from the older connection without exposing revision or tokens in public DTOs.

Store validated internal `startEpochMs` and `endEpochMs` fields, and query stale events by `ownerUserId`, provider source, `startEpochMs < range.end`, and `endEpochMs > range.start`. Convert timed RFC 3339 values as absolute instants. Convert strict date-only `YYYY-MM-DD` values to Asia/Tokyo (`+09:00`) midnight, keeping the all-day end exclusive, and use the same `eventBoundaryToEpochMs` helper for start/end order validation, storage, and overlap. Reject mixed date-only/timed boundaries at the store boundary, and reject equal or reversed all-day/timed ranges. Treat `google` as source `google` and provider `microsoft` as both source `microsoft` and `teams`. These internal epoch fields are stripped from the events API response. Task 12 must deploy the matching composite index. Use owner-scoped event IDs so one member cannot overwrite another member's source event.

Derive the Firestore document ID as a fixed 64-character lowercase SHA-256 hex digest of the normalized `event.eventId`. Never use a raw provider event ID as a document path. Validate the event payload and its hash before fenced transaction writes, and keep the original deterministic `eventId` inside the document.

- [ ] **Step 5: Trigger the first member sync after Google connection**

After the connection record is saved, register `syncAllCalendars({ memberId })` with Next.js `after()` and immediately redirect with `google=connected&sync=pending`. If initial sync fails, keep the valid Google connection and let the safe status/next scheduled run retry; never put a raw background error in the redirect.

- [ ] **Step 6: Run focused tests**

```bash
npx vitest run src/server/calendarSync.test.ts src/server/memberStore.test.ts src/server/googleConnection.test.ts src/server/googleRoutes.test.ts src/server/memberAdmin.test.ts src/server/events.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit only with Git authorization**

```bash
git add src/server/calendarSync.ts src/server/calendarSync.test.ts src/server/memberStore.ts src/server/memberStore.test.ts src/server/googleConnection.ts src/server/googleConnection.test.ts src/server/googleOAuthCallback.ts src/server/googleRoutes.test.ts src/server/memberAdmin.ts src/server/memberAdmin.test.ts src/server/events.ts src/server/events.test.ts app/api/google/oauth/callback/route.ts src/components/GoogleConnectPanel.tsx src/components/GoogleConnectPanel.test.tsx docs/plans/2026-08-11-calendar-sync-design.md docs/plans/2026-08-11-calendar-sync-implementation.md
git commit -m "Add failure-safe calendar synchronization"
```

---

### Task 10: Add scheduled and manual synchronization endpoints

**Files:**
- Create: `app/api/internal/sync/calendars/route.ts`
- Create: `app/api/admin/sync/route.ts`
- Create: `src/server/syncAuth.ts`
- Create: `src/server/syncAuth.test.ts`
- Modify: `src/components/AdminMembers.tsx`
- Modify: `src/components/AdminMembers.test.tsx`
- Modify: `.env.example`

- [ ] **Step 1: Write failing authorization tests for sync entrypoints**

Test the extracted scheduler and administrator validators:

```ts
expect(isValidSyncSecret(undefined, "configured-secret")).toBe(false);
expect(isValidSyncSecret("wrong", "configured-secret")).toBe(false);
expect(isValidSyncSecret("configured-secret", "configured-secret")).toBe(true);
await expect(requireAdminSyncRequest(nonAdminRequest)).rejects.toMatchObject({ status: 403 });
```

Mock `requireAppUser()` for `requireAdminSyncRequest()`. Assert that a valid constant-time secret comparison calls `syncAllCalendars()` once from the thin route.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/server/calendarSync.test.ts src/server/syncAuth.test.ts src/components/AdminMembers.test.tsx
```

Expected: FAIL until endpoints and manual button exist.

- [ ] **Step 3: Implement internal scheduler authentication**

Read `x-sync-secret`, compare it to `SYNC_JOB_SECRET` with `timingSafeEqual`, reject missing or length-mismatched values, call `syncAllCalendars()`, and return counts only. Never return individual event content or secrets.

- [ ] **Step 4: Implement admin manual sync**

Require Firebase authentication plus `canManage()`. Add a disabled/loading state button to `AdminMembers`. Refresh member sync statuses after completion.

- [ ] **Step 5: Document the secret name**

```dotenv
SYNC_JOB_SECRET=
```

- [ ] **Step 6: Run focused tests and type check**

```bash
npx vitest run src/server/calendarSync.test.ts src/server/syncAuth.test.ts src/components/AdminMembers.test.tsx
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 7: Commit only with Git authorization**

```bash
git add app/api/internal/sync app/api/admin/sync src/server/syncAuth.ts src/server/syncAuth.test.ts src/components/AdminMembers.tsx src/components/AdminMembers.test.tsx .env.example
git commit -m "Add scheduled calendar sync endpoints"
```

---

### Task 11: Connect synchronized members and events to the calendar UI

**Files:**
- Modify: `src/server/events.ts`
- Modify: `app/api/events/route.ts`
- Modify: `src/components/ScheduleApp.tsx`
- Modify: `src/components/ScheduleApp.test.tsx`
- Modify: `app/page.tsx`

- [ ] **Step 1: Write failing UI integration tests**

Mock `/api/members` and `/api/events`. Assert the owner selector contains the Firestore members instead of demo members:

```tsx
expect(await screen.findByRole("option", { name: "田中" })).toHaveValue("member-1");
expect(screen.queryByRole("option", { name: "デモ担当者" })).not.toBeInTheDocument();
```

Assert an owner selection adds `ownerUserId=member-1` while keeping the Firebase authorization header.

- [ ] **Step 2: Run and confirm RED**

```bash
npx vitest run src/components/ScheduleApp.test.tsx
```

Expected: FAIL because members still arrive through `initialMembers` demo props.

- [ ] **Step 3: Read synchronized events from Firestore**

Keep `NormalizedEvent` as the API response contract. In production require `USE_FIRESTORE=true`; only use demo events when `ALLOW_DEMO_AUTH=true`. Apply start/end/member/source filters server-side where possible, then reuse domain filtering as a defensive layer.

- [ ] **Step 4: Fetch public members after authentication**

Remove `initialMembers` from `ScheduleApp`. Fetch `/api/members` using the same Firebase ID token helper as `/api/events`. Populate the owner selector with `PublicSalesMember` only.

- [ ] **Step 5: Run UI tests, server tests, and type check**

```bash
npx vitest run src/components/ScheduleApp.test.tsx src/server/auth.test.ts src/domain/schedule.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit only with Git authorization**

```bash
git add src/server/events.ts app/api/events/route.ts src/components/ScheduleApp.tsx src/components/ScheduleApp.test.tsx app/page.tsx
git commit -m "Show synchronized calendar members and events"
```

---

### Task 12: Add Firestore deployment policy and indexes

**Files:**
- Create: `firestore.rules`
- Create: `firestore.indexes.json`
- Create: `firebase.json`

- [ ] **Step 1: Add deny-by-default client rules**

Use:

```text
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}
```

All application access remains through authenticated Next.js API routes using Firebase Admin SDK.

- [ ] **Step 2: Add required composite indexes**

Define indexes for:

- `events`: `startEpochMs ASC`, `endEpochMs ASC`（期間だけの閲覧query）
- `events`: `ownerUserId ASC`, `startEpochMs ASC`, `endEpochMs ASC`（担当者指定の閲覧query）
- `events`: `source ASC`, `startEpochMs ASC`, `endEpochMs ASC`（予定元指定の閲覧query）
- `events`: `ownerUserId ASC`, `source ASC`, `startEpochMs ASC`, `endEpochMs ASC`（担当者・予定元指定の閲覧query、および同期時のstale予定query）
- `salesMembers`: `active ASC`, `displayName ASC`

`events`の各queryは`startEpochMs < end`と`endEpochMs > start`という複数range filterを使うため、上記の順で複合インデックスを定義する。Task 9の差し替え処理では`ownerUserId == memberId`に加え、Googleを`source in [google]`、Microsoft providerを`source in [microsoft, teams]`へ対応付ける。これは4番目のインデックスを使い、閲覧APIの`source ==` queryと重複して別のfield順を作らない。

- [ ] **Step 3: Validate Firebase configuration locally**

Run:

```bash
npx firebase-tools firestore:indexes
```

Expected: configuration parses; if authentication is unavailable, record the auth blocker without changing rules.

- [ ] **Step 4: Commit only with Git authorization**

```bash
git add firestore.rules firestore.indexes.json firebase.json
git commit -m "Add Firestore calendar sync policy"
```

---

### Task 13: Document Microsoft, Google, and Scheduler setup

**Files:**
- Create: `docs/setup/calendar-integrations.md`
- Modify: `PROJECT.md`
- Modify: `.env.example`

- [ ] **Step 1: Write the Microsoft administrator procedure**

Document these exact outcomes:

1. The Entra app uses tenant-only accounts.
2. Server credentials are created and stored outside Git.
3. Exchange Online Application RBAC grants `Application Calendars.Read` only to the sales mailbox management scope.
4. Client credentials variables are stored as App Hosting secrets.
5. A Graph test reads one registered mailbox and fails for a mailbox outside the scope.

Do not instruct creation of `Calendars.ReadWrite`.

- [ ] **Step 2: Write the Google OAuth procedure**

Document:

1. Enable Google Calendar API.
2. Configure an External OAuth consent screen because personal Google accounts are used.
3. Add the app's HTTPS callback URI ending in `/api/google/oauth/callback`.
4. Add test users while the consent app is in testing.
5. Create a Web application OAuth client.
6. Store client ID/secret server-side.
7. Generate a 32-byte token encryption key with `openssl rand -base64 32` and store it as a secret without printing it into documentation or Git.
8. Enable a Firestore TTL policy for `oauthStates.expiresAt` so expired OAuth state records are removed automatically.

- [ ] **Step 3: Write the Cloud Scheduler procedure**

Document a 5-minute schedule `*/5 * * * *`, Asia/Tokyo timezone, POST method, the deployed `/api/internal/sync/calendars` URL, and `x-sync-secret`. Include secret rotation and manual sync verification.

- [ ] **Step 4: Update project direction**

Change `PROJECT.md` from deferred synchronization to the approved Firestore synchronization architecture. Keep the read-only/privacy constraints unchanged.

- [ ] **Step 5: Document the safe Firestore policy deployment handoff**

Document these exact safeguards:

1. Run every Firebase command with the explicit target `--project schedule-share-4ff0e`; do not persist or infer an active project alias.
2. If the CLI reports expired credentials, the user performs `firebase login --reauth` interactively. Do not automate login or handle the user's credentials.
3. Before deployment, run `firebase firestore:indexes --project schedule-share-4ff0e` and compare the deployed indexes with `firestore.indexes.json`.
4. Deploy only the reviewed Firestore policy with `firebase deploy --only firestore:rules,firestore:indexes --project schedule-share-4ff0e`. Do not add `--force`.
5. If Firebase asks to delete an existing index, reject or cancel the prompt until its query usage and deletion necessity have been reviewed and explicitly confirmed.
6. After deployment, rerun `firebase firestore:indexes --project schedule-share-4ff0e` and confirm that the five required composite indexes are present.

- [ ] **Step 6: Check documentation for secret leakage and placeholders**

```bash
rg -n "TBD|TODO|FIXME|AIza|BEGIN PRIVATE KEY|client_secret=" docs PROJECT.md .env.example
```

Expected: no placeholders or secret values.

- [ ] **Step 7: Commit only with Git authorization**

```bash
git add docs/setup/calendar-integrations.md PROJECT.md .env.example
git commit -m "Document calendar integration deployment"
```

---

### Task 14: End-to-end verification and safe handoff

**Files:**
- Verify all files changed by Tasks 1-13

- [ ] **Step 1: Run the complete automated verification**

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

Expected: all commands exit 0; Vitest reports zero failed tests.

- [ ] **Step 2: Run a repository secret scan**

```bash
git diff -- . ':!package-lock.json' | rg -n "AIza|BEGIN PRIVATE KEY|refresh[_-]?token|client[_-]?secret|GOOGLE_TOKEN_ENCRYPTION_KEY=.+|SYNC_JOB_SECRET=.+"
```

Expected: only variable names, interfaces, tests with obvious fake values, and documentation warnings appear. No real value appears.

- [ ] **Step 3: Verify the Google onboarding flow in a real browser**

Confirm:

1. Unregistered viewer sees no connection button.
2. Registered salesperson starts Google OAuth without entering an email/calendar ID.
3. Callback immediately returns to `/connect?google=connected&sync=pending`, while the initial member sync runs through `after()`.
4. Connection page shows the selected Google email and no token.
5. Disconnect and reconnect states render correctly.

- [ ] **Step 4: Verify synchronization against test accounts**

Create one safe test event in each source. Run manual sync. Confirm Firestore stores only normalized fields plus internal `startEpochMs`/`endEpochMs`, while the events API strips those internal fields and the calendar shows both events. Confirm an online meeting appears as a schedule item without a join URL. Confirm a private event displays as `予定あり` with no location.

- [ ] **Step 5: Verify failure isolation**

Temporarily revoke the Google test connection, run sync, and confirm Microsoft events remain. Restore Google connection and confirm the next sync succeeds. Test a Microsoft mailbox outside the Application RBAC scope and confirm it is denied.

- [ ] **Step 6: Review Git scope**

```bash
git status --short --branch
git diff --stat
git log --oneline --decorate -10
```

Expected: no `.env.local`, service-account JSON, build output, Playwright output, or unrelated user changes are staged.

- [ ] **Step 7: Commit, push, and update the PR only after explicit authorization**

```bash
git push
gh pr view --web
```

Do not run these commands unless the user explicitly authorizes Git publication. Report the exact branch and PR status.
