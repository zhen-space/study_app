// 產生 /schedule/preview request 的唯一一處 mapping。
//
// 排程精靈（建立／調整）與 Today 的 AI 重排都走這裡，兩邊不各組一份 body，
// 免得同一個計畫在不同入口被用不同的語意排一次。
//
// ── 目前實際有 persistence 的排程條件 ──────────────────────────
//   users.sleep_start / sleep_end / meal_windows   （後端自己讀，不必送）
//   fixed_events                                   （後端自己讀，不必送）
//   tasks.deadline_date                            → 每一項的硬性截止
//   tasks.due_time + notes「讀書時段 A–B」          → 時間模式下的每項時長
//   plans.start_date / target_date                 → 整體區間
//
// ── 目前「沒有」persistence 的排程條件 ───────────────────────────
//   timed（待辦／時間模式）、pace（平均／盡早）、perDay、
//   限制每天數量、不排的星期／日期、行程太滿就不排的門檻、
//   章節打散或照順序、幾個單位綁一組、題型分組
//
//   Phase 2A 的 plans 表沒有 scheduling profile 欄位，Task 也沒有 workload 欄位。
//   在 2C 把排程條件正式收進 domain 之前，這裡用一個過渡的前端快照補位：
//   使用者「成功套用一次排程」時，把那次真正用的條件記下來。
//   拿不到就是拿不到 —— 不准猜成 60 分鐘／even／一天 3 項。
//
// ── 為什麼不是用 wizardDraft ────────────────────────────────
//   wizardDraft 的語意是「這次操作到一半的設定」，成功套用後就會被清掉，
//   正好是重排最需要它的時候它已經不在了。兩者生命週期相反，不能混用。
//
// ── 這個快照的限制（technical debt，2C 要收掉）────────────────
//   ・存在 localStorage：跨裝置不同步、清瀏覽器資料就消失
//   ・2B-UI-2 之前建立的計畫沒有快照
//   ・不是 domain persistence，只是過渡層；正式做法是 Plan 的
//     scheduling profile 由後端保存（見 docs/phase2c-schedule-persistence.md）
//   它唯一比 wizardDraft 正確的地方，是生命週期與語意一致。

// 「這個計畫最近一次成功套用排程時，使用者確認的排法」
const CONFIRMED_KEY = planId => `scheduleConditions:plan:${planId}`;

// 快照只保存「條件」，不保存排程結果。
// 白名單寫死在這裡：due_date / due_time / blocks / version 這類東西
// 就算呼叫端不小心傳進來也存不進去——這裡不能長成第三套 schedule state。
const CONDITION_FIELDS = [
  'timed', 'limitPerDay', 'perDay', 'pace',
  'excludeWeekdays', 'excludeDates', 'skipIfBusyHours',
];

// 缺哪一項條件就無法忠實重現原本的排法（給 UI 顯示用）
export const CONDITION_LABEL = {
  timed: '要排到幾點，還是只列每天做什麼',
  pace: '進度節奏（平均分配或盡早排完）',
  perDay: '每天排幾項',
  workload: '每一項大約要花多久',
};

/* ---------- request builder ---------- */

// conditions 就是「使用者設定的排法」，欄位名稱跟精靈裡的狀態一致。
// 這裡只做 mapping，不補預設值——沒給的條件由呼叫端自己負責。
export function buildSchedulePreviewRequest({ items, startDate, endDate, conditions }) {
  const c = conditions || {};
  const body = {
    items,
    startDate,
    endDate,
    excludeWeekdays: c.excludeWeekdays || [],
    excludeDates: c.excludeDates || [],
    skipIfBusyHours: c.skipIfBusyHours || 0,
    timed: !!c.timed,
    // 時間模式一定有每日上限；只排進度時要使用者自己勾「限制每天數量」才有
    perDay: (c.timed || c.limitPerDay) ? c.perDay : 0,
    pace: c.pace,
  };
  // 「這次調整作息」是一次性的，沒有存起來；有帶才送，沒帶就用帳號的正常作息
  if (c.sleep_start && c.sleep_end) { body.sleep_start = c.sleep_start; body.sleep_end = c.sleep_end; }
  return body;
}

/* ---------- 重排時要用的原計畫條件 ---------- */

// 時間模式下每一項要排多久：從任務自己身上還原。
// 精靈排出時段時會寫 notes「讀書時段 08:00–09:30」，那就是當初算出來的時長。
export function taskMinutes(t) {
  const m = String(t.notes || '').match(/(\d{1,2}):(\d{2})[–\-~](\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mins = (+m[3] * 60 + +m[4]) - (+m[1] * 60 + +m[2]);
  return mins > 0 ? mins : null;
}

// 成功套用一次排程後呼叫：把這次真正用的條件記下來，之後重排才有得依循。
// 一定要在清掉 wizardDraft 之前呼叫。
export function saveConfirmedConditions(planId, conditions) {
  if (planId == null) return null;
  const out = {};
  for (const k of CONDITION_FIELDS) if (conditions?.[k] !== undefined) out[k] = conditions[k];
  try { localStorage.setItem(CONFIRMED_KEY(planId), JSON.stringify(out)); } catch {}
  return out;
}

export function readConfirmedConditions(planId) {
  if (planId == null) return null;
  try { return JSON.parse(localStorage.getItem(CONFIRMED_KEY(planId)) || 'null'); } catch { return null; }
}

// 這個計畫的排法是什麼？拿不到就明講拿不到。
// pending＝這個計畫還沒完成的任務（重排的對象）。
//
// 只讀「已確認的條件快照」。刻意不讀 wizardDraft：那是操作中的草稿，
// 可能是使用者改到一半、根本沒套用過的設定，不能當成這個計畫的排法。
export function planScheduleConditions(planId, pending = []) {
  const saved = readConfirmedConditions(planId);

  const missing = [];
  if (!saved || saved.timed == null) missing.push('timed');
  if (!saved || !saved.pace) missing.push('pace');
  if (!saved || saved.perDay == null) missing.push('perDay');

  const conditions = saved ? { ...saved } : null;

  // 時間模式才需要每項時長；只排進度時排程器根本不看 minutes，
  // 所以不用（也不該）生一個假的數字出來。
  const minutes = {};
  if (conditions?.timed) {
    for (const t of pending) {
      const m = taskMinutes(t);
      if (m == null) { if (!missing.includes('workload')) missing.push('workload'); }
      else minutes[t.id] = m;
    }
  }

  return { conditions, minutes, missing, complete: missing.length === 0 };
}
