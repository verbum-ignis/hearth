import { loadConfig } from '../src/config.js';
import { extractConversationData } from '../src/extract.js';
import { analyzeYanAvoidanceResponses } from '../src/interaction-metrics.js';

const DATES = process.argv.slice(2);
if (DATES.length === 0 || DATES.some((date) => !/^\d{4}-\d{2}-\d{2}$/.test(date))) {
  throw new Error('用法: node scripts/deepseek-autonomy-audit.js YYYY-MM-DD [YYYY-MM-DD...]');
}

const config = loadConfig();
const result = {};
for (const date of DATES) {
  const { messages } = await extractConversationData({ ...config, date });
  result[date] = await analyzeYanAvoidanceResponses(config, messages);
}

console.log(JSON.stringify(result, null, 2));
