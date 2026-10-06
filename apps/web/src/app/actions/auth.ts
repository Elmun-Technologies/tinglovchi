'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { getCanonicalAppUrl, isSupabaseConfigured } from '@suhbat/database/config';
import { createSupabaseServerClient } from '@suhbat/database/server';

const credentialsSchema = z.object({
  email: z.email().trim().max(254),
  password: z.string().min(8).max(72),
});

function credentialsFrom(formData: FormData) {
  return credentialsSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
}

export async function signInAction(formData: FormData): Promise<void> {
  const credentials = credentialsFrom(formData);
  if (!credentials.success) redirect('/login?error=invalid-input');
  if (!isSupabaseConfigured()) redirect('/login?error=not-configured');

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(credentials.data);
  if (error) redirect('/login?error=sign-in');

  revalidatePath('/', 'layout');
  redirect('/');
}

export async function signUpAction(formData: FormData): Promise<void> {
  const credentials = credentialsFrom(formData);
  if (!credentials.success) redirect('/login?error=invalid-input');
  if (!isSupabaseConfigured()) redirect('/login?error=not-configured');

  const supabase = await createSupabaseServerClient();
  const appUrl = getCanonicalAppUrl();
  const { data, error } = await supabase.auth.signUp({
    ...credentials.data,
    options: { emailRedirectTo: new URL('/auth/callback', appUrl).toString() },
  });

  if (error) redirect('/login?error=sign-up');
  revalidatePath('/', 'layout');
  if (data.session) redirect('/');
  redirect('/login?notice=confirm-email');
}

export async function signOutAction(): Promise<void> {
  if (!isSupabaseConfigured()) redirect('/login?error=not-configured');
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  revalidatePath('/', 'layout');
  redirect('/login?notice=signed-out');
}
