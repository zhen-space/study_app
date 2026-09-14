// 跨全 App 的日期語意（Phase 1 §M / §D3，P0）。
//
// 問題：現在 generic「日期」同時承擔三種完全不同的概念，於是 AI 原本安排的進度日
// 被錯叫成「逾期」、deadline 與 ScheduledBlock 也長得一樣。這個純函式模組把三種語意
// 一次定義清楚，之後所有視圖（Today / Tasks / Task Detail / Calendar / Study）都從
// 這裡取字，不各自拼日期字串。
//
//   1. Deadline        → 截止 / 逾期            （學校或使用者設定的「最後期限」時間點）
//   2. Daily progress  → 今日進度 / 原定 M/D / 未完成進度（AI 安排「哪天做」，沒有時段）
//   3. ScheduledBlock  → 今天 HH:MM–HH:MM / 錯過安排（實際排定的時段）
//
// 「今天」一律由呼叫端傳入（Asia/Taipei 的今天），純函式才測得準、不依裝置時區。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const isDate = v => typeof v === 'string' && DATE_RE.test(v);
const isTime = v => typeof v === 'string' && TIME_RE.test(v);
const WD = '日一二三四五六';

/* ---------- 中文日期格式 ---------- */

// 9/14
export function zhDateShort(iso) {
  if (!isDate(iso)) return '';
  return `${+iso.slice(5, 7)}/${+iso.slice(8)}`;
}
// 9 月 14 日（可選帶星期）
export function zhDate(iso, { weekday = false } = {}) {
  if (!isDate(iso)) return '';
  const base = `${+iso.slice(5, 7)} 月 ${+iso.slice(8)} 日`;
  if (!weekday) return base;
  return `${base}（週${WD[new Date(iso + 'T00:00:00').getDay()]}）`;
}

// 相對「今天」的口語：今天／明天／昨天，否則回 zhDateShort。
export function relativeDay(iso, todayISO) {
  if (!isDate(iso) || !isDate(todayISO)) return zhDateShort(iso);
  if (iso === todayISO) return '今天';
  const d = new Date(iso + 'T00:00:00');
  const t = new Date(todayISO + 'T00:00:00');
  const diff = Math.round((d - t) / 86400000);
  if (diff === 1) return '明天';
  if (diff === -1) return '昨天';
  return zhDateShort(iso);
}

/* ---------- 三種語意的標籤 ---------- */

// Deadline：截止（未到）／逾期（已過）。tone 給 UI 上色，不決定顏色本身。
// 沒有時間＝當天結束前（不顯示假的 23:59）。
export function deadlineLabel(deadlineDate, deadlineTime, todayISO) {
  if (!isDate(deadlineDate)) return null;
  const overdue = deadlineDate < todayISO;
  const day = relativeDay(deadlineDate, todayISO);
  const time = isTime(deadlineTime) ? ` ${deadlineTime}` : '';
  return overdue
    ? { kind: 'deadline', tone: 'overdue', text: `逾期 · ${day}${time}` }
    : { kind: 'deadline', tone: deadlineDate === todayISO ? 'today' : 'normal', text: `截止 ${day}${time}` };
}

// Daily progress：AI 安排「哪一天做」，沒有時段。過了原定日不是「逾期」，是「未完成進度」。
export function dailyProgressLabel(progressDate, todayISO) {
  if (!isDate(progressDate)) return null;
  if (progressDate === todayISO) return { kind: 'daily_progress', tone: 'today', text: '今日進度' };
  if (progressDate < todayISO) return { kind: 'daily_progress', tone: 'missed', text: `未完成進度 · 原定 ${zhDateShort(progressDate)}` };
  return { kind: 'daily_progress', tone: 'normal', text: `原定 ${zhDateShort(progressDate)}` };
}

// ScheduledBlock：實際排定的時段。過了就是「錯過安排」，不是「逾期」。
export function scheduledBlockLabel(blockDate, startTime, endTime, todayISO) {
  if (!isDate(blockDate)) return null;
  const span = isTime(startTime) ? `${startTime}${isTime(endTime) ? `–${endTime}` : ''}` : '';
  if (blockDate < todayISO) return { kind: 'scheduled_block', tone: 'missed', text: `錯過安排${span ? ` · ${span}` : ''}` };
  const day = relativeDay(blockDate, todayISO);
  return { kind: 'scheduled_block', tone: blockDate === todayISO ? 'today' : 'normal', text: `${day} ${span}`.trim() };
}
