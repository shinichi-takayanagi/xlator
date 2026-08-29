# Realtime実APIスモークテスト

実音声ファイルをOpenAI Realtime Translation APIへ実時間ストリーミングし、入力文字起こし、翻訳文字起こし、翻訳音声、正常終了を確認する手動テストである。通常のPR CIには含めず、GitHub Actionsの`Realtime API Smoke`から明示的に実行する。

## 評価データ

音声は非圧縮16-bit PCMのWAVを使う。モノラル・複数チャンネルと任意のサンプルレートを受け付け、ランナーが24kHzモノラルPCM16へ変換する。個人情報、秘密情報、利用許諾のない音声はコミットしない。

`tests/fixtures/realtime/manifest.example.json`を`manifest.json`へコピーし、同じディレクトリへWAVを置く。1ケースは次の項目を持つ。

- `id`: 一意なケース名
- `audio`: manifestからの相対WAVパス
- `sourceLanguage`: `ja`、`en`、日英混在の`mixed`
- `targetLanguage`: `ja`または`en`
- `expectedSource`: 正解書き起こし。必須
- `expectedTranslation`: 代表的な正解翻訳。任意
- `requiredTranslationTerms`: 必須語句。配列を入れると表記ゆれの候補になる。任意
- `thresholds`: 文字起こし・翻訳の許容誤り率と必須語句カバー率。任意
- `expectAudio`: `false`なら翻訳音声の存在確認を省略する。既定は`true`

日本語と`mixed`は正規化後の文字誤り率（CER）、英語は単語誤り率（WER）を使う。既定上限は原文0.35、翻訳0.65である。翻訳には複数の正解があるため、精度評価では`expectedTranslation`だけに頼らず、固有名詞・数字・日時などを`requiredTranslationTerms`にも指定する。

## ローカル実行

```bash
OPENAI_API_KEY=... npm run test:smoke:api -- \
  --fixture tests/fixtures/realtime/manifest.json
```

特定ケースだけなら`--case ja-to-en`を追加する。APIへ接続せずmanifestとWAVだけを確認する場合は`--validate-only`を追加する。

ランナーはWAVを100ms単位で実時間送信し、音声末尾で`session.close`を送った後、`session.closed`まで待つ。ログには原文・翻訳、各判定、初回原文・初回翻訳・初回翻訳音声・終了までのレイテンシを出す。

## GitHub Actions

1. リポジトリのActions Secretへ`OPENAI_API_KEY`を登録する。
2. Actionsから`Realtime API Smoke`を選ぶ。
3. `fixture`へコミット済みmanifestのパスを指定して実行する。

APIの費用、モデル出力の揺らぎ、外部障害があるため、現時点では`workflow_dispatch`専用で、PRの必須チェックにはしない。外部コントリビューターのPRではAPIキーを使用しない。

## 実マイク確認

物理マイクはCI環境で再現できないため、次をリリース前の手動確認とする。

1. `.env.local`へAPIキーを設定し`npm run dev`を起動する。
2. ブラウザでマイクを許可し、日英を交互に3発話以上読む。
3. 両Realtimeセッションが`リスニング中`になり、同じ行番号に原文と翻訳が表示されることを確認する。
4. 翻訳音声を`自動`にし、元言語と反対側だけが再生されることを確認する。
5. 接続中と接続後の両方で停止でき、ライブログが残ることを確認する。

これはマイク権限、WebRTC、ブラウザ再生まで含む手動スモークであり、ファイル入力による実API精度評価とは別に扱う。
