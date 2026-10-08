/**
 * All user-facing strings for the recorder, in one place.
 *
 * Two rules for anything added here:
 * 1. **Plain language only.** No chunk numbers, job names, HTTP status codes, or storage vocabulary in
 *    the primary UI. The user should never have to know what a worker queue is.
 * 2. **Never claim success.** If the backend has not confirmed a step, the copy says what is actually
 *    happening ("saqlanmoqda" / "yuklanmoqda") rather than a percentage or a green tick.
 */

export const copy = {
  brand: 'SUHBAT',
  tagline: 'Suhbat xotirasi',

  idle: {
    start: 'Suhbatni boshlash',
    hint: 'Yozishni boshlash uchun mikrofonni bosing',
    settings: 'Sozlamalar',
  },

  recording: {
    title: 'Suhbat yozilmoqda',
    pause: 'Pauza',
    resume: 'Davom ettirish',
    stop: 'To‘xtatish',
    stopping: 'To‘xtatilmoqda…',
    mic: 'Microfon',
    system: 'System audio',
  },

  paused: {
    title: 'PAUSED',
  },

  after: {
    saving: 'Audio saqlanmoqda…',
    uploading: 'Yuklanmoqda…',
    transcribing: 'Transkripsiya qilinmoqda…',
    analyzing: 'Tahlil qilinmoqda…',
    ready: 'Suhbat tayyor',
    viewResult: 'Natijani ko‘rish',
    newMeeting: 'Yangi suhbat',
    failed: 'Suhbat saqlandi. Tahlil vaqtincha bajarilmadi.',
    duration: 'Davomiylik',
  },

  errors: {
    microphoneDenied: 'Microfon ruxsati kerak',
    microphoneDeniedDetail:
      'SUHBAT suhbatni yozib olishi uchun mikrofon ruxsati kerak. Tizim sozlamalaridan ruxsat bering.',
    systemAudioUnavailable: 'System audio yozilmayapti',
    systemAudioUnavailableDetail:
      'Tizim ovozi manbai topilmadi. Suhbat faqat mikrofondan yoziladi — bu xatolik emas.',
    offline: 'Internet yo‘q. Suhbat qurilmada xavfsiz saqlandi.',
    uploadRetry: 'Yuklash davom ettiriladi',
    pipelineFailed: 'Suhbat saqlandi. Tahlil vaqtincha bajarilmadi.',
    deviceLost: 'Mikrofon uzilib qoldi',
    diskFull: 'Diskda joy yetarli emas',
    persistenceFailed: 'Audio saqlashda muammo',
    recorderUnavailable: 'Yozish uchun SUHBAT Recorder ilovasini oching.',
    sessionExpired: 'Sessiya muddati tugagan. Iltimos, qayta kiring.',
    reauth: 'Qayta kirish',
    reauthDetail:
      'Sessiya yangilanmadi. Suhbat qurilmada saqlangan va yuklash davom etadi — faqat qayta kiring.',
    notConfigured:
      'SUHBAT xizmatiga ulanish sozlanmagan. Yordam uchun administratorga murojaat qiling.',
    generic: 'Nimadir xato ketdi. Iltimos, qayta urinib ko‘ring.',
  },

  auth: {
    title: 'SUHBAT ga kiring',
    body: 'Bir marta kiring — keyingi suhbatlar avtomatik saqlanadi.',
    createCode: 'Kod olish',
    creating: 'Kod olinmoqda…',
    openBrowser: 'Brauzerda tasdiqlash',
    waiting: 'Brauzerda tasdiqlashingiz kutilmoqda…',
    codeLabel: 'Bir martalik kod',
    approved: 'Tasdiqlandi. Ilova tayyorlanmoqda…',
    signOut: 'Chiqish',
    signOutConfirm: 'Bu qurilmadan chiqish',
  },

  consent: {
    title: 'Suhbat yoziladi',
    body: 'SUHBAT mikrofon va kompyuter tizim ovozini shu qurilmaga yozadi. Suhbat ishtirokchilariga yozib olinayotganini ayting.',
    checkbox: 'Tushundim, ishtirokchilarga aytaman',
    accept: 'Davom etish',
  },

  close: {
    title: 'Suhbat hali yozilmoqda',
    body: 'Yozib olishni to‘xtatib, suhbatni saqlashni xohlaysizmi? Yozuv qurilmada qoladi.',
    stopAndSave: 'To‘xtatish va saqlash',
    cancel: 'Bekor qilish',
  },

  recovery: {
    title: 'Oldingi suhbat topildi',
    body: 'Ilova kutilmaganda yopilgan. Yozuv qurilmada saqlangan va yuklab yuborilishi mumkin.',
    upload: 'Yuklab yuborish',
    discardLater: 'Keyinroq',
  },

  settings: {
    title: 'Sozlamalar',
    workspace: 'Ish maydoni',
    microphone: 'Mikrofon',
    systemAudio: 'Tizim ovozi',
    systemAudioToggle: 'Tizim ovozini ham yozish',
    signedInAs: 'Kirgan',
    signOut: 'Chiqish',
    close: 'Yopish',
    version: 'Versiya',
    localOnlyNote:
      'Yozuvlar avval shu qurilmaga yoziladi, keyin serverga yuboriladi. Internet bo‘lmasa ham yozish davom etadi.',
  },
} as const;

/** `Suhbat — 8 Oct, 14:32`, built from the local clock so it matches what the user saw on the button. */
export function temporaryMeetingTitle(at: Date): string {
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ] as const;
  const day = at.getDate();
  const month = months[at.getMonth()] ?? 'Jan';
  const hours = String(at.getHours()).padStart(2, '0');
  const minutes = String(at.getMinutes()).padStart(2, '0');
  return `Suhbat — ${day} ${month}, ${hours}:${minutes}`;
}
