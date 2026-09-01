import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { requireAuth } from '../middleware/auth.js';
import { q } from '../db/init.js';
import { buildPreview } from '../timetable/structure.js';
import { todayTW } from '../util/date.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const router = Router();
router.use(requireAuth);

// 把上傳檔案轉成 Claude 內容區塊（PDF/圖片/Excel/Word/文字）
export async function toContentBlock(filename, mime, data) {
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

// Fast Mode 是否為「這個帳戶沒有 Fast Mode 權限」造成的錯誤：
// 帳戶沒開通時額度＝0，會回 429 rate_limit 且訊息含 "fast mode"——這種要退回一般模式，
// 不是真的一般 API 限流。其他一般 API 的 429（真的太頻繁）才往上拋。
const isFastModeIssue = e =>
  e.status === 400 || e.status === 404 ||
  /fast[\s_-]?mode/i.test(String(e.message || '')) ||
  /fast[\s_-]?mode/i.test(String(e.error?.error?.message || ''));

// Fast Mode：同一顆 Opus 4.8 但輸出快很多（research preview）；帳戶沒權限就自動退回一般模式
export async function createFast(client, params) {
  try {
    return await client.beta.messages.create({ ...params, betas: ['fast-mode-2026-02-01'], speed: 'fast' });
  } catch (e) {
    if (e.status === 429 && !isFastModeIssue(e)) throw e; // 真正的一般 API 限流才報錯
    console.error('fast-mode fallback:', e.status, e.message?.slice(0, 200));
    return client.messages.create(params);
  }
}
// 課表解析用：先開延伸思考（讀格狀課表更準），不支援就逐步退回
async function createSmart(client, params) {
  const think = { thinking: { type: 'enabled', budget_tokens: 4000 } };
  try {
    return await client.beta.messages.create({ ...params, ...think, betas: ['fast-mode-2026-02-01'], speed: 'fast' });
  } catch (e1) {
    if (e1.status === 429 && !isFastModeIssue(e1)) throw e1;
    try { return await client.messages.create({ ...params, ...think }); }
    catch (e2) {
      if (e2.status === 429) throw e2;
      console.error('thinking fallback:', e2.status, e2.message?.slice(0, 200));
      return client.messages.create(params);
    }
  }
}
// 結構化輸出的 JSON 安全解析：被 max_tokens 截斷或格式錯誤時給明確訊息
export function parseStructuredObj(response) {
  if (response.stop_reason === 'max_tokens') {
    const e = new Error('內容太多一次讀不完，請分幾次匯入（一次少幾張照片）');
    e.friendly = true;
    throw e;
  }
  const text = response.content.find(b => b.type === 'text')?.text || '{}';
  try { return JSON.parse(text); }
  catch {
    const e = new Error('AI 回傳格式異常，請再試一次');
    e.friendly = true;
    throw e;
  }
}
const parseStructured = (response, key) => parseStructuredObj(response)[key] || [];

export function aiError(err) {
  if (err.friendly) return err.message;
  if (String(err.message || '').includes('credit balance is too low')) {
    return 'AI 帳戶餘額不足：請到 console.anthropic.com 的 Billing 儲值後再試（儲值完直接重試即可）';
  }
  const base = err.status === 401 ? '金鑰無效' : err.status === 429 ? '額度不足或太頻繁，稍後再試' : '請稍後再試';
  // 附上實際原因，出問題時才看得出是哪裡壞（訊息截短）
  const detail = err.status || err.message ? `（${err.status || ''} ${String(err.message || '').slice(0, 140)}）` : '';
  return 'AI 解讀失敗：' + base + detail;
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
    const events = parseStructured(response, 'events');

    // day_of_week → 下一次出現的日期（供每週重複的起始日）
    const today = new Date();
    // 本機時區的年月日；用 toISOString() 會照 UTC 輸出，在 UTC+N 的機器上會少一天
    const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
    const out = events.map(e => {
      let date = e.date;
      if (!date && e.day_of_week != null) {
        const d = new Date(today);
        d.setDate(d.getDate() + ((e.day_of_week - d.getDay() + 7) % 7));
        date = iso(d);
      }
      return {
        title: e.title,
        date: date || iso(today),
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

// ---- 課表匯入 v2 ----------------------------------------------------------
//
// 舊的 /parse 直接讓模型輸出「事件」，星期幾完全由模型決定，於是實機出現星期一
// 整欄消失、整週水平位移一天。這一版把分工改掉：模型只讀格子，**星期對應由
// src/timetable/structure.js 依欄位幾何確定性決定**，而且匯入前一定要人看過。

const GRID_SCHEMA = {
  type: 'object',
  properties: {
    header_row: { type: ['integer', 'null'], description: '標題列的 row 索引；沒有標題列就給 null' },
    cells: {
      type: 'array',
      description: '表格裡每一個有內容的格子。row/col 從 0 開始，照實際版面位置給，不要重排。',
      items: {
        type: 'object',
        properties: {
          row: { type: 'integer' },
          col: { type: 'integer' },
          text: { type: 'string', description: '格子裡的文字，照原文抄；空格子不要輸出' },
          row_span: { type: ['integer', 'null'], description: '這一格向下跨幾列（合併儲存格）；沒有合併就給 1 或 null' },
        },
        required: ['row', 'col', 'text', 'row_span'], additionalProperties: false,
      },
    },
  },
  required: ['header_row', 'cells'], additionalProperties: false,
};

// POST /api/import/timetable  { filename, mime, data }
// 只回 preview，永遠不寫入。
router.post('/timetable', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const { filename = '', mime = '', data } = req.body;
  if (!data) return res.status(400).json({ error: '沒有收到檔案' });
  let contentBlock;
  try { contentBlock = await toContentBlock(filename, mime, data); }
  catch (e) { return res.status(400).json({ error: e.message }); }

  try {
    const response = await createSmart(new Anthropic(), {
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      // 刻意只要求「讀格子」。星期幾、時間軸、欄界一律不問模型——
      // 那些由程式依位置決定，模型說了不算。
      system: `你是表格讀取器。把這張課表的每一個有內容的格子讀出來，附上它在版面上的列與欄索引。

規則：
- row 由上往下、col 由左往右，都從 0 開始，照實際版面位置給，不要重新排序或補洞。
- 最左邊那一欄如果是時間或節次，也要照樣輸出（它就是 col 0），不要略過。
- 標題列（寫星期幾的那一列）如果存在，輸出它的 row 索引到 header_row；沒有就給 null。
- 合併儲存格：只輸出最上面那一格，row_span 填它向下跨幾列。
- 空格子不要輸出。
- 文字照原文抄，不要翻譯、改寫或補字。看不清楚的格子寧可略過。
- 不要判斷哪一欄是星期幾，也不要輸出星期幾。那不是你的工作。`,
      output_config: { format: { type: 'json_schema', schema: GRID_SCHEMA } },
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: '請讀出這張課表的所有格子。' }] }],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一份試試' });
    }
    const grid = parseStructuredObj(response);
    res.json(buildPreview({ header_row: grid.header_row ?? 0, cells: grid.cells || [] }));
  } catch (err) {
    console.error('timetable parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

// POST /api/import/timetable/confirm
// { items:[{day_of_week,title,start_time,end_time,location?}], mapping_confirmed?:true }
//
// 這是唯一會寫入的一支，而且只寫既有的 fixed_events——沒有新的匯入結果表。
// 低信心的辨識結果一定要使用者明確確認過才准寫，不可以先寫進去再叫人去改。
router.post('/timetable/confirm', async (req, res) => {
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) return res.status(400).json({ error: '沒有要匯入的課程' });
  if (body.requires_mapping_confirmation && body.mapping_confirmed !== true) {
    return res.status(409).json({
      error: '星期對應尚未確認，請先在預覽畫面確認或整週調整後再匯入',
      code: 'mapping_confirmation_required',
    });
  }
  const clean = [];
  for (const it of items) {
    const dow = Number(it.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return res.status(400).json({ error: '星期不正確' });
    if (!String(it.title || '').trim()) return res.status(400).json({ error: '課程名稱不可空白' });
    if (!TIME_RE.test(it.start_time || '') || !TIME_RE.test(it.end_time || '')) {
      return res.status(400).json({ error: '課程時間不完整，請在預覽畫面補上' });
    }
    if (it.end_time <= it.start_time) return res.status(400).json({ error: '結束時間必須晚於開始時間' });
    clean.push({ dow, title: String(it.title).trim(), start: it.start_time, end: it.end_time, location: String(it.location || '') });
  }
  // 每週重複的課掛在「下一次該星期」那一天；沿用既有 fixed_events 的 recurring='weekly'
  const today = todayTW();
  const base = new Date(today + 'T00:00:00Z');
  const dateFor = dow => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + ((dow - base.getUTCDay() + 7) % 7));
    return d.toISOString().slice(0, 10);
  };
  await q.batch(clean.map(c => [
    'INSERT INTO fixed_events (user_id,title,date,start_time,end_time,recurring,location) VALUES (?,?,?,?,?,?,?)',
    [req.userId, c.title, dateFor(c.dow), c.start, c.end, 'weekly', c.location],
  ]));
  res.json({ imported: clean.length });
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
    book: { type: ['string', 'null'], description: '課本書名（封面或目錄頁看得到就照抄，看不到就 null）' },
    publisher: { type: ['string', 'null'], description: '出版社（如 翰林、南一、康軒、龍騰、三民；看不到就 null）' },
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
  required: ['book', 'publisher', 'chapters'], additionalProperties: false,
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
// 整本刪掉（同科目同書名的所有章）
router.delete('/toc-book', async (req, res) => {
  const { list_id, book = '' } = req.query;
  if (!list_id) return res.status(400).json({ error: '缺少科目' });
  await q.run('DELETE FROM toc_items WHERE user_id=? AND list_id=? AND book=?', [req.userId, +list_id, book]);
  res.json({ ok: true });
});
// 把「被 AI 塞進某章底下」的節/主題拉出來，獨立成自己的一章
// body: { id: 章的 toc_id, path: [節index] 或 [節index, 主題index] }
router.post('/toc-promote', async (req, res) => {
  const { id, path = [] } = req.body;
  const row = await q.get('SELECT * FROM toc_items WHERE id=? AND user_id=?', [id, req.userId]);
  if (!row || !path.length) return res.status(404).json({ error: '找不到項目' });
  let secs = [];
  try { secs = JSON.parse(row.sections || '[]'); } catch {}
  const norm = k => (typeof k === 'string' ? { title: k, level: '節', children: [] } : k);
  secs = secs.map(norm);
  let node;
  if (path.length === 1) {
    node = secs[path[0]];
    secs.splice(path[0], 1);
  } else {
    const p = secs[path[0]];
    if (!p) return res.status(400).json({ error: '找不到項目' });
    const kids = (p.children || []).map(norm);
    node = kids[path[1]];
    kids.splice(path[1], 1);
    p.children = kids;
  }
  if (!node) return res.status(400).json({ error: '找不到項目' });
  await q.run('UPDATE toc_items SET sections=? WHERE id=?', [JSON.stringify(secs), row.id]);
  // 插在原本那一章的後面（其餘往後移），順序才不會跑掉
  await q.run('UPDATE toc_items SET order_index=order_index+1 WHERE user_id=? AND list_id=? AND order_index>?',
    [req.userId, row.list_id, row.order_index]);
  const r = await q.run('INSERT INTO toc_items (user_id,list_id,title,level,sections,order_index,book,publisher) VALUES (?,?,?,?,?,?,?,?)',
    [req.userId, row.list_id, node.title, '章', JSON.stringify(node.children || []), row.order_index + 1, row.book || '', row.publisher || '']);
  res.json({ id: r.lastInsertRowid });
});

// 自己在章底下加節／在節底下加主題（AI 讀漏或課本沒印出來時手動補）
// body: { id: 章的 toc_id, path: []＝直接加在章底下｜[i]＝加在第 i 個節底下, title, level }
const normNode = k => (typeof k === 'string' ? { title: k, level: '節', children: [] } : { ...k, children: (k.children || []).map(normNode) });
const loadSecs = row => { try { return (JSON.parse(row.sections || '[]')).map(normNode); } catch { return []; } };
router.post('/toc-node', async (req, res) => {
  const { id, path = [], title, titles, level } = req.body;
  // 一次可以加很多個（titles），不用一行送一次請求
  const list0 = (Array.isArray(titles) ? titles : [title]).map(x => String(x || '').trim()).filter(Boolean);
  if (!list0.length) return res.status(400).json({ error: '請輸入名稱' });
  const row = await q.get('SELECT * FROM toc_items WHERE id=? AND user_id=?', [id, req.userId]);
  if (!row) return res.status(404).json({ error: '找不到章節' });
  if (path.length >= 2) return res.status(400).json({ error: '最多三層（章→節→主題）' });
  const secs = loadSecs(row);
  let list = secs;
  for (const i of path) {                       // 往下走到要加的那一層
    const node = list[i];
    if (!node) return res.status(400).json({ error: '找不到位置' });
    node.children = node.children || [];
    list = node.children;
  }
  for (const t of list0) {
    // 自動接續編號：AI 讀出來的節都有編號（「1 …」「主題21 …」），
    // 自己加的也要有，而且格式要跟同一層現有的一致
    let maxN = 0, style = '';
    for (const k of list) {
      const m = String(k.title || k).match(/^\s*(主題|單元|重點|第)?\s*(\d+)/);
      if (!m) continue;
      if (+m[2] > maxN) maxN = +m[2];
      if (!style && m[1]) style = m[1];
    }
    const numbered = /^\s*(主題|單元|重點|第)?\s*\d+/.test(t);
    list.push({ title: numbered ? t : `${style}${maxN + 1} ${t}`, level: level || (path.length ? '主題' : '節'), children: [] });
  }
  await q.run('UPDATE toc_items SET sections=? WHERE id=?', [JSON.stringify(secs), row.id]);
  res.json({ ok: true, sections: secs });      // 回傳整份，前端直接換掉那一章就好，不用重抓全部
});
// 刪掉自己加錯的節／主題
router.delete('/toc-node', async (req, res) => {
  const id = +req.query.id;
  const path = String(req.query.path || '').split(',').filter(x => x !== '').map(Number);
  const row = await q.get('SELECT * FROM toc_items WHERE id=? AND user_id=?', [id, req.userId]);
  if (!row || !path.length) return res.status(404).json({ error: '找不到項目' });
  const secs = loadSecs(row);
  let list = secs;
  for (const i of path.slice(0, -1)) {
    const node = list[i];
    if (!node) return res.status(400).json({ error: '找不到位置' });
    list = node.children = node.children || [];
  }
  const last = path[path.length - 1];
  if (!list[last]) return res.status(400).json({ error: '找不到項目' });
  list.splice(last, 1);
  await q.run('UPDATE toc_items SET sections=? WHERE id=?', [JSON.stringify(secs), row.id]);
  res.json({ ok: true, sections: secs });
});

// 選擇先排哪本書：照傳進來的書名順序重寫 order_index（每本書內的章順序不變）
// body: { list_id, books: ['新大滿貫', '週攻略', ...] }
router.patch('/toc-book-order', async (req, res) => {
  const { list_id, books } = req.body;
  if (!list_id || !Array.isArray(books)) return res.status(400).json({ error: '參數不完整' });
  const rows = await q.all('SELECT * FROM toc_items WHERE user_id=? AND list_id=? ORDER BY order_index, id', [req.userId, +list_id]);
  const byBook = new Map();
  for (const r of rows) { const k = r.book || ''; if (!byBook.has(k)) byBook.set(k, []); byBook.get(k).push(r); }
  const order = [...books.map(b => b || ''), ...[...byBook.keys()].filter(k => !books.includes(k))]; // 沒列到的排後面
  let i = 0;
  const stmts = [];
  for (const bk of order) {
    for (const r of (byBook.get(bk) || [])) stmts.push(['UPDATE toc_items SET order_index=? WHERE id=?', [i++, r.id]]);
  }
  if (stmts.length) await q.batch(stmts);
  res.json({ ok: true });
});

// 改書名／出版社（把同科目同書名的所有章一起改）
router.patch('/toc-book', async (req, res) => {
  const { list_id, book = '', newBook, publisher } = req.body;
  if (!list_id) return res.status(400).json({ error: '缺少科目' });
  await q.run('UPDATE toc_items SET book=COALESCE(?,book), publisher=COALESCE(?,publisher) WHERE user_id=? AND list_id=? AND book=?',
    [newBook ?? null, publisher ?? null, req.userId, +list_id, book]);
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

【書名與出版社】
- 照片上看得到書名（封面、書眉、目錄頁大標）就照抄填 book；看得到出版社（翰林/南一/康軒/龍騰/三民…）就填 publisher；看不到就 null，不要猜。

【其他】
- title 保留原始編號與名稱；level 只能用：章、節、主題、課、單元、小節、重點。
- 沒有下一層就給空的 children 陣列；國文英文以「課」為單位、通常沒有子項。
- 照片邊緣被切到、名稱讀不完整的項目就略過不要猜。忽略附錄、索引、頁碼。
- 照片可能是躺著的（順時針或逆時針轉 90 度）、歪斜、或有陰影：請自行判斷文字方向後再讀，不要因為方向不對就放棄。

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
    const obj = parseStructuredObj(response);
    const chapters = obj.chapters || [];
    if (!chapters.length) return res.status(400).json({ error: 'AI 沒有讀到章節，請拍更清楚的目錄照片' });
    let book = (obj.book || '').trim();
    let publisher = (obj.publisher || '').trim();

    let base = 0;
    if (replace !== false) {
      // 重新掃描：讀得出書名就只換同一本，讀不出就整科重來（跟舊行為一致）
      if (book) await q.run('DELETE FROM toc_items WHERE user_id=? AND list_id=? AND (book=? OR book=\'\')', [req.userId, list_id, book]);
      else await q.run('DELETE FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
      const mx = await q.get('SELECT MAX(order_index) AS m FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
      base = (mx?.m ?? -1) + 1;
    } else {
      const mx = await q.get('SELECT MAX(order_index) AS m FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
      base = (mx?.m ?? -1) + 1;
      if (req.body.book != null) {
        // 補「某一本」的後幾頁：一律掛在那一本底下
        book = req.body.book;
        const same = await q.get('SELECT publisher FROM toc_items WHERE user_id=? AND list_id=? AND book=? LIMIT 1', [req.userId, list_id, book]);
        publisher = publisher || same?.publisher || '';
      } else if (req.body.forceNew) {
        // 加一本新的書：絕不併進上一本；讀不到書名就自動編號
        if (!book) {
          const n = await q.get('SELECT COUNT(DISTINCT book) AS c FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
          book = `課本 ${(n?.c || 0) + 1}`;
        }
      } else if (!book) {
        // 沒指定也沒強制新書：沿用最近一本（舊行為）
        const last = await q.get('SELECT book, publisher FROM toc_items WHERE user_id=? AND list_id=? ORDER BY order_index DESC LIMIT 1', [req.userId, list_id]);
        book = last?.book || '';
        publisher = publisher || last?.publisher || '';
      }
    }
    const items = [];
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const kids = c.children || [];
      const r = await q.run('INSERT INTO toc_items (user_id, list_id, title, level, sections, order_index, book, publisher) VALUES (?,?,?,?,?,?,?,?)',
        [req.userId, list_id, c.title, c.level || '章', JSON.stringify(kids), base + i, book, publisher]);
      items.push({ id: r.lastInsertRowid, list_id, title: c.title, level: c.level || '章', sections: kids, order_index: base + i, book, publisher });
    }
    res.json({ items, book, publisher });
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
// 編輯單字：英文、中文、分類、顏色
router.patch('/vocab/:id', async (req, res) => {
  const { english, chinese, kind, color } = req.body;
  await q.run('UPDATE vocab_items SET english=COALESCE(?,english), chinese=COALESCE(?,chinese), kind=COALESCE(?,kind), color=COALESCE(?,color) WHERE id=? AND user_id=?',
    [english ?? null, chinese ?? null, kind ?? null, color ?? null, req.params.id, req.userId]);
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
    const words = parseStructured(response, 'words');
    const todayStr = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 台灣時區的今天
    // 去重：同一批裡重複的、以及「已經在單字本裡」的都只留一次（同一張圖重複匯入不會加兩次）
    const existing = await q.all('SELECT english FROM vocab_items WHERE user_id=?', [req.userId]);
    const seen = new Set(existing.map(r => r.english.trim().toLowerCase()));
    const clean = words.filter(w => {
      const k = (w.english || '').trim().toLowerCase();
      if (!k || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    // spread＝從基準日起一天 perDay 個；today＝全部算在基準日
    // 基準日預設今天，也可以指定（昨天/明天等，個別匯入到那一天）
    const baseDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.date || '') ? req.body.date : todayStr;
    const mode = req.body.mode === 'spread' ? 'spread' : 'today';
    const perDay = Math.max(1, Math.min(200, +req.body.perDay || 10));
    const dateOf = i => {
      if (mode !== 'spread') return baseDate;
      const d = new Date(new Date(baseDate + 'T00:00:00').getTime() + Math.floor(i / perDay) * 864e5);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    if (clean.length) {
      await q.batch(clean.map((w, i) => [
        'INSERT INTO vocab_items (user_id, date, english, chinese, kind) VALUES (?,?,?,?,?)',
        [req.userId, dateOf(i), w.english.trim(), (w.chinese || '').trim(), w.kind === '片語' ? '片語' : '單字'],
      ]));
    }
    res.json({ added: clean.length, skipped: words.length - clean.length, days: mode === 'spread' ? Math.ceil(clean.length / perDay) : 1 });
  } catch (err) {
    console.error('vocab parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

export default router;
