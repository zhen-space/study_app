import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as XLSX from 'xlsx';
import { excelToText, toContentBlock, worksheetToBoundedCsv } from '../src/routes/import.js';

const workbookBase64 = sheets => {
  const wb = XLSX.utils.book_new();
  for (const [name, rows] of sheets) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
};

describe('Excel 匯入防護', () => {
  it('正常活頁簿仍保留工作表、列欄與 CSV 跳脫', async () => {
    const data = workbookBase64([
      ['課表', [['科目', '備註'], ['數學', '複習, 例題']]],
      ['考試', [['英文', '10/20']]],
    ]);
    const block = await toContentBlock('課表.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', data);
    assert.equal(block.type, 'text');
    assert.match(block.text, /\[工作表 課表\]\n科目,備註\n數學,"複習, 例題"/);
    assert.match(block.text, /\[工作表 考試\]\n英文,10\/20/);
  });

  it('在解析前拒絕超過既有 15MB 上限的 Excel', () => {
    const oversized = Buffer.alloc(15 * 1024 * 1024 + 1).toString('base64');
    assert.throws(() => excelToText(oversized), /上限 15MB/);
  });

  it('拒絕損壞的 base64，不把寬鬆解碼結果交給 xlsx', () => {
    assert.throws(() => excelToText('%%%不是base64'), /內容損壞/);
  });

  it('巨大 !ref 與極遠稀疏儲存格只產生既有文字預算，不展開完整範圍', () => {
    const sheet = {
      A1: { t: 's', v: '開始' },
      XFD1048576: { t: 's', v: '結束' },
      '!ref': 'A1:XFD1048576',
    };
    const text = worksheetToBoundedCsv(sheet, 200);
    assert.equal(text.length, 200);
    assert.match(text, /^開始/);
  });

  it('所有工作表合計不超過既有 50,000 字 AI 輸入預算', () => {
    const data = workbookBase64([
      ['一', [[`甲${'x'.repeat(30000)}`]]],
      ['二', [[`乙${'y'.repeat(30000)}`]]],
    ]);
    assert.equal(excelToText(data).length, 50000);
  });

  it('拒絕工作表與儲存格物件上的原型污染鍵', () => {
    const sheet = { A1: { t: 's', v: '安全內容' } };
    Object.defineProperty(sheet, 'constructor', { value: {}, enumerable: true });
    assert.throws(() => worksheetToBoundedCsv(sheet), /格式不安全/);

    const cell = { t: 's', v: '安全內容' };
    Object.defineProperty(cell, '__proto__', { value: {}, enumerable: true });
    assert.throws(() => worksheetToBoundedCsv({ A1: cell }), /儲存格格式不安全/);
  });
});
