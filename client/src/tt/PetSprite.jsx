import { useState } from 'react';

// 原創小怪獸圖鑑 —— 每隻有自己的體型比例、動作節奏與說話個性
export const MONSTERS = {
  mon1: {
    body: ['#b8e26b', '#7cb342'], name: '毛吉', desc: '瘦高獨眼怪，熱血隊長型',
    scale: 1.06, // 最高
    walk: { size: 80, moveDur: 2.8, gap: [3500, 6000], anim: 'pet-waddle .5s ease-in-out infinite' }, // 大步彈跳
    voice: {
      remain: n => `還有 ${n} 項任務！衝衝衝，我陪你！🔥`,
      overdue: n => `有 ${n} 項逾期了！沒關係，現在開始追還來得及！`,
      next: t => `下一關：「${t}」！上吧！`,
      done: '任務全清！你就是傳說！🏆',
      quotes: ['先衝 5 分鐘，氣勢就出來了！', '每天贏過昨天的自己一點點！', '錯的題目都是經驗值，撿起來！', '累了就深呼吸，然後再上！'],
    },
  },
  mon2: {
    body: ['#d29bff', '#9c4dcc'], name: '嘟波', desc: '矮胖三眼怪，冷靜軍師型',
    scale: 0.88, // 矮胖
    walk: { size: 58, moveDur: 4.5, gap: [5000, 9000], anim: 'pet-waddle .8s ease-in-out infinite' }, // 慢慢晃
    voice: {
      remain: n => `我三隻眼睛都看到了：今天還剩 ${n} 項。`,
      overdue: n => `觀察報告：${n} 項逾期。建議先解決最小的那個。`,
      next: t => `依我分析，先做「${t}」效率最高。`,
      done: '今日進度 100%。數據很漂亮。📊',
      quotes: ['專注 25 分鐘 > 分心 2 小時，這是數學。', '慢慢來，比較快。', '複習的最佳時機是睡前一小時。', '把大目標切小，就不可怕了。'],
    },
  },
  mon3: {
    body: ['#6ecbff', '#1e88e5'], name: '藍牙', desc: '寬扁大嘴怪，開心果型',
    scale: 1.0, // 寬
    walk: { size: 86, moveDur: 5.5, gap: [6000, 10000], anim: 'pet-waddle 1s ease-in-out infinite' }, // 沉重慢步
    voice: {
      remain: n => `嘿嘿，還有 ${n} 項～做完我們就去玩！😁`,
      overdue: n => `哎呀 ${n} 項過期啦～沒事沒事，現在補最帥！`,
      next: t => `來嘛來嘛，「${t}」很快就寫完了啦～`,
      done: '全部做完！笑一個嘛～😆',
      quotes: ['笑著讀書記得比較牢，真的！', '寫完這頁，獎勵自己一首歌～', '讀書就像吃飯，一口一口來。', '今天也要開開心心地變聰明！'],
    },
  },
  mon4: {
    body: ['#ffb27a', '#f4511e'], name: '皮皮', desc: '迷你捲角小惡魔，嘴賤激將型',
    scale: 0.78, // 最小隻
    walk: { size: 48, moveDur: 1.4, gap: [2000, 4000], anim: 'pet-waddle .35s ease-in-out infinite' }, // 竄來竄去
    voice: {
      remain: n => `${n} 項還沒做？嘖嘖，我看你是不敢吧～😏`,
      overdue: n => `逾期 ${n} 項欸，被我抓到了吼！`,
      next: t => `「${t}」而已欸，該不會不敢寫吧？`,
      done: '哇喔，全做完了？算你厲害啦～🤟',
      quotes: ['怕就輸一輩子囉～', '你的對手正在寫第三題。', '躺著滑手機不會變聰明，可惜～', '證明給我看啊！'],
    },
  },
};

const INK = '#3a3644'; // 卡通描邊色

// 長短不一的毛髮輪廓（deterministic 偽隨機）
function furPath(cx, cy, rx, ry, n, len, seed = 1) {
  let d = '';
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const j = Math.sin(i * 7.31 * seed) * .5 + .5;
    const L = len * (.5 + j * 1.1);
    const w = (Math.PI * 2 / n) * .48;
    const sway = Math.sin(i * 3.7 + seed) * L * .45;
    const x1 = cx + Math.cos(a - w) * rx, y1 = cy + Math.sin(a - w) * ry;
    const x2 = cx + Math.cos(a + w) * rx, y2 = cy + Math.sin(a + w) * ry;
    const tx = cx + Math.cos(a) * (rx + L) + Math.cos(a + Math.PI / 2) * sway;
    const ty = cy + Math.sin(a) * (ry + L) + Math.sin(a + Math.PI / 2) * sway;
    d += `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${tx.toFixed(1)} ${ty.toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)} `;
  }
  return d;
}

// 會東張西望的眼睛
const Eye = ({ x, y, r = 13, look = true }) => (
  <g>
    <circle cx={x} cy={y} r={r} fill="#fff" stroke={INK} strokeWidth="3" />
    <g style={look ? { animation: 'pet-look 5s ease-in-out infinite' } : undefined}>
      <circle cx={x} cy={y + r * .18} r={r * .48} fill={INK} />
      <circle cx={x + r * .2} cy={y - r * .05} r={r * .17} fill="#fff" />
    </g>
  </g>
);

const Blush = ({ x, y, s = 1 }) => <ellipse cx={x} cy={y} rx={9 * s} ry={5 * s} fill="#ff7d94" opacity=".55" />;

function Gear({ equipped, headY = 40, eyeLine, glassesOne }) {
  const has = id => equipped.includes(id);
  return (
    <g>
      {has('hat') && <g transform={`translate(0 ${headY - 40})`}>
        <ellipse cx="100" cy="42" rx="33" ry="8" fill="#26232e" stroke={INK} strokeWidth="2.5" />
        <rect x="81" y="10" width="38" height="34" rx="6" fill="#26232e" stroke={INK} strokeWidth="2.5" />
        <rect x="81" y="33" width="38" height="8" fill="#e53950" />
      </g>}
      {has('glasses') && (glassesOne
        ? <g><circle cx={glassesOne[0]} cy={glassesOne[1]} r={glassesOne[2]} fill="#26232e" opacity=".9" stroke={INK} strokeWidth="2" /></g>
        : eyeLine && <g>
          <circle cx={eyeLine[0]} cy={eyeLine[2]} r="15" fill="#26232e" opacity=".9" stroke={INK} strokeWidth="2" />
          <circle cx={eyeLine[1]} cy={eyeLine[2]} r="15" fill="#26232e" opacity=".9" stroke={INK} strokeWidth="2" />
          <path d={`M${eyeLine[0] + 15} ${eyeLine[2]} L${eyeLine[1] - 15} ${eyeLine[2]}`} stroke={INK} strokeWidth="4" />
        </g>)}
      {has('bow') && <g transform="translate(100 148)">
        <path d="M0 0 L-17 -10 L-17 10 Z" fill="#f06292" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M0 0 L17 -10 L17 10 Z" fill="#f06292" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
        <circle r="5.5" fill="#c2185b" stroke={INK} strokeWidth="2" />
      </g>}
      {has('flower') && <g transform="translate(150 52) scale(.9)">
        {[0, 60, 120, 180, 240, 300].map(a => <ellipse key={a} cx="0" cy="-11" rx="6" ry="10" fill="#ffd54f" stroke={INK} strokeWidth="1.8" transform={`rotate(${a})`} />)}
        <circle r="6.5" fill="#6d4c41" stroke={INK} strokeWidth="1.8" />
      </g>}
    </g>
  );
}

/* ============ 各怪獸本體 ============ */

// 毛吉：瘦高蛋形、爆炸長毛、一顆超大眼
const Mon1 = ({ g, equipped }) => (
  <g>
    <path d={furPath(100, 108, 52, 66, 46, 16, 1)} fill={`url(#${g})`} stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <ellipse cx="100" cy="108" rx="52" ry="66" fill={`url(#${g})`} />
    {/* 呆毛 */}
    <path d="M96 40 q-4 -18 6 -26 M104 42 q6 -16 -2 -24 M100 40 q0 -14 0 -22" fill="none" stroke={INK} strokeWidth="3" strokeLinecap="round" />
    {/* 腳 */}
    <ellipse cx="78" cy="176" rx="14" ry="9" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    <ellipse cx="122" cy="176" rx="14" ry="9" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    {/* 超大獨眼 */}
    <g style={{ animation: 'pet-blink 3.4s infinite', transformOrigin: '100px 92px' }}><Eye x={100} y={92} r={26} /></g>
    <Blush x={62} y={116} /><Blush x={138} y={116} />
    {/* 開口笑＋兔牙 */}
    <path d="M78 132 Q100 152 122 132 Q100 142 78 132 Z" fill={INK} />
    <rect x="90" y="131" width="9" height="10" rx="2" fill="#fff" stroke={INK} strokeWidth="1.5" />
    <rect x="101" y="131" width="9" height="10" rx="2" fill="#fff" stroke={INK} strokeWidth="1.5" />
    {/* 小短手 */}
    <path d="M48 128 q-14 4 -16 16" fill="none" stroke={INK} strokeWidth="9" strokeLinecap="round" style={{ animation: 'pet-arm 2s ease-in-out infinite', transformOrigin: '48px 128px' }} />
    <path d="M152 128 q14 4 16 16" fill="none" stroke={INK} strokeWidth="9" strokeLinecap="round" style={{ animation: 'pet-arm 2s ease-in-out infinite reverse', transformOrigin: '152px 128px' }} />
    <Gear equipped={equipped} headY={46} glassesOne={[100, 92, 28]} />
  </g>
);

// 嘟波：矮胖水滴形、短絨毛、三眼直排＋雙彈簧天線
const Mon2 = ({ g, equipped }) => (
  <g>
    {/* 天線 */}
    <g style={{ animation: 'pet-antenna 1.6s ease-in-out infinite', transformOrigin: '86px 62px' }}>
      <path d="M86 62 q-10 -20 -2 -34" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <circle cx="84" cy="24" r="7" fill="#ffd54f" stroke={INK} strokeWidth="2.5" />
    </g>
    <g style={{ animation: 'pet-antenna 1.6s ease-in-out infinite reverse', transformOrigin: '114px 62px' }}>
      <path d="M114 62 q10 -20 2 -34" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
      <circle cx="116" cy="24" r="7" fill="#4dd0e1" stroke={INK} strokeWidth="2.5" />
    </g>
    <path d={furPath(100, 118, 62, 56, 60, 8, 2)} fill={`url(#${g})`} stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <ellipse cx="100" cy="118" rx="62" ry="56" fill={`url(#${g})`} />
    {/* 肚皮 */}
    <ellipse cx="100" cy="140" rx="30" ry="24" fill="#fff" opacity=".45" />
    <ellipse cx="70" cy="178" rx="13" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    <ellipse cx="130" cy="178" rx="13" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    {/* 三眼：中大旁小 */}
    <g style={{ animation: 'pet-blink 4.2s infinite', transformOrigin: '100px 98px' }}>
      <Eye x={68} y={102} r={9} /><Eye x={100} y={94} r={15} /><Eye x={132} y={102} r={9} />
    </g>
    <Blush x={56} y={124} s={.9} /><Blush x={144} y={124} s={.9} />
    {/* 小 o 嘴（驚訝可愛） */}
    <ellipse cx="100" cy="126" rx="8" ry="10" fill={INK} />
    <ellipse cx="100" cy="123" rx="5" ry="5" fill="#c62847" />
    {/* 圓手 */}
    <circle cx="38" cy="130" r="10" fill={`url(#${g})`} stroke={INK} strokeWidth="3" style={{ animation: 'pet-arm 2.4s ease-in-out infinite', transformOrigin: '44px 122px' }} />
    <circle cx="162" cy="130" r="10" fill={`url(#${g})`} stroke={INK} strokeWidth="3" style={{ animation: 'pet-arm 2.4s ease-in-out infinite reverse', transformOrigin: '156px 122px' }} />
    <Gear equipped={equipped} headY={56} eyeLine={null} glassesOne={[100, 94, 17]} />
  </g>
);

// 藍牙：寬扁方身、光滑、眼睛長在兩支角上、嘴巴超大
const Mon3 = ({ g, equipped }) => (
  <g>
    {/* 眼柄角 */}
    <g style={{ animation: 'pet-antenna 2.2s ease-in-out infinite', transformOrigin: '70px 66px' }}>
      <path d="M70 66 Q60 40 66 28" fill="none" stroke={INK} strokeWidth="14" strokeLinecap="round" />
      <path d="M70 66 Q60 40 66 28" fill="none" stroke={`url(#${g})`} strokeWidth="9" strokeLinecap="round" />
      <g style={{ animation: 'pet-blink 3.8s infinite', transformOrigin: '66px 24px' }}><Eye x={66} y={24} r={12} /></g>
    </g>
    <g style={{ animation: 'pet-antenna 2.2s ease-in-out infinite reverse', transformOrigin: '130px 66px' }}>
      <path d="M130 66 Q140 40 134 28" fill="none" stroke={INK} strokeWidth="14" strokeLinecap="round" />
      <path d="M130 66 Q140 40 134 28" fill="none" stroke={`url(#${g})`} strokeWidth="9" strokeLinecap="round" />
      <g style={{ animation: 'pet-blink 3.1s infinite', transformOrigin: '134px 24px' }}><Eye x={134} y={24} r={12} /></g>
    </g>
    {/* 寬扁身體 */}
    <path d="M42 70 Q100 56 158 70 Q172 74 172 96 L170 148 Q170 178 138 180 L62 180 Q30 178 30 148 L28 96 Q28 74 42 70 Z"
      fill={`url(#${g})`} stroke={INK} strokeWidth="3.5" strokeLinejoin="round" />
    {/* 身上斑點 */}
    <circle cx="52" cy="94" r="5" fill="#fff" opacity=".35" /><circle cx="150" cy="100" r="7" fill="#fff" opacity=".3" /><circle cx="60" cy="156" r="6" fill="#fff" opacity=".3" />
    {/* 超大嘴＋不規則牙齒 */}
    <path d="M46 106 Q100 96 154 106 Q158 136 100 140 Q42 136 46 106 Z" fill="#5e2643" stroke={INK} strokeWidth="3.5" />
    {[
      [56, 106, 13, 14], [74, 103, 13, 18], [92, 102, 14, 14], [110, 102, 13, 17], [128, 104, 13, 13],
    ].map(([x, y, w, h], i) => <rect key={i} x={x} y={y} width={w} height={h} rx="3" fill="#fff" stroke={INK} strokeWidth="2" />)}
    <path d="M84 138 q16 6 32 0" fill="#ff6d8e" />
    <Blush x={40} y={124} s={.8} /><Blush x={160} y={124} s={.8} />
    {/* 短腳 */}
    <ellipse cx="72" cy="182" rx="15" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    <ellipse cx="128" cy="182" rx="15" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    <Gear equipped={equipped} headY={62} eyeLine={null} glassesOne={null} />
  </g>
);

// 皮皮：小顆圓身、粗捲角、賊笑露一顆獠牙、背後尖刺＋惡魔尾巴
const Mon4 = ({ g, equipped }) => (
  <g>
    {/* 惡魔尾巴 */}
    <g style={{ animation: 'pet-tailflick 2.6s ease-in-out infinite', transformOrigin: '152px 150px' }}>
      <path d="M152 150 Q186 142 184 112" fill="none" stroke={INK} strokeWidth="7" strokeLinecap="round" />
      <path d="M184 118 L176 104 L192 104 Z" fill={`url(#${g})`} stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    </g>
    {/* 捲角 */}
    <path d="M66 58 q-26 -2 -26 -26 q0 -8 8 -10 q4 14 16 18 q10 4 8 16" fill="#f9d276" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
    <path d="M134 58 q26 -2 26 -26 q0 -8 -8 -10 q-4 14 -16 18 q-10 4 -8 16" fill="#f9d276" stroke={INK} strokeWidth="3" strokeLinejoin="round" />
    <path d={furPath(100, 116, 56, 58, 40, 11, 4)} fill={`url(#${g})`} stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <circle cx="100" cy="116" r="57" fill={`url(#${g})`} />
    {/* 胸口蓬毛 */}
    <path d={furPath(100, 146, 22, 16, 22, 7, 5)} fill="#ffe0b2" stroke="#e8a86b" strokeWidth="1.5" />
    <ellipse cx="100" cy="146" rx="22" ry="16" fill="#ffe0b2" />
    <ellipse cx="76" cy="178" rx="13" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    <ellipse cx="124" cy="178" rx="13" ry="8" fill={`url(#${g})`} stroke={INK} strokeWidth="3" />
    {/* 賊眉賊眼：一挑眉 */}
    <path d="M62 74 q12 -8 24 -2" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
    <path d="M114 70 q12 -2 24 6" fill="none" stroke={INK} strokeWidth="4" strokeLinecap="round" />
    <g style={{ animation: 'pet-blink 2.9s infinite', transformOrigin: '100px 92px' }}>
      <Eye x={76} y={92} r={12} /><Eye x={126} y={94} r={14} />
    </g>
    <Blush x={58} y={112} /><Blush x={144} y={114} />
    {/* 賊笑＋獠牙 */}
    <path d="M74 122 Q96 140 128 124 Q104 132 74 122 Z" fill={INK} />
    <path d="M112 127 l4 10 l7 -8 Z" fill="#fff" stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
    {/* 插腰小手 */}
    <path d="M46 124 q-16 8 -8 22 q8 -2 12 -10" fill={`url(#${g})`} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
    <path d="M154 124 q16 8 8 22 q-8 -2 -12 -10" fill={`url(#${g})`} stroke={INK} strokeWidth="3" strokeLinejoin="round" />
    <Gear equipped={equipped} headY={52} eyeLine={[76, 126, 93]} />
  </g>
);

const BODIES = { mon1: Mon1, mon2: Mon2, mon3: Mon3, mon4: Mon4 };

export default function PetSprite({ type, equipped = [], size = 220, walking = false }) {
  const key = MONSTERS[type] ? type : 'mon1';
  const m = MONSTERS[key];
  const Body = BODIES[key];
  const [jump, setJump] = useState(false);
  const [hearts, setHearts] = useState([]);
  const g = `g2-${key}-${walking ? 'w' : 's'}`;

  function poke() {
    if (walking) return;
    setJump(true);
    setTimeout(() => setJump(false), 600);
    const id = Date.now();
    setHearts(h => [...h, id]);
    setTimeout(() => setHearts(h => h.filter(x => x !== id)), 1200);
  }

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: walking ? 0 : '0 auto', cursor: 'pointer' }} onClick={poke}>
      <style>{`
        @keyframes pet-squash { 0%,100% { transform: scale(1,1) } 50% { transform: scale(1.035,.95) } }
        @keyframes pet-blink { 0%,90%,100% { transform: scaleY(1) } 94% { transform: scaleY(.08) } }
        @keyframes pet-look { 0%,32%,100% { transform: translateX(0) } 38%,58% { transform: translateX(3.2px) } 64%,88% { transform: translateX(-2.6px) } }
        @keyframes pet-arm { 0%,100% { transform: rotate(-7deg) } 50% { transform: rotate(12deg) } }
        @keyframes pet-antenna { 0%,100% { transform: rotate(-9deg) } 50% { transform: rotate(9deg) } }
        @keyframes pet-tailflick { 0%,70%,100% { transform: rotate(0) } 80% { transform: rotate(14deg) } 90% { transform: rotate(-6deg) } }
        @keyframes pet-jump { 0%,100% { transform: translateY(0) scale(1,1) } 15% { transform: translateY(2px) scale(1.08,.88) } 45% { transform: translateY(-30px) scale(.94,1.08) } 75% { transform: translateY(0) scale(1.06,.92) } }
        @keyframes pet-shadow { 0%,100% { transform: scaleX(1); opacity:.22 } 50% { transform: scaleX(.9); opacity:.16 } }
        @keyframes pet-heart { 0% { transform: translateY(0) scale(.6); opacity: 1 } 100% { transform: translateY(-70px) scale(1.3); opacity: 0 } }
        @keyframes pet-waddle { 0%,100% { transform: rotate(-4deg) translateY(0) } 25% { transform: rotate(0deg) translateY(-3px) } 50% { transform: rotate(4deg) translateY(0) } 75% { transform: rotate(0deg) translateY(-3px) } }
        .pet-jumping { animation: pet-jump .6s ease-out !important; }
      `}</style>

      {hearts.map(id => (
        <div key={id} style={{ position: 'absolute', left: '46%', top: '10%', fontSize: 26, animation: 'pet-heart 1.2s ease-out forwards', pointerEvents: 'none', zIndex: 3 }}>💗</div>
      ))}

      <svg viewBox="0 0 200 200" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id={g} cx="36%" cy="26%" r="85%">
            <stop offset="0%" stopColor={m.body[0]} />
            <stop offset="100%" stopColor={m.body[1]} />
          </radialGradient>
        </defs>
        <ellipse cx="100" cy="190" rx="52" ry="8" fill="#000"
          style={{ animation: 'pet-shadow 2.8s ease-in-out infinite', transformOrigin: '100px 190px' }} />
        <g className={jump ? 'pet-jumping' : ''} style={{ transformOrigin: '100px 190px' }}>
          <g style={{ animation: walking ? m.walk.anim : 'pet-squash 2.8s ease-in-out infinite', transformOrigin: '100px 190px', transform: `scale(${m.scale})`, transformBox: 'fill-box' }}>
            <Body g={g} equipped={equipped} />
          </g>
        </g>
        {equipped.includes('ball') && !walking && <g transform="translate(32 172)">
          <circle r="13" fill="#fff" stroke={INK} strokeWidth="2.5" />
          <path d="M-13 0 a13 13 0 0 1 26 0" fill="#e53950" />
          <path d="M-13 0 h26" stroke={INK} strokeWidth="2.5" />
        </g>}
      </svg>
    </div>
  );
}
