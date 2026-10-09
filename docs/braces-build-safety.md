# bracesビルド限定例外の安全条件

本書は実装・検証手順です。例外承認、main統合、Renderの変更、一般公開を承認するものではありません。
新しい判断記録は`security/risk-decisions/GHSA-vfj7-8cjw-p6xm.json`に`proposed`として保存します。
旧`brace-expansion`の記録・期限・承認者は変更しません。

## 固定範囲

- 対象は`braces@3.0.3`と`GHSA-VFJ7-8CJW-P6XM`だけ。配布物integrity、`micromatch@4.0.8`、lockfile、依存経路、制御コードを固定します。
- 親パッケージのHighも、そのHighの原因がこの組合せだけの場合に限ります。別のHigh/Critical、未解決の参照、実行時の脆弱性を許可しません。
- 期限は提案日時から最大14日で固定します。再生成で期限を延長しません。失効後の新しいマージ・デプロイは拒否します。
- 期限切れだけを理由に稼働中の購入処理を停止しません。起動時は期限ではなく実際の禁止依存の有無を確認します。

## ビルド制御

`safe-build.mjs`はコマンドを限定し、本番のDB接続情報、Shopify/Renderキー、暗号鍵、GitHub tokenを子プロセスへ渡しません。
プロファイル、npm設定、CLIキャッシュは一時ディレクトリへ隔離し、完了・失敗時に清掃します。
ローカルの秘密値入り`.env`があるプロジェクトでの実行は拒否します。OS全体の読取り権限を制限するサンドボックスではないため、本番秘密を含まない使い捨てCI環境を基本にします。

- Nodeヒープ上限は1GiB。型生成は2分、Functionテストは3分、アプリ・拡張ビルドは5分まで。
- Functionのschema/query設定は既存の`schema.graphql`と`src/*.graphql`に固定。
- Node 24の同期module hooksで、`braces`公開APIと内部parse/compile/expand/stringifyをビルド中だけ保護します。インストール済みライブラリのソースやversionは書き換えません。
- パターン長1,024文字、brace深さ32、AST深さ64、ASTノード数2,048、パターン配列64件を超えた入力・循環ASTは呼出し前に拒否します。
- 制限に違反したビルドやタイムアウトしたビルドから成果物を採用しません。制限は一般用途の安全保証ではなく、今回の既知の再帰問題への防御です。

GitHub Actionsの権限は読取り専用、checkoutの資格情報保持は無効です。未承認forkは成功扱いのskipにせず、verifyを失敗させて信頼されたブランチでの再確認を求めます。
Functionsの実行は既存のShopify/Wasmtimeテスターを使い、購入制御の中核コードは変更しません。

## 実行用依存の実体

`runtime:check`は既存lockfileから実行用manifest・lockfileを生成し、一時環境へ`npm ci --omit=dev --ignore-scripts`で実際にインストールします。
必要なPrisma Clientを生成し、lockfileの不変、全実行用依存の監査、禁止パッケージの実体・別名・入れ子・親ディレクトリからの混入を確認します。
検証記録は`.audit/runtime-package-evidence.json`へ保存し、失敗時には古い記録を再利用しません。一時環境は清掃します。

本番用`build:production`は承認済み・期限内・同一証拠の記録がないと開始できません。
ビルド後は検証済み実行用node_modulesだけへ切り替えます。コピー・切り替えに失敗した場合は元のnode_modulesを復元します。
サーバーも起動前に禁止依存と`NODE_PATH`を検査し、混入時は購入リクエストを受け付けません。

## 承認経路

1. 全テスト、Windows/Linuxビルド、実行用インストール、監査証拠を揃えます。
2. CIが`risk_not_accepted`だけで失敗する提案commitを保存します。他の失敗がある状態では承認に進みません。
3. 所有者が、対象PR・提案commit・CI実行番号・固定期限を含む明示承認を行います。
4. 承認メタデータだけを別commitへ記録します。CIは実際のGitHubコメント、所有者、CI証跡、commitの祖先関係、メタデータだけの差分を照合します。
5. 依存、制御コード、実行用構成、成果物のハッシュが変われば再確認が必要です。自動承認・延長はありません。

## Render反映前の停止位置

現在のRender設定は変更していません。従来のソースビルドのままこのPRをマージすると、起動時の依存検査が失敗する可能性があるため、マージしてはいけません。
承認後に同commitの非公開状態を保ち、次の変更をまとめて確認します。

- 暗号鍵を安全に設定し、既存ハッシュ秘密値を維持する。
- Build command候補: `npm ci --ignore-scripts --no-audit --no-fund && npm run build:production`
- 既存preDeployのPrisma migrationと`npm run start`は維持する。実行用Prisma CLI/Clientが残ることを確認する。
- 未適用migration、起動、5xx、正式ストアへの転送、権限拒否、本番依存の実体を確認する。
- 失敗時は非公開を維持する。暗号化開始後は同じ鍵・schema・互換読取りを残した修正版で復旧し、旧コードへ単純ロールバックしない。

App Version release、商品・在庫・注文・決済・返金・パスワード、一般公開の切り替えは別承認です。

参考: [上流の再帰問題と暫定対策](https://github.com/micromatch/braces/issues/70)、[GitHub Actionsの安全指針](https://docs.github.com/en/actions/reference/security/secure-use)。
