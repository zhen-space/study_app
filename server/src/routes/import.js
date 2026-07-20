import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { requireAuth } from '../middleware/auth.js';
import { q } from '../db/init.js';

const router = Router();
router.use(requireAuth);

// 把上傳檔案轉成 Claude 內容區塊（PDF/圖片/Excel/Word/文字）
async function toContentBlock(filename, mime, data) {
  const ext = filename.toLowerCase().split('.').pop();
  if (['pages', 'numbers', 'key'].includes(ext)) {
    throw new Error('Pages/Numbers 是 Apple 專用格式，請先在檔案 App 中「輸出成 PDF」再上傳');
  }
  if (ext === 'pdf' || mime === 'application/pdf') {
    return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
  }
  if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
    const mediaType = mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
  }
  if (['xlsx', 'xls', 'csv'].includes(ext)) {
    const wb = XLSX.read(Buffer.from(data, 'base64'));
    const text = wb.SheetNames.map(n => `[工作表 ${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
    return { type: 'text', text: `檔案內容（CSV 格式）：\n${text.slice(0, 50000)}` };
  }
  if (ext === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data, 'base64') });
    return { type: 'text', text: `檔案內容：\n${value.slice(0, 50000)}` };
  }
  if (['txt', 'md'].includes(ext)) {
    return { type: 'text', text: `檔案內容：\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 50000)}` };
  }
  throw new Error(`不支援的檔案格式 .${ext}，支援：PDF、圖片、Excel、Word(docx)、CSV、TXT`);
}

// Fast Mode：同一顆 Opus 4.8 但輸出快很多（research preview）；環境不支援就自動退回一般模式
async function createFast(client, params) {
  try {
    return await client.beta.messages.create({ ...params, betas: ['fast-mode-2026-02-01'], speed: 'fast' });
  } catch (e) {
    if (e.status === 400 || e.status === 404) return client.messages.create(params);
    throw e;
  }
}
// 課表解析用：先開延伸思考（讀格狀課表更準），環境不支援再逐步退回
async function createSmart(client, params) {
  const think = { thinking: { type: 'enabled', budget_tokens: 4000 } };
  try {
    return await client.beta.messages.create({ ...params, ...think, betas: ['fast-mode-2026-02-01'], speed: 'fast' });
  } catch (e1) {
    try { return await client.messages.create({ ...params, ...think }); }
    catch (e2) {
      if (e2.status === 400) return client.messages.create(params);
      throw e2;
    }
  }
}

function aiError(err) {
  return 'AI 解讀失敗：' + (err.status === 401 ? '金鑰無效' : err.status === 429 ? '額度不足或太頻繁，稍後再試' : '請稍後再試');
}

const SCHEMA = {
  type: 'object',
  properties: {
    events: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          date: { type: ['string', 'null'], description: '單次事件的日期 YYYY-MM-DD；每週重複課程則為 null' },
          day_of_week: { type: ['integer', 'null'], description: '每週重複課程的星期幾，0=週日 1=週一 ... 6=週六；單次事件為 null' },
          start_time: { type: 'string', description: 'HH:MM 24小時制' },
          end_time: { type: 'string', description: 'HH:MM 24小時制' },
          recurring: { type: 'boolean', description: '是否每週重複（課表上的課通常是 true）' },
          location: { type: ['string', 'null'], description: '地點/教室（如有標示），沒有就 null' },
        },
        required: ['title', 'date', 'day_of_week', 'start_time', 'end_time', 'recurring', 'location'],
        additionalProperties: false,
      },
    },
  },
  required: ['events'],
  additionalProperties: false,
};

// POST /api/import/parse  { filename, mime, data: <base64> }
router.post('/parse', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const { filename = '', mime = '', data } = req.body;
  if (!data) return res.status(400).json({ error: '沒有收到檔案' });

  let contentBlock;
  try {
    contentBlock = await toContentBlock(filename, mime, data);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時區
    const client = new Anthropic();
    const response = await createSmart(client, {
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      system: `你是課表解讀助手。從使用者提供的檔案中擷取所有固定行程（課程、社團、補習、活動等），轉成結構化資料。
今天是 ${todayStr}。

【日期規則｜最重要】
- 一律輸出「實際發生的每一個日期」（recurring=false、date 填 YYYY-MM-DD、day_of_week=null）。
- 一項活動在課表上出現幾次，就輸出幾筆單一日期的資料。例如某活動出現在 7/7、7/14、7/21，就輸出三筆 date 分別是這三天，不要合併成區間，也不要寫「每週」。
- 只有一個唯一情況才用 recurring=true：這是一張沒有標任何具體日期的「星期課表」（欄位只寫星期一～日、完全沒有月份日期），此時才 recurring=true、填 day_of_week、date=null。
- 只要檔案上出現任何具體月份/日期，就一律用實際日期，絕對不要判成每週重複。
- 日期沒寫年份時，一律推定為「今天或未來最近」的年份，絕不輸出過去的日期。

【讀取規則】
- 若是「欄＝日期、列＝時間」的格狀行事曆，逐欄（逐日）讀每一格；同一天同名活動的相鄰時段合併成一段（如 9:00-10:00 與 10:00-11:00 的數學合併為 9:00-11:00）。
- 時間一律 24 小時制 HH:MM。只寫節次沒寫時間時，依台灣中學作息推估（第1節08:10-09:00，每節50分、間隔10分，午休12:00-13:10）。
- 看不出任何行程就回傳空陣列。

【正確性檢查｜輸出前逐筆核對】
- 每筆行程的日期一定要對準它「所在的那一欄」的日期、時間對準它「所在的那一列」的時段，不要串欄串列。
- 名稱與地點照原文抄寫，不要改寫、翻譯或猜測；模糊看不清楚的字寧可略過該筆。
- 核對總數：表上有幾格行程，就輸出幾筆（相鄰同名時段合併後），不可多也不可漏。`,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: '請擷取這份檔案中的所有固定行程。' },
        ],
      }],
    });

    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一份試試' });
    }
    const text = response.content.find(b => b.type === 'text')?.text || '{"events":[]}';
    const { events } = JSON.parse(text);

    // day_of_week → 下一次出現的日期（供每週重複的起始日）
    const today = new Date();
    const out = events.map(e => {
      let date = e.date;
      if (!date && e.day_of_week != null) {
        const d = new Date(today);
        d.setDate(d.getDate() + ((e.day_of_week - d.getDay() + 7) % 7));
        date = d.toISOString().slice(0, 10);
      }
      return {
        title: e.title,
        date: date || today.toISOString().slice(0, 10),
        start_time: e.start_time,
        end_time: e.end_time,
        recurring: e.recurring ? 'weekly' : null,
        location: e.location || '',
      };
    }).filter(e => /^\d{2}:\d{2}/.test(e.start_time) && /^\d{2}:\d{2}/.test(e.end_time));

    res.json({ events: out });
  } catch (err) {
    console.error('import parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

// 三層固定結構（structured outputs 不支援遞迴）：章 → 節 → 小節/主題
const leaf = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    level: { type: 'string', description: '這一層的單位名稱，如 小節 / 主題 / 節次' },
  },
  required: ['title', 'level'], additionalProperties: false,
};
const mid = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    level: { type: 'string', description: '這一層的單位名稱，如 節 / 單元' },
    children: { type: 'array', items: leaf, description: '底下的小節或主題；沒有就給空陣列' },
  },
  required: ['title', 'level', 'children'], additionalProperties: false,
};
const TOC_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '章或課的完整名稱，含編號' },
          level: { type: 'string', description: '這一層的單位名稱，通常是 章 或 課 或 單元' },
          children: { type: 'array', items: mid, description: '底下的節；沒有分節就給空陣列' },
        },
        required: ['title', 'level', 'children'], additionalProperties: false,
      },
    },
  },
  required: ['chapters'], additionalProperties: false,
};

// GET /api/import/toc → 全部章節庫（依科目分組用 list_id）
router.get('/toc', async (req, res) => {
  const rows = await q.all('SELECT * FROM toc_items WHERE user_id=? ORDER BY list_id, order_index, id', [req.userId]);
  res.json(rows.map(r => ({ ...r, sections: JSON.parse(r.sections) })));
});
router.delete('/toc/:id', async (req, res) => {
  await q.run('DELETE FROM toc_items WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});

// POST /api/import/toc  { list_id, files:[{filename,mime,data}] | filename,mime,data, replace }
// → AI 解讀目錄（可多張照片一起讀），存成該科章節庫
router.post('/toc', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const { list_id, replace } = req.body;
  // 相容單檔與多檔
  const files = req.body.files?.length
    ? req.body.files
    : (req.body.data ? [{ filename: req.body.filename || '', mime: req.body.mime || '', data: req.body.data }] : []);
  if (!files.length || !list_id) return res.status(400).json({ error: '沒有收到檔案或科目' });
  if (files.length > 12) return res.status(400).json({ error: '一次最多 12 張照片' });

  let blocks;
  try {
    blocks = [];
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) blocks.push({ type: 'text', text: `【第 ${i + 1} 張／共 ${files.length} 張】` });
      blocks.push(await toContentBlock(files[i].filename, files[i].mime, files[i].data));
    }
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const client = new Anthropic();
    const response = await createFast(client, {
      model: 'claude-opus-4-8',
      max_tokens: 12000,
      system: `你是課本目錄解讀助手。使用者可能上傳多張目錄照片（同一本課本的連續頁面），請把所有照片視為同一份目錄，依頁面順序合併，不要遺漏跨頁內容，也不要重複計算兩張照片重疊處的同一項。
【階層判讀｜台灣課本常見編排】目錄最多三層，請完整擷取：
1. 章（最上層）：通常是「大的阿拉伯數字＋名稱」，如「3 大氣」「5 氣候變遷與永續發展」，或寫「第3章」。level 填「章」（若課本用「課」「單元」則照用）。
2. 節（第二層）：常用國字數字「壹、貳、參、肆、伍、陸…」或「3-1」「一、二、三」開頭，如「壹 大氣的性質與分層結構」。level 填「節」。
3. 主題／小節（第三層）：常寫「主題 1」「重點 2」，如「主題1 大氣的成分」。level 填「主題」（或課本實際用的詞，如「小節」「重點」）。

【最重要｜巢狀階層，不可攤平】
資料是三層巢狀樹，務必正確歸屬父子關係：
- chapters[] 只放「章」（大數字，如「3 大氣」）。
- 每個「章」的 children[] 只放它底下的「節」（壹貳參肆伍陸…）。
- 每個「節」的 children[] 只放它底下的「主題／小節」（主題1、主題2…）。
- 「主題N」一定要放進它所屬那個「節」的 children 裡，絕對不可以和「壹貳參」並列成為章的直接子項。
- level 要標對：大數字=「章」、壹貳參=「節」、主題N=「主題」。千萬不要把每一項都標成「節」。

【其他】
- title 保留原始編號與名稱；level 只能用：章、節、主題、課、單元、小節、重點。
- 沒有下一層就給空的 children 陣列；國文英文以「課」為單位、通常沒有子項。
- 照片邊緣被切到、名稱讀不完整的項目就略過不要猜。忽略附錄、索引、頁碼。

【正確範例】「3 大氣」底下有「壹 大氣的性質與分層結構」，而「壹」底下有「主題1 大氣的成分、主題2 大氣的垂直分布」，正確輸出（注意主題在壹的 children 裡）：
{"chapters":[{"title":"3 大氣","level":"章","children":[{"title":"壹 大氣的性質與分層結構","level":"節","children":[{"title":"主題1 大氣的成分","level":"主題"},{"title":"主題2 大氣的垂直分布","level":"主題"}]},{"title":"貳 溼度與水氣凝結","level":"節","children":[]}]}]}
【錯誤示範｜不要這樣】把主題和壹貳並列、全標成節：
{"chapters":[{"title":"3 大氣","level":"章","children":[{"title":"壹…","level":"節","children":[]},{"title":"主題1…","level":"節","children":[]}]}]}  ← 錯！主題被攤平了`,
      output_config: { format: { type: 'json_schema', schema: TOC_SCHEMA } },
      messages: [{
        role: 'user',
        content: [...blocks, { type: 'text', text: '請把以上所有照片合併，完整擷取這本課本目錄的章節結構。' }],
      }],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一張更清楚的照片' });
    }
    const text = response.content.find(b => b.type === 'text')?.text || '{"chapters":[]}';
    const { chapters } = JSON.parse(text);
    if (!chapters.length) return res.status(400).json({ error: 'AI 沒有讀到章節，請拍更清楚的目錄照片' });

    let base = 0;
    if (replace !== false) {
      await q.run('DELETE FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
    } else {
      const mx = await q.get('SELECT MAX(order_index) AS m FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
      base = (mx?.m ?? -1) + 1;
    }
    const items = [];
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const kids = c.children || [];
      const r = await q.run('INSERT INTO toc_items (user_id, list_id, title, level, sections, order_index) VALUES (?,?,?,?,?,?)',
        [req.userId, list_id, c.title, c.level || '章', JSON.stringify(kids), base + i]);
      items.push({ id: r.lastInsertRowid, list_id, title: c.title, level: c.level || '章', sections: kids, order_index: base + i });
    }
    res.json({ items });
  } catch (err) {
    console.error('toc parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

// ---- 每日單字：拍照 → AI 擷取單字/片語＋中文意思 ----
const VOCAB_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          english: { type: 'string', description: '英文單字或片語，照原文抄寫' },
          chinese: { type: 'string', description: '中文意思（照片上有就照抄，沒有才自己給簡短翻譯）' },
          kind: { type: 'string', enum: ['單字', '片語'], description: '單一個字＝單字；兩個字以上的慣用組合＝片語' },
        },
        required: ['english', 'chinese', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['words'],
  additionalProperties: false,
};

router.get('/vocab', async (req, res) => {
  res.json(await q.all('SELECT * FROM vocab_items WHERE user_id=? ORDER BY date DESC, id LIMIT 1000', [req.userId]));
});
router.delete('/vocab/:id', async (req, res) => {
  await q.run('DELETE FROM vocab_items WHERE id=? AND user_id=?', [req.params.id, req.userId]);
  res.json({ ok: true });
});
// POST /api/import/vocab
//   { files:[{filename,mime,data}] | filename,mime,data, mode:'today'|'spread', perDay }
//   today＝全部算今天的單字；spread＝整本分配，從今天起每天 perDay 個
router.post('/vocab', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const files = req.body.files?.length
    ? req.body.files
    : (req.body.data ? [{ filename: req.body.filename || '', mime: req.body.mime || '', data: req.body.data }] : []);
  if (!files.length) return res.status(400).json({ error: '沒有收到檔案' });
  if (files.length > 12) return res.status(400).json({ error: '一次最多 12 張照片/檔案' });
  let blocks;
  try {
    blocks = [];
    for (let i = 0; i < files.length; i++) {
      if (files.length > 1) blocks.push({ type: 'text', text: `【第 ${i + 1} 份／共 ${files.length} 份】` });
      blocks.push(await toContentBlock(files[i].filename, files[i].mime, files[i].data));
    }
  } catch (e) { return res.status(400).json({ error: e.message }); }
  try {
    const client = new Anthropic();
    const response = await createFast(client, {
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      system: `你是背單字助手。從照片/檔案擷取所有要背的英文單字與片語：
- english 照原文抄寫（含大小寫），不要自己改拼字；看不清楚的字寧可略過。
- chinese：照片上有中文意思就照抄；沒有才給最常用的簡短中文意思。
- kind：單一個字＝「單字」；兩個字以上的慣用組合（如 give up、in front of）＝「片語」。
- 忽略例句、音標、頁碼；同一個字出現多次只輸出一次。找不到任何單字就回傳空陣列。
- 多份檔案時視為同一批，依順序全部擷取、重疊處不重複。單字照原文出現的順序輸出。`,
      output_config: { format: { type: 'json_schema', schema: VOCAB_SCHEMA } },
      messages: [{ role: 'user', content: [...blocks, { type: 'text', text: '請擷取這些檔案中所有要背的英文單字與片語。' }] }],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一張試試' });
    }
    const text = response.content.find(b => b.type === 'text')?.text || '{"words":[]}';
    const { words } = JSON.parse(text);
    const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時區的今天
    // 去重（同一批裡同一個字只留一次）
    const seen = new Set();
    const clean = words.filter(w => {
      const k = (w.english || '').trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // spread＝從今天起一天 perDay 個；today＝全部今天
    const mode = req.body.mode === 'spread' ? 'spread' : 'today';
    const perDay = Math.max(1, Math.min(200, +req.body.perDay || 10));
    const dateOf = i => {
      if (mode !== 'spread') return todayStr;
      const d = new Date(new Date(todayStr + 'T00:00:00').getTime() + Math.floor(i / perDay) * 864e5);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    if (clean.length) {
      await q.batch(clean.map((w, i) => [
        'INSERT INTO vocab_items (user_id, date, english, chinese, kind) VALUES (?,?,?,?,?)',
        [req.userId, dateOf(i), w.english.trim(), (w.chinese || '').trim(), w.kind === '片語' ? '片語' : '單字'],
      ]));
    }
    res.json({ added: clean.length, days: mode === 'spread' ? Math.ceil(clean.length / perDay) : 1 });
  } catch (err) {
    console.error('vocab parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

export default router;
