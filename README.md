# LiuYi Workbench Cloud

Cloud-side scheduler for Liu Yi's personal workbench.

This repository intentionally stores only automation code and sanitized status snapshots. It must not contain local vault contents, local absolute file indexes, Feishu access tokens, WeCom webhook URLs, or Codex private thread contents.

## What runs in the cloud

- GitHub Actions scheduled workflow
- Manual workflow dispatch
- Repository dispatch from a local/Codex activity uploader
- WeCom notification on failures, stale snapshots, conflicts, or explicit manual tests

## What remains local

- `E:\OneDrive\Typora\MyVault`
- Codex official thread list access
- Local Feishu CLI login state
- Local file opening and script execution

## Required GitHub secrets

- `WECOM_WEBHOOK_URL`: WeCom group bot webhook URL.

## Required GitHub variables

- `FEISHU_ENTRY_URL`: Feishu cloud document entry for phone access.

