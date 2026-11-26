// SUHBAT Lokal — sahifa mantig'i: Start → yozib olish → Stop → tahlil → prezentatsiya.
const $ = (id) => document.getElementById(id);

// Har 20 daqiqada yangi mustaqil audio fayl. (?segmentSeconds=N — faqat sinov uchun qisqartirish.)
const SEGMENT_MS =
  (Number(new URLSearchParams(location.search).get('segmentSeconds')) || 20 * 60) * 1000;
const TIMESLICE_MS = 5000; // har 5 soniyada diskka saqlash
const VIEWS = ['idle', 'rec', 'proc', 'ready', 'fail'];

let settings = null;
let meetings = [];
let currentId = null; // ekranda ko'rsatilayotgan suhbat
let pollTimer = null;

function show(view) {
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== view;
}

function banner(text, { error = false, action = null } = {}) {
  const el = $('banner');
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.className = `banner${error ? ' error' : ''}`;
  el.textContent = text;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.onclick = action.onClick;
    el.append(b);
  }
}

async function api(path, { method = 'GET', json, body, headers } = {}) {
  const res = await fetch(path, {
    method,
    headers: json ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: json ? JSON.stringify(json) : body,
  });
  const data = await res.json().catch(() => ({}));
  // Server rejimida sessiya tugasa — kirish sahifasiga (yozuv paytida emas: yozuvni uzib qo'ymaslik uchun).
  if (res.status === 401 && !rec.active) {
    location.reload();
    await new Promise(() => {});
  }
  if (!res.ok)
    throw Object.assign(new Error(data.error || `Xato ${res.status}`), { status: res.status });
  return data;
}

const fmtClock = (ms) => {
  const s = Math.floor(ms / 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
};
const fmtDuration = (ms) => {
  if (ms > 0 && ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} soniya`;
  const min = Math.round(ms / 60000);
  const h = Math.floor(min / 60);
  return h ? `${h} soat ${min % 60} daqiqa` : `${min} daqiqa`;
};
const fmtDate = (iso) =>
  new Date(iso).toLocaleString('uz-UZ', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

// ---------------------------------------------------------------- Yozib olish
const rec = {
  active: false,
  paused: false,
  meetingId: null,
  stream: null,
  recorder: null,
  mime: '',
  segIndex: 0,
  segStartMs: 0,
  accumulatedMs: 0, // pauzalarsiz yozilgan vaqt
  resumedAt: 0,
  rotateTimer: null,
  tickTimer: null,
  queue: Promise.resolve(),
  pending: 0,
  uploadFailing: false,
  wakeLock: null,
  audioCtx: null,
  analyser: null,
  silentSince: 0,
  stopping: false,
};

const elapsedMs = () =>
  rec.accumulatedMs + (rec.paused || !rec.resumedAt ? 0 : performance.now() - rec.resumedAt);

function pickMime() {
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return options.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
}

// Parchalar serverga qat'iy ketma-ket yuboriladi; xato bo'lsa, muvaffaqiyatgacha qayta uriniladi.
function enqueue(task) {
  rec.pending++;
  rec.queue = rec.queue.then(async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await task();
        if (rec.uploadFailing) {
          rec.uploadFailing = false;
          banner(null);
        }
        break;
      } catch (err) {
        const retryable =
          !err.status || err.status >= 500 || err.status === 408 || err.status === 401;
        if (!retryable) {
          console.error('Parcha rad etildi', err);
          break;
        }
        rec.uploadFailing = true;
        if (err.status === 401) {
          banner(
            'Sessiya tugagan. Yozuv davom etmoqda — boshqa tabda saytga qayta kiring, audio o‘zi yuboriladi.',
            { error: true },
          );
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        banner(
          settings?.serverMode
            ? 'Internet uzildi. Yozuv davom etmoqda, audio shu kompyuter xotirasida turibdi — internet qaytishi bilan yuboriladi. Sahifani YOPMANG.'
            : 'Audio diskka saqlanmayapti — dastur oynasi (qora oyna) yopilgan bo‘lishi mumkin. Qayta urinilmoqda…',
          { error: true },
        );
        await new Promise((r) => setTimeout(r, Math.min(1000 * 2 ** attempt, 10000)));
      }
    }
    rec.pending--;
  });
  return rec.queue;
}

function startSegment() {
  rec.segIndex++;
  let seq = 0; // shu bo'lak ichidagi parcha tartib raqami
  rec.segStartMs = Math.round(elapsedMs());
  const seg = rec.segIndex;
  const startMs = rec.segStartMs;
  const meetingId = rec.meetingId;
  const recorder = new MediaRecorder(
    rec.stream,
    rec.mime ? { mimeType: rec.mime, audioBitsPerSecond: 48000 } : {},
  );
  recorder.ondataavailable = (e) => {
    if (!e.data || !e.data.size) return;
    const n = seq++;
    const t = Math.round(elapsedMs());
    const type = (e.data.type || rec.mime || 'audio/webm').split(';')[0];
    enqueue(() =>
      api(`/api/meetings/${meetingId}/chunk?seg=${seg}&seq=${n}&startMs=${startMs}&t=${t}`, {
        method: 'POST',
        body: e.data,
        headers: { 'Content-Type': type },
      }),
    );
  };
  recorder.onstop = () => {
    enqueue(() => api(`/api/meetings/${meetingId}/segment-done?seg=${seg}`, { method: 'POST' }));
  };
  recorder.onerror = (e) => console.error('MediaRecorder xatosi', e.error || e);
  recorder.start(TIMESLICE_MS);
  rec.recorder = recorder;
  clearTimeout(rec.rotateTimer);
  rec.rotateTimer = setTimeout(rotateSegment, SEGMENT_MS);
}

// Eski bo'lakni yopib, shu zahoti yangisini boshlaydi (oradagi uzilish — millisoniyalar).
function rotateSegment() {
  if (!rec.active || rec.stopping) return;
  if (rec.paused) {
    rec.rotateTimer = setTimeout(rotateSegment, 30000);
    return;
  }
  const old = rec.recorder;
  startSegment();
  if (old.state !== 'inactive') old.stop();
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      rec.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    // ixtiyoriy imkoniyat
  }
}

function startMeter() {
  try {
    rec.audioCtx = new AudioContext();
    const src = rec.audioCtx.createMediaStreamSource(rec.stream);
    rec.analyser = rec.audioCtx.createAnalyser();
    rec.analyser.fftSize = 1024;
    src.connect(rec.analyser);
  } catch {
    rec.analyser = null;
  }
}

function tick() {
  if (!rec.active) return;
  $('timer').textContent = fmtClock(elapsedMs());
  if (rec.analyser && !rec.paused) {
    const buf = new Float32Array(rec.analyser.fftSize);
    rec.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
    $('meter-bar').style.width = `${Math.round(level * 100)}%`;
    $('btn-stop').style.setProperty('--level', level.toFixed(2));
    const now = performance.now();
    if (level > 0.01) {
      if (rec.silentSince && !rec.uploadFailing) banner(null);
      rec.silentSince = 0;
    } else if (!rec.silentSince) rec.silentSince = now;
    else if (now - rec.silentSince > 45000 && !rec.uploadFailing) {
      banner('Mikrofondan ovoz kelmayapti. Mikrofon o‘chirilmaganini tekshiring.', { error: true });
    }
  }
}

async function getStream() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: true,
    },
  });
}

function watchTrack() {
  const track = rec.stream.getAudioTracks()[0];
  if (!track) return;
  track.onended = async () => {
    if (!rec.active || rec.stopping) return;
    // Mikrofon uzildi (masalan, quloqchin chiqarildi) — boshqa mikrofon bilan davom etamiz.
    banner('Mikrofon uzildi — qayta ulanilmoqda…', { error: true });
    try {
      const old = rec.recorder;
      rec.stream = await getStream();
      watchTrack();
      rec.audioCtx?.close().catch(() => {});
      startMeter();
      startSegment();
      if (old.state !== 'inactive') old.stop();
      else
        enqueue(() =>
          api(`/api/meetings/${rec.meetingId}/segment-done?seg=${rec.segIndex - 1}`, {
            method: 'POST',
          }),
        );
      banner(null);
    } catch {
      // Yozuv to'xtadi: soatni ham to'xtatamiz, shunda davomiylik haqiqiy yozilgan vaqtga teng bo'ladi.
      rec.accumulatedMs = elapsedMs();
      rec.paused = true;
      rec.micLost = true;
      setPausedUi(true);
      $('rec-label').textContent = 'Mikrofon uzildi — yozilmayapti';
      $('btn-pause').hidden = true;
      banner(
        'Mikrofon topilmadi. Shu paytgacha yozilgan qism saqlangan — STOP bosib tahlil qilishingiz mumkin.',
        { error: true },
      );
    }
  };
}

async function startRecording() {
  if (rec.active) return;
  const btn = $('btn-start');
  btn.disabled = true;
  try {
    if (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        'Bu brauzer ovoz yozishni qo‘llab-quvvatlamaydi. Google Chrome yoki Microsoft Edge’dan foydalaning.',
      );
    }
    try {
      rec.stream = await getStream();
    } catch (err) {
      if (err.name === 'NotAllowedError')
        throw new Error(
          'Mikrofonga ruxsat berilmadi. Manzil satridagi qulf belgisini bosib, mikrofonga ruxsat bering.',
        );
      if (err.name === 'NotFoundError')
        throw new Error('Mikrofon topilmadi. Mikrofon ulanganini tekshiring.');
      throw err;
    }
    const { meeting } = await api('/api/meetings', { method: 'POST', json: {} });
    Object.assign(rec, {
      active: true,
      paused: false,
      stopping: false,
      meetingId: meeting.id,
      mime: pickMime(),
      segIndex: 0,
      accumulatedMs: 0,
      resumedAt: performance.now(),
      queue: Promise.resolve(),
      pending: 0,
      uploadFailing: false,
      silentSince: 0,
      micLost: false,
    });
    $('btn-pause').hidden = false;
    currentId = meeting.id;
    watchTrack();
    startMeter();
    startSegment();
    acquireWakeLock();
    rec.tickTimer = setInterval(tick, 100);
    setPausedUi(false);
    $('timer').textContent = '00:00:00';
    banner(null);
    show('rec');
  } catch (err) {
    rec.stream?.getTracks().forEach((t) => t.stop());
    banner(err.message || String(err), { error: true });
  } finally {
    btn.disabled = false;
  }
}

function setPausedUi(paused) {
  document.querySelector('.rec-status').classList.toggle('paused', paused);
  $('rec-label').textContent = paused ? 'Pauza — yozilmayapti' : 'Yozib olinmoqda';
  $('btn-pause').textContent = paused ? '▶ Davom ettirish' : '⏸ Pauza';
}

function togglePause() {
  if (!rec.active || rec.stopping || rec.micLost) return;
  if (!rec.paused) {
    rec.accumulatedMs = elapsedMs();
    rec.paused = true;
    if (rec.recorder.state === 'recording') rec.recorder.pause();
    $('meter-bar').style.width = '0%';
  } else {
    rec.paused = false;
    rec.resumedAt = performance.now();
    if (rec.recorder.state === 'paused') rec.recorder.resume();
    rec.silentSince = 0;
  }
  setPausedUi(rec.paused);
}

async function stopRecording() {
  if (!rec.active || rec.stopping) return;
  if (!window.confirm('Suhbatni tugatib, tahlilni boshlaymizmi?')) return;
  rec.stopping = true;
  const durationMs = Math.round(elapsedMs());
  rec.accumulatedMs = durationMs;
  rec.paused = true;
  clearTimeout(rec.rotateTimer);
  clearInterval(rec.tickTimer);
  $('proc-stage').textContent = 'Audio saqlanmoqda…';
  show('proc');

  const recorder = rec.recorder;
  if (recorder.state !== 'inactive') {
    const stopped = new Promise((resolve) =>
      recorder.addEventListener('stop', resolve, { once: true }),
    );
    recorder.stop();
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 4000))]);
  }
  rec.stream.getTracks().forEach((t) => t.stop());
  rec.audioCtx?.close().catch(() => {});
  rec.wakeLock?.release().catch(() => {});
  while (rec.pending > 0) await rec.queue; // hamma parchalar diskka yozilishini kutamiz
  rec.active = false;
  banner(null);
  try {
    await api(`/api/meetings/${rec.meetingId}/finish`, { method: 'POST', json: { durationMs } });
  } catch (err) {
    banner(err.message, { error: true });
  }
  watch(rec.meetingId);
}

document.addEventListener('visibilitychange', () => {
  if (rec.active && document.visibilityState === 'visible') acquireWakeLock();
});
window.addEventListener('beforeunload', (e) => {
  if (rec.active) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------------------------------------------------------------- Holatni kuzatish
function renderMeeting(m) {
  if (rec.active) return;
  currentId = m.id;
  if (m.status === 'processing') {
    $('proc-stage').textContent = m.stage || 'Navbatda…';
    show('proc');
  } else if (m.status === 'ready') {
    $('ready-title').textContent = m.title || 'Tahlil tayyor';
    const c = m.counts;
    $('ready-meta').textContent = [
      fmtDuration(m.durationMs),
      c ? `${c.tasks} ta vazifa` : '',
      c && c.p1 ? `${c.p1} tasi shoshilinch` : '',
    ]
      .filter(Boolean)
      .join(' · ');
    $('btn-open').href = `/m/${m.id}/presentation.html`;
    $('lnk-md').href = `/m/${m.id}/xulosa.md`;
    $('lnk-tr').href = `/m/${m.id}/transcript.txt`;
    show('ready');
  } else if (m.status === 'failed' || m.status === 'interrupted' || m.status === 'recording') {
    const interrupted = m.status !== 'failed';
    $('fail-title').textContent = interrupted ? 'Yozuv uzilib qolgan' : 'Tahlil tugallanmadi';
    $('fail-text').textContent = interrupted
      ? `Saqlangan qism: ${fmtDuration(m.durationMs)}. Shu qismni tahlil qilish mumkin.`
      : m.error || 'Noma’lum xato';
    $('btn-retry').textContent = interrupted ? 'Saqlangan qismni tahlil qilish' : 'Qayta urinish';
    $('btn-retry').dataset.mode = interrupted ? 'finish' : 'retry';
    show('fail');
  }
}

function watch(id) {
  clearInterval(pollTimer);
  currentId = id;
  const poll = async () => {
    try {
      const { meeting } = await api(`/api/meetings/${id}`);
      if (currentId !== id) return;
      renderMeeting(meeting);
      if (meeting.status !== 'processing') {
        clearInterval(pollTimer);
        refresh();
      }
    } catch (err) {
      if (err.status === 404) clearInterval(pollTimer);
    }
  };
  poll();
  pollTimer = setInterval(poll, 2000);
}

function goHome() {
  clearInterval(pollTimer);
  currentId = null;
  show('idle');
  refresh();
}

async function refresh() {
  try {
    const state = await api('/api/state');
    settings = state.settings;
    meetings = state.meetings;
  } catch {
    banner('Dastur bilan aloqa yo‘q. Dastur oynasini (qora oyna) qayta ishga tushiring.', {
      error: true,
    });
    return;
  }
  $('btn-logout').hidden = !settings.serverMode;
  if (settings.serverMode)
    $('rec-note').textContent =
      'Audio har 5 soniyada serverga yuborilmoqda. Bu sahifani yopmang va kompyuterni uxlatmang.';
  $('history-count').textContent = meetings.length ? `(${meetings.length})` : '';
  renderHistory();
  if (!rec.active && !rec.uploadFailing) {
    if (settings.demo) banner('Sinov rejimi: haqiqiy tahlil o‘rniga namuna ma’lumot ko‘rsatiladi.');
    else if (!settings.hasAnthropic || !settings.hasStt) {
      banner('Tahlil ishlashi uchun API kalitlarini bir marta kiriting.', {
        action: { label: 'Kiritish', onClick: openSettings },
      });
    } else if ($('banner').className === 'banner') banner(null);
  }
}

const STATUS_LABEL = {
  ready: 'Tayyor',
  processing: 'Tahlil qilinmoqda',
  failed: 'Xato',
  interrupted: 'Uzilgan',
  recording: 'Uzilgan',
};

function renderHistory() {
  const list = $('history-list');
  list.textContent = '';
  if (!meetings.length) {
    const d = document.createElement('div');
    d.className = 'empty';
    d.textContent = 'Hali suhbat yozilmagan.';
    list.append(d);
    return;
  }
  for (const m of meetings) {
    if (rec.active && m.id === rec.meetingId) continue;
    const item = document.createElement('div');
    item.className = 'item';
    const title = document.createElement('div');
    title.className = 'item-title';
    title.textContent = m.title || (m.source === 'upload' ? m.note || 'Yuklangan fayl' : 'Suhbat');
    const tag = document.createElement('span');
    tag.className = `tag ${m.status}`;
    tag.textContent = STATUS_LABEL[m.status] || m.status;
    title.append(tag);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${fmtDate(m.createdAt)}${m.durationMs ? ' · ' + fmtDuration(m.durationMs) : ''}`;
    const actions = document.createElement('div');
    actions.className = 'item-actions';
    const link = (label, href) => {
      const a = document.createElement('a');
      a.className = 'ghost';
      a.textContent = label;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      return a;
    };
    const button = (label, onClick) => {
      const b = document.createElement('button');
      b.className = 'ghost';
      b.type = 'button';
      b.textContent = label;
      b.onclick = onClick;
      return b;
    };
    if (m.status === 'ready') {
      actions.append(
        link('Prezentatsiya', `/m/${m.id}/presentation.html`),
        link('Xulosa', `/m/${m.id}/xulosa.md`),
        link('Transkript', `/m/${m.id}/transcript.txt`),
      );
    } else {
      actions.append(
        button('Ochish', () => {
          $('history').hidden = true;
          if (m.status === 'processing') watch(m.id);
          else renderMeeting(m);
        }),
      );
    }
    (m.audio || []).forEach((a, i, all) =>
      actions.append(
        link(all.length > 1 ? `Audio ${i + 1}` : 'Audio', `/m/${m.id}/audio/${a.file}`),
      ),
    );
    if (m.status !== 'processing') {
      actions.append(
        button('O‘chirish', async () => {
          if (!window.confirm('Bu suhbat (audio va tahlil) butunlay o‘chirilsinmi?')) return;
          await api(`/api/meetings/${m.id}`, { method: 'DELETE' }).catch((e) =>
            banner(e.message, { error: true }),
          );
          if (currentId === m.id) goHome();
          else refresh();
        }),
      );
    }
    item.append(title, meta, actions);
    list.append(item);
  }
}

// ---------------------------------------------------------------- Sozlamalar
function openSettings() {
  const f = $('settings-form');
  f.elevenlabsApiKey.value = '';
  f.voicelabApiKey.value = '';
  f.anthropicApiKey.value = '';
  f.sttProvider.value = settings?.sttProvider || '';
  f.voicelabApiKey.placeholder = settings?.hasVoicelab
    ? 'Saqlangan ✓ (o‘zgartirish uchun yangisini kiriting)'
    : 'vlk_…';
  f.elevenlabsApiKey.placeholder = settings?.hasElevenlabs
    ? 'Saqlangan ✓ (o‘zgartirish uchun yangisini kiriting)'
    : 'sk_…';
  f.anthropicApiKey.placeholder = settings?.hasAnthropic
    ? 'Saqlangan ✓ (o‘zgartirish uchun yangisini kiriting)'
    : 'sk-ant-…';
  f.companyName.value = settings?.companyName || '';
  f.teamMembers.value = settings?.teamMembers || '';
  f.language.value = settings?.language || 'uzb';
  $('check-result').hidden = true;
  if (settings?.serverMode)
    $('keys-hint').textContent =
      'Kalitlar serverda saqlanadi va brauzerga hech qachon qaytarilmaydi. Bir marta kiritiladi.';
  $('settings-save').textContent = 'Saqlash va tekshirish';
  $('data-dir').textContent = settings
    ? `Yozuvlar va tahlillar shu papkada saqlanadi: ${settings.dataDir}`
    : '';
  $('settings').showModal();
}

function setCheck(id, label, result) {
  const el = $(id);
  el.className = result ? (result.ok ? 'ok' : 'bad') : 'wait';
  el.textContent = result
    ? `${result.ok ? '✓' : '✕'} ${label}: ${result.message}`
    : `… ${label}: tekshirilmoqda`;
}

$('settings-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const save = $('settings-save');
  save.disabled = true;
  try {
    await api('/api/settings', {
      method: 'POST',
      json: {
        elevenlabsApiKey: f.elevenlabsApiKey.value,
        voicelabApiKey: f.voicelabApiKey.value,
        sttProvider: f.sttProvider.value,
        anthropicApiKey: f.anthropicApiKey.value,
        companyName: f.companyName.value,
        teamMembers: f.teamMembers.value,
        language: f.language.value,
      },
    });
    f.elevenlabsApiKey.value = '';
    f.voicelabApiKey.value = '';
    f.anthropicApiKey.value = '';
    await refresh();
    // Kalitlar haqiqatan ishlashini shu yerning o'zida ko'rsatamiz.
    $('check-result').hidden = false;
    setCheck('check-eleven', 'Transkripsiya', null);
    setCheck('check-claude', 'Claude (tahlil)', null);
    const result = await api('/api/check', { method: 'POST' });
    setCheck(
      'check-eleven',
      `${result.stt.provider || 'Transkripsiya'} (transkripsiya)`,
      result.stt,
    );
    setCheck('check-claude', 'Claude (tahlil)', result.anthropic);
    if (result.stt.ok && result.anthropic.ok) {
      save.textContent = 'Hammasi tayyor ✓';
      setTimeout(() => $('settings').close(), 1500);
    }
  } catch (err) {
    $('check-result').hidden = false;
    setCheck('check-eleven', 'Xato', { ok: false, message: err.message });
    $('check-claude').textContent = '';
  } finally {
    save.disabled = false;
  }
});
$('settings-cancel').onclick = () => $('settings').close();

// ---------------------------------------------------------------- Fayl yuklash
function audioDurationMs(file) {
  return new Promise((resolve) => {
    const a = new Audio();
    const done = (ms) => {
      URL.revokeObjectURL(a.src);
      resolve(ms);
    };
    a.preload = 'metadata';
    a.onloadedmetadata = () =>
      done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0);
    a.onerror = () => done(0);
    setTimeout(() => done(0), 5000);
    a.src = URL.createObjectURL(file);
  });
}

$('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file || rec.active) return;
  $('history').hidden = true;
  $('proc-stage').textContent = 'Fayl yuklanmoqda…';
  show('proc');
  try {
    const durationMs = await audioDurationMs(file);
    const { meeting } = await api(
      `/api/upload?name=${encodeURIComponent(file.name)}&durationMs=${durationMs}`,
      {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
    );
    watch(meeting.id);
  } catch (err) {
    show('idle');
    banner(err.message, { error: true });
  }
});

// ---------------------------------------------------------------- Tugmalar
$('btn-start').onclick = startRecording;
$('btn-stop').onclick = stopRecording;
$('btn-pause').onclick = togglePause;
$('btn-new').onclick = goHome;
$('btn-new2').onclick = goHome;
$('btn-settings').onclick = openSettings;
$('btn-logout').onclick = async () => {
  if (rec.active) return;
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  location.reload();
};
$('btn-history').onclick = () => {
  $('history').hidden = !$('history').hidden;
  if (!$('history').hidden) refresh();
};
document.querySelector('[data-close="history"]').onclick = () => ($('history').hidden = true);
$('btn-retry').onclick = async () => {
  const id = currentId;
  if (!id) return;
  const mode = $('btn-retry').dataset.mode === 'finish' ? 'finish' : 'retry';
  try {
    await api(`/api/meetings/${id}/${mode}`, { method: 'POST', json: {} });
    watch(id);
  } catch (err) {
    banner(err.message, { error: true });
  }
};

// Sahifa ochilganda: tahlil ketayotgan suhbat bo'lsa, o'shani ko'rsatamiz.
await refresh();
const inFlight = meetings.find((m) => m.status === 'processing');
const cutOff = meetings.find((m) => m.status === 'recording' || m.status === 'interrupted');
if (inFlight) watch(inFlight.id);
else if (cutOff) renderMeeting(cutOff);
else show('idle');
