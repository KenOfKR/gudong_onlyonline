/* ============================================================================
 * ui/art.js — 角色立繪
 * 優先讀取 assets/roles/<角色名>.png（或 .jpg / .webp）；找不到時使用內建手繪 SVG。
 * 想換圖：把圖檔以角色名命名放進 assets/roles/ 即可，不需要改程式。
 * ========================================================================== */
(function (GD) {
  'use strict';
  const loaded = {};        // 角色名 → 實際圖檔路徑
  const EXT = ['png'];

  function buildTailoredCharacterSvg(roleName) {
        const m = GD.ROLES[roleName] || GD.ROLES['許願'];
        let art = '';
        if (roleName === '許願') {
          art = `
            <rect x="75" y="25" width="150" height="240" fill="#efe2c8" opacity="0.45"/>
            <path d="M55 215 Q35 170 85 185 L130 235 L95 265 Z" fill="#8c6239" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M245 215 Q265 170 215 185 L170 235 L205 265 Z" fill="#8c6239" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M85 115 Q150 100 215 115 L235 185 L190 215 L110 215 L65 185 Z" fill="#b38b59" stroke="#1e1610" stroke-width="3.5"/>
            <polygon points="130,118 170,118 162,205 138,205" fill="#2b2623" stroke="#1e1610" stroke-width="2.5"/>
            <ellipse cx="150" cy="82" rx="34" ry="38" fill="#e6c79c" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M114 78 Q112 42 150 40 Q188 42 186 78 Q175 55 150 60 Q125 55 114 78 Z" fill="#1a1412" stroke="#1e1610" stroke-width="3"/>
            <path d="M105 225 L215 278" stroke="#a67c52" stroke-width="13" stroke-linecap="round"/>
            <path d="M105 225 L215 278" stroke="#1e1610" stroke-width="3.5" stroke-linecap="round"/>
          `;
        } else if (roleName === '方震') {
          art = `
            <rect x="0" y="0" width="300" height="320" fill="#52585c" opacity="0.35"/>
            <path d="M68 125 L115 98 L185 98 L232 125 L248 275 L52 275 Z" fill="#bfa37a" stroke="#1e1610" stroke-width="3.5"/>
            <polygon points="122,102 178,102 170,225 130,225" fill="#f2e7d3" stroke="#1e1610" stroke-width="2.5"/>
            <polygon points="145,118 155,118 158,215 142,215" fill="#2c2623" stroke="#1e1610" stroke-width="2"/>
            <ellipse cx="150" cy="76" rx="32" ry="36" fill="#e6c79c" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M116 68 Q120 36 155 38 Q184 40 182 70 Q165 52 135 55 Z" fill="#1e1610"/>
          `;
        } else if (roleName === '姬雲浮') {
          art = `
            <path d="M78 120 Q150 105 222 120 L235 275 L65 275 Z" fill="#9c7e54" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M62 118 L118 102 L105 270 L52 265 Z" fill="#785c38" stroke="#1e1610" stroke-width="3.5"/>
            <ellipse cx="150" cy="76" rx="32" ry="36" fill="#edd3b0" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M118 68 Q125 36 160 38 Q185 42 182 70 Q155 52 118 68 Z" fill="#1a1412"/>
          `;
        } else if (roleName === '黃煙煙') {
          art = `
            <path d="M60 245 Q110 195 195 235 L235 275 L65 275 Z" fill="#403d39" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M85 125 L215 125 L225 215 L75 215 Z" fill="#9c784c" stroke="#1e1610" stroke-width="3.5"/>
            <ellipse cx="150" cy="78" rx="31" ry="35" fill="#edd3b0" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M95 145 Q85 40 150 40 Q215 40 205 145 Q185 80 150 75 Q115 80 95 145 Z" fill="#4a2c18" stroke="#1e1610" stroke-width="3"/>
            <rect x="142" y="185" width="14" height="45" rx="3" transform="rotate(20 142 185)" fill="#3b3734" stroke="#1e1610" stroke-width="2.5"/>
          `;
        } else if (roleName === '木戶加奈') {
          art = `
            <path d="M75 275 L105 195 L195 195 L225 275 Z" fill="#e6d2b5" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M98 122 Q150 112 202 122 L212 198 L88 198 Z" fill="#c7ae87" stroke="#1e1610" stroke-width="3.5"/>
            <ellipse cx="150" cy="82" rx="30" ry="34" fill="#f2dec2" stroke="#1e1610" stroke-width="3.5"/>
            <ellipse cx="168" cy="52" rx="38" ry="18" transform="rotate(22 168 52)" fill="#d6be96" stroke="#1e1610" stroke-width="3"/>
            <rect x="65" y="178" width="65" height="45" fill="#bfa37a" stroke="#1e1610" stroke-width="3"/>
          `;
        } else if (roleName === '老朝奉') {
          art = `
            <path d="M75 128 Q150 112 225 128 L242 275 L58 275 Z" fill="#241c18" stroke="#1e1610" stroke-width="3.5"/>
            <ellipse cx="150" cy="86" rx="28" ry="30" fill="#120e0c" stroke="#1e1610" stroke-width="3"/>
            <ellipse cx="150" cy="68" rx="62" ry="18" transform="rotate(-12 150 68)" fill="#8c6d46" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M115 62 L125 32 L175 32 L185 62 Z" fill="#735836" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M48 165 Q35 120 62 90 Q45 55 75 25" fill="none" stroke="#6b5340" stroke-width="2.5" stroke-dasharray="4 3"/>
          `;
        } else if (roleName === '藥不然') {
          art = `
            <path d="M82 122 Q150 108 218 122 L232 275 L68 275 Z" fill="#dfd0b8" stroke="#1e1610" stroke-width="3.5"/>
            <polygon points="105,122 195,122 185,225 115,225" fill="#735838" stroke="#1e1610" stroke-width="3"/>
            <ellipse cx="150" cy="78" rx="32" ry="36" fill="#edd3b0" stroke="#1e1610" stroke-width="3.5"/>
            <circle cx="136" cy="80" r="11" fill="none" stroke="#1e1610" stroke-width="3"/>
            <circle cx="164" cy="80" r="11" fill="none" stroke="#1e1610" stroke-width="3"/>
            <line x1="147" y1="80" x2="153" y2="80" stroke="#1e1610" stroke-width="3"/>
          `;
        } else {
          art = `
            <path d="M55 118 L112 100 L188 100 L245 118 L258 275 L42 275 Z" fill="#82623e" stroke="#1e1610" stroke-width="3.5"/>
            <polygon points="118,105 182,105 175,220 125,220" fill="#efe2c8" stroke="#1e1610" stroke-width="2.5"/>
            <ellipse cx="150" cy="76" rx="33" ry="37" fill="#dec096" stroke="#1e1610" stroke-width="3.5"/>
            <path d="M122 92 Q150 115 178 92" fill="#9e9589" stroke="#1e1610" stroke-width="2.5"/>
            <line x1="145" y1="145" x2="178" y2="162" stroke="#4a2e16" stroke-width="7" stroke-linecap="round"/>
          `;
        }
  
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 320">
          <rect width="300" height="320" fill="#dfd0b2"/>
          <g opacity="0.16" stroke="#1e1610" stroke-width="1">
            <line x1="0" y1="30" x2="300" y2="30"/><line x1="0" y1="70" x2="300" y2="70"/>
            <line x1="0" y1="110" x2="300" y2="110"/><line x1="0" y1="150" x2="300" y2="150"/>
          </g>
          ${art}
          <rect x="8" y="8" width="284" height="304" rx="8" fill="none" stroke="#1e1610" stroke-width="4"/>
          <rect x="22" y="268" width="256" height="36" rx="6" fill="#231810" stroke="#f5d08a" stroke-width="1.5"/>
          <text x="150" y="292" text-anchor="middle" font-size="18" font-family="Noto Serif TC" font-weight="900" fill="#f5d08a" letter-spacing="4">${roleName}・${m.badge}</text>
        </svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      }

  const cache = {};
  const Art = {
    url(role) {
      if (loaded[role]) return loaded[role];
      return cache[role] || (cache[role] = buildTailoredCharacterSvg(role));
    },
    /** 啟動時探測 assets/roles/ 內有沒有自訂圖；找到就通知 UI 重繪 */
    probe() {
      GD.ROLE_ORDER.forEach(role => EXT.forEach(ext => {
        const img = new Image();
        img.onload = () => { if (!loaded[role]) { loaded[role] = 'assets/roles/' + role + '.' + ext; GD.bus.emit('art'); } };
        img.src = 'assets/roles/' + role + '.' + ext;
      }));
    }
  };
  GD.Art = Art;
})(window.GD);
