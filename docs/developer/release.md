# 发布与自动更新

Susie 用 **electron-updater + GitHub Releases**（`AFutureD/Susie-App`，公开仓库）做自动更新。
打包身份：Apple Developer 账户 `the.trip@outlook.com`，bundle id `me.afuture.susie`。

## 一次性准备（新机器 / 新账户）

1. **签名证书**（钥匙串中需存在，二选一途径）：
   - Xcode → Settings → Accounts → 添加 `the.trip@outlook.com` → Manage Certificates → 创建
     `Apple Development`（本地调试）与 **`Developer ID Application`**（对外分发 + 自动更新必需）；
   - 或在 [developer.apple.com/certificates](https://developer.apple.com/account/resources/certificates/list)
     创建后下载双击导入。
   - 注意：`Developer ID Application` 仅付费 Program 的 **Account Holder** 能创建。
2. **公证凭证：App Store Connect API Key**（notarytool 用）：
   - [App Store Connect](https://appstoreconnect.apple.com) → 用户和访问 → 集成 → App Store Connect API → 团队密钥 → 生成
     （角色选 Developer 及以上；**.p8 只能下载一次**）
   - 把 `.p8` 存到固定路径，例如 `~/.private_keys/AuthKey_<KEYID>.p8`
   - 发布时以环境变量传入：
     - `APPLE_API_KEY`：`.p8` 文件路径
     - `APPLE_API_KEY_ID`：Key ID（生成页显示）
     - `APPLE_API_ISSUER`：Issuer ID（同页顶部的 UUID）
3. **GitHub token**：`GH_TOKEN=$(gh auth token)`（需 `repo` scope，上传 Release 用）。

## 发布一个新版本

```bash
npm version <x.y.z> --no-git-tag-version --workspaces-update=false
git commit -am "chore: v<x.y.z>" && git push
APPLE_API_KEY=~/.private_keys/AuthKey_<KEYID>.p8 \
APPLE_API_KEY_ID=<KEYID> APPLE_API_ISSUER=<ISSUER-UUID> \
GH_TOKEN=$(gh auth token) npm run release
```

发布后**必须核对**（electron-builder 已知问题：~100MB 大文件可能静默上传失败，exit 0 但 asset 缺失）：

```bash
gh release view v<x.y.z> --json isDraft,assets --jq '{draft:.isDraft,assets:[.assets[].name]}'
```

应包含 5 个 asset：`zip` / `zip.blockmap` / `dmg` / `dmg.blockmap` / `latest-mac.yml`。
缺失的从本地 `release/` 补传，并把 draft 转正式（draft 对 updater 不可见）：

```bash
gh release upload v<x.y.z> release/<缺失文件> --clobber
gh release edit v<x.y.z> --draft=false
```

## 无 Developer ID 证书时的测试构建

用开发证书签名 + 跳过公证（新旧版本同一证书即可通过 Squirrel.Mac 验签）：

```bash
npx electron-builder --mac zip -c.mac.type=development -c.mac.notarize=false
```

注意 `--dir` 构建**不生成** `app-update.yml`（只有 zip 等可更新 target 才生成），测更新必须 `--mac zip`。

## 注意事项

- 换 bundle id / 签名 Team 后，旧包无法自动升级到新包（Squirrel 验签按签名身份匹配），
  已装旧测试版的机器需手动重装一次。
- 更新缓存目录：`~/Library/Caches/susie-app-updater/`；更新日志走 electron-log（设置页「日志」可看）。
- 更新状态链路：`src/main/updater.ts` → IPC `update:state` → 设置页「运行信息」卡片。
