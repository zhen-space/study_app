import { useState } from 'react';

// 原創小怪獸圖鑑（毛茸茸剪影用鋸齒路徑產生，造型皆為原創）
export const MONSTERS = {
  mon1: { body: ['#c5e1a5', '#558b2f'], name: '毛吉', desc: '獨眼綠毛怪，樂觀派' },
  mon2: { body: ['#ce93d8', '#7b1fa2'], name: '嘟波', desc: '三眼紫怪，觀察力滿分' },
  mon3: { body: ['#81d4fa', '#0277bd'], name: '藍牙', desc: '大嘴藍怪，愛笑' },
  mon4: { body: ['#ffab91', '#d84315'], name: '皮皮', desc: '捲角小惡魔，古靈精怪' },
};

const fuzz = (cx, cy, rx, ry, n = 60, d = 5) => {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = i % 2 ? d : -1;
    pts.push(`${(cx + Math.cos(a) * (rx + rr)).toFixed(1)},${(cy + Math.sin(a) * (ry + rr)).toFixed(1)}`);
  }
  return 'M' + pts.join(' L') + ' Z';
};

const Eye = ({ x, y, r = 12 }) => (
  <g>
    <circle cx={x} cy={y} r={r} fill="#fff" stroke="#37474f" strokeWidth="2" />
    <circle cx={x} cy={y + r * .15} r={r * .45} fill="#37474f" />
    <circle cx={x + r * .2} cy={y - r * .15} r={r * .18} fill="#fff" />
  </g>
);

export default function PetSprite({ type, equipped = [], size = 220, walking = false }) {
  const m = MONSTERS[type] || MONSTERS.mon1;
  const key = MONSTERS[type] ? type : 'mon1';
  const [jump, setJump] = useState(false);
  const [hearts, setHearts] = useState([]);
  const gid = `g-${key}-${walking ? 'w' : 's'}`;

  function poke() {
    if (walking) return; // 陪伴模式的點擊由外層處理
    setJump(true);
    setTimeout(() => setJump(false), 600);
    const id = Date.now();
    setHearts(h => [...h, id]);
    setTimeout(() => setHearts(h => h.filter(x => x !== id)), 1200);
  }

  const has = id => equipped.includes(id);

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: walking ? 0 : '0 auto', cursor: 'pointer' }} onClick={poke}>
      <style>{`
        @keyframes pet-bob { 0%,100% { transform: scaleY(1) } 50% { transform: scaleY(.955) translateY(3px) } }
        @keyframes pet-blink { 0%,92%,100% { transform: scaleY(1) } 95% { transform: scaleY(.1) } }
        @keyframes pet-arm { 0%,100% { transform: rotate(-6deg) } 50% { transform: rotate(10deg) } }
        @keyframes pet-jump { 0%,100% { transform: translateY(0) } 40% { transform: translateY(-26px) } 70% { transform: translateY(0) } 85% { transform: translateY(-8px) } }
        @keyframes pet-shadow { 0%,100% { transform: scaleX(1); opacity:.22 } 50% { transform: scaleX(.9); opacity:.17 } }
        @keyframes pet-heart { 0% { transform: translateY(0) scale(.6); opacity: 1 } 100% { transform: translateY(-70px) scale(1.3); opacity: 0 } }
        @keyframes pet-waddle { 0%,100% { transform: rotate(-3deg) } 50% { transform: rotate(3deg) } }
        .pet-jumping { animation: pet-jump .6s ease-out !important; }
      `}</style>

      {hearts.map(id => (
        <div key={id} style={{ position: 'absolute', left: '46%', top: '14%', fontSize: 26, animation: 'pet-heart 1.2s ease-out forwards', pointerEvents: 'none', zIndex: 3 }}>💗</div>
      ))}

      <svg viewBox="0 0 200 200" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id={gid} cx="38%" cy="28%" r="80%">
            <stop offset="0%" stopColor={m.body[0]} />
            <stop offset="100%" stopColor={m.body[1]} />
          </radialGradient>
        </defs>

        <ellipse cx="100" cy="188" rx="50" ry="8" fill="#000"
          style={{ animation: 'pet-shadow 3s ease-in-out infinite', transformOrigin: '100px 188px' }} />

        <g className={jump ? 'pet-jumping' : ''} style={{ transformOrigin: '100px 188px' }}>
          <g style={{ animation: walking ? 'pet-waddle .5s ease-in-out infinite' : 'pet-bob 3s ease-in-out infinite', transformOrigin: '100px 188px' }}>

            {/* ===== 角 / 頭飾 ===== */}
            {key === 'mon1' && <>
              <path d="M74 42 L68 18 L88 34 Z" fill={m.body[1]} />
              <path d="M126 42 L132 18 L112 34 Z" fill={m.body[1]} />
            </>}
            {key === 'mon2' && <g>
              <line x1="100" y1="40" x2="100" y2="14" stroke={m.body[1]} strokeWidth="5" strokeLinecap="round" />
              <circle cx="100" cy="11" r="8" fill={m.body[0]} stroke={m.body[1]} strokeWidth="3" />
            </g>}
            {key === 'mon3' && <>
              <path d="M60 52 Q44 40 46 24 Q60 32 66 46 Z" fill={m.body[1]} />
              <path d="M140 52 Q156 40 154 24 Q140 32 134 46 Z" fill={m.body[1]} />
            </>}
            {key === 'mon4' && <>
              <path d="M70 40 q-22 -4 -20 -24 q16 2 22 16 q2 5 -2 8" fill={m.body[1]} />
              <path d="M130 40 q22 -4 20 -24 q-16 2 -22 16 q-2 5 2 8" fill={m.body[1]} />
            </>}

            {/* ===== 身體（毛茸茸鋸齒剪影；藍牙是光滑的） ===== */}
            <path d={key === 'mon3'
              ? 'M100 38 C142 38 162 70 162 108 C162 150 138 176 100 176 C62 176 38 150 38 108 C38 70 58 38 100 38 Z'
              : fuzz(100, 108, 61, 69)} fill={`url(#${gid})`} />

            {/* 手（會小幅擺動） */}
            <ellipse cx="36" cy="118" rx="9" ry="17" fill={m.body[1]}
              style={{ animation: 'pet-arm 2.4s ease-in-out infinite', transformOrigin: '40px 104px' }} />
            <ellipse cx="164" cy="118" rx="9" ry="17" fill={m.body[1]}
              style={{ animation: 'pet-arm 2.4s ease-in-out infinite reverse', transformOrigin: '160px 104px' }} />
            {/* 腳 */}
            <ellipse cx="74" cy="176" rx="15" ry="8" fill={m.body[1]} />
            <ellipse cx="126" cy="176" rx="15" ry="8" fill={m.body[1]} />

            {/* ===== 臉（依怪獸種類） ===== */}
            <g style={{ animation: 'pet-blink 3.6s infinite', transformOrigin: '100px 92px' }}>
              {key === 'mon1' && <Eye x={100} y={86} r={20} />}
              {key === 'mon2' && <><Eye x={72} y={88} r={10} /><Eye x={100} y={82} r={14} /><Eye x={128} y={88} r={10} /></>}
              {key === 'mon3' && <><Eye x={78} y={80} r={11} /><Eye x={122} y={80} r={11} /></>}
              {key === 'mon4' && <><Eye x={76} y={86} r={13} /><Eye x={124} y={86} r={13} /></>}
            </g>

            {key === 'mon1' && <path d="M76 122 Q100 140 124 122 L118 124 L110 131 L100 126 L90 131 L82 124 Z" fill="#37474f" />}
            {key === 'mon1' && <><rect x="88" y="122" width="9" height="9" rx="2" fill="#fff" /><rect x="104" y="122" width="9" height="9" rx="2" fill="#fff" /></>}
            {key === 'mon2' && <path d="M82 118 q6 8 12 0 q6 8 12 0 q6 8 12 0" fill="none" stroke="#37474f" strokeWidth="3.5" strokeLinecap="round" />}
            {key === 'mon3' && <g>
              <path d="M64 108 Q100 148 136 108 Q100 128 64 108 Z" fill="#263238" />
              {[72, 88, 104, 120].map(x => <rect key={x} x={x} y="110" width="11" height="10" rx="2" fill="#fff" />)}
            </g>}
            {key === 'mon4' && <>
              <path d="M84 118 Q100 132 116 118" fill="none" stroke="#37474f" strokeWidth="3.5" strokeLinecap="round" />
              <rect x="104" y="118" width="9" height="10" rx="2" fill="#fff" transform="rotate(4 108 122)" />
              <circle cx="66" cy="106" r="2.4" fill={m.body[1]} /><circle cx="58" cy="98" r="2.4" fill={m.body[1]} /><circle cx="134" cy="106" r="2.4" fill={m.body[1]} /><circle cx="142" cy="98" r="2.4" fill={m.body[1]} />
            </>}

            {/* 腮紅 */}
            <ellipse cx="60" cy="112" rx="8" ry="5" fill="#ff8a80" opacity=".5" />
            <ellipse cx="140" cy="112" rx="8" ry="5" fill="#ff8a80" opacity=".5" />

            {/* ===== 裝備 ===== */}
            {has('hat') && <g>
              <ellipse cx="100" cy="42" rx="32" ry="7" fill="#212121" />
              <rect x="82" y="12" width="36" height="32" rx="5" fill="#212121" />
              <rect x="82" y="34" width="36" height="7" fill="#b71c1c" />
            </g>}
            {has('bow') && <g transform="translate(100 52)">
              <path d="M0 0 L-15 -8 L-15 8 Z" fill="#ec407a" /><path d="M0 0 L15 -8 L15 8 Z" fill="#ec407a" />
              <circle r="4.5" fill="#ad1457" />
            </g>}
            {has('glasses') && (key === 'mon1'
              ? <g><circle cx="100" cy="86" r="22" fill="#212121" opacity=".88" /><path d="M78 80 l-14 -6 M122 80 l14 -6" stroke="#212121" strokeWidth="3.5" /></g>
              : <g>
                <circle cx={key === 'mon3' ? 78 : 76} cy={key === 'mon3' ? 80 : 86} r="14" fill="#212121" opacity=".88" />
                <circle cx={key === 'mon3' ? 122 : 124} cy={key === 'mon3' ? 80 : 86} r="14" fill="#212121" opacity=".88" />
                <path d={`M${key === 'mon3' ? 90 : 88} ${key === 'mon3' ? 80 : 86} h${key === 'mon3' ? 20 : 24}`} stroke="#212121" strokeWidth="3.5" />
              </g>)}
            {has('flower') && <g transform="translate(146 56) scale(.85)">
              {[0, 60, 120, 180, 240, 300].map(a => <ellipse key={a} cx="0" cy="-10" rx="5.5" ry="9" fill="#ffca28" transform={`rotate(${a})`} />)}
              <circle r="6" fill="#795548" />
            </g>}
          </g>
        </g>

        {has('ball') && !walking && <g transform="translate(36 170)">
          <circle r="13" fill="#fff" stroke="#333" strokeWidth="1.5" />
          <path d="M-13 0 a13 13 0 0 1 26 0" fill="#e53935" />
          <path d="M-13 0 h26" stroke="#333" strokeWidth="1.5" />
        </g>}
      </svg>
    </div>
  );
}
