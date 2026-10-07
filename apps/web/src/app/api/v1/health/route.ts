import { NextResponse } from 'next/server';
import { evaluateOperationalHealth } from '@suhbat/database/observability';
import { getPhase4Runtime } from '../../../../lib/api-v1-runtime';
import { resolveDataMode } from '../../../../lib/data-mode';

export async function GET(): Promise<NextResponse> {
  const runtime = getPhase4Runtime();
  const report = await evaluateOperationalHealth({
    db: runtime?.service.db ?? null,
    storage: runtime?.service.storage ?? null,
    dataMode: resolveDataMode(),
    nodeEnv: process.env.NODE_ENV ?? 'development',
  });

  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: {
      'Cache-Control': 'no-store, max-age=0',
    },
  });
}
