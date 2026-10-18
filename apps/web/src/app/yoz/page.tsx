import { hasAccess } from '../../lib/quick/access';
import { missingAnalysisConfig } from '../../lib/quick/analyze';
import { listSessions } from '../../lib/quick/store';
import { missingTranscriptionConfig } from '../../lib/quick/transcribe';
import { AccessGate } from './gate';
import { Recorder } from './recorder';
import { SessionList } from './session-list';

export const dynamic = 'force-dynamic';

export default async function RecordPage() {
  const missing = [...missingTranscriptionConfig(), ...missingAnalysisConfig()];
  const warnings = missing.map((key) => `Serverda ${key} o‘rnatilmagan.`);
  const recent = (await hasAccess()) ? (await listSessions()).slice(0, 5) : [];

  return (
    <AccessGate>
      <section className="flex flex-col items-center pt-4 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">
          Suhbatni yozib olish
        </h1>
        <p className="mt-2 max-w-md text-sm text-slate-500">
          Uchrashuv boshlanishidan oldin tugmani bosing. Tugagach «Tugatish»ni bosing — xulosa,
          vazifalar, mind map, roadmap va prezentatsiya avtomatik tayyorlanadi.
        </p>
        <div className="mt-8 w-full max-w-md">
          <Recorder warnings={warnings} />
        </div>
      </section>
      {recent.length > 0 ? (
        <section className="mx-auto mt-14 max-w-2xl">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Oxirgi suhbatlar
          </h2>
          <SessionList sessions={recent} />
        </section>
      ) : null}
    </AccessGate>
  );
}
