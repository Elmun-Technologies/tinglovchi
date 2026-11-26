# CLAUDE.md — tinglovchi / SUHBAT

## Loyiha
`apps/local` — SUHBAT: suhbatni mikrofon orqali yozadi → transkript (STT) → Claude tahlili → prezentatsiya. Node (ESM), bog'liqlik minimal, ma'lumot fayllarda.

## Buyruqlar
- `cd apps/local && npm ci && npm test` (node --test, ~1 daqiqa)
- Formatlash: `npx prettier --write apps/local`

## Arxitektura
- `lib/pipeline.mjs` — bo'laklar → STT → tahlil. `lib/stt.mjs` — provayder tanlash (`sttConfig`), ElevenLabs Scribe. `lib/voicelab.mjs` — VoiceLab STT (asinxron: POST /v1/stt → polling).
- Ikkala STT ham `{language, words:[{text,start,end(sek),speaker:'speaker_N'}]}` qaytaradi.
- `lib/store.mjs` — sozlamalar (`sozlamalar.json`, 0600) va suhbatlar.

## Qarorlar
- STT provayder: `sttProvider` = ''(avto: VoiceLab kaliti bo'lsa VoiceLab) | voicelab | elevenlabs. Sabab: ElevenLabs limiti tugagan, VoiceLab to'langan.
- VoiceLab kaliti: `vlk_…`, `stt:write` ruxsati kerak. Env: `VOICELAB_API_KEY`, `VOICELAB_BASE_URL`.

## Audio qayerda
`<DATA_DIR>/suhbatlar/<id>/audio/seg-NNN.webm` (DATA_DIR: standart `~/Suhbat-AI`, Docker/serverda `/data`). Brauzerda: tarixdagi «Audio» havolasi → `/m/<id>/audio/<fayl>`.

## Pitfalls
- VoiceLab vaqtlari millisekundda (`start_ms`), biz soniyaga o'tkazamiz.
- VoiceLab docs (docs.voicelab.uz) sandbox'dan ochilmadi; shakl `voicelab-uz/mcp` repodan olingan — haqiqiy kalit bilan bir marta sinab ko'ring.
- Balans/me endpointi yo'q: «Tekshirish» faqat yuklash so'rovini yuboradi.
