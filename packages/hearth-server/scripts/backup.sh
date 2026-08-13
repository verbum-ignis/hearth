#!/usr/bin/env bash
# hearth.db 每日备份，挂 crontab（复用 Phase 10 模式）。保留 14 天。
# 用 node:sqlite 的 VACUUM INTO 做一致性备份——服务器没有 sqlite3 CLI（apt 镜像不通），不引入新依赖。
set -euo pipefail

NODE_BIN="${HEARTH_NODE_BIN:-/root/.nvm/versions/node/v22.23.1/bin/node}"
DB_PATH="${HEARTH_DB_PATH:-/opt/yan/hearth-server/hearth.db}"
BACKUP_DIR="${HEARTH_BACKUP_DIR:-/opt/yan/hearth-server/backups}"
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%d_%H%M%S)
"$NODE_BIN" --no-warnings -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(\`VACUUM INTO '\${process.argv[2]}'\`);
db.close();
" "$DB_PATH" "$BACKUP_DIR/hearth_$STAMP.db"
find "$BACKUP_DIR" -name 'hearth_*.db' -mtime +$KEEP_DAYS -delete
echo "backup done: hearth_$STAMP.db"
