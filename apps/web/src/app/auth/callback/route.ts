import { NextResponse, type NextRequest } from 'next/server';
import { createSupabaseServerClient } from '@suhbat/database/server';
import { getCanonicalAppUrl, isSupabaseConfigured } from '@suhbat/database/config';

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get('code');
  const canonicalAppUrl = getCanonicalAppUrl();
  const safeRedirect = (path: string) => NextResponse.redirect(new URL(path, canonicalAppUrl));

  if (!code || !isSupabaseConfigured()) {
    return safeRedirect('/login?error=auth-callback');
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return safeRedirect('/login?error=auth-callback');
  }

  return safeRedirect('/');
}
