# xlator

[![CI](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci.yml)

共有マイクへ入力された日本語・英語の会話を、発話ごとに両言語へそろえて表示するローカルWebアプリです。音声認識と翻訳にはOpenAI Realtime APIへのインターネット接続が必要です。

![xlator interface](docs/images/xlator-current.jpg)

## セットアップ

必要なNode.jsバージョンは[.nvmrc](.nvmrc)に記載しています。nvmを使う場合は最初に`nvm use`を実行してください。

```bash
npm ci
cp .env.example .env.local
npm run dev
```

`.env.local`の`OPENAI_API_KEY`へサーバー用APIキーを設定し、ブラウザで[http://localhost:3000](http://localhost:3000)を開きます。APIキーを`NEXT_PUBLIC_*`へ設定しないでください。

## 開発コマンド

```bash
npm run dev        # ローカル開発
npm run verify     # lint、型チェック、build、test
npm run start      # production buildの起動
```

現在の動作、アーキテクチャ、非対応範囲は[docs/spec.md](docs/spec.md)を参照してください。
