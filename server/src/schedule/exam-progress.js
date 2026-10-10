import { addDays, parseDay } from '../util/date.js';

const daysBetweenInclusive = (start, end) =>
  Math.max(1, Math.round((parseDay(end) - parseDay(start)) / 86400000) + 1);

// 「完成範圍」不是把整份考試範圍掛在同一個大日期區間，而是把每科內容
// 依輸入順序與預估分鐘切成數個連續區間。它不建立每日待辦；每一段只回答
// 「這幾天以前要讀完哪些內容」。預覽與正式寫入共用這一支，避免所見非所得。
export function buildExamProgressSegments(scope, startDate, subjectNames = new Map()) {
  const result = [];
  let order = 0;

  for (const subject of scope.orderedSubjects) {
    const sid = Number(subject.subject_list_id);
    const end = subject.exam_date;
    const start = startDate || end;
    const items = [
      ...scope.scopeItems
        .filter(item => Number(item.subjectId) === sid)
        .map(item => ({
          kind: item.kind,
          title: item.title,
          minutes: Number(item.minutes) > 0 ? Number(item.minutes) : 30,
          content_item_id: item.contentItemId == null ? null : Number(item.contentItemId),
        })),
      ...scope.manualEntries
        .filter(item => Number(item.subject_list_id) === sid)
        .map(item => ({
          kind: 'manual', title: item.label,
          minutes: Number(item.estimated_minutes) > 0 ? Number(item.estimated_minutes) : 30,
          content_item_id: null,
        })),
    ];
    if (!items.length) continue;

    const availableDays = daysBetweenInclusive(start, end);
    const bucketCount = Math.min(items.length, availableDays);
    const totalMinutes = items.reduce((sum, item) => sum + item.minutes, 0);
    // 日數足夠時每個範圍各自一段；範圍比日數多時才依原順序合併，且每一天
    // 至少有一段。這樣不會為了「平均分鐘」把所有內容又吞回同一個大區間。
    const buckets = Array.from({ length: bucketCount }, () => ({ items: [], minutes: 0 }));
    items.forEach((item, index) => {
      const bucket = buckets[Math.floor(index * bucketCount / items.length)];
      bucket.items.push(item);
      bucket.minutes += item.minutes;
    });

    let cursor = start;
    let usedDays = 0;
    let usedMinutes = 0;
    buckets.forEach((bucket, index) => {
      const remainingBuckets = buckets.length - index - 1;
      usedMinutes += bucket.minutes;
      const idealEnd = index === buckets.length - 1
        ? availableDays
        : Math.round((usedMinutes / totalMinutes) * availableDays);
      const endOffset = Math.max(usedDays + 1, Math.min(availableDays - remainingBuckets, idealEnd));
      const segmentEnd = addDays(start, endOffset - 1);
      const subjectName = subjectNames.get(sid) || '科目';
      const title = `${subjectName}：${bucket.items.map(item => item.title).join('、')}`;
      result.push({
        subject_list_id: sid,
        subject_name: subjectNames.get(sid) || null,
        start_date: cursor,
        end_date: segmentEnd,
        title,
        scope: bucket.items.map(item => item.content_item_id).filter(id => id != null),
        items: bucket.items,
        kind: 'study',
        order_index: order++,
      });
      usedDays = endOffset;
      cursor = addDays(segmentEnd, 1);
    });
  }
  return result;
}
