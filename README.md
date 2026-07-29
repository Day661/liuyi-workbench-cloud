# LiuYi Workbench Cloud

Cloud-side scheduler for Liu Yi's personal workbench.

This repository intentionally stores only automation code and sanitized status snapshots. It must not contain local vault contents, local absolute file indexes, Feishu access tokens, WeCom webhook URLs, or Codex private thread contents.

## What runs in the cloud

- GitHub Actions scheduled workflow
- Manual workflow dispatch
- Repository dispatch from a local/Codex activity uploader
- WeCom notification on failures, stale snapshots, conflicts, or explicit manual tests
- Daily Codex digest delivery at 21:00 Asia/Hong_Kong, when `data/codex-daily-digest.json` contains selected items for that day

## What remains local

- `E:\OneDrive\Typora\MyVault`
- Codex official thread list access
- Local Feishu CLI login state
- Local file opening and script execution
- Selection of which Codex answers are allowed to enter the WeCom group

## Codex daily digest

The cloud workflow does not read local Codex thread databases. It only sends the sanitized daily digest published by the local exporter.

By default, the exporter includes only Q&A turns whose user message contains a marker such as `#企微`, `#日报`, `#发群`, `发到企微`, or `进群摘要`. This avoids sending private thread content to the group by accident.

## Required GitHub secrets

- `WECOM_WEBHOOK_URL`: WeCom group bot webhook URL.

## Required GitHub variables

- `FEISHU_ENTRY_URL`: Feishu cloud document entry for phone access.
