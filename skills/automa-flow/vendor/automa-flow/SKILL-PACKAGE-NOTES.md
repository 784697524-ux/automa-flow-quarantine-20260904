# automa-flow CLI 代码快照

本目录由 `pnpm skill:pack` 打入 skill 包。
首次使用前执行 `pnpm install`；若宿主 pnpm/Corepack 不可用，可先在源仓库运行 CLI。
本快照包含已生成的 `src/generated/block-registry.json`，日常生成、校验、doctor、import、merge 不需要完整 Automa 仓库。
默认生成物引用 Automa Credentials 中的 `dingtalkAppKey`、`dingtalkAppSecret` 和 `dingtalkOperatorId`，不要在样例或交付包里放真实应用凭据或个人 unionId。
只有 Automa 升级并需要重新提取块注册表时，才需要提供 Automa 仓库路径运行 `pnpm registry`。
