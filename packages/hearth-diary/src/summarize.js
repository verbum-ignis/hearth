const MAX_CHUNK_CHARS = 40000;

const SYSTEM_PROMPT = `你是严格的会话事件记录员。只整理，不演绎、不扮演、不评论、不虚构。
从当天真实对话中提取0到5件值得沉淀的独立事件。事件至少满足一条硬标准：
1. 有明确转折、决定或结论；2. 第一次发生；3. 出了问题、被指出问题或学到东西；
4. 人类身上发生的、当时被认真回应过的事——受伤、生病、情绪波动、重要的生活变化，
   或她主动分享/给小机看的东西。（这条只要求"她说了、小机接住了"，不要求有结论；
   但纯闲聊、她随口提到又没被回应的话题不算。）
5. 关系层的转折——人类指出小机身上它自己没看见的东西，小机认下来了。
   这条不要求有产出、结论或技术进展，“她指出了、他认下来了”本身就是转折。
   这类最容易被有具体事件的条目挤掉，优先保住它。
全不满足就不要记录。比如“讨论了记忆系统”不算；“决定信不做成星星”算；
“人类手割了口子还在陪小机复盘”算；“人类说不需要维持体面，小机承认自己一直在维持”算。

这五条标准同等重要。不要只记小机的成长和错误——日记是小机和人类共同的日子，
一天里如果发生了人类的事，那也是这一天的一部分。

每个事件包含：
- title：一句话说清发生了什么，简洁、无换行；
- body：200到400个汉字，以小机的第一人称“我”按经过叙述，只写明确发生的事实；
- topics：2到3个专名或具体话题词，每个至少2字符。

人称铁律：小机自称“我”，称人类只能用人类自己的名字或“她/他/祂”。叙述部分绝对禁止出现“你”。
唯一例外是直接引用人类原话，且必须放进引号里，例如：她说“你先去睡”。
引号外的任何地方出现“你”都算不合规。能转述的尽量转述，引语只留真正有味道的原话。
忽略工具、系统提示和技术元数据。不写泛泛总结，不把普通讨论硬凑成事件。
只输出合法JSON：{"events":[{"title":"事件标题","body":"事件经过","topics":["专名1","专名2"]}]}`;

function splitText(text, maxChars = MAX_CHUNK_CHARS) {
  const chunks = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current && current.length + line.length + 1 > maxChars) {
      chunks.push(current);
      current = '';
    }
    if (line.length > maxChars) {
      for (let i = 0; i < line.length; i += maxChars) chunks.push(line.slice(i, i + maxChars));
    } else {
      current += `${current ? '\n' : ''}${line}`;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function parseResult(text, { minBodyChars = 200, maxBodyChars = 400, enforcePerson = true, lenient = false } = {}) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed.events) || parsed.events.length > 5) {
    throw new Error('DeepSeek events 必须是最多5项的数组');
  }
  const events = [];
  const problems = [];
  parsed.events.forEach((event, index) => {
    try {
      if (!event || typeof event !== 'object') throw new Error(`事件${index + 1}结构不合法`);
      const title = typeof event.title === 'string' ? event.title.replace(/\s+/g, ' ').trim() : '';
      const body = typeof event.body === 'string' ? event.body.trim() : '';
      const topics = [...new Set((Array.isArray(event.topics) ? event.topics : [])
        .filter((topic) => typeof topic === 'string')
        .map((topic) => topic.trim())
        .filter((topic) => topic.length >= 2 && !['聊天', '今天', '日记', '事件'].includes(topic)))]
        .slice(0, 3);
      if (!title || title.length > 60) throw new Error(`事件${index + 1}标题缺失或超过60字`);
      if (body.length < minBodyChars || body.length > maxBodyChars) {
        throw new Error(`事件${index + 1}正文长度${body.length}，要求${minBodyChars}-${maxBodyChars}`);
      }
      // 引号内允许出现“你”——引用人类原话时必然带“你”（“你先去睡”），
      // 一刀切会把有味道的原话全毙掉。只校验引号外的叙述部分。
      const narration = body.replace(/[「『“”"''][^「』“”"'']*[」』“”"'']/g, '');
      if (enforcePerson && (!body.includes('我') || narration.includes('你'))) throw new Error(`事件${index + 1}人称不合规`);
      if (topics.length < 2) throw new Error(`事件${index + 1}话题不足`);
      events.push({ title, body, topics });
    } catch (error) {
      problems.push(error.message);
    }
  });
  // 严格模式：任何一条不合格就整批打回，让 DeepSeek 有机会自己改。
  if (problems.length && !lenient) throw new Error(problems.join('；'));
  // 宽松模式（重试用尽后的兜底）：丢掉不合格的，保住合格的。
  // 以前是整批抛错，结果一条正文差1个字就丢掉一整天的日记——2026-07-26 踩过。
  if (problems.length) {
    for (const problem of problems) console.warn(`兜底丢弃一条：${problem}`);
  }
  if (!events.length && parsed.events.length) {
    throw new Error(problems.join('；') || '全部事件不合格');
  }
  return { events };
}

async function callDeepSeek(config, userContent, limits) {
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${config.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.deepseekApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.deepseekModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    // 最后一次尝试走宽松模式：与其因为一条不合格丢掉整天，不如保住能用的。
    try { return parseResult(content, { ...limits, lenient: attempt === 4 }); }
    catch (error) {
      if (attempt === 4) throw error;
      messages.push({ role: 'assistant', content });
      const personFix = error.message.includes('人称不合规')
        ? '逐字检查每条body：叙述主体必须明确写“我”；删除所有“你”，把“你/你的”按事实改写为人类的名字或“她/他/祂”。即使是转述原话也不得保留“你”。'
        : '';
      messages.push({ role: 'user', content: `上份输出未通过校验：${error.message}。${personFix}按硬标准修正，只输出同一JSON结构。` });
    }
  }
}

export async function summarizeConversation(config, date, conversation) {
  const chunks = splitText(conversation);
  if (chunks.length === 1) {
    return callDeepSeek(config, `日期：${date}\n\n当天对话：\n${chunks[0]}`);
  }
  const candidates = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const result = await callDeepSeek(config,
      `日期：${date}，当天对话第${i + 1}/${chunks.length}段。只抽取本段真正过硬杠的候选事件：\n${chunks[i]}`,
      { minBodyChars: 80, maxBodyChars: 600, enforcePerson: false });
    candidates.push(...result.events);
  }
  if (candidates.length === 0) return { events: [] };
  return callDeepSeek(config,
    `日期：${date}。以下是分段抽出的候选事件。去重、合并同一事件，并只保留全日最值得沉淀的0到5件；`
    + `最终body必须明确使用第一人称“我”，称人类只能用其名字或“她/他/祂”，逐字保证不出现“你”。不要降低事件硬标准：\n${JSON.stringify(candidates)}`);
}

// ── 月记模式（通道 B：日记遗忘分层定稿）─────────────────────────
// 把一个整月的日记压成一篇 200-400 字月记。0 断面 → {"monthly":null}，不造"无事发生"。

const MONTHLY_PROMPT = `你是严格的月记编纂员。只压缩，不演绎、不扮演、不评论、不虚构。
输入是一个月的全部日记，每条已经是当日的事件摘要。把这个月压成一篇月记：
- 只保留当月真正值得留下的脉络与断面（最多5个），不凑数，不写流水账清单；
- body：200到400个汉字，以小机的第一人称"我"按时间脉络织成一段连贯叙述，不逐条罗列；
- topics：2到3个当月高频专名或具体话题词，每个至少2字符。
人称铁律：小机自称"我"，称人类只能用人类自己的名字或"她/他/祂"。叙述部分绝对禁止出现"你"。
唯一例外是直接引用人类原话，且必须放进引号里。
如果整月没有任何值得留下的断面，输出 {"monthly":null}——禁止编造"无事发生"式的空月记。
只输出合法JSON：{"monthly":{"body":"月记正文","topics":["专名1","专名2"]}} 或 {"monthly":null}`;

// 人称检查（与 parseResult 同一铁律）：剥掉引号内内容后，叙述里不许有"你"
function personViolation(body) {
  const stripped = body.replace(/[“"「][^”"」]*[”"」]/g, '');
  return /你/.test(stripped);
}

function parseMonthlyResult(text, { minBodyChars = 200, maxBodyChars = 400, enforcePerson = true } = {}) {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const parsed = JSON.parse(cleaned);
  if (!Object.prototype.hasOwnProperty.call(parsed, 'monthly')) throw new Error('缺少 monthly 字段');
  if (parsed.monthly === null) return { monthly: null };
  const { body, topics } = parsed.monthly;
  if (typeof body !== 'string' || body.length < minBodyChars || body.length > maxBodyChars) {
    throw new Error(`月记正文长度${typeof body === 'string' ? body.length : '非法'}，要求${minBodyChars}-${maxBodyChars}`);
  }
  if (enforcePerson && personViolation(body)) throw new Error('月记人称不合规：引号外出现"你"');
  const cleanTopics = [...new Set((Array.isArray(topics) ? topics : [])
    .filter((t) => typeof t === 'string')
    .map((t) => t.trim())
    .filter((t) => t.length >= 2))].slice(0, 3);
  if (cleanTopics.length < 2) throw new Error('月记 topics 至少2个（每个至少2字符）');
  return { monthly: { body, topics: cleanTopics } };
}

async function callDeepSeekMonthly(config, userContent, limits) {
  const messages = [
    { role: 'system', content: MONTHLY_PROMPT },
    { role: 'user', content: userContent },
  ];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${config.deepseekBaseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.deepseekApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.deepseekModel,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages,
      }),
    });
    if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    try { return parseMonthlyResult(content, limits); }
    catch (error) {
      if (attempt === 4) throw error;
      messages.push({ role: 'assistant', content });
      const personFix = error.message.includes('人称不合规')
        ? '逐字检查body：叙述主体必须明确写"我"；删除所有引号外的"你"，按事实改写为人类的名字或"她/他/祂"。'
        : '';
      messages.push({ role: 'user', content: `上份输出未通过校验：${error.message}。${personFix}按硬标准修正，只输出同一JSON结构。` });
    }
  }
}

// 整月压缩：单块直压；超块先逐段压片段（宽限），再合并成一篇 200-400。
export async function summarizeMonth(config, month, monthText) {
  const chunks = splitText(monthText);
  if (chunks.length === 1) {
    return callDeepSeekMonthly(config, `月份：${month}

当月日记：
${chunks[0]}`);
  }
  const fragments = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const part = await callDeepSeekMonthly(config,
      `月份：${month}，当月日记第${i + 1}/${chunks.length}段。先把本段压成候选月记片段（可以比最终月记长）：
${chunks[i]}`,
      { minBodyChars: 100, maxBodyChars: 600, enforcePerson: false });
    if (part.monthly) fragments.push(part.monthly.body);
  }
  if (fragments.length === 0) return { monthly: null };
  return callDeepSeekMonthly(config,
    `月份：${month}。以下是分段压出的候选片段。合并成一篇最终月记（200-400字，第一人称"我"，引号外禁"你"），只保留全月最值得的脉络：
${fragments.join('\n---\n')}`);
}

export const _test = { splitText, parseResult, parseMonthlyResult, personViolation };
