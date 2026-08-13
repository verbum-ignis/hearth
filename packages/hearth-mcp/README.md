# hearth-mcp

把本机 Hearth 接成 stdio MCP 服务。

先启动 `hearth-server`，再复制 `.env.example` 为 `.env` 并填好同一份 `HEARTH_TOKEN`。你的 MCP 客户端需要以环境变量方式启动 `node src/index.js`；不要把 token 写进项目文件或提交到仓库。

它提供 `hearth_load`、`hearth_touch`、`hearth_write` 等工具。触发提示只提示相关条目，小机仍可自行决定打开或跳过。
