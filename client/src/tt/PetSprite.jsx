import { useState } from 'react';

// 依寵物種類的配色與特徵
const VARIANTS = {
  '🐱': { body: ['#ffb74d', '#f57c00'], belly: '#ffe0b2', ears: 'point', tail: 'curl', whiskers: true },
  '🐶': { body: ['#bcaaa4', '#795548'], belly: '#efebe9', ears: 'flop', tail: 'wag', whiskers: false },
  '🐰': { body: ['#f8bbd0', '#f48fb1'], belly: '#fff', ears: 'long', tail: 'puff', whiskers: true },
  '🐹': { body: ['#ffe082', '#ffb300'], belly: '#fff8e1', ears: 'round', tail: 'none', whiskers: true },
  '🐧': { body: ['#546e7a', '#263238'], belly: '#eceff1', ears: 'none', tail: 'none', whiskers: false },
  '🦊': { body: ['#ff8a65', '#e64a19'], belly: '#ffccbc', ears: 'point', tail: 'fox', whiskers: true },
};

export default function PetSprite({ type, equipped = [], size = 220 }) {
  const v = VARIANTS[type] || VARIANTS['🐱'];
  const [jump, setJump] = useState(false);
  const [hearts, setHearts] = useState([]);

  function poke() {
    setJump(true);
    setTimeout(() => setJump(false), 600);
    const id = Date.now();
    setHearts(h => [...h, id]);
    setTimeout(() => setHearts(h => h.filter(x => x !== id)), 1200);
  }

  const has = id => equipped.includes(id);

  return (
    <div style={{ position: 'relative', width: size, height: size, margin: '0 auto', cursor: 'pointer' }} onClick={poke}>
      <style>{`
        @keyframes pet-bob { 0%,100% { transform: scaleY(1) } 50% { transform: scaleY(.96) translateY(2px) } }
        @keyframes pet-blink { 0%,92%,100% { transform: scaleY(1) } 95% { transform: scaleY(.08) } }
        @keyframes pet-tail { 0%,100% { transform: rotate(-8deg) } 50% { transform: rotate(14deg) } }
        @keyframes pet-ear { 0%,90%,100% { transform: rotate(0) } 94% { transform: rotate(-8deg) } }
        @keyframes pet-jump { 0%,100% { transform: translateY(0) } 40% { transform: translateY(-26px) } 70% { transform: translateY(0) } 85% { transform: translateY(-8px) } }
        @keyframes pet-shadow { 0%,100% { transform: scaleX(1); opacity:.25 } 50% { transform: scaleX(.92); opacity:.2 } }
        @keyframes pet-heart { 0% { transform: translateY(0) scale(.6); opacity: 1 } 100% { transform: translateY(-70px) scale(1.3); opacity: 0 } }
        .pet-jumping { animation: pet-jump .6s ease-out !important; }
      `}</style>

      {hearts.map(id => (
        <div key={id} style={{ position: 'absolute', left: '50%', top: '18%', fontSize: 26, animation: 'pet-heart 1.2s ease-out forwards', pointerEvents: 'none', zIndex: 3 }}>💗</div>
      ))}

      <svg viewBox="0 0 200 200" width={size} height={size} style={{ overflow: 'visible' }}>
        <defs>
          <radialGradient id="pg-body" cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor={v.body[0]} />
            <stop offset="100%" stopColor={v.body[1]} />
          </radialGradient>
          <radialGradient id="pg-belly" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stopColor={v.belly} />
            <stop offset="100%" stopColor={v.belly} stopOpacity=".7" />
          </radialGradient>
        </defs>

        {/* 地面陰影 */}
        <ellipse cx="100" cy="186" rx="52" ry="9" fill="#000"
          style={{ animation: 'pet-shadow 3s ease-in-out infinite', transformOrigin: '100px 186px' }} />

        <g className={jump ? 'pet-jumping' : ''} style={{ transformOrigin: '100px 186px' }}>
          <g style={{ animation: 'pet-bob 3s ease-in-out infinite', transformOrigin: '100px 186px' }}>

            {/* 尾巴 */}
            {v.tail === 'curl' && <path d="M150 150 q28 -6 24 -34 q-2 -14 -14 -16" fill="none" stroke={v.body[1]} strokeWidth="13" strokeLinecap="round"
              style={{ animation: 'pet-tail 2.2s ease-in-out infinite', transformOrigin: '150px 150px' }} />}
            {v.tail === 'wag' && <path d="M152 152 q26 -10 30 -30" fill="none" stroke={v.body[1]} strokeWidth="14" strokeLinecap="round"
              style={{ animation: 'pet-tail 1s ease-in-out infinite', transformOrigin: '152px 152px' }} />}
            {v.tail === 'fox' && <g style={{ animation: 'pet-tail 2.4s ease-in-out infinite', transformOrigin: '150px 152px' }}>
              <path d="M150 152 q36 -4 34 -38 q-16 2 -22 14 q-8 10 -12 24" fill={v.body[1]} />
              <circle cx="182" cy="116" r="9" fill="#fff" /></g>}
            {v.tail === 'puff' && <circle cx="156" cy="158" r="12" fill="#fff"
              style={{ animation: 'pet-tail 2.6s ease-in-out infinite', transformOrigin: '156px 158px' }} />}

            {/* 耳朵 */}
            <g style={{ animation: 'pet-ear 5s ease-in-out infinite', transformOrigin: '100px 70px' }}>
              {v.ears === 'point' && <>
                <path d="M58 62 L50 24 L86 44 Z" fill={v.body[1]} /><path d="M60 56 L56 34 L78 46 Z" fill="#ffab91" opacity=".8" />
                <path d="M142 62 L150 24 L114 44 Z" fill={v.body[1]} /><path d="M140 56 L144 34 L122 46 Z" fill="#ffab91" opacity=".8" />
              </>}
              {v.ears === 'long' && <>
                <ellipse cx="70" cy="26" rx="13" ry="34" fill={v.body[1]} transform="rotate(-10 70 26)" />
                <ellipse cx="70" cy="28" rx="7" ry="24" fill="#fff" opacity=".7" transform="rotate(-10 70 28)" />
                <ellipse cx="130" cy="26" rx="13" ry="34" fill={v.body[1]} transform="rotate(10 130 26)" />
                <ellipse cx="130" cy="28" rx="7" ry="24" fill="#fff" opacity=".7" transform="rotate(10 130 28)" />
              </>}
              {v.ears === 'flop' && <>
                <ellipse cx="56" cy="66" rx="15" ry="26" fill={v.body[1]} transform="rotate(18 56 66)" />
                <ellipse cx="144" cy="66" rx="15" ry="26" fill={v.body[1]} transform="rotate(-18 144 66)" />
              </>}
              {v.ears === 'round' && <>
                <circle cx="62" cy="44" r="16" fill={v.body[1]} /><circle cx="62" cy="46" r="9" fill="#ffab91" opacity=".7" />
                <circle cx="138" cy="44" r="16" fill={v.body[1]} /><circle cx="138" cy="46" r="9" fill="#ffab91" opacity=".7" />
              </>}
            </g>

            {/* 身體（頭身一體的圓潤造型） */}
            <path d="M100 36 C140 36 158 66 160 104 C162 146 138 174 100 174 C62 174 38 146 40 104 C42 66 60 36 100 36 Z" fill="url(#pg-body)" />
            {/* 肚子 */}
            <ellipse cx="100" cy="132" rx="34" ry="34" fill="url(#pg-belly)" />
            {/* 腳 */}
            <ellipse cx="72" cy="172" rx="14" ry="8" fill={v.body[1]} />
            <ellipse cx="128" cy="172" rx="14" ry="8" fill={v.body[1]} />

            {/* 臉 */}
            <g>
              {/* 眼睛（眨眼） */}
              <g style={{ animation: 'pet-blink 3.4s infinite', transformOrigin: '100px 88px' }}>
                <circle cx="76" cy="88" r="7.5" fill="#263238" />
                <circle cx="124" cy="88" r="7.5" fill="#263238" />
                <circle cx="78.5" cy="85.5" r="2.6" fill="#fff" />
                <circle cx="126.5" cy="85.5" r="2.6" fill="#fff" />
              </g>
              {/* 腮紅 */}
              <ellipse cx="64" cy="102" rx="9" ry="5.5" fill="#ff8a80" opacity=".55" />
              <ellipse cx="136" cy="102" rx="9" ry="5.5" fill="#ff8a80" opacity=".55" />
              {/* 鼻子與嘴 */}
              <ellipse cx="100" cy="99" rx="5" ry="3.6" fill="#5d4037" />
              <path d="M100 102 q0 6 -7 7 M100 102 q0 6 7 7" fill="none" stroke="#5d4037" strokeWidth="2.2" strokeLinecap="round" />
              {v.whiskers && <>
                <path d="M52 96 h-16 M53 104 h-15" stroke={v.body[1]} strokeWidth="1.8" strokeLinecap="round" opacity=".8" />
                <path d="M148 96 h16 M147 104 h15" stroke={v.body[1]} strokeWidth="1.8" strokeLinecap="round" opacity=".8" />
              </>}
              {/* 企鵝嘴 */}
              {type === '🐧' && <path d="M92 96 L108 96 L100 106 Z" fill="#ff9800" />}
            </g>

            {/* 裝備 */}
            {has('hat') && <g>
              <ellipse cx="100" cy="42" rx="34" ry="7" fill="#212121" />
              <rect x="80" y="10" width="40" height="34" rx="5" fill="#212121" />
              <rect x="80" y="34" width="40" height="7" fill="#b71c1c" />
            </g>}
            {has('bow') && <g transform="translate(100 44)">
              <path d="M0 0 L-16 -9 L-16 9 Z" fill="#ec407a" /><path d="M0 0 L16 -9 L16 9 Z" fill="#ec407a" />
              <circle r="5" fill="#ad1457" />
            </g>}
            {has('glasses') && <g>
              <circle cx="76" cy="88" r="13" fill="#212121" opacity=".9" />
              <circle cx="124" cy="88" r="13" fill="#212121" opacity=".9" />
              <path d="M89 88 h22 M63 84 l-12 -5 M137 84 l12 -5" stroke="#212121" strokeWidth="3.5" />
            </g>}
            {has('flower') && <g transform="translate(148 62) scale(.9)">
              {[0, 60, 120, 180, 240, 300].map(a => <ellipse key={a} cx="0" cy="-10" rx="5.5" ry="9" fill="#ffca28" transform={`rotate(${a})`} />)}
              <circle r="6" fill="#795548" />
            </g>}
          </g>
        </g>

        {/* 玩具球（在腳邊，不隨身體動） */}
        {has('ball') && <g transform="translate(38 168)">
          <circle r="14" fill="#fff" stroke="#333" strokeWidth="1.5" />
          <path d="M-14 0 a14 14 0 0 1 28 0" fill="#e53935" />
          <path d="M-14 0 h28" stroke="#333" strokeWidth="1.5" />
        </g>}
      </svg>
    </div>
  );
}
