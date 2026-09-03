import { useMemo } from 'react';
import { today } from './helpers';

// 計畫的資料來源分兩種，Phase 2A 兩種並存：
//
//   1. 正式 Plan（後端 plans 表）—— 任務帶 plan_id，由 /api/plans 取得
//   2. Legacy 推導 —— 舊資料沒有 plan_id，只能照標籤／標題猜，依科目分組
//
// 舊資料還沒 migrate（要等 docs/phase2-plan-domain.md §5A 的閘門解除），
// 所以 legacy 推導必須留著，不然使用者現有的計畫會整個從畫面消失。
// 正式 Plan 一旦有了，同一批任務就不會再被 legacy 推導撿走。

/* ---------- 共用小工具 ---------- */

// 標題形如「物理｜新大滿貫｜單元3｜節2｜範例+例題」→ 書名取第 2 段
export const bookOf = title => {
  const seg = String(title || '').split('｜');
  return seg.length >= 2 ? seg[1].trim() : '其他';
};
// 顯示用：把「科目｜書名｜」前綴拿掉，列表裡不用一直重複
export const shortTitle = title => {
  const seg = String(title || '').split('｜');
  return seg.length > 2 ? seg.slice(2).join('｜') : title;
};
export const md = d => (d ? `${+d.slice(5, 7)}/${+d.slice(8)}` : '');
export const byLesson = new Intl.Collator('zh-Hant', { numeric: true }).compare;

// 舊的讀書計劃任務：帶「讀書計劃」標籤，或標題含全形｜（早期標籤遺失的那批）
export const isLegacyPlanTask = t =>
  !t.deleted && t.plan_id == null
  && ((Array.isArray(t.tags) && t.tags.includes('讀書計劃')) || (t.title || '').includes('｜'));

/* ---------- 計畫名稱（新建與 legacy 共用同一套規則） ---------- */

// 單科單書 → 「{科目}｜{書名}」；其他 → 「讀書計畫｜{起}–{迄}」
// 兩邊用同一套，新舊計畫在列表裡看起來才是同一類東西。
export function planName(tasks, lists) {
  const listIds = [...new Set(tasks.map(t => t.list_id ?? t.subject_id).filter(x => x != null))];
  const books = [...new Set(tasks.map(t => bookOf(t.title)))];
  if (listIds.length === 1 && books.length === 1 && books[0] !== '其他') {
    const name = lists.find(l => String(l.id) === String(listIds[0]))?.name;
    if (name) return `${name}｜${books[0]}`;
  }
  const dates = tasks.map(t => t.due_date || t.date).filter(Boolean).sort();
  const a = dates[0], b = dates[dates.length - 1];
  return `讀書計畫｜${a ? md(a) : ''}–${b ? md(b) : ''}`;
}

/* ---------- 統一的計畫視圖 ---------- */

// 把正式 Plan 與 legacy 推導的計畫合併成同一種形狀，畫面只認這一種。
// legacy 的 `isLegacy: true`，UI 據此標示並限制可編輯的動作。
export function usePlans(tasks, lists, apiPlans = []) {
  return useMemo(() => {
    const ord = {};
    lists.forEach((l, i) => { ord[String(l.id)] = i; });
    const decorate = (items, extra) => {
      const dates = items.map(t => t.due_date).filter(Boolean).sort();
      const list = lists.find(x => String(x.id) === String(extra.listId));
      // 跨科摘要：一個 Plan 可以同時有好幾科的任務，卡片與明細都要顯示得出來。
      // primary_list_id 只是顯示提示，不代表 Plan 的身分。
      const bySubj = new Map();
      for (const t of items) {
        const k = String(t.list_id ?? '');
        bySubj.set(k, (bySubj.get(k) || 0) + 1);
      }
      const subjects = [...bySubj.entries()]
        .sort((a, b) => b[1] - a[1] || (ord[a[0]] ?? 99) - (ord[b[0]] ?? 99))
        .map(([k, count]) => {
          const l = lists.find(x => String(x.id) === k);
          return { id: k === '' ? null : Number(k), name: l?.name || '未分科目', color: l?.color || 'var(--muted)', icon: l?.icon || 'book', count };
        });
      return {
        items,
        done: items.filter(t => t.completed).length,
        total: items.length,
        overdue: items.filter(t => !t.completed && t.due_date && t.due_date < today()).length,
        // 「在計畫裡」不等於「已經排到日期」——沒有日期的就是還沒安排。
        // （2C 之後改看 active ScheduleVersion 的 block，目前 due_date 仍是權威來源，
        //   見 docs/phase2c-schedule-persistence.md §5B 2A-1 的過渡例外）
        unplaced: items.filter(t => !t.completed && !t.due_date),
        subjects,
        start: extra.start ?? dates[0] ?? '',
        end: extra.end ?? dates[dates.length - 1] ?? '',
        books: [...new Set(items.map(t => bookOf(t.title)))],
        color: list?.color || subjects[0]?.color || 'var(--muted)',
        icon: list?.icon || subjects[0]?.icon || 'book',
        ...extra,
      };
    };

    // ① 正式 Plan
    const byPlan = new Map();
    for (const t of tasks) {
      if (t.deleted || t.plan_id == null) continue;
      if (!byPlan.has(t.plan_id)) byPlan.set(t.plan_id, []);
      byPlan.get(t.plan_id).push(t);
    }
    const real = apiPlans.map(p => decorate(byPlan.get(p.id) || [], {
      key: `plan:${p.id}`,
      planId: p.id,
      listId: p.primary_list_id,
      name: p.name,
      status: p.status,
      // 舊 archived 資料保留 read compatibility：分類時依 archived_from_status
      // 投影回已完成／已結束，不另存新狀態。
      archived_from_status: p.archived_from_status || null,
      start: p.start_date || undefined,
      end: p.target_date || undefined,
      isLegacy: false,
    }));

    // ② 還沒 migrate 的舊資料：照科目分組（暫時做法，不是 domain rule）
    const byList = new Map();
    for (const t of tasks.filter(isLegacyPlanTask)) {
      const k = String(t.list_id ?? '');
      if (!byList.has(k)) byList.set(k, []);
      byList.get(k).push(t);
    }
    const legacy = [...byList.entries()]
      .sort((a, b) => (ord[a[0]] ?? 99) - (ord[b[0]] ?? 99))
      .map(([k, items]) => decorate(items, {
        key: `legacy:${k}`,
        planId: null,
        listId: k === '' ? null : Number(k),
        name: lists.find(x => String(x.id) === k)?.name || '未分科目',
        status: 'active',
        isLegacy: true,
      }));

    return [...real, ...legacy];
  }, [tasks, lists, apiPlans]);
}
