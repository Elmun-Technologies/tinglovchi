// Tahlil natijasidan o'z-o'zidan ishlaydigan HTML prezentatsiya yasaydi (internet shart emas,
// shrift fayl ichiga joylangan). Strelkalar bilan varaqlanadi, «PDF» har bir slaydni alohida sahifa qiladi.
// Dizayn: och kulrang fon, katta yumaloq kartalar, kontur «pill»lar, qora/ko'k/sariq urg'ular.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FONT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'fonts');
const fontB64 = (name) => {
  try {
    return fs.readFileSync(path.join(FONT_DIR, name)).toString('base64');
  } catch {
    return '';
  }
};
const FONT_LATIN = fontB64('outfit-latin-wght-normal.woff2');
const FONT_LATIN_EXT = fontB64('outfit-latin-ext-wght-normal.woff2');

const esc = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const arr = (v) => (Array.isArray(v) ? v : []);
const filled = (v) => {
  const s = String(v ?? '').trim();
  return s && !/^belgilanmagan$/i.test(s) ? s : '';
};
const pad2 = (n) => String(n).padStart(2, '0');

/** Ro'yxatni ko'pi bilan `size` ta elementli, teng bo'laklarga ajratadi (6 → 3+3, 1 ta yetim slayd bo'lmaydi). */
function chunk(list, size) {
  if (!list.length) return [[]];
  const pages = Math.ceil(list.length / size);
  const per = Math.ceil(list.length / pages);
  const out = [];
  for (let i = 0; i < list.length; i += per) out.push(list.slice(i, i + per));
  return out;
}

export function formatDuration(ms) {
  if ((ms || 0) > 0 && ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} soniya`;
  const totalMin = Math.round((ms || 0) / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h && m) return `${h} soat ${m} daqiqa`;
  if (h) return `${h} soat`;
  return `${m} daqiqa`;
}

const MONTHS = [
  'yanvar',
  'fevral',
  'mart',
  'aprel',
  'may',
  'iyun',
  'iyul',
  'avgust',
  'sentabr',
  'oktabr',
  'noyabr',
  'dekabr',
];
export function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getDate()}-${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
const shortDate = (iso) => {
  const d = new Date(iso);
  return `${d.getDate()}-${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

const SIDE_LABEL = { biz: 'Biz', mijoz: 'Mijoz', hamkor: 'Hamkor', nomalum: 'Noma’lum' };
const SIDE_TITLE = {
  mijoz: 'Mijoz talablari',
  biz: 'Bizning talablar',
  hamkor: 'Hamkor talablari',
  nomalum: 'Boshqa talablar',
};
const PRIORITY_LABEL = { P1: 'Shoshilinch', P2: 'Muhim', P3: 'Keyinroq' };
const STATUS_LABEL = { kelishildi: 'Kelishildi', taklif: 'Taklif', ochiq: 'Ochiq' };
const IMPACT_LABEL = { yuqori: 'Yuqori', orta: 'O‘rta', past: 'Past' };
const PRI_ORDER = { P1: 0, P2: 1, P3: 2 };
const byPriority = (a, b) => (PRI_ORDER[a.priority] ?? 3) - (PRI_ORDER[b.priority] ?? 3);

const pri = (p) =>
  `<span class="pill pri pri-${esc(p)}">${esc(p)} · ${esc(PRIORITY_LABEL[p] || '')}</span>`;
const time = (t) => (filled(t) ? `<span class="time">${esc(t)}</span>` : '');
const ARROW = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 18 18 6M8 6h10v10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"/></svg>`;
const ARROW_R = `<svg viewBox="0 0 32 16" aria-hidden="true"><path d="M0 8h29M23 2l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

function initials(name) {
  const parts = String(name || '')
    .replace(/[()"«»]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return '?';
  return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
}
const AVATAR_TONES = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
const avatar = (name, i = 0) =>
  `<span class="avatar ${AVATAR_TONES[i % AVATAR_TONES.length]}">${esc(initials(name))}</span>`;

/** Sarlavha uzunligiga qarab shrift o'lchamini tanlaydi (kesilib qolmasligi uchun). */
function fitSize(text, steps) {
  const n = String(text || '').length;
  for (const [maxChars, size] of steps) if (n <= maxChars) return size;
  return steps[steps.length - 1][1];
}

function head(title, no, kicker) {
  return `<header class="head">
  <h2>${esc(title)}</h2>
  <div class="head-r">${kicker ? `<span class="pill solid">${esc(kicker)}</span>` : ''}${no ? `<span class="no">${esc(no)}.</span>` : ''}</div>
</header>`;
}

const slide = (cls, inner) => `<section class="slide ${cls}">${inner}</section>`;
const fitBox = (inner, cls = '') =>
  `<div class="fitbox ${cls}"><div class="fit">${inner}</div></div>`;

// ---------- Mind map (SVG) ----------
function wrapText(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = '';
      if (lines.length === maxLines) break;
    }
    cur = (cur + ' ' + w).trim();
    used++;
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  if (used < words.length && lines.length) lines[lines.length - 1] += '…';
  return lines;
}

const TOPIC_STYLES = [
  { fill: '#0A5CFF', text: '#fff', stroke: '#0A5CFF' },
  { fill: '#0A0A0A', text: '#fff', stroke: '#0A0A0A' },
  { fill: '#EDFF00', text: '#0A0A0A', stroke: '#EDFF00' },
  { fill: '#fff', text: '#0A0A0A', stroke: '#0A0A0A' },
  { fill: '#DAD7FF', text: '#0A0A0A', stroke: '#DAD7FF' },
  { fill: '#E4E1CB', text: '#0A0A0A', stroke: '#E4E1CB' },
  { fill: '#FF5B35', text: '#fff', stroke: '#FF5B35' },
  { fill: '#EFEFEF', text: '#0A0A0A', stroke: '#CFCFCF' },
];

export function mindMapSvg(analysis) {
  const topics = arr(analysis.topics).slice(0, 8);
  const W = 1500;
  const cx = W / 2;
  const left = [];
  const right = [];
  topics.forEach((t, i) =>
    (i % 2 === 0 ? right : left).push({ t, s: TOPIC_STYLES[i % TOPIC_STYLES.length] }),
  );
  const LEAF_H = 44;
  const GAP = 30;
  const blockH = (b) => Math.max(1.5, Math.min(arr(b.t.points).length, 4)) * LEAF_H;
  const colH = (col) => col.reduce((s, b) => s + blockH(b), 0) + Math.max(0, col.length - 1) * GAP;
  const H = Math.max(520, Math.max(colH(left), colH(right)) + 60);
  const cy = H / 2;
  let lines = '';
  let nodes = '';

  const drawSide = (col, dir) => {
    let y = cy - colH(col) / 2;
    const topicX = cx + dir * 330;
    const leafX = cx + dir * 520;
    for (const b of col) {
      const h = blockH(b);
      const ty = y + h / 2;
      const tl = wrapText(b.t.title, 20, 2);
      const tw = Math.min(250, Math.max(130, Math.max(...tl.map((l) => l.length)) * 11.5 + 48));
      const th = tl.length > 1 ? 68 : 50;
      lines += `<path d="M${cx + dir * 120},${cy} C${cx + dir * 220},${cy} ${topicX - dir * 150},${ty} ${topicX - dir * (tw / 2)},${ty}" stroke="#0A0A0A" stroke-width="1.6" fill="none"/>`;
      nodes += `<rect x="${topicX - tw / 2}" y="${ty - th / 2}" width="${tw}" height="${th}" rx="${th / 2}" fill="${b.s.fill}" stroke="${b.s.stroke}" stroke-width="1.6"/>`;
      tl.forEach((line, i) => {
        nodes += `<text x="${topicX}" y="${ty + (i - (tl.length - 1) / 2) * 22 + 7}" text-anchor="middle" class="mm-topic" fill="${b.s.text}">${esc(line)}</text>`;
      });
      arr(b.t.points)
        .slice(0, 4)
        .forEach((p, i, all) => {
          const ly = y + (h - all.length * LEAF_H) / 2 + LEAF_H * i + LEAF_H / 2;
          const ax = topicX + dir * (tw / 2);
          lines += `<path d="M${ax},${ty} C${ax + dir * 50},${ty} ${leafX - dir * 70},${ly} ${leafX - dir * 14},${ly}" stroke="#B9B9B9" stroke-width="1.3" fill="none"/>`;
          nodes += `<circle cx="${leafX - dir * 10}" cy="${ly}" r="4" fill="#0A0A0A"/>`;
          wrapText(p, 30, 2).forEach((line, j, ll) => {
            nodes += `<text x="${leafX + dir * 4}" y="${ly + (j - (ll.length - 1) / 2) * 19 + 6}" text-anchor="${dir > 0 ? 'start' : 'end'}" class="mm-leaf">${esc(line)}</text>`;
          });
        });
      y += h + GAP;
    }
  };
  drawSide(right, 1);
  drawSide(left, -1);
  const cl = wrapText(analysis.client || analysis.title || 'Suhbat', 16, 3);
  const ch = 54 + cl.length * 26;
  nodes += `<rect x="${cx - 130}" y="${cy - ch / 2}" width="260" height="${ch}" rx="${Math.min(ch / 2, 64)}" fill="#0A0A0A"/>`;
  cl.forEach((line, i) => {
    nodes += `<text x="${cx}" y="${cy + (i - (cl.length - 1) / 2) * 27 + 8}" text-anchor="middle" class="mm-center">${esc(line)}</text>`;
  });
  return `<svg class="mindmap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mind map">${lines}${nodes}</svg>`;
}

// ---------- Slaydlar ----------
export function buildSlides(analysis, meeting, { brand = 'SUHBAT' } = {}) {
  const a = analysis;
  const slides = [];
  const participants = arr(a.participants);
  const tasks = [...arr(a.tasks)].sort(byPriority);
  let section = 0;
  const nextNo = () => pad2(++section);

  // 1. Muqova
  const title = a.title || 'Suhbat tahlili';
  slides.push(
    slide(
      'cover',
      `<aside class="cover-side"><b class="brand">${esc(brand)}</b><span>${esc(shortDate(meeting.createdAt))}</span></aside>
<div class="cover-main">
  <h1 style="font-size:${fitSize(title, [
    [28, 104],
    [48, 84],
    [70, 68],
    [100, 56],
    [999, 46],
  ])}px">${esc(title)}</h1>
  <p>${filled(a.client) ? `<b>${esc(a.client)}</b> · ` : ''}${filled(a.meeting_type) ? esc(a.meeting_type) + '. ' : ''}Ushbu hujjat — suhbatning to‘liq tahlili: nima anglashildi, kim nimani talab qildi, kim nimani yuboradi, vazifalar va yo‘l xaritasi.</p>
</div>
<div class="cover-art art art-pink">
  <div class="cover-pills"><span class="pill ghost">${esc(formatDate(meeting.createdAt))}</span><span class="pill ghost">${esc(formatDuration(meeting.durationMs))}</span></div>
  <span class="round white">${ARROW}</span>
</div>`,
    ),
  );

  // 2. Nima anglashildi
  const takeaways = arr(a.key_takeaways).slice(0, 8);
  const no1 = nextNo();
  slides.push(
    slide(
      'about',
      `<div class="about-top">
  <h2>Suhbatdan nima<br>anglashildi</h2>
  ${fitBox(`<b class="label">Qisqacha</b><p class="cols2">${esc(a.executive_summary)}</p>`, 'about-text')}
  <span class="no big">${no1}.</span>
</div>
<div class="about-sheet">
  <div class="about-art art art-coral"><span>Asosiy xulosa</span><b>${takeaways.length} ta muhim fikr</b></div>
  <div class="about-grid-wrap">
    <h3>Eng muhim xulosalar :</h3>
    ${fitBox(`<div class="cells c${takeaways.length > 6 ? 4 : 3}">${takeaways.map((t, i) => `<div class="cell"><i>${pad2(i + 1)}</i>${esc(t)}</div>`).join('')}</div>`)}
  </div>
</div>`,
    ),
  );

  // 3. Raqamlar
  const counts = [
    ['talablar', arr(a.requirements).length],
    ['vazifalar', tasks.length],
    ['shoshilinch (P1)', tasks.filter((t) => t.priority === 'P1').length],
    ['yuboriladigan narsalar', arr(a.deliverables).length],
    ['ko‘rib chiqish', arr(a.reviews).length],
    ['qarorlar', arr(a.decisions).length],
    ['ochiq savollar', arr(a.open_questions).length],
    ['risklar', arr(a.risks).length],
  ];
  const numbers = arr(a.key_numbers).slice(0, 6);
  slides.push(
    slide(
      'story',
      `<div class="story-left">
  <div class="story-badge"><b>${esc(formatDuration(meeting.durationMs))}</b><span>suhbat davomiyligi</span></div>
  <div class="story-art art art-blue"><span>Suhbat<br>raqamlarda</span></div>
</div>
<div class="story-card">
  <div class="ruled"><h2>Suhbat raqamlarda</h2></div>
  ${fitBox(
    numbers.length
      ? `<div class="numlist">${numbers.map((n) => `<div><span>${esc(n.label)}</span><b>${esc(n.value)}</b></div>`).join('')}</div>`
      : `<p class="lead">${esc(takeaways[0] || a.executive_summary)}</p>`,
    'story-body',
  )}
  <div class="stat-pills">${counts.map(([l, n]) => `<div class="stat"><span>${esc(l)}</span><b>${n}</b></div>`).join('')}</div>
</div>`,
    ),
  );

  // 4. Ishtirokchilar
  if (participants.length) {
    const groups = {};
    for (const p of participants) (groups[p.side] ||= []).push(p);
    const order = ['biz', 'mijoz', 'hamkor', 'nomalum'].filter((s) => groups[s]);
    slides.push(
      slide(
        'team',
        `<div class="team-top">
  <div class="team-black">
    <span class="muted">ishtirokchilar</span>
    <b class="huge">+${participants.length}</b>
    <hr>
    <b>Kim qatnashdi</b>
    <p>${order.map((s) => `${SIDE_LABEL[s]} — ${groups[s].length} kishi`).join(', ')}.</p>
    <span class="pill white">${esc(filled(a.client) || 'suhbat ishtirokchilari')}</span>
  </div>
  <div class="team-cards n${Math.min(order.length, 4)}">${order
    .map(
      (s) =>
        `<div class="ocard"><h3>${esc(SIDE_LABEL[s])}</h3>${fitBox(
          groups[s]
            .map((p) => `<p><b>${esc(p.name)}</b>${filled(p.role) ? ` — ${esc(p.role)}` : ''}</p>`)
            .join(''),
        )}</div>`,
    )
    .join('')}</div>
</div>
<hr class="rule">
<div class="name-rows">${chunk(participants, Math.ceil(participants.length / 2) || 1)
          .map(
            (row, r) =>
              `<div class="name-row">${row.map((p, i) => `<span class="name-pill">${avatar(p.name, i + r * 3)}${esc(p.name)}</span>`).join('')}</div>`,
          )
          .join('')}</div>`,
      ),
    );
  }

  // 5–6. Mavzular
  if (arr(a.topics).length) {
    const no = nextNo();
    slides.push(
      slide(
        'map',
        `<div class="map-card">
  <div class="map-head"><h2>Suhbat xaritasi</h2><p>Mind map — suhbatda ko‘tarilgan<br>asosiy mavzular va ularning tarmoqlari.</p><span class="no">${no}.</span></div>
  <div class="map-body">${mindMapSvg(a)}</div>
</div>`,
      ),
    );
    const pages = chunk(arr(a.topics), 6);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Nimalar muhokama qilindi — ${pi + 1}/${pages.length}` : 'Nimalar muhokama qilindi', no, 'MAVZULAR')}
<div class="grid ${items.length > 4 ? 'g3' : 'g2'}">${items
            .map(
              (t) =>
                `<div class="ocard"><h3>${esc(t.title)}${time(t.time)}</h3>${fitBox(
                  `<p class="muted">${esc(t.summary)}</p><ul class="dots">${arr(t.points)
                    .map((p) => `<li>${esc(p)}</li>`)
                    .join('')}</ul>`,
                )}</div>`,
            )
            .join('')}</div>`,
        ),
      );
    });
  }

  // 7. Talablar — tomonlar bo'yicha ikkita katta karta
  if (arr(a.requirements).length) {
    const no = nextNo();
    const cards = [];
    for (const s of ['mijoz', 'biz', 'hamkor', 'nomalum']) {
      const list = arr(a.requirements)
        .filter((r) => r.side === s)
        .sort(byPriority);
      chunk(list, 4).forEach((items, i, all) => {
        if (items.length)
          cards.push({ side: s, items, part: all.length > 1 ? ` ${i + 1}/${all.length}` : '' });
      });
    }
    const TONE = { mijoz: 'dark', biz: 'blue', hamkor: 'beige', nomalum: 'soft' };
    chunk(cards, 2).forEach((pair) => {
      slides.push(
        slide(
          'plain',
          `${head('Kim tarafdan qanday talablar qo‘yildi', no, 'TALABLAR')}
<div class="duo${pair.length === 1 ? ' one' : ''}">${pair
            .map(
              (c) => `<div class="bigcard ${TONE[c.side]}">
  <h3>${esc(SIDE_TITLE[c.side])}${esc(c.part)}</h3>
  ${fitBox(
    c.items
      .map(
        (r) =>
          `<div class="req">${pri(r.priority)}<div><b>${esc(r.requirement)}</b><span>${esc(r.from)}${filled(r.details) ? ` · ${esc(r.details)}` : ''}${filled(r.time) ? ` · ${esc(r.time)}` : ''}</span></div></div>`,
      )
      .join(''),
  )}
</div>`,
            )
            .join('')}</div>`,
        ),
      );
    });
  }

  // 8. Kim nimani yuboradi
  if (arr(a.deliverables).length) {
    const no = nextNo();
    const pages = chunk([...arr(a.deliverables)].sort(byPriority), 6);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Kim nimani yuborishi kerak — ${pi + 1}/${pages.length}` : 'Kim nimani yuborishi kerak', no, 'YUBORISH')}
<div class="sheet">${fitBox(
            items
              .map(
                (d) => `<div class="row flow">
  <span class="pill line who">${esc(d.from)}</span><span class="arrow">${ARROW_R}</span><span class="pill solid who">${esc(d.to)}</span>
  <div class="row-main"><b>${esc(d.item)}</b>${time(d.time)}</div>
  ${pri(d.priority)}
  <span class="pill soft due">${esc(d.deadline)}</span>
</div>`,
              )
              .join(''),
          )}</div>`,
        ),
      );
    });
  }

  // 9. Kim nimani ko'rib beradi
  if (arr(a.reviews).length) {
    const no = nextNo();
    const pages = chunk(arr(a.reviews), 6);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Kim nimani ko‘rib berishi kerak — ${pi + 1}/${pages.length}` : 'Kim nimani ko‘rib berishi kerak', no, 'KO‘RIB CHIQISH')}
<div class="sheet">${fitBox(
            items
              .map(
                (r, i) => `<div class="row flow">
  <span class="name-pill sm">${avatar(r.who, i)}${esc(r.who)}</span>
  <div class="row-main"><b>${esc(r.what)}</b>${time(r.time)}</div>
  <span class="pill soft due">${esc(r.deadline)}</span>
</div>`,
              )
              .join(''),
          )}</div>`,
        ),
      );
    });
  }

  // 10. Vazifalar
  if (tasks.length) {
    const no = nextNo();
    const c = (p) => tasks.filter((t) => t.priority === p).length;
    slides.push(
      slide(
        'case',
        `<div class="case-top">
  <div><h2>Vazifalar</h2><span class="ul">muhimlik bo‘yicha <i class="round sm">${ARROW}</i></span></div>
  <span class="no giant">${no}</span>
</div>
<hr>
<div class="tags"><span class="pill ghost">${tasks.length} ta vazifa</span><span class="pill ghost">P1 · shoshilinch — ${c('P1')}</span><span class="pill ghost">P2 · muhim — ${c('P2')}</span><span class="pill ghost">P3 · keyinroq — ${c('P3')}</span></div>
<div class="case-cards">${tasks
          .slice(0, 3)
          .map(
            (t, i) => `<div class="case-card">
  <div class="case-card-h"><span class="no sm">${pad2(i + 1)}</span>${pri(t.priority)}</div>
  ${fitBox(`<h3>${esc(t.title)}</h3>${filled(t.details) ? `<p class="muted">${esc(t.details)}</p>` : ''}`)}
  <div class="case-card-f"><span class="name-pill sm">${avatar(t.owner, i)}${esc(t.owner)}</span><span class="pill soft">${esc(t.deadline)}</span></div>
</div>`,
          )
          .join('')}</div>`,
      ),
    );

    const pages = chunk(tasks, 6);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Vazifalar ro‘yxati — ${pi + 1}/${pages.length}` : 'Vazifalar ro‘yxati', no, 'VAZIFALAR')}
<div class="sheet">${fitBox(
            items
              .map(
                (t, i) => `<div class="row task">
  <span class="no sm">${pad2(pi * pages[0].length + i + 1)}</span>
  <div class="row-main"><b>${esc(t.title)}</b>${filled(t.details) ? `<span>${esc(t.details)}</span>` : ''}</div>
  ${pri(t.priority)}
  <span class="name-pill sm">${avatar(t.owner, pi * pages[0].length + i)}${esc(t.owner)}</span>
  <span class="pill soft due">${esc(t.deadline)}</span>
</div>`,
              )
              .join(''),
          )}</div>`,
        ),
      );
    });

    const byOwner = {};
    for (const t of tasks) (byOwner[filled(t.owner) || 'Egasi belgilanmagan'] ||= []).push(t);
    const owners = Object.entries(byOwner);
    const ownerPages = chunk(owners, 3);
    ownerPages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(ownerPages.length > 1 ? `Kim nima qiladi — ${pi + 1}/${ownerPages.length}` : 'Kim nima qiladi', no, 'MAS’ULLAR')}
<div class="grid g3 tall">${items
            .map(
              ([owner, list], i) => `<div class="ocard owner">
  <div class="owner-h">${avatar(owner, pi * 3 + i)}<h3>${esc(owner)}</h3><span class="pill line">${list.length} ta</span></div>
  ${fitBox(
    list
      .map(
        (t) =>
          `<div class="mini">${pri(t.priority)}<b>${esc(t.title)}</b>${filled(t.deadline) ? `<span>${esc(t.deadline)}</span>` : ''}</div>`,
      )
      .join(''),
  )}
</div>`,
            )
            .join('')}</div>`,
        ),
      );
    });
  }

  // 11. Qarorlar
  if (arr(a.decisions).length) {
    const no = nextNo();
    const pages = chunk(arr(a.decisions), 6);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Nimaga kelishildi — ${pi + 1}/${pages.length}` : 'Nimaga kelishildi', no, 'QARORLAR')}
<div class="sheet">${fitBox(
            items
              .map(
                (d) =>
                  `<div class="row"><span class="pill st st-${esc(d.status)}">${esc(STATUS_LABEL[d.status] || d.status)}</span><div class="row-main"><b class="reg">${esc(d.decision)}</b></div>${time(d.time)}</div>`,
              )
              .join(''),
          )}</div>`,
        ),
      );
    });
  }

  // 12. Ochiq savollar
  if (arr(a.open_questions).length) {
    const no = nextNo();
    const pages = chunk(arr(a.open_questions), 4);
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Javob kutilayotgan savollar — ${pi + 1}/${pages.length}` : 'Javob kutilayotgan savollar', no, 'OCHIQ SAVOLLAR')}
<div class="grid g2">${items
            .map(
              (q, i) => `<div class="ocard q">
  <span class="qmark">?</span>
  ${fitBox(`<h3>${esc(q.question)}</h3>`)}
  <div class="q-f"><span class="muted">javob beradi</span><span class="name-pill sm">${avatar(q.who_answers, pi * 4 + i)}${esc(q.who_answers)}</span>${time(q.time)}</div>
</div>`,
            )
            .join('')}</div>`,
        ),
      );
    });
  }

  // 13. Risklar
  if (arr(a.risks).length) {
    const no = nextNo();
    const order = { yuqori: 0, orta: 1, past: 2 };
    const pages = chunk(
      [...arr(a.risks)].sort((x, y) => (order[x.impact] ?? 1) - (order[y.impact] ?? 1)),
      3,
    );
    pages.forEach((items, pi) => {
      slides.push(
        slide(
          'plain',
          `${head(pages.length > 1 ? `Nimaga e’tibor berish kerak — ${pi + 1}/${pages.length}` : 'Nimaga e’tibor berish kerak', no, 'RISKLAR')}
<div class="grid g3 tall">${items
            .map(
              (r) => `<div class="ocard risk">
  <span class="pill imp imp-${esc(r.impact)}">ta’sir: ${esc(IMPACT_LABEL[r.impact] || r.impact)}</span>
  ${fitBox(`<h3>${esc(r.risk)}</h3>`)}
  <div class="risk-f"><b>Nima qilish kerak</b>${fitBox(`<p>${esc(r.mitigation)}</p>`)}</div>
</div>`,
            )
            .join('')}</div>`,
        ),
      );
    });
  }

  // 14. Road map
  if (arr(a.roadmap).length) {
    nextNo();
    const phases = arr(a.roadmap).slice(0, 8);
    const ARTS = ['art-lilac', 'art-mint', 'art-coral', 'art-blue', 'art-pink'];
    const per = phases.length <= 4 ? phases.length : 3;
    chunk(phases, per).forEach((items, pi) => {
      slides.push(
        slide(
          'road',
          `<div class="road-grid n${items.length}">${items
            .map((p, i) => {
              const n = pi * per + i;
              return `<div class="road-card">
  <div class="road-art art ${ARTS[n % ARTS.length]}"><span>#${n + 1}</span><b style="font-size:${fitSize(
    p.phase,
    [
      [12, 64],
      [20, 50],
      [32, 40],
      [999, 32],
    ],
  )}px">${esc(p.phase)}</b></div>
  <h3>Muddat</h3>
  <span class="pill line">${esc(p.timeframe)}</span>
  ${fitBox(
    `<ul class="dots">${arr(p.items)
      .map((it) => `<li>${esc(it)}</li>`)
      .join('')}</ul>`,
    'road-items',
  )}
  ${arr(p.goals).length ? `<div class="road-goal"><b>Maqsad</b>${fitBox(`<p>${arr(p.goals).map(esc).join('; ')}</p>`)}</div>` : ''}
</div>`;
            })
            .join('')}</div>`,
        ),
      );
    });
  }

  // 15. Keyingi qadamlar
  const steps = arr(a.next_steps).slice(0, 7);
  slides.push(
    slide(
      'final',
      `<div class="final-art art art-mint"><span class="brand">${esc(brand)}</span></div>
<div class="final-black"><b>ENDI<br>NIMA</b><b class="br">QILAMIZ</b><span class="round yellow">${ARROW}</span></div>
<div class="final-blue">
  <div class="cover-pills"><span class="pill ghost">${esc(shortDate(meeting.createdAt))}</span><span class="pill ghost">keyingi qadamlar</span></div>
  ${fitBox(
    steps.length
      ? `<ol class="steps">${steps.map((s, i) => `<li><i>${pad2(i + 1)}</i><span>${esc(s)}</span></li>`).join('')}</ol>`
      : `<p class="thanks">rahmat.</p>`,
    'final-steps',
  )}
  <div class="final-cta"><span>rahmat.</span>${ARROW}</div>
</div>`,
    ),
  );

  return slides;
}

const CSS = `
@font-face{font-family:"Outfit";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${FONT_LATIN_EXT}) format("woff2");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}
@font-face{font-family:"Outfit";font-style:normal;font-weight:100 900;font-display:block;src:url(data:font/woff2;base64,${FONT_LATIN}) format("woff2");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}
:root{--canvas:#ECECEC;--card:#fff;--ink:#0A0A0A;--muted:#8A8A8A;--soft:#F3F3F3;--line:#D8D8D8;--blue:#0A5CFF;--yellow:#EDFF00;--dark:#262626;--beige:#E4E1CB;--lilac:#DAD7FF;--coral:#FF5B35}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:#111;font-family:"Outfit","Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}
.deck{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.slide{position:absolute;width:1600px;height:900px;background:#fff;display:none;transform-origin:center center;overflow:hidden;font-size:22px;line-height:1.35}
h1,h2,h3,p{margin:0}
h1,h2{font-weight:400;letter-spacing:-.035em;line-height:1}
h2{font-size:68px}
h3{font-size:34px;font-weight:600;letter-spacing:-.02em;line-height:1.1}
hr{border:0;border-top:1.5px solid var(--line);margin:0}
.muted{color:var(--muted)}
.no{font-weight:300;font-size:64px;letter-spacing:-.04em;line-height:1}
.no.big{font-size:110px}.no.giant{font-size:230px;font-weight:300;line-height:.8}.no.sm{font-size:32px;color:#B5B5B5;min-width:54px}
.time{font-size:16px;color:#ABABAB;margin-left:10px;font-weight:400;letter-spacing:0;font-variant-numeric:tabular-nums;white-space:nowrap}
.fitbox{min-height:0;overflow:hidden;flex:1}
.fit{width:100%}
.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;padding:8px 20px;font-size:21px;line-height:1.2;white-space:nowrap;border:1.5px solid transparent}
.pill.line{border-color:var(--ink)}
.pill.solid{background:var(--ink);color:#fff}
.pill.soft{background:#EDEDED}
.pill.white{background:#fff;color:var(--ink)}
.pill.ghost{border-color:currentColor}
.pri{font-size:18px;font-weight:600;padding:5px 15px}
.pri-P1{background:var(--coral);color:#fff}.pri-P2{background:var(--yellow);color:var(--ink)}.pri-P3{background:#E6E6E6;color:#555}
.st{min-width:150px;justify-content:center;font-size:19px;font-weight:500}
.st-kelishildi{background:var(--ink);color:#fff}.st-taklif{border-color:var(--ink)}.st-ochiq{background:#E6E6E6;color:#555}
.imp{font-size:19px;font-weight:500;align-self:flex-start}
.imp-yuqori{background:var(--coral);color:#fff}.imp-orta{background:var(--yellow)}.imp-past{background:#E6E6E6;color:#555}
.round{display:inline-flex;align-items:center;justify-content:center;width:96px;height:96px;border-radius:50%}
.round svg{width:40%;height:40%}
.round.white{background:#fff;color:var(--ink)}.round.yellow{background:var(--yellow);color:var(--ink);width:170px;height:170px}
.round.sm{width:26px;height:26px;background:#fff;color:#000;vertical-align:middle}
.avatar{display:inline-flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;font-size:16px;font-weight:600;flex:none;letter-spacing:0}
.a1{background:var(--ink);color:#fff}.a2{background:var(--blue);color:#fff}.a3{background:var(--yellow)}.a4{background:var(--lilac)}.a5{background:var(--beige)}.a6{background:var(--coral);color:#fff}
.name-pill{display:inline-flex;align-items:center;gap:14px;border:1.5px solid #CFCFCF;border-radius:999px;padding:8px 30px 8px 8px;font-size:34px;font-weight:300;letter-spacing:-.02em;white-space:nowrap;background:#fff}
.name-pill .avatar{width:58px;height:58px;font-size:20px}
.name-pill.sm{font-size:21px;font-weight:400;padding:4px 16px 4px 4px;gap:8px;letter-spacing:0;max-width:300px;overflow:hidden;text-overflow:ellipsis}
.name-pill.sm .avatar{width:36px;height:36px;font-size:14px}
ul.dots{margin:14px 0 0;padding:0;list-style:none}
ul.dots li{position:relative;padding:6px 0 6px 26px;font-size:25px;line-height:1.28}
ul.dots li:before{content:"";position:absolute;left:2px;top:18px;width:8px;height:8px;border-radius:50%;background:var(--ink)}
.art{position:relative;overflow:hidden;color:#fff}
.art:after{content:"";position:absolute;inset:0;background:repeating-linear-gradient(90deg,rgba(255,255,255,.2) 0 2px,rgba(255,255,255,0) 2px 26px,rgba(0,0,0,.05) 26px 28px);mix-blend-mode:soft-light;pointer-events:none}
.art>*{position:relative;z-index:1}
.art-pink{background:radial-gradient(46% 42% at 26% 78%,#B21FE0 0,rgba(178,31,224,0) 70%),radial-gradient(40% 46% at 78% 40%,#7F86FF 0,rgba(127,134,255,0) 70%),radial-gradient(34% 40% at 82% 82%,#FFC531 0,rgba(255,197,49,0) 70%),radial-gradient(36% 36% at 30% 30%,#F5F0C8 0,rgba(245,240,200,0) 70%),linear-gradient(160deg,#F2C9BC,#EDA79E)}
.art-blue{background:radial-gradient(50% 44% at 30% 22%,#DDF2FF 0,rgba(221,242,255,0) 70%),radial-gradient(52% 46% at 74% 44%,#22B6F2 0,rgba(34,182,242,0) 70%),radial-gradient(60% 50% at 30% 88%,#2D5BFF 0,rgba(45,91,255,0) 75%),linear-gradient(170deg,#9CC4EE,#5B7BFF)}
.art-coral{background:radial-gradient(54% 50% at 76% 20%,#F4E3DF 0,rgba(244,227,223,0) 70%),radial-gradient(54% 54% at 24% 36%,#C7654F 0,rgba(199,101,79,0) 70%),radial-gradient(60% 50% at 60% 90%,#FFB9B4 0,rgba(255,185,180,0) 75%),linear-gradient(165deg,#E9B8A8,#F6A6A0)}
.art-mint{background:radial-gradient(50% 46% at 70% 26%,#8FB3A2 0,rgba(143,179,162,0) 70%),radial-gradient(46% 46% at 24% 70%,#C9C4FF 0,rgba(201,196,255,0) 70%),radial-gradient(40% 40% at 80% 86%,#F7E9D7 0,rgba(247,233,215,0) 70%),linear-gradient(165deg,#DCE8E0,#B8D2C4)}
.art-lilac{background:radial-gradient(46% 46% at 24% 30%,#FF7C6B 0,rgba(255,124,107,0) 68%),radial-gradient(50% 50% at 76% 34%,#7A6BFF 0,rgba(122,107,255,0) 70%),radial-gradient(60% 46% at 40% 92%,#C8C2FF 0,rgba(200,194,255,0) 75%),linear-gradient(165deg,#F3D9E6,#CFC8FF)}

/* 1 — muqova */
.cover.active{display:grid;grid-template-columns:186px 1fr 720px;gap:0;padding:10px}
.cover-side{display:flex;flex-direction:column;justify-content:space-between;padding:26px 0 18px 34px;font-size:15px;color:#9B9B9B}
.brand{font-weight:700;font-size:21px;letter-spacing:.02em;color:var(--ink);text-transform:uppercase;line-height:1.05;word-break:break-word}
.cover-main{background:#EFEFEF;border-radius:64px 0 0 64px;padding:44px 50px 34px 46px;display:flex;flex-direction:column;justify-content:space-between;margin-right:-64px;padding-right:110px}
.cover-main h1{font-weight:400;color:#2A2A2A;line-height:1.02}
.cover-main p{color:#A3A3A3;font-size:19px;max-width:560px;line-height:1.3;letter-spacing:-.01em}
.cover-main p b{color:#6A6A6A;font-weight:500}
.cover-art{border-radius:48px;display:flex;flex-direction:column;justify-content:space-between;padding:26px}
.cover-pills{display:flex;gap:12px;justify-content:flex-end;flex-wrap:wrap}

/* 2 — nima anglashildi */
.about{background:#F3F3F3}
.about.active{display:flex;flex-direction:column}
.about-top{display:grid;grid-template-columns:480px 1fr 190px;gap:56px;padding:110px 60px 0 84px;height:386px}
.about-top h2{font-size:70px;line-height:.98}
.about-text{padding-top:26px}
.label{display:block;font-size:20px;font-weight:600;margin-bottom:12px}
.cols2{column-count:2;column-gap:44px;color:#8B8B8B;font-size:22px;line-height:1.32}
.about-top .no{align-self:end;text-align:right;padding-bottom:42px}
.about-sheet{flex:1;background:#fff;border-radius:60px 60px 0 0;padding:18px;display:grid;grid-template-columns:620px 1fr;gap:38px;min-height:0}
.about-art{border-radius:44px;display:flex;flex-direction:column;justify-content:flex-end;padding:0 44px 34px}
.about-art span{font-size:30px;font-weight:500;opacity:.92}
.about-art b{font-size:62px;font-weight:600;letter-spacing:-.03em;line-height:1}
.about-grid-wrap{display:flex;flex-direction:column;padding:26px 40px 26px 0;min-height:0}
.about-grid-wrap h3{font-size:32px;font-weight:500;margin-bottom:22px}
.cells{display:grid;border-top:1.5px solid #E4E4E4;border-left:1.5px solid #E4E4E4}
.cells.c3{grid-template-columns:repeat(3,1fr)}.cells.c4{grid-template-columns:repeat(4,1fr)}
.cell{border-right:1.5px solid #E4E4E4;border-bottom:1.5px solid #E4E4E4;padding:22px 24px;font-size:23px;line-height:1.25;min-height:150px}
.cell i{display:block;font-style:normal;color:#B5B5B5;font-size:15px;margin-bottom:8px}

/* 3 — raqamlar */
.story{background:#D9D9D9}
.story.active{display:grid;grid-template-columns:524px 1fr;gap:10px;padding:10px}
.story-left{display:flex;flex-direction:column;gap:6px;min-height:0}
.story-badge{background:#fff;border-radius:80px;padding:38px 60px;display:flex;flex-direction:column;gap:2px}
.story-badge b{font-size:44px;font-weight:600;letter-spacing:-.03em}.story-badge span{color:var(--muted);font-size:20px}
.story-art{flex:1;border-radius:80px;display:flex;align-items:flex-end;padding:0 0 56px 50px}
.story-art span{writing-mode:vertical-rl;transform:rotate(180deg);font-size:92px;line-height:.98;font-weight:400;letter-spacing:-.03em}
.story-card{background:#fff;border-radius:84px;padding:78px 62px 42px 84px;display:flex;flex-direction:column;min-height:0}
.ruled{border-top:1.5px solid #CFCFCF;border-bottom:1.5px solid #CFCFCF;padding:22px 0 26px}
.story-body{padding:34px 0 20px}
.lead{font-size:30px;line-height:1.15;font-weight:300;letter-spacing:-.01em}
.numlist{display:grid;grid-template-columns:1fr 1fr;column-gap:56px}
.numlist div{display:flex;justify-content:space-between;align-items:baseline;gap:20px;padding:14px 0;border-bottom:1.5px solid #E6E6E6}
.numlist span{color:#8B8B8B;font-size:23px;line-height:1.2}.numlist b{font-size:36px;font-weight:600;letter-spacing:-.02em;text-align:right}
.stat-pills{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
.stat{background:#F3F3F3;border-radius:999px;padding:18px 30px 16px;height:104px;display:flex;flex-direction:column;justify-content:space-between}
.stat span{font-style:italic;font-weight:300;color:#9A9A9A;font-size:19px;line-height:1.1}
.stat b{font-size:38px;font-weight:700;text-align:right;line-height:1;letter-spacing:-.02em}

/* 4 — ishtirokchilar */
.team.active{display:flex;flex-direction:column;padding:18px}
.team-top{display:grid;grid-template-columns:770px 1fr;gap:34px;height:452px}
.team-black{background:#000;color:#fff;border-radius:40px;padding:42px 44px;display:flex;flex-direction:column;align-items:flex-start;gap:8px}
.team-black .muted{color:#9A9A9A;font-size:17px}
.huge{font-size:66px;font-weight:500;letter-spacing:-.03em;line-height:1}
.team-black hr{width:100%;border-color:#3A3A3A;margin:16px 0 22px}
.team-black p{font-size:25px;font-weight:300;line-height:1.3;max-width:540px;flex:1}
.team-cards{display:grid;gap:18px;min-height:0}
.team-cards.n1{grid-template-columns:1fr}.team-cards.n2{grid-template-columns:1fr 1fr}.team-cards.n3,.team-cards.n4{grid-template-columns:1fr 1fr;grid-template-rows:1fr 1fr}
.ocard{border:1.5px solid #E2E2E2;border-radius:36px;padding:32px 34px 28px;display:flex;flex-direction:column;gap:14px;min-height:0;background:#fff}
.ocard p{font-size:23px;color:#7E7E7E;line-height:1.3;margin-bottom:10px}
.ocard p b{color:var(--ink);font-weight:500}
.rule{margin:48px 0 44px}
.name-rows{display:flex;flex-direction:column;gap:12px}
.name-row{display:flex;gap:12px;flex-wrap:wrap}

/* 5 — mind map */
.map{background:#9A9A9A}
.map.active{display:block;padding:10px}
.map-card{background:#fff;border-radius:56px;height:100%;padding:56px 60px 30px;display:flex;flex-direction:column}
.map-head{display:grid;grid-template-columns:auto 1fr auto;gap:48px;align-items:center}
.map-head p{color:#8B8B8B;font-size:18px;line-height:1.25}
.map-body{flex:1;min-height:0;display:flex;align-items:center;justify-content:center}
.mindmap{width:100%;height:100%}
.mm-topic{font-size:18px;font-weight:500}.mm-leaf{fill:#2B2B2B;font-size:16.5px}.mm-center{fill:#fff;font-size:23px;font-weight:500}

/* umumiy kontent slaydi */
.plain{background:#F3F3F3}
.plain.active{display:flex;flex-direction:column;padding:56px 60px 44px}
.head{display:flex;justify-content:space-between;align-items:flex-end;gap:40px;padding-bottom:26px;border-bottom:1.5px solid #CFCFCF;margin-bottom:26px}
.head h2{font-size:62px;line-height:1}
.head-r{display:flex;align-items:center;gap:26px;flex:none}
.head-r .pill{font-size:15px;letter-spacing:.02em;padding:6px 16px}
.grid{display:grid;gap:18px;flex:1;min-height:0}
.g2{grid-template-columns:1fr 1fr;grid-auto-rows:1fr}
.g3{grid-template-columns:repeat(3,1fr)}
.sheet{background:#fff;border-radius:44px;padding:14px 40px;flex:1;min-height:0;display:flex}
.row{display:flex;align-items:center;gap:22px;padding:24px 0;border-bottom:1.5px solid #EAEAEA}
.row:last-child{border-bottom:0}
.row-main{flex:1;min-width:0}
.row-main b{font-size:29px;font-weight:500;letter-spacing:-.01em;line-height:1.2}
.row-main b.reg{font-weight:400}
.row-main span:not(.time){display:block;color:#8B8B8B;font-size:21px;margin-top:4px;line-height:1.25}
.who{font-size:23px;max-width:280px;overflow:hidden;text-overflow:ellipsis}
.arrow{width:42px;flex:none;display:flex}.arrow svg{width:100%}
.due{font-size:21px;min-width:170px;justify-content:center}
.duo{display:grid;grid-template-columns:1fr 1fr;gap:10px;flex:1;min-height:0}
.duo.one{grid-template-columns:1fr}
.bigcard{border-radius:44px;padding:40px 44px 30px;display:flex;flex-direction:column;gap:22px;min-height:0}
.bigcard h3{font-size:54px;font-weight:400;letter-spacing:-.035em}
.bigcard.dark{background:var(--dark);color:#fff}.bigcard.blue{background:var(--blue);color:#fff}.bigcard.beige{background:var(--beige)}.bigcard.soft{background:#fff}
.req{display:flex;gap:18px;align-items:flex-start;padding:19px 0;border-top:1.5px solid rgba(255,255,255,.2)}
.bigcard.beige .req,.bigcard.soft .req{border-top-color:rgba(0,0,0,.12)}
.req .pri{margin-top:3px;flex:none}
.req b{display:block;font-size:28px;font-weight:500;line-height:1.2;letter-spacing:-.01em}
.req span:not(.pill){display:block;font-size:20px;opacity:.72;margin-top:4px;line-height:1.25}
.owner-h{display:flex;align-items:center;gap:14px}
.owner-h h3{flex:1;font-size:31px}
.owner-h .avatar{width:52px;height:52px}
.mini{padding:15px 0;border-top:1.5px solid #EAEAEA;font-size:23px;line-height:1.25}
.mini b{display:block;font-weight:500;margin:8px 0 3px}.mini span:not(.pill){color:#8B8B8B;font-size:19px}
.q{position:relative;padding-top:34px}
.qmark{font-size:74px;font-weight:300;line-height:.7;color:#C9C9C9}
.q h3{font-weight:500;font-size:36px;line-height:1.15}
.q-f{display:flex;align-items:center;gap:12px;font-size:19px}
.risk h3{font-size:36px;line-height:1.12}
.risk-f{background:#F6F4F3;border-radius:26px;padding:20px 24px;display:flex;flex-direction:column;gap:8px;height:46%;min-height:0;margin:0 -8px -4px}
.risk-f b{font-size:20px;font-weight:600}
.risk-f p{font-size:23px;line-height:1.3;color:#3A3A3A;margin:0}

/* vazifalar muqovasi */
.case{background:#000;color:#fff}
.case.active{display:flex;flex-direction:column;padding:70px 40px 0}
.case-top{display:flex;justify-content:space-between;align-items:flex-start;height:150px}
.case h2{font-size:104px;font-weight:300;letter-spacing:-.02em}
.ul{display:inline-flex;align-items:center;gap:12px;font-size:32px;font-weight:300;border-bottom:1.5px solid #fff;padding-bottom:2px;margin-top:10px}
.case hr{border-color:#4A4A4A;margin:44px 0 28px}
.tags{display:flex;gap:6px;flex-wrap:wrap}
.tags .pill{font-size:19px;padding:5px 16px}
.case-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-top:64px;flex:1;min-height:0}
.case-card{background:#fff;color:var(--ink);border-radius:36px 36px 0 0;padding:30px 32px 26px;display:flex;flex-direction:column;gap:16px;min-height:0}
.case-card-h,.case-card-f{display:flex;justify-content:space-between;align-items:center;gap:10px}
.case-card h3{font-size:38px;font-weight:500;line-height:1.12}
.case-card p{font-size:22px;margin-top:10px;line-height:1.3}

/* road map */
.road{background:#E6E6E6}
.road.active{display:block;padding:18px}
.road-grid{display:grid;gap:10px;height:100%}
.road-grid.n1{grid-template-columns:1fr}.road-grid.n2{grid-template-columns:1fr 1fr}.road-grid.n3{grid-template-columns:repeat(3,1fr)}.road-grid.n4{grid-template-columns:repeat(4,1fr)}
.road-card{background:#fff;border-radius:44px;padding:8px;display:flex;flex-direction:column;align-items:center;gap:14px;min-height:0;text-align:center}
.road-art{align-self:stretch;height:250px;border-radius:38px;display:flex;flex-direction:column;justify-content:flex-end;align-items:flex-start;padding:0 30px 24px;text-align:left;flex:none}
.road-art span{font-size:34px;font-weight:500;font-style:italic;opacity:.95}
.road-art b{font-weight:500;letter-spacing:-.03em;line-height:1}
.road-card h3{font-size:38px;font-weight:600;letter-spacing:-.03em;margin-top:12px;color:#2B2B2B}
.road-items{align-self:stretch;padding:0 30px;text-align:left}
.road-goal{align-self:stretch;background:#F6F4F3;border-radius:34px;padding:18px 26px 20px;display:flex;flex-direction:column;gap:4px;height:132px;flex:none}
.road-goal b{font-size:19px;font-weight:600}.road-goal p{font-size:22px;line-height:1.25}

/* yakuniy slayd */
.final{background:#9A9A9A}
.final.active{display:grid;grid-template-columns:526px 1fr 530px;gap:0;padding:10px}
.final-art{border-radius:40px;padding:34px 38px}
.final-art .brand{color:#fff;font-size:26px}
.final-black{background:#000;color:#fff;border-radius:40px;padding:34px 38px;display:flex;flex-direction:column;justify-content:space-between;position:relative}
.final-black b{font-size:74px;font-weight:400;letter-spacing:-.02em;line-height:1.08}
.final-black .br{text-align:right}
.final-black .round{position:absolute;left:-85px;top:50%;margin-top:-85px;z-index:2}
.final-blue{background:var(--blue);color:#fff;border-radius:40px;padding:26px 30px 22px;display:flex;flex-direction:column;gap:22px;min-height:0}
.final-steps{display:flex;align-items:center}
.steps{list-style:none;margin:0;padding:0}
.steps li{display:flex;gap:16px;padding:16px 0;border-bottom:1.5px solid rgba(255,255,255,.3);font-size:25px;line-height:1.25}
.steps li:last-child{border-bottom:0}
.steps i{font-style:normal;opacity:.7;font-size:16px;padding-top:3px;min-width:26px}
.thanks{font-size:64px;font-weight:500;text-align:center;width:100%}
.final-cta{border:1.5px solid #fff;border-radius:999px;padding:16px 30px;display:flex;justify-content:space-between;align-items:center;font-size:30px}
.final-cta span{border-bottom:1.5px solid #fff;line-height:1.1}
.final-cta svg{width:38px;height:38px}

.toolbar{position:fixed;right:16px;bottom:14px;display:flex;gap:6px;align-items:center;z-index:5;font-family:inherit;transition:opacity .4s}
.toolbar.idle{opacity:0;pointer-events:none}
.toolbar button,.toolbar a{background:rgba(255,255,255,.1);color:#fff;border:1.5px solid rgba(255,255,255,.28);border-radius:999px;padding:7px 16px;font-size:14px;cursor:pointer;text-decoration:none;font-family:inherit}
.toolbar button:hover,.toolbar a:hover{background:#fff;color:#000}
.counter{color:#9A9A9A;font-size:14px;margin-right:8px;font-variant-numeric:tabular-nums}
.deck.all{position:static;display:block;overflow:auto;padding:24px 0 80px}
.deck.all .slide{position:relative;margin:0 auto 24px}
@media print{
  @page{size:1600px 900px;margin:0}
  html,body{background:#fff;height:auto}
  .toolbar{display:none}
  .deck{position:static;display:block}
  .slide{position:relative;transform:none!important;page-break-after:always;break-after:page;margin:0}
  .slide:last-child{page-break-after:auto;break-after:auto}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`;

// Har bir slayd turi o'ziga xos "display"ga ega; faqat .active bo'lganda ko'rinadi.
const DISPLAY_RULES = `
.slide.active{display:block}
.slide.cover.active{display:grid}.slide.about.active{display:flex}.slide.story.active{display:grid}
.slide.team.active{display:flex}.slide.plain.active{display:flex}.slide.case.active{display:flex}
.slide.final.active{display:grid}`;

const SCRIPT = `
(function(){
  var deck=document.querySelector('.deck');
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var counter=document.querySelector('.counter');
  var i=Math.min(slides.length-1,Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1));
  function scale(){
    var all=deck.classList.contains('all');
    var s=all?Math.min(1,(window.innerWidth-48)/1600):Math.min(window.innerWidth/1600,window.innerHeight/900);
    slides.forEach(function(el){
      if(all){el.style.transform='none';el.style.zoom=s;}
      else{el.style.zoom=1;el.style.transform='scale('+s+')';}
    });
  }
  // Matn o'z joyiga sig'masa, faqat o'sha blok kichraytiriladi (hech narsa kesilib qolmaydi).
  function fitAll(){
    slides.forEach(function(el){
      var was=el.classList.contains('active');el.classList.add('active');
      [].forEach.call(el.querySelectorAll('.fitbox'),function(box){
        var inner=box.firstElementChild;if(!inner)return;
        var z=1;inner.style.zoom=1;
        while(box.scrollHeight>box.clientHeight+1&&z>0.45){z-=0.03;inner.style.zoom=z;}
      });
      if(!was)el.classList.remove('active');
    });
  }
  function show(n){
    i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(el,k){el.classList.toggle('active',deck.classList.contains('all')||k===i);});
    counter.textContent=(i+1)+' / '+slides.length;
    try{history.replaceState(null,'','#'+(i+1));}catch(e){}
  }
  function full(){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();}
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();show(i+1);}
    if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();show(i-1);}
    if(e.key==='Home')show(0); if(e.key==='End')show(slides.length-1);
    if(e.key==='f'||e.key==='F')full();
  });
  deck.addEventListener('click',function(e){ if(deck.classList.contains('all'))return; show(e.clientX>window.innerWidth/2?i+1:i-1);});
  document.getElementById('prev').onclick=function(){show(i-1)};
  document.getElementById('next').onclick=function(){show(i+1)};
  document.getElementById('full').onclick=full;
  document.getElementById('all').onclick=function(){deck.classList.toggle('all');show(i);scale();};
  document.getElementById('print').onclick=function(){window.print();};
  window.addEventListener('beforeprint',function(){slides.forEach(function(el){el.classList.add('active');});});
  window.addEventListener('afterprint',function(){show(i);scale();});
  window.addEventListener('resize',scale);
  var bar=document.querySelector('.toolbar'),idleTimer;
  function wake(){bar.classList.remove('idle');clearTimeout(idleTimer);idleTimer=setTimeout(function(){bar.classList.add('idle');},3000);}
  ['mousemove','keydown','touchstart'].forEach(function(ev){document.addEventListener(ev,wake);});
  function boot(){scale();fitAll();show(i);wake();}
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(boot);else boot();
})();`;

export function renderPresentation(analysis, meeting, options = {}) {
  const slides = buildSlides(analysis, meeting, options);
  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(analysis.title || 'Suhbat tahlili')}</title>
<style>${CSS}${DISPLAY_RULES}</style>
</head>
<body>
<main class="deck">
${slides.join('\n')}
</main>
<nav class="toolbar">
  <span class="counter"></span>
  <button id="prev" title="Oldingi (←)">←</button>
  <button id="next" title="Keyingi (→)">→</button>
  <button id="all" title="Hamma slaydlar bir sahifada">Hammasi</button>
  <button id="full" title="To‘liq ekran (F)">To‘liq ekran</button>
  <button id="print" title="PDF sifatida saqlash">PDF</button>
</nav>
<script>${SCRIPT}</script>
</body>
</html>`;
}

/** Telegram/email'ga yopishtirish uchun oddiy matnli xulosa. */
export function renderMarkdown(a, meeting) {
  const L = [];
  L.push(`# ${a.title || 'Suhbat tahlili'}`);
  L.push(
    `${formatDate(meeting.createdAt)} · ${formatDuration(meeting.durationMs)}${filled(a.client) ? ' · ' + a.client : ''}`,
  );
  L.push('', '## Qisqacha', a.executive_summary || '');
  if (arr(a.key_takeaways).length)
    L.push('', '## Nima anglashildi', ...arr(a.key_takeaways).map((t) => `- ${t}`));
  if (arr(a.requirements).length)
    L.push(
      '',
      '## Talablar',
      ...arr(a.requirements).map(
        (r) => `- [${r.priority}] ${SIDE_LABEL[r.side] || ''} (${r.from}): ${r.requirement}`,
      ),
    );
  if (arr(a.deliverables).length)
    L.push(
      '',
      '## Kim nimani yuboradi',
      ...arr(a.deliverables).map((d) => `- ${d.from} → ${d.to}: ${d.item} (muddat: ${d.deadline})`),
    );
  if (arr(a.reviews).length)
    L.push(
      '',
      '## Kim nimani ko‘rib chiqadi',
      ...arr(a.reviews).map((r) => `- ${r.who}: ${r.what} (muddat: ${r.deadline})`),
    );
  if (arr(a.tasks).length)
    L.push(
      '',
      '## Vazifalar',
      ...[...arr(a.tasks)]
        .sort(byPriority)
        .map((t) => `- [${t.priority}] ${t.title} — ${t.owner} (muddat: ${t.deadline})`),
    );
  if (arr(a.decisions).length)
    L.push(
      '',
      '## Qarorlar',
      ...arr(a.decisions).map((d) => `- (${STATUS_LABEL[d.status] || d.status}) ${d.decision}`),
    );
  if (arr(a.open_questions).length)
    L.push(
      '',
      '## Ochiq savollar',
      ...arr(a.open_questions).map((q) => `- ${q.question} — ${q.who_answers}`),
    );
  if (arr(a.risks).length)
    L.push(
      '',
      '## Risklar',
      ...arr(a.risks).map(
        (r) => `- (${IMPACT_LABEL[r.impact] || r.impact}) ${r.risk} → ${r.mitigation}`,
      ),
    );
  if (arr(a.roadmap).length)
    L.push(
      '',
      '## Yo‘l xaritasi',
      ...arr(a.roadmap).map(
        (p, i) => `${i + 1}. ${p.phase} (${p.timeframe}): ${arr(p.items).join('; ')}`,
      ),
    );
  if (arr(a.next_steps).length)
    L.push('', '## Keyingi qadamlar', ...arr(a.next_steps).map((s, i) => `${i + 1}. ${s}`));
  return L.join('\n') + '\n';
}
