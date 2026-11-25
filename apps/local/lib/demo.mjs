// Namuna ma'lumotlar: kalitlarsiz sinov rejimi (SUHBAT_DEMO=1) va «Namuna prezentatsiya» uchun.
// Bu yerda hech qanday haqiqiy mijoz ma'lumoti yo'q — to'qima misol.

const DEMO_LINES = [
  [
    'speaker_0',
    'Assalomu alaykum Jasur aka, vaqt ajratganingiz uchun rahmat. Bugun onlayn do‘kon loyihasini gaplashib olsak.',
  ],
  [
    'speaker_1',
    'Vaalaykum assalom. Ha, bizga sayt va mobil ilova kerak, yangi yil mavsumidan oldin ishga tushishi shart.',
  ],
  [
    'speaker_0',
    'Tushunarli. Mahsulotlar katalogi nechta pozitsiya bo‘ladi va to‘lov tizimlaridan qaysilari kerak?',
  ],
  [
    'speaker_1',
    'Taxminan uch ming mahsulot. Payme va Click bo‘lishi shart, keyinroq Uzum nasiya ham qo‘shamiz.',
  ],
  [
    'speaker_2',
    'Omborimiz 1C da yuritiladi, qoldiqlar sayt bilan avtomatik sinxron bo‘lishi kerak.',
  ],
  [
    'speaker_0',
    'Yaxshi, unda bizga 1C ga kirish huquqi va mahsulotlar bazasining eksporti kerak bo‘ladi. Qachon yubora olasizlar?',
  ],
  [
    'speaker_2',
    'Juma kunigacha Excel faylni yuboraman, kirish huquqini IT bo‘limi bilan gaplashib beraman.',
  ],
  [
    'speaker_0',
    'Biz esa payshanbagacha tijorat taklifi va bosqichma-bosqich rejani yuboramiz. Dizayn maketini Dilnoza tayyorlaydi.',
  ],
  [
    'speaker_1',
    'Byudjet bo‘yicha: birinchi bosqichga 180 million so‘mdan oshmasligi kerak. Shartnomani yuristimiz ko‘rib chiqadi.',
  ],
  [
    'speaker_0',
    'Kelishdik. Yetkazib berish xizmati bilan integratsiya masalasi ochiq qoldi, uni keyingi uchrashuvda hal qilamiz.',
  ],
];

export function demoWords(segmentIndex = 1) {
  const words = [];
  let t = 1;
  for (const [speaker, line] of DEMO_LINES) {
    for (const w of line.split(' ')) {
      words.push({ text: w, start: t, end: t + 0.35, speaker });
      t += 0.42;
    }
    t += 1.2;
  }
  return segmentIndex === 1 ? words : words.slice(0, 40);
}

export const DEMO_ANALYSIS = {
  title: 'Onlayn do‘kon loyihasi bo‘yicha mijoz bilan uchrashuv (NAMUNA)',
  client: 'Namuna Savdo MChJ',
  meeting_type: 'Mijoz bilan dastlabki uchrashuv',
  language: 'o‘zbek',
  executive_summary:
    'Mijoz yangi yil mavsumidan oldin onlayn do‘kon (sayt va mobil ilova) ishga tushirmoqchi. Asosiy talablar — 3000 ga yaqin mahsulotli katalog, Payme va Click to‘lovlari hamda 1C ombor bilan avtomatik sinxronizatsiya. Birinchi bosqich byudjeti 180 million so‘m bilan cheklangan. Yetkazib berish integratsiyasi masalasi ochiq qoldi.',
  key_takeaways: [
    'Muddat qat’iy: yangi yil mavsumidan oldin ishga tushishi shart',
    'Birinchi bosqich byudjeti — 180 mln so‘mdan oshmasligi kerak',
    '1C bilan qoldiqlar sinxronizatsiyasi — eng murakkab texnik qism',
    'Payme va Click birinchi bosqichda, Uzum nasiya keyinroq',
    'Shartnomani mijoz yuristi ko‘rib chiqadi — vaqt zaxirasi kerak',
    'Yetkazib berish integratsiyasi hali hal qilinmagan',
  ],
  participants: [
    { name: 'Sardor', side: 'biz', role: 'Loyiha menejeri', speaker_labels: ['Q1/S1'] },
    { name: 'Dilnoza', side: 'biz', role: 'Dizayner (suhbatda tilga olindi)', speaker_labels: [] },
    { name: 'Jasur aka', side: 'mijoz', role: 'Direktor', speaker_labels: ['Q1/S2'] },
    {
      name: 'Ombor mudiri',
      side: 'mijoz',
      role: 'Ombor va 1C uchun mas’ul',
      speaker_labels: ['Q1/S3'],
    },
  ],
  topics: [
    {
      title: 'Loyiha doirasi',
      summary: 'Sayt va mobil ilova, 3000 ga yaqin mahsulot.',
      points: ['Sayt + mobil ilova', '≈3000 mahsulot katalogi', 'Yangi yilgacha ishga tushirish'],
      time: '00:00:12',
    },
    {
      title: 'To‘lov tizimlari',
      summary: 'Payme va Click majburiy, Uzum nasiya ikkinchi bosqichda.',
      points: ['Payme — 1-bosqich', 'Click — 1-bosqich', 'Uzum nasiya — keyinroq'],
      time: '00:00:31',
    },
    {
      title: '1C integratsiyasi',
      summary: 'Ombor qoldiqlari sayt bilan avtomatik sinxron bo‘lishi kerak.',
      points: [
        'Qoldiqlar avtomatik sinxron',
        '1C ga kirish huquqi kerak',
        'Mahsulotlar bazasi eksporti',
      ],
      time: '00:00:44',
    },
    {
      title: 'Byudjet va shartnoma',
      summary: 'Birinchi bosqich 180 mln so‘m; shartnomani yurist ko‘radi.',
      points: [
        '1-bosqich ≤ 180 mln so‘m',
        'Tijorat taklifi payshanbagacha',
        'Yurist shartnomani ko‘radi',
      ],
      time: '00:01:15',
    },
    {
      title: 'Yetkazib berish',
      summary: 'Integratsiya masalasi keyingi uchrashuvga qoldirildi.',
      points: ['Xizmat tanlanmagan', 'Keyingi uchrashuvda hal qilinadi'],
      time: '00:01:28',
    },
  ],
  requirements: [
    {
      from: 'Jasur aka',
      side: 'mijoz',
      requirement: 'Yangi yil mavsumidan oldin ishga tushirish',
      details: 'Muddat qat’iy, kechikish mumkin emas',
      priority: 'P1',
      time: '00:00:14',
    },
    {
      from: 'Jasur aka',
      side: 'mijoz',
      requirement: 'Payme va Click orqali to‘lov',
      details: 'Uzum nasiya keyingi bosqichda',
      priority: 'P1',
      time: '00:00:33',
    },
    {
      from: 'Ombor mudiri',
      side: 'mijoz',
      requirement: '1C bilan qoldiqlarni avtomatik sinxronlash',
      details: '',
      priority: 'P1',
      time: '00:00:44',
    },
    {
      from: 'Jasur aka',
      side: 'mijoz',
      requirement: '1-bosqich byudjeti 180 mln so‘mdan oshmasin',
      details: '',
      priority: 'P2',
      time: '00:01:15',
    },
    {
      from: 'Sardor',
      side: 'biz',
      requirement: '1C ga kirish huquqi va mahsulotlar bazasi eksporti',
      details: 'Integratsiyani baholash uchun zarur',
      priority: 'P1',
      time: '00:00:55',
    },
  ],
  deliverables: [
    {
      from: 'Ombor mudiri',
      to: 'Sardor',
      item: 'Mahsulotlar bazasi (Excel eksport)',
      deadline: 'Juma',
      priority: 'P1',
      time: '00:01:02',
    },
    {
      from: 'Mijoz IT bo‘limi',
      to: 'Bizning jamoa',
      item: '1C ga kirish huquqi',
      deadline: 'Belgilanmagan',
      priority: 'P1',
      time: '00:01:05',
    },
    {
      from: 'Sardor',
      to: 'Jasur aka',
      item: 'Tijorat taklifi va bosqichma-bosqich reja',
      deadline: 'Payshanba',
      priority: 'P1',
      time: '00:01:09',
    },
    {
      from: 'Dilnoza',
      to: 'Jasur aka',
      item: 'Dizayn maketi',
      deadline: 'Belgilanmagan',
      priority: 'P2',
      time: '00:01:12',
    },
  ],
  reviews: [
    {
      who: 'Mijoz yuristi',
      what: 'Shartnoma loyihasini ko‘rib chiqish',
      deadline: 'Belgilanmagan',
      time: '00:01:19',
    },
    {
      who: 'Jasur aka',
      what: 'Tijorat taklifi va rejani tasdiqlash',
      deadline: 'Kelasi hafta boshi (taxminan)',
      time: '00:01:09',
    },
  ],
  tasks: [
    {
      title: 'Tijorat taklifi va bosqichli rejani tayyorlab yuborish',
      owner: 'Sardor',
      side: 'biz',
      priority: 'P1',
      deadline: 'Payshanba',
      details: 'Byudjet chegarasi 180 mln so‘mni hisobga olish',
      time: '00:01:09',
    },
    {
      title: 'Mahsulotlar bazasini Excel ko‘rinishida yuborish',
      owner: 'Ombor mudiri',
      side: 'mijoz',
      priority: 'P1',
      deadline: 'Juma',
      details: '',
      time: '00:01:02',
    },
    {
      title: '1C ga kirish huquqini olib berish',
      owner: 'Ombor mudiri',
      side: 'mijoz',
      priority: 'P1',
      deadline: 'Belgilanmagan',
      details: 'IT bo‘limi bilan kelishish kerak',
      time: '00:01:05',
    },
    {
      title: 'Dizayn maketini tayyorlash',
      owner: 'Dilnoza',
      side: 'biz',
      priority: 'P2',
      deadline: 'Belgilanmagan',
      details: '',
      time: '00:01:12',
    },
    {
      title: 'Yetkazib berish xizmatlari variantlarini o‘rganish',
      owner: 'Belgilanmagan',
      side: 'biz',
      priority: 'P2',
      deadline: 'Keyingi uchrashuvgacha',
      details: '',
      time: '00:01:28',
    },
    {
      title: 'Uzum nasiya integratsiyasi shartlarini aniqlash',
      owner: 'Belgilanmagan',
      side: 'biz',
      priority: 'P3',
      deadline: 'Belgilanmagan',
      details: 'Ikkinchi bosqich uchun',
      time: '00:00:36',
    },
  ],
  decisions: [
    {
      decision: 'Birinchi bosqichda Payme va Click ulanadi',
      status: 'kelishildi',
      time: '00:00:33',
    },
    {
      decision: 'Tijorat taklifi payshanbagacha yuboriladi',
      status: 'kelishildi',
      time: '00:01:09',
    },
    { decision: 'Uzum nasiya ikkinchi bosqichga qoldiriladi', status: 'taklif', time: '00:00:36' },
    { decision: 'Yetkazib berish integratsiyasi', status: 'ochiq', time: '00:01:28' },
  ],
  open_questions: [
    {
      question: 'Qaysi yetkazib berish xizmati bilan integratsiya qilinadi?',
      who_answers: 'Jasur aka',
      time: '00:01:28',
    },
    {
      question: '1C ning qaysi versiyasi va API bormi?',
      who_answers: 'Mijoz IT bo‘limi',
      time: '00:00:44',
    },
  ],
  risks: [
    {
      risk: 'Muddat qisqa — yangi yilgacha ulgurmaslik xavfi',
      impact: 'yuqori',
      mitigation:
        'MVP doirasini qat’iy belgilash, ilovani 2-bosqichga surish variantini taklif qilish',
    },
    {
      risk: '1C ga kirish kechiksa, integratsiya to‘xtab qoladi',
      impact: 'yuqori',
      mitigation: 'Kirish huquqi uchun aniq sana va mas’ulni belgilash',
    },
    {
      risk: 'Yurist tekshiruvi shartnomani kechiktirishi mumkin',
      impact: 'orta',
      mitigation: 'Shartnoma loyihasini taklif bilan birga yuborish',
    },
  ],
  key_numbers: [
    { label: '1-bosqich byudjeti (yuqori chegara)', value: '180 mln so‘m' },
    { label: 'Mahsulotlar soni', value: '≈ 3 000' },
    { label: 'Ishga tushirish', value: 'Yangi yilgacha' },
  ],
  roadmap: [
    {
      phase: 'Tayyorgarlik',
      timeframe: '1-hafta',
      goals: ['Doira va narxni kelishish'],
      items: ['Tijorat taklifi', 'Ma’lumotlar bazasini olish', '1C kirish huquqi'],
    },
    {
      phase: 'Dizayn va shartnoma',
      timeframe: '2–3-hafta',
      goals: ['Maket tasdiqlanadi'],
      items: ['Dizayn maketi', 'Shartnoma imzolash'],
    },
    {
      phase: 'Ishlab chiqish',
      timeframe: '4–9-hafta',
      goals: ['Sayt ishlaydi'],
      items: ['Katalog', 'Payme/Click', '1C sinxronizatsiya'],
    },
    {
      phase: 'Ishga tushirish',
      timeframe: 'Yangi yil oldidan',
      goals: ['Savdo boshlanadi'],
      items: ['Test', 'Xodimlarni o‘qitish', 'Ishga tushirish'],
    },
  ],
  next_steps: [
    'Payshanbagacha tijorat taklifi va rejani yuborish (Sardor)',
    'Jumagacha mahsulotlar bazasini olish (Ombor mudiri)',
    '1C kirish huquqi bo‘yicha mas’ul va sanani aniqlash',
    'Keyingi uchrashuv sanasini belgilash — yetkazib berish masalasi',
  ],
};
