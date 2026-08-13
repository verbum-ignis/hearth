# hearth-server

Hearth 的本地核心。它只监听本机端口，数据写入 SQLite。

```powershell
Copy-Item .env.example .env
# 编辑 .env 后填入 HEARTH_TOKEN 与 HEARTH_SEAL
npm install
npm start
```

默认地址是 `http://127.0.0.1:3002`。数据库会在 `HEARTH_DB_PATH` 指定的位置首次启动时创建；空库就是新 Hearth 的开始，不需要导入任何 seed。

运行测试：

```powershell
npm test
```
