# xlator

[![CI/CD](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci-cd.yml/badge.svg?branch=master)](https://github.com/shinichi-takayanagi/xlator/actions/workflows/ci-cd.yml)

A translation tool that runs locally.

![xlator interface](docs/images/xlator-current.jpg)

## How to install

Use Node.js 22.13.0 and npm 10.9.2. If you use nvm, run `nvm use` first.

```bash
npm ci
cp .env.example .env.local
# Add your OpenAI API key in the file opened by the command below.
open -t .env.local
npm run dev
open http://localhost:3000
```
