import { NextResponse, type NextRequest } from 'next/server';
import type { TelegramBotMessageUpdateInput } from '@suhbat/contracts';
import {
  handleApiError,
  parseJsonBody,
  resolveApiContext,
} from '../../../../../lib/api-v1-runtime';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const { phase8Service } = await resolveApiContext(request);
    const webhookSecret = request.headers.get('x-telegram-bot-api-secret-token');
    const body = (await parseJsonBody(request)) as TelegramBotMessageUpdateInput;
    const result = await phase8Service.handleBotUpdate(webhookSecret, body);
    return NextResponse.json(result, { status: 200 });
  } catch (cause) {
    return handleApiError(cause);
  }
}
