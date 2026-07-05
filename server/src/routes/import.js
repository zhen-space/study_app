import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import * as XLSX from 'xlsx';
import mammoth from 'mammoth';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

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
  const ext = filename.toLowerCase().split('.').pop();

  if (['pages', 'numbers', 'key'].includes(ext)) {
    return res.status(400).json({ error: 'Pages/Numbers 是 Apple 專用格式，請先在檔案 App 中「輸出成 PDF」再上傳' });
  }

  // 組出給模型的內容區塊
  let contentBlock;
  try {
    if (ext === 'pdf' || mime === 'application/pdf') {
      contentBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    } else if (mime.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext)) {
      const mediaType = mime.startsWith('image/') ? mime : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
      contentBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
    } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
      const wb = XLSX.read(Buffer.from(data, 'base64'));
      const text = wb.SheetNames.map(n => `[工作表 ${n}]\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n\n');
      contentBlock = { type: 'text', text: `課表檔案內容（CSV 格式）：\n${text.slice(0, 50000)}` };
    } else if (ext === 'docx') {
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(data, 'base64') });
      contentBlock = { type: 'text', text: `課表檔案內容：\n${value.slice(0, 50000)}` };
    } else if (['txt', 'md'].includes(ext)) {
      contentBlock = { type: 'text', text: `課表檔案內容：\n${Buffer.from(data, 'base64').toString('utf8').slice(0, 50000)}` };
    } else {
      return res.status(400).json({ error: `不支援的檔案格式 .${ext}，支援：PDF、圖片、Excel、Word(docx)、CSV、TXT` });
    }
  } catch {
    return res.status(400).json({ error: '檔案讀取失敗，請確認檔案沒有損壞' });
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 8000,
      system: '你是課表解讀助手。從使用者提供的檔案中擷取所有固定行程（課程、社團、補習等），轉成結構化資料。學校課表上的課通常每週重複（recurring=true、填 day_of_week、date=null）。若檔案標明具體日期的單次活動則 recurring=false、填 date。時間一律用 24 小時制 HH:MM。若課表只寫節次沒寫時間，依台灣中學常見作息推估（第1節08:10-09:00，之後每節50分鐘、間隔10分鐘，午休12:00-13:10）。看不出任何行程就回傳空陣列。',
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
    res.status(500).json({ error: 'AI 解讀失敗：' + (err.status === 401 ? '金鑰無效' : err.status === 429 ? '額度不足或太頻繁，稍後再試' : '請稍後再試') });
  }
});

export default router;
