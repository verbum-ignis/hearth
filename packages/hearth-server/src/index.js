import express from 'express';
import { handleLoad } from './routes/load.js';
import { handleWrite } from './routes/write.js';
import { handleTouch, touchErrorStatus, handleKeysIndex } from './routes/touch.js';
import { handleSearch, searchErrorStatus } from './routes/search.js';
import { handleStars, handleDustDetail } from './routes/stars.js';
import { handleVerify } from './routes/verify.js';
import { handleSources } from './routes/sources.js';

const PORT = process.env.HEARTH_PORT || 3002;
const TOKEN = process.env.HEARTH_TOKEN;
const SEAL = process.env.HEARTH_SEAL;

if (!TOKEN || !SEAL) {
  console.error('缺少 HEARTH_TOKEN 或 HEARTH_SEAL 环境变量，拒绝启动');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// 暗语防注入：所有响应统一附 seal，值只存在服务器环境变量。
// CLAUDE.md 侧验证：seal 不对或缺失即视为异常返回。
function reply(res, status, body) {
  res.status(status).json({ ...body, seal: SEAL });
}

app.use((req, res, next) => {
  const auth = req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) return reply(res, 401, { error: 'unauthorized' });
  next();
});

app.post('/load', (req, res) => {
  const mode = req.body && req.body.mode === 'full' ? 'full' : 'start';
  reply(res, 200, handleLoad(mode));
});

app.post('/write', (req, res) => {
  const { status, body } = handleWrite(req.body);
  reply(res, status, body);
});

app.post('/touch', (req, res) => {
  try {
    reply(res, 200, handleTouch(req.body));
  } catch (err) {
    const status = touchErrorStatus(err);
    if (status) return reply(res, status, { error: err.message });
    throw err;
  }
});

app.post('/search', (req, res) => {
  try {
    reply(res, 200, handleSearch(req.body));
  } catch (err) {
    const status = searchErrorStatus(err);
    if (status) return reply(res, status, { error: err.message });
    throw err;
  }
});

app.get('/keys', (req, res) => reply(res, 200, handleKeysIndex()));

app.get('/stars', (req, res) => reply(res, 200, handleStars()));

app.get('/dust/:historyId', (req, res) => {
  const row = handleDustDetail(Number(req.params.historyId));
  if (!row) return reply(res, 404, { error: 'not found' });
  reply(res, 200, row);
});

app.get('/verify/:id', (req, res) => {
  const { status, body } = handleVerify(req.params.id);
  reply(res, status, body);
});

app.get('/sources/:entryId', (req, res) => {
  const { status, body } = handleSources(req.params.entryId);
  reply(res, status, body);
});

app.get('/health', (req, res) => reply(res, 200, { ok: true }));

app.use((err, req, res, next) => {
  console.error(err);
  reply(res, 500, { error: 'internal error' });
});

app.listen(PORT, () => {
  console.log(`hearth-server listening on :${PORT}`);
});
