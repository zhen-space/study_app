// 正式 Material import parser。
//
// 與 legacy 的 POST /api/import/toc 是**兩條路**，刻意不共用 prompt：
// legacy 的 prompt 要求「章 → 節 → 主題」三層巢狀，那與正式 hierarchy
// （Section 與 Topic 同層）正面衝突。直接改舊 endpoint 會讓既有資料的語意
// 在一次部署之間改變，所以舊的原樣保留，新的走這裡。
//
// 這支直接輸出 canonical draft，不先產 legacy TOC 形狀再讓前端自己轉——
// 轉換寫在前端就等於把 hierarchy 契約複製了一份到前端，遲早分岔。

import Anthropic from '@anthropic-ai/sdk';

// structured outputs 不支援遞迴，所以層級寫死。
// 這正好與正式 hierarchy 一致：Book → Chapter →（Section｜Topic），到此為止。
const CONTENT_ITEM = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '這個項目在課本上的名稱' },
    kind: {
      type: 'string',
      enum: ['reading', 'example', 'example_problem', 'unit_exercise', 'past_exam'],
      description: 'reading=課本內容, example=範例, example_problem=例題, unit_exercise=單元練習, past_exam=歷屆試題',
    },
  },
  required: ['title', 'kind'], additionalProperties: false,
};
const CHILD = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    kind: { type: 'string', enum: ['section', 'topic'], description: 'section=節, topic=主題' },
    content_items: { type: 'array', items: CONTENT_ITEM },
  },
  required: ['title', 'kind', 'content_items'], additionalProperties: false,
};
const CHAPTER = {
  type: 'object',
  properties: {
    title: { type: 'string', description: '章的完整名稱，含編號' },
    children: { type: 'array', items: CHILD, description: '這一章底下的節與主題（同一層）' },
    content_items: {
      type: 'array', items: CONTENT_ITEM,
      description: '直接屬於這一章的內容，通常是單元練習與歷屆試題',
    },
  },
  required: ['title', 'children', 'content_items'], additionalProperties: false,
};
export const MATERIAL_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    book: {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'], description: '課本書名，看不到就 null，不要猜' },
        publisher: { type: ['string', 'null'], description: '出版社，看不到就 null' },
      },
      required: ['title', 'publisher'], additionalProperties: false,
    },
    chapters: { type: 'array', items: CHAPTER },
  },
  required: ['book', 'chapters'], additionalProperties: false,
};

export const MATERIAL_PARSER_SYSTEM = `你是課本目錄解讀助手。使用者可能上傳多張目錄照片（同一本課本的連續頁面），請把所有照片視為同一份目錄，依頁面順序合併，不要遺漏跨頁內容，也不要重複計算兩張照片重疊處的同一項。

【階層｜最重要】
正式結構只有兩層節點，**節與主題是同一層**：

書
└─ 章
   ├─ 節（section）
   ├─ 主題（topic）
   ├─ 單元練習（章直屬）
   └─ 歷屆試題（章直屬）

- chapters[] 只放「章」（大的阿拉伯數字或「第N章」「第N課」「單元N」）。
- 每個章的 children[] 同時放「節」與「主題」，**兩者平行並列**，用 kind 區分：
  節（壹貳參肆、3-1、一二三…）→ kind="section"
  主題／重點（主題1、重點2…）→ kind="topic"
- **絕對不要**把主題放進節的 children —— children 底下沒有再下一層。
- 主題在課本上如果印在某個節底下，仍然照原本順序排在那個節的後面，但 kind 標成 topic、和節並列。

【內容項目 content_items】
把課本上實際「要讀／要做」的東西列出來，kind 只能是這五種：
- reading（課本內容）：這一節／主題的講解內文
- example（範例）：課本示範、講解過的例子
- example_problem（例題）：要學生自己動手做的題目
- unit_exercise（單元練習）：整章後面的練習題
- past_exam（歷屆試題）：歷屆考題

放置規則（違反會被拒絕）：
- example 與 example_problem **只能**放在節或主題的 content_items 裡
- unit_exercise 與 past_exam **只能**放在章的 content_items 裡
- reading 章、節、主題都可以

【範例與例題要分開】
「範例」是課本講解過的示範，「例題」是要自己做的題目。它們是兩種不同的東西，
不要合併成一項。課本上只看得到其中一種時，就只輸出那一種。

【不要無中生有】
- 目錄上沒有印出來的內容項目就不要編。看得到「範例1-5」才輸出範例。
- 如果整節只看得到標題、沒有列出內容，就給 content_items: [] 或只放一筆 reading。
- 不要為了讓題目有 parent 而虛構一個節。單元練習與歷屆試題直接放章底下。

【書名與出版社】
照片上看得到就照抄；看不到就 null，不要猜。

【其他】
- title 保留原始編號與名稱。
- 照片邊緣被切到、名稱讀不完整的項目就略過不要猜。忽略附錄、索引、頁碼。
- 照片可能是躺著的、歪斜、或有陰影：請自行判斷文字方向後再讀。`;

// 把模型輸出轉成 canonical draft 的輸入形狀。
// 這裡只做欄位搬運與順序補齊；合法性一律交給 draft.js 的 validateDraft，
// 不在這裡再寫一份規則。
export function toDraftInput(parsed, { subjectListId = null, fallbackTitle = '' } = {}) {
  const chapters = (parsed?.chapters || []).map((c, ci) => ({
    title: c?.title ?? '',
    order: ci,
    content_items: (c?.content_items || []).map((it, i) => ({ ...it, order: i })),
    children: (c?.children || []).map((s, si) => ({
      kind: s?.kind,
      title: s?.title ?? '',
      order: si,
      content_items: (s?.content_items || []).map((it, i) => ({ ...it, order: i })),
    })),
  }));
  return {
    book: {
      title: (parsed?.book?.title || fallbackTitle || '').trim(),
      publisher: parsed?.book?.publisher || '',
      subject_list_id: subjectListId,
    },
    chapters,
  };
}

// 呼叫模型。createFn 由呼叫端注入（沿用 import.js 既有的重試包裝），
// 測試時也可以注入假的，不必真的打 API。
export async function parseMaterialImage(blocks, { createFn, model = 'claude-opus-4-8' } = {}) {
  const client = new Anthropic();
  const response = await createFn(client, {
    model,
    max_tokens: 12000,
    system: MATERIAL_PARSER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: MATERIAL_DRAFT_SCHEMA } },
    messages: [{
      role: 'user',
      content: [...blocks, { type: 'text', text: '請把以上所有照片合併，完整擷取這本課本的目錄結構。' }],
    }],
  });
  return response;
}
