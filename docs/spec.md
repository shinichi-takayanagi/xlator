# xlator 仕様書

更新日: 2026-08-29
ステータス: Realtime接続MVP実装済み／実音声・実API確認待ち

## 1. 目的

共有マイクへ入力された日本語・英語混在の会話を、発話ごとに日本語と英語の両方へそろえて表示するローカルWebアプリを作る。

「ローカル」はUIとサーバーが `localhost` で動くことを指す。音声認識・翻訳にはOpenAI APIへのインターネット接続が必要で、完全オフライン動作ではない。

## 2. 確定したプロダクト方針

- 実装言語はブラウザ・サーバーともにTypeScriptとする。WebRTC、React、イベント型API、共有データ型を1言語で扱えるため、PythonよりこのMVPに適する
- 翻訳モデルは `gpt-realtime-translate` を使う
- 入力は1本の共有マイクとする
- 話者は発話ごとに日本語・英語を自由に切り替えられる
- 日本語ログと英語ログを別々の会話として扱わず、1発話を1つの対応レコードとして保持する
- デスクトップでは日本語を左、英語を右に表示する
- 狭い画面では日本語を上、英語を下に表示する
- 話者分離はMVP対象外とし、将来 `A` / `B` 表示を追加する
- OpenAI APIキーはサーバーだけが保持し、ブラウザへ公開しない
- ログ保存、録音、セッション履歴は現時点では実装しない

## 3. 入出力仕様

各発話の元言語を判定し、元言語側には文字起こし、反対言語側には翻訳を表示する。

| 入力言語 | 日本語ログ | 英語ログ |
| --- | --- | --- |
| 日本語 | 日本語の文字起こし | 英訳 |
| 英語 | 和訳 | 英語の文字起こし |

元言語側でもASRによる軽微な正規化は許容する。例として、`こんちわ` が `こんにちは`、`YES` が `Yes` になる可能性がある。

### 受け入れ例

入力:

```text
こんちわ、今日は暑いですね
Yes, too hot!
元気ですか？
Yep, I'm fine
```

日本語ログ:

```text
こんちわ、今日は暑いですね
ええ、とてもあつね
元気ですか？
はい、元気です！
```

英語ログ:

```text
Hello, it is hot today
YES, too hot!
How are you?
Yep, I'm fine
```

## 4. UI仕様

### レイアウト

- ヘッダーに製品名、`REALTIME`、`localhost`、GitHubリポジトリへのアイコンリンクを表示する
- 操作部に会話開始、停止、接続状態、経過時間、翻訳音声、ダウンロードを配置する
- デスクトップでは日本語ログと英語ログを左右2列で表示する
- 画面幅620px以下では上下2段へ切り替える
- ワークスペースは画面のほぼ全幅を使い、デスクトップの左右余白は12pxを基準とする
- 説明用ヒーローや対応番号の説明文は置かず、会話ログを第一表示とする

### ログ表示

- 両ログは同じ発話数、順序、通し番号を持つ
- 各行に通し番号、開始時刻、`原文` / `翻訳` / `処理中`、本文を表示する
- 確定前の行は薄く表示する
- 各パネルは独立して内部スクロールする
- 新規発話と文字列デルタの到着時は、アニメーションなしで最新位置へ即時追従する
- 初期画面にはUI確認用の16発話を表示する
- 会話開始時に初期データを消し、ライブログへ切り替える
- 停止後は取得済みライブログを画面に残す
- ページ再読み込み時は初期データへ戻る

### 接続状態

- `待機中`: 開始前または停止後
- `APIキー未設定`: 起動時の設定確認で `OPENAI_API_KEY` が見つからない
- `接続中`: マイク取得後、Realtimeセッション確立中
- `リスニング中`: 日本語向け・英語向けの両セッションが接続済み
- `接続エラー`: API設定、マイク、WebRTC、Realtimeイベントのいずれかで失敗
- 2セッションの片方だけが接続できた場合は開始せず、両方を閉じてエラーとする
- SDP応答の設定だけでは接続済みとみなさず、両方の `RTCPeerConnection.connectionState` が `connected` になってから `リスニング中` へ移る
- 接続確立が15秒以内に完了しない場合はタイムアウトエラーとする
- `接続中` の停止操作は進行中のWebRTC接続をキャンセルし、遅れて接続が成立して `リスニング中` へ戻ることを防ぐ

## 5. データモデル

日本語・英語のログを別配列にせず、次の対応レコードを配列で保持する。

```ts
type Utterance = {
  id: string;
  sequence: number;
  at: string;
  sourceLanguage: "ja" | "en" | "unknown";
  sourceText?: string;
  startMs?: number;
  endMs?: number;
  status?: "draft" | "final";
  ja: string;
  en: string;
};
```

初期表示データでは時刻文字列と翻訳済み本文だけを持ち、ライブデータでは `sourceText`、ミリ秒時刻、状態も保持する。

## 6. システム構成

```text
Browser / React / TypeScript
  ├─ app/page.tsx: screen composition only
  ├─ useConversationSession
  │    ├─ aligned utterance state
  │    ├─ WebRTC translation session: target=en
  │    └─ WebRTC translation session: target=ja
  ├─ useLocalVad
  │    └─ microphone capture + lightweight local voice activity detection
  └─ ConversationControls
       └─ transient control UI state and download actions
          │ short-lived client secrets
Local Vinext server / TypeScript
  └─ /api/realtime/session
          │ OPENAI_API_KEY
OpenAI Realtime Translation API
  └─ gpt-realtime-translate
```

React側では、`app/page.tsx`を画面構成だけに限定する。Realtime接続・対応済み発話状態・翻訳音声制御は`useConversationSession`、Web Audio APIとRMSベースのVADライフサイクルは`useLocalVad`、ダウンロードメニューなど画面操作だけに閉じる一時状態は`ConversationControls`が担当する。機能追加時もこの責務境界を維持し、ページコンポーネントへ接続処理やVAD実装を戻さない。

同じマイク音声トラックを、英語出力用と日本語出力用の2つのWebRTCセッションへ並行送信する。セッション作成も並列で行う。

ブラウザとOpenAIの接続には専用のRealtime Translationエンドポイントを使う。

- クライアントシークレット: `/v1/realtime/translations/client_secrets`
- WebRTC call: `/v1/realtime/translations/calls`

## 7. OpenAI API設定とセキュリティ

- 恒久キーは `OPENAI_API_KEY` 環境変数からのみ読む
- ローカル開発ではGit管理外の `.env.local` に設定する
- `.env.example` のAPIキーは空のままにし、文字起こしモデルには非機密の既定値だけを置く
- ブラウザはローカルAPIから短期クライアントシークレットだけを受け取る
- `NEXT_PUBLIC_*` など、ブラウザへ埋め込まれる環境変数へAPIキーを設定しない
- Realtime入力文字起こしモデルはサーバー側の `OPENAI_TRANSCRIPTION_MODEL` 環境変数で指定する
- `OPENAI_TRANSCRIPTION_MODEL` が未設定または空の場合は `gpt-live-transcribe` を使う。`.env.example` にもこの既定値を記載する
- 入力ノイズ低減は `far_field` を使う

`GET /api/realtime/session` はキー設定有無だけを返し、キー値は返さない。`POST` は `ja` または `en` を受け取り、有効期間10分の短期シークレットを作る。

キー設定を確認できた時点で、ブラウザは日本語向け・英語向けの短期シークレットを並列に先読みする。取得済みシークレットは失効5秒前までメモリ内で再利用し、先読みが失敗した場合や期限切れの場合は接続開始時に再取得する。ページ保存や永続化は行わない。

## 8. Realtimeイベント処理

### 原文

両セッションの `session.input_transcript.delta` を原文候補として受け取る。英語向けセッションだけへ固定しない。

- セッションごとに候補文字列と最終 `elapsed_ms` を保持する
- 文字数が長い候補を優先する
- 別候補の時刻が600ms以上進んだ場合は、文字数が短くても進んだ候補へ切り替える
- これにより、片方の入力文字起こしが遅延・停止しても、もう片方へ追従する
- 日本語文字を含む場合は `ja`、Latin文字を含む場合は `en`、判定不能時は `unknown` とする
- 元言語が決まったら、該当言語側を候補文字列で上書きする

### 翻訳

`session.output_transcript.delta` を対象言語側へ追記する。ただし対象言語が元言語と同じ場合は表示へ追加しない。

### 発話境界と対応付け

現行MVPではWeb Audio APIによる軽量なローカルVADと、文字起こしデルタのフォールバックタイマーを組み合わせる。

- マイク入力のRMS音量と追従するノイズフロアから発話中かを推定する
- 発話検出後、原文候補が文末記号（`。.!！？?…`）で終わる場合は320ms、それ以外は450msの無音が続いたら現在行を `final` にする
- 遅れて到着した入力文字起こしデルタだけでは、ローカル音声から開始した無音時間の計測をリセットしない
- VADが発話終了を検出できない場合は、入力文字起こしデルタが1.2秒途切れた時点で確定する
- `elapsed_ms` と発話開始時刻から、翻訳デルタを直近の行へ対応付ける
- 時刻比較には400msの許容幅を設ける
- 確定後700ms以内の遅延入力デルタは直前行へ戻す

この方式では、無音がない長時間発話が1行へまとまること、静かな発話や大きな環境音で境界を誤ること、文中のポーズを発話終了とみなすこと、セッション間のタイミング差で境界がずれる可能性がある。高精度な音声分類モデルを使うVADはまだ実装していない。

## 9. 翻訳音声

選択肢は `再生しない`、`日本語`、`English`、`自動` とする。初期値は `再生しない`。

音声は必ず元言語と反対側、つまり翻訳結果だけを再生する。

- 日本語入力では英語音声だけを再生可能
- 英語入力では日本語音声だけを再生可能
- 明示言語が元言語と同じ場合は再生しない
- `自動` は元言語判定後に反対側を再生する
- セッション開始時と次の発話の音声検出時に言語判定を `unknown` へ戻し、言語判定前は両方ミュートする

## 10. ダウンロード

ブラウザ内で現在の対応レコードからファイルを生成し、サーバー側の保存や出力APIは使わない。ファイル名は `xlator-log.{format}` とする。

- TXT: 日本語ログと英語ログを見出し付きで出力
- CSV: 番号、時刻、元言語、日本語、英語を出力
- JSON: `Utterance[]` を出力
- SRT: ライブデータではRealtimeイベントの `elapsed_ms` に基づく `startMs` / `endMs` を使い、両言語を1字幕へ出力する。`endMs` は最後に採用した入力文字起こしデルタの時刻であり、実音声の厳密な終端ではない。初期データは4秒間隔の仮時刻を使う

## 11. レイテンシ方針

- ブラウザ音声はWebRTCで直接ストリーミングする
- APIキー設定確認後に2つの短期クライアントシークレットを先読みする
- 2つのセッションを並列作成する
- 各セッションではクライアントシークレット取得とWebRTC offer生成を並列に進める
- 文字起こし・翻訳デルタは到着ごとに即時反映する
- 文末を検出できた発話は320ms、それ以外も450msの無音で確定し、遅着デルタで無音時計を巻き戻さない
- 遅れている原文候補による重複再描画は行わない
- 発話の時刻検索は直近行から行い、変更のないログ行は再描画しない
- 自動スクロールのアニメーションは使わない
- モデル処理とネットワーク遅延はクライアントだけでは除去できない
- 評価時は、接続開始、初回原文、初回翻訳、発話確定を別々に計測する

## 12. テストと品質評価

通常のCIでは`npm run verify`を実行し、lint、型チェック、production build、実APIを使わない挙動テストを必須とする。

実音声と実APIの確認には`npm run test:smoke:api`を使う。ランナーは非圧縮16-bit PCM WAVを読み、チャンネルをモノラルへ統合して24kHz PCM16へ変換し、Realtime TranslationのWebSocketへ100ms単位で実時間送信する。

- `session.input_transcript.delta`を正解書き起こしと比較する
- 日本語と日英混在はCER、英語はWERを使う
- `session.output_transcript.delta`は代表訳との誤り率と必須語句カバー率を確認する
- 翻訳音声デルタが空でないことを確認する
- 音声末尾で`session.close`を送り、`session.closed`まで待つ
- 初回原文、初回翻訳、初回翻訳音声、セッション終了のレイテンシを出力する

API費用、モデル出力の揺らぎ、外部障害から通常PRの必須チェックにはせず、GitHub Actionsの手動`Realtime API Smoke` workflowで実行する。APIキーはActions Secretの`OPENAI_API_KEY`からだけ渡す。

物理マイクはCIでは再現せず、マイク権限、WebRTC接続、日英交互発話、翻訳音声、停止をリリース前にブラウザで手動確認する。詳細手順とfixture形式は`docs/realtime-smoke.md`を正とする。

### 現在の実装・検証状況

| 対象 | 実装状況 | 検証状況 | 現在の扱い |
| --- | --- | --- | --- |
| ブラウザのRealtime接続MVP | 実装済み | production buildと接続・イベント処理の自動テストに成功 | 実マイクと実APIを組み合わせた確認は未実施 |
| 通常CI | `npm run verify`を実行するGitHub Actionsを実装済み | 現在の変更ブランチでlint、型チェック、build、23テストに成功 | PRの必須品質ゲートとして使用する |
| 実APIスモークCLI | WAV変換、WebSocket送信、CER/WER、翻訳語句、翻訳音声、レイテンシ、正常終了判定を実装済み | APIを呼ばない`--validate-only`をCLI入口まで自動テスト済み | 実API呼び出しは未実施 |
| 実音声fixture | manifest例と入力検証を実装済み | 合成テスト用WAVで変換処理を自動テスト済み | 実発話WAV、正解書き起こし、正解翻訳は未登録 |
| 手動GitHub Actions | `workflow_dispatch`の`Realtime API Smoke`を実装済み | workflowファイル追加後も通常CIに成功。実API呼び出しは未実施 | 実行に必要なfixture、APIキー登録、default branchへの反映が未完了 |
| 物理マイク確認 | 手動手順を`docs/realtime-smoke.md`へ定義済み | 未実施 | 自動CIではなくリリース前手動確認とする |

### 残課題と完了条件

1. 実発話WAVと正解データを登録する
   - 最低限、日本語から英語、英語から日本語を含める
   - 日英が発話ごとに切り替わるケース、数字・日時・固有名詞を含める
   - `tests/fixtures/realtime/manifest.json`と参照WAVを追加し、`--validate-only`を成功させる
2. GitHub Actionsの実API実行条件を整える
   - Actions Secretまたは保護Environmentへ`OPENAI_API_KEY`を登録する
   - workflowがdefault branchへ反映された後に`Realtime API Smoke`を手動実行する
   - 入力文字起こし、翻訳、翻訳音声、`session.closed`がすべて成功した結果を残す
3. 物理マイクでブラウザMVPを確認する
   - `docs/realtime-smoke.md`の5手順を実行する
   - 接続、日英交互発話、行対応、翻訳音声、接続中・接続後停止を確認する
4. 初回の実測結果から閾値を調整する
   - 現在の原文0.35、翻訳0.65を初期値とし、正常ケースの揺らぎと見逃したくない誤りを確認して固定する

上記1〜3が成功するまでは、実APIスモークと実マイク確認を「実装済み」ではなく「基盤・手順実装済み、実地検証待ち」と表記する。

## 13. 現在の非対応範囲

- 話者分離、話者ラベル
- 重なり発話の分離
- 音声録音と再処理
- SQLiteなどへの永続保存
- セッション履歴
- ログの手修正
- 固有名詞辞書
- 接続の自動再試行
- 専用VADによる高精度な発話境界
- 物理マイクを使う自動E2Eテスト

## 14. 将来候補

1. 実発話WAVを使う日英コードスイッチングgolden setの拡充
2. 発話境界と2セッション間アラインメントの改善
3. 録音保存とセッション履歴
4. 後処理による話者分離（`A` / `B`）
5. 誤認識・誤訳の手修正
6. 固有名詞辞書

## 15. 主要ファイル

```text
AGENTS.md                               Codex向け作業規約
docs/spec.md                            本仕様書
app/page.tsx                            画面構成のみ
app/components/conversation-controls.tsx 会話操作、翻訳音声選択、ダウンロードUI
app/components/session-error-toast.tsx  接続エラー表示
app/components/site-header.tsx          ヘッダー
app/components/transcript-panel.tsx     日英ログパネル
app/components/ui-icons.tsx             UIアイコンと波形
app/hooks/use-conversation-session.ts   Realtime接続、発話状態、翻訳音声制御
app/hooks/use-local-vad.ts               Web Audio APIによるローカルVAD
app/globals.css                         レイアウトとスタイル
app/api/realtime/session/route.ts       短期シークレット発行
lib/demo-utterances.ts                  初期画面fixture
lib/download-log.ts                     TXT / CSV / JSON / SRT生成
lib/local-vad.ts                        VAD無音時間の純粋ロジック
lib/realtime-translation.ts             WebRTC接続
lib/translation-types.ts                共有データ型
lib/utterance-alignment.ts              言語判定と発話対応付け
lib/realtime-smoke.ts                   WAV変換、Realtime WebSocket、精度評価
scripts/realtime-smoke.ts               実APIスモークテストCLI
tests/fixtures/realtime/                実音声manifestとgolden set
.github/workflows/realtime-smoke.yml     手動の実APIスモークテスト
docs/realtime-smoke.md                  fixture・実行・実マイク確認手順
worker/index.ts                         Vinext Workerエントリ
.env.example                            環境変数例
```

DB、認証、サンプルAPIなど、現行MVPで使わない雛形コードは置かない。

## 16. 受け入れ確認

- 初期画面で左右の最新ログが表示される
- デスクトップで左右余白が最小限になっている
- 16発話の初期データで両パネルが最終行へ自動追従する
- 会話開始でマイク許可後に2つのRealtimeセッションが接続される
- 短期クライアントシークレットは失効前なら接続開始時に再利用される
- 日本語・英語を交互に話しても同じ番号の両言語ログへそろう
- 発話後の無音をローカルVADが検出すると、文末ありは約320ms、それ以外は約450msで行が確定する
- 片方の入力文字起こしが止まっても、もう片方の候補へ追従する
- 翻訳音声は元言語と反対側だけ再生される
- TXT / CSV / JSON / SRTをダウンロードできる
- 実音声fixtureはAPI接続なしで形式とWAV変換を検証できる
- 手動workflowから実APIスモークテストを実行できる
- APIキーがブラウザHTML、JavaScript、ダウンロードへ含まれない
- ヘッダーのGitHubアイコンから本リポジトリを新しいタブで開ける
- `npm run verify` が成功する
