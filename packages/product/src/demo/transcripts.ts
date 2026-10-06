import type { LanguageCode, TranscriptSegment } from '../domain';
import { person } from './ids';

/**
 * Authored demo transcripts.
 *
 * A line is `[speaker, text, language?]`. Timestamps are **derived**, not hand-written: each line is placed
 * proportionally across the meeting's duration and given a speech length from its word count. That keeps
 * `startMs < endMs < next startMs` true by construction (the property that makes evidence ranges and the
 * transcript list coherent) while letting the corpus be written like a conversation.
 *
 * Text is deliberately mixed Uzbek / Russian / English, as the real corpus is.
 */

export type AuthoredLine = [personId: string, text: string, language?: LanguageCode];

export function segmentIdFor(slug: string, index: number): string {
  return `seg_${slug}_${String(index).padStart(3, '0')}`;
}

const SPEECH_MS_PER_WORD = 335;
const LINE_GAP_MS = 650;
const MIN_SPEECH_MS = 1_400;
const MAX_SPEECH_MS = 15_000;

function speechMs(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.min(Math.max(words * SPEECH_MS_PER_WORD + LINE_GAP_MS, MIN_SPEECH_MS), MAX_SPEECH_MS);
}

export function buildTranscript(
  meetingId: string,
  slug: string,
  durationMs: number,
  speakerLabels: Record<string, string>,
  lines: AuthoredLine[],
): TranscriptSegment[] {
  if (lines.length === 0) return [];
  const slot = Math.floor(durationMs / lines.length);
  return lines.map((line, index) => {
    const [speakerPersonId, text, language = 'uz'] = line;
    const startMs = index * slot;
    const speech = Math.min(speechMs(text), Math.max(slot - 200, 800));
    return {
      id: segmentIdFor(slug, index),
      meetingId,
      index,
      speakerPersonId,
      speakerLabel: speakerLabels[speakerPersonId] ?? `Speaker ${index + 1}`,
      startMs,
      endMs: startMs + speech,
      text,
      language,
      topicId: null,
      // Real ASR reports confidence; a fixture that invented one would teach the UI to display a
      // number nobody produced.
    };
  });
}

/** Line index ranges used by the analysis fixtures, so `evidence()` below stays readable. */
export const transcriptLines = {
  fooderaMarketing: [
    [
      person.elmurod,
      'Bo‘laymiz. Bugungi maqsad bitta — sentyabr metrikalarini ko‘rib, oktabr byudjetini tasdiqlash va kim nima olishini aniq yozib qo‘yish.',
      'uz',
    ],
    [
      person.dilshod,
      'Qisqacha: sentyabrda 4 120 ta lead keldi, ularning 57 foizi kvalifikatsiyadan o‘tdi. Bizning maqsad 70 foizdan yuqori edi.',
      'uz',
    ],
    [
      person.aziz,
      'Ru — сводка по неделям: week 1 — 54%, week 2 — 56%, week 3 — 58%, week 4 — 61%. Тренд положительный, но до цели не дотягиваем.',
      'ru',
    ],
    [
      person.akmal,
      'Мнение: проблема не в объёме трафика, а в качестве формы. Мы просим телефон, имя, адрес и комментарий — это четыре шага.',
      'ru',
    ],
    [
      person.dilshod,
      'Kelishdimiz — forma uzun. Lekin forma qisqarsa leadlar kamayadi, sifat oshadi degan kafolat yo‘q. Men savdo jamoasidan eshitganman: ular qo‘ng‘iroq soniga qaraydi.',
      'uz',
    ],
    [
      person.elmurod,
      'Aniqrog‘i: hozirgi targetni kengaytirishdan oldin sales funnel’ni tekshirishimiz kerak. Aks holda pulni yomon sarflaymiz.',
      'uz',
    ],
    [
      person.aziz,
      'Воронка по шагам: клик → форма → звонок менеджера → квалификация. Потеря на шаге «форма → звонок» — 41%. Это и есть дыра.',
      'ru',
    ],
    [person.malika, 'Извините, уточню: 41% — это по всем каналам или только Meta?', 'ru'],
    [
      person.aziz,
      'По Meta — 44%, по Google — 37%, по органике — 29%. То есть paid-канал мы теряем сильнее всего.',
      'ru',
    ],
    [
      person.akmal,
      'Targetni kengaytirmasdan avval 3 narsani qilamiz: formani 3 ta maydonga qisqartirish, kvalifikatsiya savolini qo‘shish, va 24 soat ichida qo‘ng‘iroq qilish qoidasi.',
      'uz',
    ],
    [
      person.dilshod,
      'Согласен на сокращение формы, но дайте нам неделю на тест, иначе отдел продаж не успеет перестроиться.',
      'ru',
    ],
    [
      person.nigora,
      'Qo‘ng‘iroq qilish bo‘yicha: hozir 6 ta menejer bor, ular kuniga o‘rtacha 70 ta lead oladi. 24 soat — real, lekin ish vaqti chegarasi kerak.',
      'uz',
    ],
    [
      person.elmurod,
      'Ok — 24 hours from the moment the lead is captured, business hours only, and we say that in the SLA. Akmal, write it down.',
      'en',
    ],
    [person.akmal, 'Yozib qo‘yyapman. Deadline — juma, 9-oktabrgacha yangi forma ishlaydi.', 'uz'],
    [
      person.aziz,
      'Endi про креативы: UGC-ролики дают CTR 2.4%, студийные — 1.6%. Но стоимость квалифицированного лида у UGC выше на 18%.',
      'ru',
    ],
    [
      person.dilshod,
      'Потому что UGC приводит молодую аудиторию, а они не заказывают. Это не креатив виноват, это аудитория.',
      'ru',
    ],
    [
      person.akmal,
      'To‘g‘ri. Shuning uchun Advantage+ ni hozircha o‘chirib turamiz — u yoshroq auditoriyani ko‘paytirdi.',
      'uz',
    ],
    [
      person.aziz,
      'Частота показа за 28 дней — 4.2. Это усталость. Нужна ротация креативов каждые 10 дней.',
      'ru',
    ],
    [
      person.nigora,
      'Kreativlar soni: hozir 9 ta ishlayapti, 10 kunda almashtirish uchun kamida 6 tasi tayyor bo‘lishi kerak. Bu jarayon bizda yo‘q.',
      'uz',
    ],
    [
      person.elmurod,
      'Unday bo‘lsa decision: creative pipeline’ni ichida qilamiz — oyiga 12 ta UGC, 4 ta studio. Aziz, buni o‘lchab ber.',
      'en',
    ],
    [
      person.aziz,
      'Посчитаю по CPL и по доходу на лид, отдам в понедельник. Данные по доходу возьму из amoCRM, они там с 1 октября.',
      'ru',
    ],
    [
      person.rustam,
      'По amoCRM: сейчас воронка из 11 стадий, менеджеры заполняют только три. Нужно сократить до шести и добавить обязательное поле «источник лида».',
      'ru',
    ],
    [
      person.dilshod,
      'Bu o‘zgarishlar 6 kishilik jamaga tushadi — ular allaqachon band. Menga bir hafta vaqt bering.',
      'uz',
    ],
    [
      person.elmurod,
      'Kelishdik: CRM qisqartirishini keyingi sprintga qoldiramiz, ammo maydon nomi va majburiylik talabini hozirdan yozamiz.',
      'uz',
    ],
    [
      person.akmal,
      'Audience: hozir Tashkent bo‘ylab 3–5 km radius va 18–45 yosh. Kengaytirish bo‘yicha taklif — Yunusobod va Chilonzorni alohida g‘uruchga ajratish.',
      'uz',
    ],
    [
      person.aziz,
      'Про гео: Yunusabad даёт CPL 34 000, Chilonzor — 41 000, центр — 29 000. Центр дороже, но конверсия в заказ 18% против 12%.',
      'ru',
    ],
    [
      person.nigora,
      'Demak radiusni kichraytirsak ham bo‘ladi — lekin buyurtma soni kamayadi. Foodera uchun hajm muhim, ular restoranchiklarga ham sotishi kerak.',
      'uz',
    ],
    [
      person.dilshod,
      'Вот это ключевой риск: если мы сузим таргет, у нас упадёт количество заказов, а владелец хочет объём.',
      'ru',
    ],
    [
      person.elmurod,
      'Shu sababli decision: oktabrda byudjet oshmaydi, $5 000 o‘zgarishsiz qoladi. Kengaytirish emas, sifat bilan ishlaymiz.',
      'uz',
    ],
    [
      person.akmal,
      'Qo‘shimcha: $800 ni test sifatida Google PMax’ga ajratamiz — Meta’ga bog‘liqlikni kamaytirish uchun. Bu byudjet ichida.',
      'en',
    ],
    [
      person.aziz,
      'Важная оговорка: атрибуция GA4 и amoCRM расходятся на 21%. Пока не разберёмся, цифры по доходу — ориентировочные.',
      'ru',
    ],
    [
      person.dilshod,
      'Open question — qaysi tizim bizning asosiy hisobimiz bo‘ladi? Hozir ikkala jamoa boshqa-boshqa raqam aytayapti.',
      'uz',
    ],
    [
      person.akmal,
      'Qoida: moliyaviy hisob uchun amoCRM, media rejasi uchun GA4. Aziz ikki hafta ichida ayirboshash jadvalini tayyorlaydi.',
      'uz',
    ],
    [
      person.rustam,
      'По лид-скорингу: предлагаю три вопроса в форме — «сколько курьеров», «работаете ли с агрегаторами», «средний чек». Это и есть квалификация.',
      'ru',
    ],
    [
      person.nigora,
      'Uchinchi savol menejerlarni qo‘rqitadi — mijozlar “nafas” ni yozmaydi. Ikki savol bilan boshlaylik.',
      'uz',
    ],
    [
      person.elmurod,
      "Decision: ikkita savol — kur'yer soni va agregatordan foydalanish. Uchinchi savolni keyingi testda qo‘shamiz.",
      'uz',
    ],
    [
      person.aziz,
      'Тогда нужно зафиксировать, что считается квалифицированным лидом. Иначе через неделю снова будет три версии.',
      'ru',
    ],
    [
      person.akmal,
      'Yozamiz: qualified = 3+ kuryer, kamida 1 agregator bilan ishlaydi, oylik buyurtma hajmi 500+... yo‘q, bu judu qattiq. Kelishamiz: 3+ kuryer AND ishlaydi yoki ishlaydi agregator bilan.',
      'uz',
    ],
    [
      person.dilshod,
      'Оставим порог по заказам — 300 заказов в месяц. Иначе мы отсекаем малые точки, которые нам выгодны маржой.',
      'ru',
    ],
    [
      person.elmurod,
      'Qabul qilindi: 3+ kuryer, agregator bilan ishlash, oyiga 300+ buyurtma. Uchala shart ham CRM’da maydon bo‘ladi.',
      'uz',
    ],
    [
      person.akmal,
      'Kreativ bo‘yicha action: 6 ta UGC sentyabr statistikasiga asoslangan holda qayta yoziladi, 15-oktabrgacha.',
      'uz',
    ],
    [
      person.nigora,
      'Qo‘shimcha taklif — eski mijozlarni qaytarish uchun WhatsApp oqimi. Bu lead sotib olishdan arzonroq.',
      'uz',
    ],
    [
      person.aziz,
      'Идея хорошая, но нужны цифры: у нас 12 400 «спящих» клиентов. Если 3% вернутся при чеке 96 000 — это 35 млн сумов.',
      'ru',
    ],
    [
      person.elmurod,
      'Idea statusini «considering» deb yozamiz, Akmal haftalik review’da javob beradi. Decision emas.',
      'en',
    ],
    [
      person.dilshod,
      'Ещё возражение: мы не сможем вручную переносить лиды из формы в CRM. Если интеграции нет, всё умрёт.',
      'ru',
    ],
    [
      person.rustam,
      'Интеграция формы с amoCRM — это два дня работы, я сделаю. Но нужен доступ к их API-ключу.',
      'ru',
    ],
    [
      person.akmal,
      'Rustamga CRM’ga ulash bo‘yicha access beriladi; Dilshod shuni juma kuniga qadar tayyorlaydi.',
      'uz',
    ],
    [
      person.elmurod,
      'Xulosa qilib: oktabr byudjeti $5 000, sifat ustida ishlaymiz, kengaytirmaymiz. Kvalifikatsiya qoidasi yuqoridagidek.',
      'uz',
    ],
    [
      person.aziz,
      'И недельный ритм: каждый понедельник в 9:30 разбор лид-скора и CPL, 25 минут.',
      'ru',
    ],
    [
      person.nigora,
      'Kelishdik — dushanba 09:30. Men ham qatshaman, chunki mijoz taraf statistikasini olib kelaman.',
      'uz',
    ],
    [
      person.dilshod,
      'Последнее: отчёт владельцу я покажу в пятницу, но цифры по доходу — с пометкой, что атрибуция не сверена.',
      'ru',
    ],
    [
      person.elmurod,
      'To‘g‘ri. Hujjatga shuni yozamiz: daromad bo‘yicha raqamlar taxminiy, manba amoCRM.',
      'uz',
    ],
    [
      person.akmal,
      'Keyingi qadamlar: forma — Aziz, kreativ — Malika bilan kelishamiz, CRM — Rustam, hisobot — Dilshod.',
      'uz',
    ],
    [
      person.malika,
      'Я могу взять на себя только согласование креативов, но не съёмки. Съёмки — на стороне Foodera.',
      'ru',
    ],
    [person.elmurod, 'Aniqlashtirdik: su‘rat olish Dilshod tomonida, brief va talab bizda.', 'uz'],
    [
      person.aziz,
      'Зафиксирую сроки: форма — 9 октября, креативы — 15 октября, интеграция — 9 октября, отчёт — 10 октября.',
      'ru',
    ],
    [
      person.dilshod,
      'Хорошо. И дайте нам доступ к дашборду лид-скора — иначе я буду спорить с цифрами, которых не вижу.',
      'ru',
    ],
    [
      person.akmal,
      'Qilamiz: dashboard’ga read-only access, Dilshod va Nigora uchun. Keyingi uchrashuvda ko‘rsatamiz.',
      'uz',
    ],
    [
      person.elmurod,
      'Yakun: bugun 6 ta decision, 6 ta action, 1 ta ochiq savol. Hisobotni ertaga ko‘ramiz.',
      'uz',
    ],
  ] as AuthoredLine[],
  fooderaCrmSync: [
    [
      person.rustam,
      'Начнём с воронки. Сейчас 11 стадий, фактически используются три — «новый», «в работе», «отказ».',
      'ru',
    ],
    [
      person.akmal,
      'Qisqartirish bo‘yicha taklif: 6 ta bosqich — New, Qualified, Demo, Proposal, Won, Lost.',
      'uz',
    ],
    [
      person.rustam,
      'Согласен. Обязательные поля: «источник лида», «число курьеров», «агрегатор», «сумма отказа».',
      'ru',
    ],
    [
      person.dilshod,
      'Сумма отказа — это чтобы менеджеры не закрывали лиды без причины. Понял, добавлю в регламент.',
      'ru',
    ],
    [
      person.nigora,
      '24 soat qoidasi CRM’da avtomatik bo‘lishi kerak: SLA belgisi va keyin qizil rang.',
      'uz',
    ],
    [
      person.rustam,
      'Это автозадача по времени — сделаю за два дня, если дам права на редактирование полей.',
      'ru',
    ],
    [
      person.aziz,
      'Ещё вопрос: куда пишем историю переноса старых лидов? Их 8 600, дедупликация не сделана.',
      'ru',
    ],
    [
      person.akmal,
      'Eski leadlarni import qilishni 21-oktabrgacha qildiramiz; tozalash mezonini Aziz yozadi.',
      'uz',
    ],
    [
      person.rustam,
      'Правило дедупликации: по телефону и по названию компании, приоритет у последней активной сделки.',
      'ru',
    ],
    [
      person.dilshod,
      'Менеджеры просят мобильное приложение. Без него они не будут заполнять поля в поле — в прямом смысле.',
      'ru',
    ],
    [
      person.nigora,
      'Mobil ilova amoCRM’da bor, lekin rus tilida. Mijozlar ro‘yxati o‘zbek tilida bo‘lsa yaxshi bo‘lardi.',
      'uz',
    ],
    [
      person.akmal,
      'Decision: standart rus interfeysi bilan ishlaymiz, lekin maydon nomlarini o‘zbekcha etiketkalar bilan to‘g‘rilaymiz.',
      'uz',
    ],
    [
      person.rustam,
      'Тогда я подготовлю CSV-шаблон полей до понедельника, а Акмаль согласует его с Dilshod.',
      'ru',
    ],
    [
      person.aziz,
      'И измерим эффект: доля лидов с заполненным «источником» — цель 95% к концу месяца.',
      'ru',
    ],
  ] as AuthoredLine[],
  nomadPipeline: [
    [
      person.alexey,
      'Коллеги, по осени: нам нужно 240 заказов на обучение, сейчас в воронке 610 лидов.',
      'ru',
    ],
    [
      person.akmal,
      'Kelishdik — hozir konversiya 18%. Maqsadga yetish uchun 1 330 ta lead kerak yoki konversiyani 26% ga ko‘tarish.',
      'uz',
    ],
    [
      person.alexey,
      'Второе реалистичнее. Что мешает? Главный блок — цена и расписание, а не количество заявок.',
      'ru',
    ],
    [
      person.aziz,
      'Проверил: 34% заявок бросают анкету на шаге оплаты. Это не про цену, это про трение.',
      'ru',
    ],
    [
      person.malika,
      'Speaker C — это кто? У меня в записи три голоса, третьего я не опознал.',
      'ru',
    ],
    [
      person.akmal,
      'Hali mapping qilinmagan — uchinchi ovoz Product team’dan bo‘lishi mumkin, keyin aniqlaymiz.',
      'uz',
    ],
    [
      person.alexey,
      'Предложение: два слота по субботам и рассрочка на три платежа. Это закрывает обе жалобы.',
      'ru',
    ],
    [
      person.aziz,
      'Тогда нужно посчитать юнит-экономику рассрочки — иначе мы потеряем маржу незаметно.',
      'ru',
    ],
    [
      person.akmal,
      'Decision: uchta qo‘shimcha slotni tasdiqlaymiz, рассрочка bo‘yicha hisob-kitob tayyor bo‘lgach ikkinchi qaror.',
      'uz',
    ],
    [
      person.alexey,
      'И ещё: мы прекращаем показ рекламы в 22:00, потому что лиды ночные и некачественные.',
      'ru',
    ],
    [
      person.nigora,
      'Kechqurun 22:00 dan keyin lead sifatining pasayishi bizda ham bor — ular ertaga javob bermaydi.',
      'uz',
    ],
    [
      person.aziz,
      'Замерю по часам к среде: доля ответов в течение часа, доля дошедших до оплаты.',
      'ru',
    ],
    [
      person.malika,
      'Плюс нужна статистика по преподавателям — родители спрашивают, кто ведёт группу.',
      'ru',
    ],
    [
      person.akmal,
      'Action: o‘qituvchi profillarini landing sahifasiga qo‘yamiz, juma kunigacha.',
      'uz',
    ],
  ] as AuthoredLine[],
  chirchikExport: [
    [
      person.malika,
      'По экспорту: первые две партии готовы, но сертификаты на партию 2 ещё не выданы.',
      'ru',
    ],
    [
      person.akmal,
      'Sertifikat muddati — qachon? Mijoz (Almaty) shu hujjatsiz to‘lov qilmaydi.',
      'uz',
    ],
    [person.malika, 'Ожидаем 14 дней. Если не успеем, отгружаем только партию 1.', 'ru'],
    [
      person.aziz,
      'Цена: $6.40 за метр с доставкой до Алматы. Покупатель просит $6.05 при объёме 12 000 метров.',
      'ru',
    ],
    [
      person.elmurod,
      'Kelishuv: narx 6.20$ + transport hisobidan, lekin hajm 15 000 metr bo‘lsa.',
      'uz',
    ],
    [
      person.malika,
      'Тогда нужна предоплата 30% — иначе мы не запускаем ткань в производство.',
      'ru',
    ],
    [
      person.akmal,
      'Decision: 30% oldindan to‘lov, qolgan qismi yetkazib berishdan keyin 10 kun.',
      'uz',
    ],
    [person.aziz, 'Есть незакрытый вопрос: кто платит за сертификацию — мы или покупатель?', 'ru'],
    [person.malika, 'Раньше платили мы, это 1.8 млн сумов на партию. Надо заложить в цену.', 'ru'],
    [
      person.elmurod,
      'Keyingi uchrashuvgacha biz hisoblab chiqamiz. Hozircha qaror qabul qilmaymiz.',
      'uz',
    ],
    [person.akmal, 'Action: logistics taklifini 2-oktabrgacha olamiz, Aziz buni oladi.', 'uz'],
    [
      person.malika,
      'И нам нужен шаблон коммерческого предложения — мы каждый раз пишем вручную.',
      'ru',
    ],
  ] as AuthoredLine[],
  boardQ4: [
    [
      person.elmurod,
      'Q4 maqsadi: ARR $180K, uchta aktiv mijoz, va desktop recorder’ning barqaror versiyasi.',
      'uz',
    ],
    [
      person.akmal,
      'Hozirgi holat: 5 ta pilot, 3 tasi pull-to-pay bosqichida. Chirchik va Nomad — to‘lovga yaqin.',
      'uz',
    ],
    [
      person.aziz,
      'Product metrics: недельное удержание команд — 62%, среднее число встреч на workspace — 11.',
      'ru',
    ],
    [
      person.elmurod,
      'Decision: enterprise funksiyalarini keyingi yilga qoldiramiz; hozir kursor — kichik jamoalar.',
      'uz',
    ],
    [
      person.akmal,
      'Hiring: growth engineer bitta, Rust systems engineer bitta — shu ikkisi Q4 ichida.',
      'uz',
    ],
    [
      person.aziz,
      'По найму: рынок медленный, цикл 8 недель. Если не закроем Rust к 1 декабря, сдвигаем срок Windows-бэкэнда.',
      'ru',
    ],
    [
      person.elmurod,
      'Kelishdik: Rust bo‘lmasa Windows’ni keyingi chorakka, lekin macOS capture’ni to‘xtatmaymiz.',
      'uz',
    ],
    [
      person.akmal,
      'Qo‘shimcha: pricing test — $39 o‘rniga $45/seat. Buni pilot mijoza’lar bilan sinab ko‘ramiz.',
      'uz',
    ],
    [
      person.aziz,
      'Нужна осторожность: пилоты могут уйти из-за повышения цены. Предлагаю только для новых клиентов.',
      'ru',
    ],
    [
      person.elmurod,
      'Decision: yangi mijozlarga $45, mavjud pilotlarga eskicha narx saqlanadi.',
      'uz',
    ],
    [person.malika, 'Board deck — 20-noyabrga, men yig‘aman, Elmurod tahrir qiladi.', 'ru'],
    [person.akmal, 'Action: q4 roadmap hujjatini juma kunigacha tayyorlayman.', 'uz'],
  ] as AuthoredLine[],
  fooderaCreative: [
    [
      person.akmal,
      'Kreativ review: 6 ta yangi UGC skripti, 3 ta studio varianti. Qaysi biri birinchi chiqadi?',
      'uz',
    ],
    [person.malika, 'Я бы поставила два с курьером в кадре — у них самый высокий досмотр.', 'ru'],
    [
      person.dilshod,
      'Согласен, но дайте один ролик с текстом на узбекском — у нас 60% аудитории читает, а не слушает.',
      'ru',
    ],
    [
      person.nigora,
      'Skriptdagi narx taklifi endi eshitilmoqda — lekin bizning promo kodi tugagan. Buni tuzatish kerak.',
      'uz',
    ],
    [
      person.akmal,
      'Decision: promo kodi bo‘lmagan variantlar bilan launch qilamiz; kodli versiya — keyingi partiyada.',
      'uz',
    ],
    [
      person.aziz,
      'Замер: у старых роликов CTR 2.4% при частоте 4.2. Новая партия должна удержать CTR выше 2.2 при частоте ниже 3.',
      'ru',
    ],
    [
      person.dilshod,
      'Open question: сколько роликов считается «достаточным набором» для ротации — 6 или 12?',
      'ru',
    ],
    [
      person.akmal,
      'Bu savolga javobni analytics’dan olamiz: frequency 3 ga yetganda qaysi kreativ tirik qoladi — shu asos bo‘ladi.',
      'uz',
    ],
    [
      person.malika,
      'И нужно решить, кто снимает — мы или подрядчик. Подрядчик дороже на 40%, но быстрее.',
      'ru',
    ],
    [
      person.elmurod,
      'Kelishuv: 12 tagacha — chunki 10 kunlik rotatsiyaga yetarli. Ijrochi — ichki jamoa, kontsept bo‘yicha bir marta tashqi yordam olamiz.',
      'uz',
    ],
    [person.nigora, 'To‘g‘rimi — 12 ta kreativ, 15-oktabrgacha?', 'uz'],
    [person.akmal, 'Ha. Va brief’ta sifat metrikasi ham bo‘ladi: CPL, emas ko‘rinish soni.', 'uz'],
    [
      person.dilshod,
      'Возражение по срокам: 15 октября — это пять рабочих дней. Если съёмка сдвинется, вы хотите, чтобы я перенёс запуск?',
      'ru',
    ],
    [
      person.akmal,
      'Qisqa javob: ha, lekin birinchi 6 tasini 15 oktabrga, qolganlariga 22 oktabr.',
      'uz',
    ],
    [
      person.elmurod,
      'Qayd etildi. Ochiq savol — ikkinchi partiya uchun byudjet ajratilganmi?',
      'uz',
    ],
    [
      person.dilshod,
      'По бюджету: у нас осталось 900 долларов на продакшн до конца месяца, этого хватит на шесть роликов.',
      'ru',
    ],
  ] as AuthoredLine[],
} satisfies Record<string, AuthoredLine[]>;

export const meetingSlugs = {
  fooderaMarketing: 'foodera_marketing',
  fooderaCrmSync: 'foodera_crm_sync',
  nomadPipeline: 'nomad_pipeline',
  chirchikExport: 'chirchik_export',
  boardQ4: 'board_q4',
  fooderaCreative: 'foodera_creative',
} as const;

export const speakerLabels: Record<string, Record<string, string>> = {
  fooderaMarketing: {
    [person.elmurod]: 'Speaker A',
    [person.dilshod]: 'Speaker B',
    [person.aziz]: 'Speaker C',
    [person.akmal]: 'Speaker D',
    [person.nigora]: 'Speaker E',
    [person.rustam]: 'Speaker F',
    [person.malika]: 'Speaker G',
  },
  fooderaCrmSync: {
    [person.rustam]: 'Speaker A',
    [person.akmal]: 'Speaker B',
    [person.nigora]: 'Speaker C',
    [person.dilshod]: 'Speaker D',
    [person.aziz]: 'Speaker E',
  },
  nomadPipeline: {
    [person.alexey]: 'Speaker A',
    [person.akmal]: 'Speaker B',
    [person.aziz]: 'Speaker C',
    [person.malika]: 'Speaker D',
    [person.nigora]: 'Speaker E',
  },
  chirchikExport: {
    [person.malika]: 'Speaker A',
    [person.akmal]: 'Speaker B',
    [person.aziz]: 'Speaker C',
    [person.elmurod]: 'Speaker D',
  },
  boardQ4: {
    [person.elmurod]: 'Speaker A',
    [person.akmal]: 'Speaker B',
    [person.aziz]: 'Speaker C',
    [person.malika]: 'Speaker D',
  },
  fooderaCreative: {
    [person.akmal]: 'Speaker A',
    [person.malika]: 'Speaker B',
    [person.dilshod]: 'Speaker C',
    [person.nigora]: 'Speaker D',
    [person.aziz]: 'Speaker E',
    [person.elmurod]: 'Speaker F',
  },
};
