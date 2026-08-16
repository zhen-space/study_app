import PomoView from './PomoView';

// 「讀書」＝中央主要動作：現在就開始一段讀書。
//
// Phase 1 只重新定位入口，不做完整的 Study Session domain。
// 既有的番茄鐘能力（絕對時間戳倒數、背景音、綁定任務、/pomo 專注紀錄）
// 原封不動保留在 PomoView 裡，這層只負責「這是讀書的入口」這件事，
// 以後 Study Session（開始／暫停／記錄實際讀了哪個 Scheduled Block）
// 接上來的時候，改這個檔案就好，不用動計時器本身。

export default function StudyView({ tasks }) {
  return <PomoView tasks={tasks} />;
}
