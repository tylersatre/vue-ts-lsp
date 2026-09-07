# DRAFT — correction for Muromi-Rikka/cc-learn ("方案二：vue-ts-lsp（专用代理）" section)

> The guide recommends vue-ts-lsp but its instructions don't work; readers following them will fail and blame the tool. File as an issue on their repo (or a PR patching the page) from your own account. Chinese first (site language), English below for reference.

---

## Issue title

vue-ts-lsp 章节的安装步骤有误（`npx vue-ts-lsp install cc` 不存在）

## Issue body (中文)

感谢推荐 vue-ts-lsp！我是该项目的维护者。当前文档中的安装步骤有三处与实际不符，按文档操作会失败：

1. **`npx vue-ts-lsp install cc` 这个命令不存在。** 正确的安装方式是全局安装后通过 Claude Code 插件机制接入：

    ```bash
    npm install -g vue-ts-lsp
    claude plugin marketplace add tylersatre/vue-ts-lsp
    claude plugin install vue-ts-lsp@vue-ts-lsp
    ```

2. **项目根目录的 `.lsp.json` 不会被识别。** Claude Code 只通过插件目录发现 LSP 服务器（plugin-only discovery），所以必须走上面的插件安装路径，或用 `claude --plugin-dir` 加载一个包含 `.lsp.json` 的插件目录。

3. **不需要设置 `ENABLE_LSP_TOOL=1`。** 当前版本的 Claude Code 不需要这个环境变量。

参考:官方 README 的安装说明 https://github.com/tylersatre/vue-ts-lsp#installation — 如有问题欢迎在仓库提 issue。

## English reference (not for posting)

1. `npx vue-ts-lsp install cc` does not exist; the real install is global npm install + `claude plugin marketplace add tylersatre/vue-ts-lsp` + `claude plugin install vue-ts-lsp@vue-ts-lsp`.
2. A project-root `.lsp.json` is not picked up — Claude Code discovers LSP servers through plugins only (or `claude --plugin-dir`).
3. `ENABLE_LSP_TOOL=1` is not required on current Claude Code versions.

---

_Notes for Tyler: verify the guide's current wording before filing (it may have changed); offering the correction as a PR against their repo is friendlier if their pages are markdown._
