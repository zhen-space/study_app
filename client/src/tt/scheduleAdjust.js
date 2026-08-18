import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

// 2C-P6-A：手動調整用的前端共用層。
//
// 2C 起 ScheduledBlock 是排定時間的唯一真相，Task 的 due_date 只是鏡射。
// 畫面上大多數地方讀 due_date 就夠了（顯示用），但「調整這一項」必須知道
// 它到底是哪一個 block ——一個任務在 timed 模式下會被切成好幾塊，
// 用 task_id 去調會把使用者沒碰到的那幾塊一起重置。
//
// 所以這一層只做一件事：拿到目前生效的版本與它的 blocks，
// 並提供 task_id → blocks 的對照。不快取、不另存一份排程狀態。

export function useActiveSchedule() {
  const [state, setState] = useState({ loading: true, active: false, version: null, blocks: [] });

  const load = useCallback(async () => {
    try {
      const r = await api('/schedule/active');
      setState({ loading: false, ...r });
    } catch {
      // 讀不到就當作「還沒進入 2C」：畫面照舊顯示，只是沒有調整入口。
      // 這裡不跳錯誤訊息——使用者只是在看今天要做什麼。
      setState({ loading: false, active: false, version: null, blocks: [] });
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load };
}

// 一個任務在目前這一版的全部 block，照時間排好。
export function blocksForTask(blocks, taskId) {
  return (blocks || [])
    .filter(b => Number(b.task_id) === Number(taskId))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.start_time || '').localeCompare(b.start_time || ''));
}

// 衝突訊息：後端已經算得出原因，前端不自己重新猜一套說法。
// 只有 Lock 的 type 是機器碼（LOCKED_*），那幾種才在這裡翻成人話。
const LOCK_TEXT = {
  LOCKED_TASK_UNPLACED: '這一項已鎖定，不能移出目前的安排',
  LOCKED_TASK_MOVED: '這一項已鎖定，不能換時間',
  LOCKED_DAY_CHANGED: '那一天已鎖定，不能有任何變動',
  LOCKED_SLICE_CHANGED: '那個時段已鎖定，不能有任何變動',
};

export function conflictText(conflict) {
  return LOCK_TEXT[conflict?.type] || conflict?.message || '這個時間放不下';
}
