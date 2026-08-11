# Microsoft 365 認証ハードニング実装計画

## 目的

Firebase Authentication の Microsoft プロバイダーを本番用の入口にし、Firebase Admin 設定不足、無効なトークン、Microsoft 以外の認証、社外ドメインを安全に拒否する。デモ認証は `ALLOW_DEMO_AUTH=true` の場合だけ有効にする。

## 実装範囲

- [x] `src/server/auth.test.ts` に認証境界の失敗テストを追加する。
  - [x] Firebase Admin 未設定かつデモ無効なら 500 を返す。
  - [x] 認証ヘッダーがなければ 401 を返す。
  - [x] 無効な Firebase ID トークンは 401 を返す。
  - [x] Microsoft 以外の Firebase 認証プロバイダーは 403 を返す。
  - [x] 社外ドメインは 403、許可済み社内ドメインはユーザー情報を返す。
  - [x] デモ認証は `ALLOW_DEMO_AUTH=true` のときだけ動作する。
- [x] `src/server/auth.ts` を最小限変更し、上記テストを通す。
  - [x] Firebase Admin 未設定時の自動デモ切り替えを削除する。
  - [x] Firebase ID トークン検証エラーを 401 に変換する。
  - [x] `firebase.sign_in_provider` が `microsoft.com` であることを確認する。
- [x] `src/components/ScheduleApp.test.tsx` にログイン待機・失敗表示のテストを追加する。
- [x] `src/components/ScheduleApp.tsx` に認証初期化中とログイン失敗の表示を追加し、未認証時に予定 API を呼ばないようにする。
- [x] `PROJECT.md` と `.env.example` の説明を、明示的なデモ認証に合わせて更新する。
- [x] `npm test`、`npx tsc --noEmit`、`npm run build` を実行する。

## 完了条件

- `ALLOW_DEMO_AUTH=false` では、Firebase Admin 設定が不足してもデモ認証へフォールバックしない。
- Microsoft 365 以外のログイン情報では予定 API を閲覧できない。
- 認証待機中・未認証・ログイン失敗を画面上で判別できる。
- 既存の日・週・月表示テストを含め、全テスト・型チェック・ビルドが成功する。
