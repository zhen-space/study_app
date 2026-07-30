import { api } from '../api';

// 照片先在手機端縮圖壓縮（最長邊 2000px、JPEG 85%）：
// 1) 不會爆伺服器/AI 的大小限制（iPhone 原圖一張就 4-5MB）2) 上傳與 AI 讀取都快很多
// 手機直立拍的照片，畫素其實是橫的、靠 EXIF 方向旗標轉正。
// createImageBitmap(file) 預設 imageOrientation:'none' 會把旗標丟掉 →
// 送給 AI 的圖是躺著的，目錄自然讀不出來。用 <img> 解碼（瀏覽器會自動轉正），
// 失敗才退回 createImageBitmap 並明確要求 from-image。
async function decodeUpright(file) {
  const url = URL.createObjectURL(file);
  try {
    const el = await new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('decode failed'));
      im.src = url;
    });
    if (el.decode) { try { await el.decode(); } catch {} }
    return { img: el, w: el.naturalWidth || el.width, h: el.naturalHeight || el.height, free: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { bmp = await createImageBitmap(file); }
    return { img: bmp, w: bmp.width, h: bmp.height, free: () => bmp.close?.() };
  }
}

export async function fileToPayload(file) {
  if ((file.type || '').startsWith('image/')) {
    let d = null;
    try {
      d = await decodeUpright(file);
      const scale = Math.min(1, 2000 / Math.max(d.w, d.h));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(d.w * scale));
      c.height = Math.max(1, Math.round(d.h * scale));
      c.getContext('2d').drawImage(d.img, 0, 0, c.width, c.height);
      const dataUrl = c.toDataURL('image/jpeg', 0.85);
      return { filename: (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', mime: 'image/jpeg', data: dataUrl.split(',')[1] };
    } catch { /* 讀不了（如 HEIC 舊機型）就走原檔 */ }
    finally { d?.free?.(); }
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return { filename: file.name, mime: file.type, data: btoa(bin) };
}

export async function filesToPayload(fileList, max = 12) {
  const out = [];
  for (const f of [...fileList].slice(0, max)) out.push(await fileToPayload(f));
  return out;
}

// 匯入中的請求存 localStorage：解析途中退出 App，重開會自動接著做（跟日曆匯入一樣）
export const savePending = p => { try { localStorage.setItem('vocabPending', JSON.stringify(p)); } catch {} };
export const getPending = () => { try { const s = localStorage.getItem('vocabPending'); return s ? JSON.parse(s) : null; } catch { return null; } };
export const clearPending = () => { try { localStorage.removeItem('vocabPending'); } catch {} };

// ---- 遺忘曲線：決定「學過的單字哪天要再出現」 ----
// none＝不複習｜ebb＝艾賓浩斯 1/2/4/7/15/30 天｜tds＝今天學、明天再看、週日總複習｜custom＝自訂天數
export const getCurve = () => ({
  mode: localStorage.getItem('vocabCurve') || 'none',
  days: (localStorage.getItem('vocabCurveDays') || '1,3,7').split(',').map(x => +x.trim()).filter(x => x > 0),
});
export const setCurve = (mode, days) => {
  try {
    localStorage.setItem('vocabCurve', mode);
    if (days != null) localStorage.setItem('vocabCurveDays', days);
  } catch {}
};
const dayDiff = (a, b) => Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 864e5);
// learnDate 學的日子；dateStr 要判斷的日子（通常是今天）
export function reviewDue(learnDate, dateStr, curve = getCurve()) {
  const n = dayDiff(learnDate, dateStr);
  if (n <= 0) return false;
  if (curve.mode === 'ebb') return [1, 2, 4, 7, 15, 30].includes(n);
  if (curve.mode === 'tds') return n === 1 || (new Date(dateStr + 'T00:00:00').getDay() === 0 && n <= 6);
  if (curve.mode === 'custom') return curve.days.includes(n);
  return false;
}

let running = false; // 首頁卡片與單字本可能同時掛載，確保同一批只送一次
export const importing = () => running;
export async function runImport(payload) {
  if (running) return null;
  running = true;
  try {
    const r = await api('/import/vocab', { method: 'POST', body: payload });
    clearPending();
    window.dispatchEvent(new Event('vocab-updated'));
    return r;
  } finally { running = false; }
}
// 有未完成的匯入就接著做；回傳是否有接手
export function resumePending(onDone) {
  const p = getPending();
  if (!p || running) return false;
  runImport(p).then(r => onDone && onDone(r, null)).catch(e => onDone && onDone(null, e));
  return true;
}
