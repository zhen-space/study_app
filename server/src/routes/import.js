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
        },
        required: ['title', 'date', 'day_of_week', 'start_time', 'end_time', 'recurring'],
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
    const todayStr = new Date().toISOString().slice(0, 10);
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      system: `你是課表解讀助手。從使用者提供的檔案中擷取所有固定行程（課程、社團、補習等），轉成結構化資料。
今天是 ${todayStr}。重要：若課表日期沒寫年份，一律推定為「今天或未來最近」的那個年份，絕不要輸出過去的日期。
若課表是「欄＝日期、列＝時間」的格狀行事曆，請逐欄（逐日）仔細讀取每一格，同一天同名課程相鄰時段要合併成一段（如 9:00-10:00 與 10:00-11:00 的數學合併為 9:00-11:00）。
學校週課表上的課每週重複（recurring=true、填 day_of_week、date=null）；標明具體日期的則 recurring=false、填 date。
時間一律 24 小時制 HH:MM。只寫節次沒寫時間時，依台灣中學作息推估（第1節08:10-09:00，每節50分、間隔10分，午休12:00-13:10）。看不出任何行程就回傳空陣列。`,
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
      };
    }).filter(e => /^\d{2}:\d{2}/.test(e.start_time) && /^\d{2}:\d{2}/.test(e.end_time));

    res.json({ events: out });
  } catch (err) {
    console.error('import parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

const TOC_SCHEMA = {
  type: 'object',
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '章或課的完整名稱，含編號，如「第2章 三角函數」「第3課 背影」' },
          sections: { type: 'array', items: { type: 'string' }, description: '該章底下的節名稱，如「2-1 銳角三角函數」；課文類（國文英文）通常沒有節，給空陣列' },
        },
        required: ['title', 'sections'],
        additionalProperties: false,
      },
    },
  },
  required: ['chapters'],
  additionalProperties: false,
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

// POST /api/import/toc  { list_id, filename, mime, data } → AI 解讀目錄，存成該科章節庫
router.post('/toc', async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: '伺服器尚未設定 AI 金鑰（ANTHROPIC_API_KEY）' });
  }
  const { list_id, filename = '', mime = '', data, replace } = req.body;
  if (!data || !list_id) return res.status(400).json({ error: '沒有收到檔案或科目' });

  let contentBlock;
  try {
    contentBlock = await toContentBlock(filename, mime, data);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      system: '你是課本目錄解讀助手。從使用者拍攝或上傳的課本目錄中，完整擷取所有章/課與其底下的節。保留原始編號與名稱（如「第2章 三角函數」、節「2-1 銳角三角函數」）。國文、英文等以「課」為單位的科目，每課是一個 chapter、sections 給空陣列。忽略附錄、索引、頁碼。',
      output_config: { format: { type: 'json_schema', schema: TOC_SCHEMA } },
      messages: [{
        role: 'user',
        content: [contentBlock, { type: 'text', text: '請完整擷取這份課本目錄的章節結構。' }],
      }],
    });
    if (response.stop_reason === 'refusal') {
      return res.status(400).json({ error: 'AI 無法處理這份檔案，請換一張更清楚的照片' });
    }
    const text = response.content.find(b => b.type === 'text')?.text || '{"chapters":[]}';
    const { chapters } = JSON.parse(text);
    if (!chapters.length) return res.status(400).json({ error: 'AI 沒有讀到章節，請拍更清楚的目錄照片' });

    if (replace !== false) {
      await q.run('DELETE FROM toc_items WHERE user_id=? AND list_id=?', [req.userId, list_id]);
    }
    const items = [];
    for (let i = 0; i < chapters.length; i++) {
      const c = chapters[i];
      const r = await q.run('INSERT INTO toc_items (user_id, list_id, title, sections, order_index) VALUES (?,?,?,?,?)',
        [req.userId, list_id, c.title, JSON.stringify(c.sections || []), i]);
      items.push({ id: r.lastInsertRowid, list_id, title: c.title, sections: c.sections || [], order_index: i });
    }
    res.json({ items });
  } catch (err) {
    console.error('toc parse error:', err.message);
    res.status(500).json({ error: aiError(err) });
  }
});

export default router;
