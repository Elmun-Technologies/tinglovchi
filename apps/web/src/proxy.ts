import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { getSupabasePublicConfig } from '@suhbat/database/config';
import type { Database } from '@suhbat/database/types';

export async function proxy(request: NextRequest) {
  const config = getSupabasePublicConfig();
  if (!config) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(config.url, config.anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // Refreshes/validates auth cookies without making authorization decisions in the proxy.
  await supabase.auth.getUser();
  return response;
}

export const config = {
  // `api/quick` is excluded: the one-button recorder needs no Supabase session, and a route behind the proxy
  // gets its request body capped (10 MB by default), which an hour-long recording exceeds.
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/quick|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
