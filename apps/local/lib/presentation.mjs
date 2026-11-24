// Tahlil natijasidan o'z-o'zidan ishlaydigan HTML prezentatsiya yasaydi (internet shart emas).
// Strelkalar bilan varaqlanadi, "PDF" tugmasi har bir slaydni alohida sahifa qilib chop etadi.

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

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out.length ? out : [[]];
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
  return `${d.getDate()}-${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const SIDE_LABEL = { biz: 'Biz', mijoz: 'Mijoz', hamkor: 'Hamkor', nomalum: 'Noma’lum' };
const PRIORITY_LABEL = { P1: 'Shoshilinch', P2: 'Muhim', P3: 'Keyinroq' };
const STATUS_LABEL = { kelishildi: 'Kelishildi', taklif: 'Taklif', ochiq: 'Ochiq' };
const IMPACT_LABEL = { yuqori: 'Yuqori', orta: 'O‘rta', past: 'Past' };

const pri = (p) =>
  `<span class="pill pri-${esc(p)}">${esc(p)} · ${esc(PRIORITY_LABEL[p] || '')}</span>`;
const sidePill = (s) => `<span class="pill side-${esc(s)}">${esc(SIDE_LABEL[s] || s)}</span>`;
const time = (t) => (filled(t) ? `<span class="time">${esc(t)}</span>` : '');
const PRI_ORDER = { P1: 0, P2: 1, P3: 2 };
const byPriority = (a, b) => (PRI_ORDER[a.priority] ?? 3) - (PRI_ORDER[b.priority] ?? 3);

function slide({ title, kicker, body, cls = '' }) {
  return `<section class="slide ${cls}">
  ${kicker || title ? `<header>${kicker ? `<div class="kicker">${esc(kicker)}</div>` : ''}${title ? `<h2>${esc(title)}</h2>` : ''}</header>` : ''}
  <div class="body"><div class="fit">${body}</div></div>
</section>`;
}

function paged(list, size, render, { title, kicker, cls }) {
  const pages = chunk(list, size);
  return pages.map((items, i) =>
    slide({
      title: pages.length > 1 ? `${title} (${i + 1}/${pages.length})` : title,
      kicker,
      cls,
      body: render(items, i),
    }),
  );
}

// ---------- Mind map (SVG) ----------
function wrapText(text, maxChars, maxLines) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else cur = (cur + ' ' + w).trim();
  }
  if (lines.length < maxLines && cur) lines.push(cur);
  const used = lines.join(' ').split(/\s+/).length;
  if (used < words.length && lines.length)
    lines[lines.length - 1] = lines[lines.length - 1].replace(/.{0,2}$/, '…');
  return lines;
}

const BRANCH_COLORS = [
  '#3E63DD',
  '#E5484D',
  '#30A46C',
  '#F5A524',
  '#8E4EC6',
  '#0EA5B7',
  '#D6409F',
  '#7C8A9E',
];

export function mindMapSvg(analysis) {
  const topics = arr(analysis.topics).slice(0, 8);
  const W = 1600;
  const cx = W / 2;
  const left = [];
  const right = [];
  topics.forEach((t, i) =>
    (i % 2 === 0 ? right : left).push({ t, color: BRANCH_COLORS[i % BRANCH_COLORS.length] }),
  );
  const LEAF_H = 46;
  const TOPIC_GAP = 26;
  const blockH = (b) => Math.max(1, Math.min(arr(b.t.points).length, 4)) * LEAF_H;
  const colH = (col) =>
    col.reduce((s, b) => s + blockH(b), 0) + Math.max(0, col.length - 1) * TOPIC_GAP;
  const H = Math.max(520, Math.max(colH(left), colH(right)) + 80);
  const cy = H / 2;
  let svg = '';

  const drawSide = (col, dir) => {
    let y = cy - colH(col) / 2;
    const topicX = cx + dir * 330;
    const leafX = cx + dir * 560;
    for (const b of col) {
      const h = blockH(b);
      const ty = y + h / 2;
      svg += `<path d="M${cx + dir * 150},${cy} C${cx + dir * 240},${cy} ${topicX - dir * 120},${ty} ${topicX - dir * 105},${ty}" stroke="${b.color}" stroke-width="4" fill="none"/>`;
      const tl = wrapText(b.t.title, 22, 2);
      svg += `<rect x="${topicX - 105}" y="${ty - 32}" width="210" height="64" rx="14" fill="${b.color}"/>`;
      tl.forEach((line, i) => {
        svg += `<text x="${topicX}" y="${ty + (i - (tl.length - 1) / 2) * 22 + 7}" text-anchor="middle" class="mm-topic">${esc(line)}</text>`;
      });
      const pts = arr(b.t.points).slice(0, 4);
      pts.forEach((p, i) => {
        const ly = y + LEAF_H * i + LEAF_H / 2;
        const anchorX = topicX + dir * 105;
        svg += `<path d="M${anchorX},${ty} C${anchorX + dir * 50},${ty} ${leafX - dir * 70},${ly} ${leafX - dir * 10},${ly}" stroke="${b.color}" stroke-width="2" fill="none" opacity=".7"/>`;
        const ll = wrapText(p, 34, 2);
        ll.forEach((line, j) => {
          svg += `<text x="${leafX}" y="${ly + (j - (ll.length - 1) / 2) * 19 + 6}" text-anchor="${dir > 0 ? 'start' : 'end'}" class="mm-leaf">${esc(line)}</text>`;
        });
        svg += `<circle cx="${leafX - dir * 10}" cy="${ly}" r="4" fill="${b.color}"/>`;
      });
      y += h + TOPIC_GAP;
    }
  };
  drawSide(right, 1);
  drawSide(left, -1);
  const cl = wrapText(analysis.title || 'Suhbat', 18, 3);
  svg += `<ellipse cx="${cx}" cy="${cy}" rx="155" ry="${36 + cl.length * 14}" fill="#0B1B3F"/>`;
  cl.forEach((line, i) => {
    svg += `<text x="${cx}" y="${cy + (i - (cl.length - 1) / 2) * 26 + 8}" text-anchor="middle" class="mm-center">${esc(line)}</text>`;
  });
  return `<svg class="mindmap" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mind map">${svg}</svg>`;
}

// ---------- Slaydlar ----------
export function buildSlides(analysis, meeting) {
  const a = analysis;
  const slides = [];
  const participants = arr(a.participants);

  slides.push(`<section class="slide cover">
  <div class="cover-inner">
    <div class="kicker">Suhbat tahlili${filled(a.meeting_type) ? ' · ' + esc(a.meeting_type) : ''}</div>
    <h1>${esc(a.title || 'Suhbat')}</h1>
    ${filled(a.client) ? `<div class="client">${esc(a.client)}</div>` : ''}
    <div class="meta">
      <div><b>${esc(formatDate(meeting.createdAt))}</b><span>Sana</span></div>
      <div><b>${esc(formatDuration(meeting.durationMs))}</b><span>Davomiyligi</span></div>
      <div><b>${participants.length || '—'}</b><span>Ishtirokchi</span></div>
      <div><b>${arr(a.tasks).length}</b><span>Vazifa</span></div>
    </div>
  </div>
</section>`);

  slides.push(
    slide({
      kicker: 'Qisqacha',
      title: 'Suhbatdan nima anglashildi',
      body: `<p class="lead">${esc(a.executive_summary)}</p>
<ul class="takeaways">${arr(a.key_takeaways)
        .slice(0, 8)
        .map((t) => `<li>${esc(t)}</li>`)
        .join('')}</ul>`,
    }),
  );

  // Raqamlar paneli
  const counts = [
    ['Talablar', arr(a.requirements).length],
    ['Yuboriladigan narsalar', arr(a.deliverables).length],
    ['Ko‘rib chiqish', arr(a.reviews).length],
    ['Vazifalar', arr(a.tasks).length],
    ['Shoshilinch (P1)', arr(a.tasks).filter((t) => t.priority === 'P1').length],
    ['Qarorlar', arr(a.decisions).length],
    ['Ochiq savollar', arr(a.open_questions).length],
    ['Risklar', arr(a.risks).length],
  ];
  slides.push(
    slide({
      kicker: 'Umumiy ko‘rinish',
      title: 'Suhbat raqamlarda',
      body: `<div class="stats">${counts
        .map(
          ([l, n]) =>
            `<div class="stat${l.includes('P1') && n ? ' hot' : ''}"><b>${n}</b><span>${esc(l)}</span></div>`,
        )
        .join('')}</div>
${
  arr(a.key_numbers).length
    ? `<h3>Suhbatda aytilgan muhim raqamlar</h3><div class="numbers">${arr(a.key_numbers)
        .slice(0, 8)
        .map((n) => `<div><b>${esc(n.value)}</b><span>${esc(n.label)}</span></div>`)
        .join('')}</div>`
    : ''
}`,
    }),
  );

  if (participants.length) {
    const groups = {};
    for (const p of participants) (groups[p.side] ||= []).push(p);
    slides.push(
      slide({
        kicker: 'Kim qatnashdi',
        title: 'Ishtirokchilar',
        body: `<div class="cols">${Object.entries(groups)
          .map(
            ([s, list]) =>
              `<div class="col"><h3>${sidePill(s)}</h3>${list
                .map(
                  (p) =>
                    `<div class="person"><b>${esc(p.name)}</b><span>${esc(p.role)}</span></div>`,
                )
                .join('')}</div>`,
          )
          .join('')}</div>`,
      }),
    );
  }

  if (arr(a.topics).length) {
    slides.push(
      slide({ kicker: 'Mind map', title: 'Suhbat xaritasi', body: mindMapSvg(a), cls: 'wide' }),
    );
    slides.push(
      ...paged(
        arr(a.topics),
        4,
        (items) =>
          `<div class="grid2">${items
            .map(
              (t) =>
                `<div class="card"><div class="card-h"><b>${esc(t.title)}</b>${time(t.time)}</div><p>${esc(t.summary)}</p><ul>${arr(
                  t.points,
                )
                  .map((p) => `<li>${esc(p)}</li>`)
                  .join('')}</ul></div>`,
            )
            .join('')}</div>`,
        { kicker: 'Mavzular', title: 'Nimalar muhokama qilindi' },
      ),
    );
  }

  if (arr(a.requirements).length) {
    const reqs = [...arr(a.requirements)].sort((x, y) =>
      x.side === y.side ? byPriority(x, y) : x.side === 'mijoz' ? -1 : 1,
    );
    slides.push(
      ...paged(
        reqs,
        6,
        (items) =>
          `<table><thead><tr><th>Kimdan</th><th>Talab</th><th>Muhimlik</th></tr></thead><tbody>${items
            .map(
              (r) =>
                `<tr><td>${sidePill(r.side)}<div class="who">${esc(r.from)}</div></td><td><b>${esc(r.requirement)}</b>${
                  filled(r.details) ? `<div class="sub">${esc(r.details)}</div>` : ''
                }${time(r.time)}</td><td>${pri(r.priority)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        { kicker: 'Talablar', title: 'Kim tarafdan qanday talablar qo‘yildi' },
      ),
    );
  }

  if (arr(a.deliverables).length) {
    slides.push(
      ...paged(
        [...arr(a.deliverables)].sort(byPriority),
        6,
        (items) =>
          `<table><thead><tr><th>Kim</th><th></th><th>Kimga</th><th>Nimani yuboradi</th><th>Muddat</th></tr></thead><tbody>${items
            .map(
              (d) =>
                `<tr><td class="who-cell">${esc(d.from)}</td><td class="arrow">→</td><td class="who-cell">${esc(d.to)}</td><td><b>${esc(
                  d.item,
                )}</b> ${pri(d.priority)}${time(d.time)}</td><td class="nowrap">${esc(d.deadline)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        { kicker: 'Yuborish kerak', title: 'Kim nimani yuborishi kerak' },
      ),
    );
  }

  if (arr(a.reviews).length) {
    slides.push(
      ...paged(
        arr(a.reviews),
        7,
        (items) =>
          `<table><thead><tr><th>Kim</th><th>Nimani ko‘rib chiqadi / tasdiqlaydi</th><th>Muddat</th></tr></thead><tbody>${items
            .map(
              (r) =>
                `<tr><td class="who-cell">${esc(r.who)}</td><td><b>${esc(r.what)}</b>${time(r.time)}</td><td class="nowrap">${esc(r.deadline)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        { kicker: 'Ko‘rib chiqish', title: 'Kim nimani ko‘rib berishi kerak' },
      ),
    );
  }

  if (arr(a.tasks).length) {
    const tasks = [...arr(a.tasks)].sort(byPriority);
    slides.push(
      ...paged(
        tasks,
        5,
        (items, page) =>
          `<div class="tasks">${items
            .map(
              (t, i) => `<div class="task pri-border-${esc(t.priority)}">
  <div class="task-n">${page * 5 + i + 1}</div>
  <div class="task-main"><b>${esc(t.title)}</b>${filled(t.details) ? `<div class="sub">${esc(t.details)}</div>` : ''}</div>
  <div class="task-meta"><div>${pri(t.priority)}</div><div class="who">${esc(t.owner)} ${t.side ? sidePill(t.side) : ''}</div><div class="deadline">⏱ ${esc(
    t.deadline,
  )}</div></div>
</div>`,
            )
            .join('')}</div>`,
        { kicker: 'Vazifalar', title: 'Vazifalar — muhimlik bo‘yicha' },
      ),
    );

    // Odamlar kesimida
    const byOwner = {};
    for (const t of tasks) (byOwner[filled(t.owner) || 'Egasi belgilanmagan'] ||= []).push(t);
    const owners = Object.entries(byOwner);
    slides.push(
      ...paged(
        owners,
        4,
        (items) =>
          `<div class="grid2">${items
            .map(
              ([owner, list]) =>
                `<div class="card"><div class="card-h"><b>${esc(owner)}</b><span class="count">${list.length} ta</span></div><ul class="plain">${list
                  .map(
                    (t) =>
                      `<li>${pri(t.priority)} ${esc(t.title)}${filled(t.deadline) ? ` <span class="muted">· ${esc(t.deadline)}</span>` : ''}</li>`,
                  )
                  .join('')}</ul></div>`,
            )
            .join('')}</div>`,
        { kicker: 'Vazifalar', title: 'Kim nima qiladi' },
      ),
    );
  }

  if (arr(a.decisions).length) {
    slides.push(
      ...paged(
        arr(a.decisions),
        7,
        (items) =>
          `<ul class="rows">${items
            .map(
              (d) =>
                `<li><span class="pill st-${esc(d.status)}">${esc(STATUS_LABEL[d.status] || d.status)}</span> <span>${esc(d.decision)}</span>${time(d.time)}</li>`,
            )
            .join('')}</ul>`,
        { kicker: 'Qarorlar', title: 'Nimaga kelishildi' },
      ),
    );
  }

  if (arr(a.open_questions).length) {
    slides.push(
      ...paged(
        arr(a.open_questions),
        7,
        (items) =>
          `<table><thead><tr><th>Savol</th><th>Kim javob beradi</th></tr></thead><tbody>${items
            .map(
              (q) =>
                `<tr><td><b>${esc(q.question)}</b>${time(q.time)}</td><td class="who-cell">${esc(q.who_answers)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        { kicker: 'Ochiq savollar', title: 'Javob kutilayotgan savollar' },
      ),
    );
  }

  if (arr(a.risks).length) {
    slides.push(
      ...paged(
        arr(a.risks),
        5,
        (items) =>
          `<table><thead><tr><th>Risk</th><th>Ta’sir</th><th>Nima qilish kerak</th></tr></thead><tbody>${items
            .map(
              (r) =>
                `<tr><td><b>${esc(r.risk)}</b></td><td><span class="pill imp-${esc(r.impact)}">${esc(IMPACT_LABEL[r.impact] || r.impact)}</span></td><td>${esc(r.mitigation)}</td></tr>`,
            )
            .join('')}</tbody></table>`,
        { kicker: 'Risklar', title: 'Nimaga e’tibor berish kerak' },
      ),
    );
  }

  if (arr(a.roadmap).length) {
    const phases = arr(a.roadmap).slice(0, 6);
    slides.push(
      slide({
        kicker: 'Road map',
        title: 'Yo‘l xaritasi',
        cls: 'wide',
        body: `<div class="roadmap" style="--n:${phases.length}">${phases
          .map(
            (p, i) => `<div class="phase" style="--c:${BRANCH_COLORS[i % BRANCH_COLORS.length]}">
  <div class="phase-dot">${i + 1}</div>
  <div class="phase-time">${esc(p.timeframe)}</div>
  <div class="phase-card"><b>${esc(p.phase)}</b>
  ${arr(p.goals).length ? `<div class="goal">🎯 ${arr(p.goals).map(esc).join('; ')}</div>` : ''}
  <ul>${arr(p.items)
    .slice(0, 5)
    .map((it) => `<li>${esc(it)}</li>`)
    .join('')}</ul></div>
</div>`,
          )
          .join('')}</div>`,
      }),
    );
  }

  if (arr(a.next_steps).length) {
    slides.push(
      slide({
        kicker: 'Keyingi qadamlar',
        title: 'Endi nima qilamiz',
        body: `<ol class="steps">${arr(a.next_steps)
          .slice(0, 8)
          .map((s) => `<li>${esc(s)}</li>`)
          .join('')}</ol>`,
      }),
    );
  }

  return slides;
}

const CSS = `
:root{--ink:#0B1B3F;--muted:#5B6478;--line:#E3E7EF;--bg:#EEF1F6;--card:#F7F9FC;--accent:#3E63DD;
--p1:#E5484D;--p2:#F5A524;--p3:#30A46C}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:#0A0F1E;font-family:"Segoe UI",Inter,Roboto,"Helvetica Neue",Arial,sans-serif;color:var(--ink)}
.deck{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.slide{position:absolute;width:1280px;height:720px;background:#fff;padding:56px 72px 48px;display:none;flex-direction:column;border-radius:6px;box-shadow:0 20px 60px rgba(0,0,0,.4);transform-origin:center center;overflow:hidden}
.slide.active{display:flex}
.slide header{margin-bottom:22px}
.kicker{text-transform:uppercase;letter-spacing:.12em;font-size:14px;font-weight:700;color:var(--accent)}
h1{font-size:54px;line-height:1.1;margin:14px 0 10px}
h2{font-size:38px;line-height:1.15;margin:6px 0 0}
h3{font-size:18px;margin:22px 0 10px;color:var(--muted)}
.body{flex:1;min-height:0;font-size:19px;line-height:1.45}
.slide.wide{padding:40px 48px}
.fit{width:100%}
.slide.wide .body{display:flex;align-items:center;justify-content:center}
.slide.wide .fit{height:100%;display:flex;align-items:center;justify-content:center}
.cover{background:radial-gradient(circle at 85% 15%,#2B4AC7 0,#0B1B3F 55%);color:#fff;justify-content:center}
.cover .kicker{color:#9FB4FF}
.cover .client{font-size:26px;color:#C9D4FF}
.cover .meta{display:flex;gap:56px;margin-top:56px}
.cover .meta b{display:block;font-size:30px}.cover .meta span{color:#9FB4FF;font-size:15px;text-transform:uppercase;letter-spacing:.08em}
.lead{font-size:23px;line-height:1.5;margin:0 0 18px;color:#1D2B4F}
.takeaways{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:10px 28px}
.takeaways li{padding:10px 14px 10px 44px;background:var(--card);border-radius:10px;position:relative;font-size:17px}
.takeaways li:before{content:"✓";position:absolute;left:14px;top:9px;color:#fff;background:var(--accent);width:22px;height:22px;border-radius:50%;font-size:13px;display:flex;align-items:center;justify-content:center}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
.stat{background:var(--card);border-radius:14px;padding:20px 22px;border:1px solid var(--line)}
.stat b{display:block;font-size:44px;line-height:1}.stat span{color:var(--muted);font-size:16px}
.stat.hot{background:#FFF0F0;border-color:#FFCDCE}.stat.hot b{color:var(--p1)}
.numbers{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.numbers div{border-left:4px solid var(--accent);padding:6px 12px}.numbers b{display:block;font-size:22px}.numbers span{color:var(--muted);font-size:15px}
.cols{display:flex;gap:24px}.col{flex:1;background:var(--card);border-radius:14px;padding:6px 20px 16px}
.person{padding:8px 0;border-bottom:1px solid var(--line)}.person:last-child{border:0}.person b{display:block}.person span{color:var(--muted);font-size:16px}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;font-size:16px;line-height:1.4}
.card p{margin:6px 0;color:#2A3655}.card ul{margin:6px 0 0;padding-left:20px}
.card-h{display:flex;justify-content:space-between;gap:10px;align-items:baseline;font-size:18px}
ul.plain{list-style:none;padding:0}ul.plain li{padding:5px 0;border-bottom:1px dashed var(--line)}
table{width:100%;border-collapse:collapse;font-size:16px}
th{text-align:left;color:var(--muted);font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.06em;padding:6px 10px;border-bottom:2px solid var(--line)}
td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.who{color:var(--muted);font-size:14px;margin-top:3px}.who-cell{font-weight:600;white-space:nowrap}
.sub{color:var(--muted);font-size:14px;margin-top:3px}.muted{color:var(--muted)}
.arrow{color:var(--accent);font-weight:700;font-size:20px;width:20px}.nowrap{white-space:nowrap}
.pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 9px;border-radius:999px;white-space:nowrap;vertical-align:middle}
.pri-P1{background:#FFE5E5;color:#C62A2F}.pri-P2{background:#FFF3D6;color:#A16207}.pri-P3{background:#DDF6E7;color:#1B7F4B}
.side-biz{background:#E1E8FF;color:#2C4BC0}.side-mijoz{background:#FCE7F3;color:#B4237A}.side-hamkor{background:#E8F7FA;color:#0B7285}.side-nomalum{background:#EEF0F4;color:#5B6478}
.st-kelishildi{background:#DDF6E7;color:#1B7F4B}.st-taklif{background:#FFF3D6;color:#A16207}.st-ochiq{background:#EEF0F4;color:#5B6478}
.imp-yuqori{background:#FFE5E5;color:#C62A2F}.imp-orta{background:#FFF3D6;color:#A16207}.imp-past{background:#DDF6E7;color:#1B7F4B}
.time{font-size:12px;color:#8A93A8;margin-left:8px;font-variant-numeric:tabular-nums}
.tasks{display:flex;flex-direction:column;gap:10px}
.task{display:flex;gap:16px;align-items:center;background:var(--card);border-radius:12px;padding:10px 16px;border-left:6px solid #ccc}
.pri-border-P1{border-left-color:var(--p1)}.pri-border-P2{border-left-color:var(--p2)}.pri-border-P3{border-left-color:var(--p3)}
.task-n{font-weight:800;color:#AAB2C5;width:28px}.task-main{flex:1;font-size:17px}.task-meta{width:300px;font-size:14px;display:flex;flex-direction:column;gap:3px;align-items:flex-end;text-align:right}
.deadline{color:var(--muted)}
.rows{list-style:none;padding:0;margin:0}.rows li{padding:11px 0;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline}
.mindmap{width:100%;height:100%;max-height:600px}
.mm-topic{fill:#fff;font-size:18px;font-weight:700}.mm-leaf{fill:#1D2B4F;font-size:16px}.mm-center{fill:#fff;font-size:22px;font-weight:800}
.roadmap{display:grid;grid-template-columns:repeat(var(--n),1fr);gap:14px;width:100%;position:relative;padding-top:10px}
.roadmap:before{content:"";position:absolute;left:4%;right:4%;top:32px;height:4px;background:linear-gradient(90deg,#3E63DD,#30A46C)}
.phase{position:relative;display:flex;flex-direction:column;align-items:center}
.phase-dot{width:46px;height:46px;border-radius:50%;background:var(--c);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center;font-size:20px;z-index:1;border:4px solid #fff}
.phase-time{font-size:14px;font-weight:700;color:var(--c);margin:8px 0}
.phase-card{background:var(--card);border-top:4px solid var(--c);border-radius:10px;padding:12px 14px;font-size:14.5px;width:100%;line-height:1.35}
.phase-card b{font-size:16px}.phase-card ul{padding-left:18px;margin:6px 0 0}.goal{color:var(--muted);margin-top:6px;font-size:13.5px}
.steps{counter-reset:s;list-style:none;padding:0;margin:0;display:flex;flex-direction:column;gap:12px}
.steps li{counter-increment:s;position:relative;padding:12px 16px 12px 64px;background:var(--card);border-radius:12px;font-size:19px}
.steps li:before{content:counter(s);position:absolute;left:16px;top:9px;width:34px;height:34px;border-radius:50%;background:var(--accent);color:#fff;font-weight:800;display:flex;align-items:center;justify-content:center}
.count{color:var(--muted);font-size:14px}
.toolbar{position:fixed;right:16px;bottom:14px;display:flex;gap:8px;align-items:center;z-index:5}
.toolbar button,.toolbar a{background:rgba(255,255,255,.12);color:#fff;border:1px solid rgba(255,255,255,.2);border-radius:8px;padding:8px 12px;font-size:14px;cursor:pointer;text-decoration:none;font-family:inherit}
.toolbar button:hover,.toolbar a:hover{background:rgba(255,255,255,.22)}
.counter{color:#AEB6CC;font-size:14px;margin-right:6px;font-variant-numeric:tabular-nums}
.deck.grid{position:static;display:block;overflow:auto;padding:24px}
.deck.grid .slide{position:relative;display:flex;margin:0 auto 24px}
@media print{
  @page{size:1280px 720px;margin:0}
  html,body{background:#fff;height:auto}
  .slide:last-child{page-break-after:auto;break-after:auto}
  .toolbar{display:none}
  .deck{position:static;display:block}
  .slide{display:flex!important;position:relative;transform:none!important;box-shadow:none;border-radius:0;page-break-after:always;break-after:page;margin:0}
  *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
}`;

const SCRIPT = `
(function(){
  var deck=document.querySelector('.deck');
  var slides=[].slice.call(document.querySelectorAll('.slide'));
  var counter=document.querySelector('.counter');
  var i=Math.min(slides.length-1,Math.max(0,(parseInt(location.hash.slice(1),10)||1)-1));
  function fit(){
    var s=Math.min(window.innerWidth/1300,window.innerHeight/740);
    slides.forEach(function(el){el.style.transform=deck.classList.contains('grid')?'scale('+Math.min(1,window.innerWidth/1330)+')':'scale('+s+')';});
  }
  // Matn slaydga sig'masa, shu slayd ichidagi kontent kichraytiriladi (hech narsa kesilib qolmaydi).
  function fitContent(el){
    var body=el.querySelector('.body'), inner=el.querySelector('.fit');
    if(!body||!inner)return;
    var z=1; inner.style.zoom=1;
    while(body.scrollHeight>body.clientHeight+1&&z>0.5){z-=0.04;inner.style.zoom=z;}
  }
  function fitAll(){
    slides.forEach(function(el){var was=el.classList.contains('active');el.classList.add('active');fitContent(el);if(!was)el.classList.remove('active');});
  }
  function show(n){
    i=Math.max(0,Math.min(slides.length-1,n));
    slides.forEach(function(el,k){el.classList.toggle('active',k===i);});
    counter.textContent=(i+1)+' / '+slides.length;
    history.replaceState(null,'','#'+(i+1));
  }
  document.addEventListener('keydown',function(e){
    if(e.key==='ArrowRight'||e.key==='PageDown'||e.key===' '){e.preventDefault();show(i+1);}
    if(e.key==='ArrowLeft'||e.key==='PageUp'){e.preventDefault();show(i-1);}
    if(e.key==='Home')show(0); if(e.key==='End')show(slides.length-1);
    if(e.key==='f'||e.key==='F'){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();}
  });
  deck.addEventListener('click',function(e){ if(deck.classList.contains('grid'))return; if(e.target.closest('a,button'))return; show(e.clientX>window.innerWidth/2?i+1:i-1);});
  document.getElementById('prev').onclick=function(){show(i-1)};
  document.getElementById('next').onclick=function(){show(i+1)};
  document.getElementById('print').onclick=function(){window.print()};
  document.getElementById('full').onclick=function(){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();};
  document.getElementById('grid').onclick=function(){deck.classList.toggle('grid');fit();};
  window.addEventListener('resize',fit); fit(); fitAll(); show(i);
})();`;

export function renderPresentation(analysis, meeting) {
  const slides = buildSlides(analysis, meeting);
  return `<!doctype html>
<html lang="uz">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(analysis.title || 'Suhbat tahlili')}</title>
<style>${CSS}</style>
</head>
<body>
<main class="deck">
${slides.join('\n')}
</main>
<nav class="toolbar">
  <span class="counter"></span>
  <button id="prev" title="Oldingi (←)">←</button>
  <button id="next" title="Keyingi (→)">→</button>
  <button id="grid" title="Hamma slaydlar bir sahifada">Hammasi</button>
  <button id="full" title="To‘liq ekran (F)">To‘liq ekran</button>
  <button id="print" title="PDF sifatida saqlash">PDF / Chop etish</button>
  <a href="transcript.txt" target="_blank">Transkript</a>
  <a href="xulosa.md" target="_blank">Matn xulosa</a>
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
