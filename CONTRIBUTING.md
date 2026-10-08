# 贡献指南

感谢你有兴趣让 SFTPulse 更好！

## 开发环境

1. 安装 Node.js ≥ 18。
2. `npm install`
3. `npm run dev` 启动开发窗口。

## 工作流

1. Fork 本仓库并新建分支：`git checkout -b feat/你的功能`。
2. 提交前跑一遍：
   ```bash
   npm run typecheck
   npm run dev   # 手动冒烟测试
   ```
3. 提交信息建议遵循 [Conventional Commits](https://www.conventionalcommits.org/)（`feat:` / `fix:` / `docs:` …）。
4. 发起 Pull Request，描述改动动机与影响范围。

## 代码约定

- TypeScript `strict` 模式，尽量不写 `any`。
- 主进程敏感能力一律通过 `preload` 白名单暴露，**不要**在渲染进程开启 `nodeIntegration`。
- 新增 IPC 通道时，同步更新 `src/preload/index.ts` 与 `src/preload/index.d.ts`。

## 提问

用 Issues 提问即可，附上复现步骤与所用系统版本会更高效。
