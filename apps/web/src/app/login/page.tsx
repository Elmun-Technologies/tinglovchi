import Link from 'next/link';
import { ArrowLeft, Headphones, LockKeyhole, Mail } from 'lucide-react';
import { isSupabaseConfigured } from '@suhbat/database/config';
import { Button, Card, FieldLabel, Input } from '@suhbat/ui';
import { signInAction, signUpAction } from '../actions/auth';

const productName = process.env.NEXT_PUBLIC_APP_NAME?.trim() || 'SUHBAT AI';

const errorMessages: Record<string, string> = {
  'invalid-input': 'Enter a valid email and a password with at least 8 characters.',
  'not-configured':
    'Supabase is not configured. Add the public project URL and anon key to apps/web/.env.local.',
  'sign-in': 'Sign-in failed. Check your email and password, then try again.',
  'sign-up': 'Account creation failed. Check the email address or try signing in.',
  'auth-callback':
    'The email confirmation link could not be verified. Request a new link and try again.',
};

const noticeMessages: Record<string, string> = {
  'confirm-email':
    'Account created. If email confirmation is enabled, check your inbox to finish signing in.',
  'signed-out': 'You have been signed out.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const params = await searchParams;
  const configured = isSupabaseConfigured();

  return (
    <main className="grid min-h-screen bg-white lg:grid-cols-[minmax(360px,0.9fr)_1.1fr]">
      <section className="flex flex-col px-6 py-7 sm:px-10 lg:px-14">
        <Link
          href="/"
          className="inline-flex w-fit items-center gap-2 text-sm font-medium text-slate-500 hover:text-slate-900"
        >
          <ArrowLeft size={16} /> Back to home
        </Link>

        <div className="mx-auto my-auto w-full max-w-[440px] py-12">
          <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-xl bg-teal-800 text-white">
            <Headphones size={21} />
          </div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-teal-800">
            {productName}
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-950">
            Sign in to your workspace
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            Keep your team’s meeting context organized and accessible.
          </p>

          {params.error && errorMessages[params.error] ? (
            <div
              role="alert"
              className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
            >
              {errorMessages[params.error]}
            </div>
          ) : null}
          {params.notice && noticeMessages[params.notice] ? (
            <div
              role="status"
              className="mt-6 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900"
            >
              {noticeMessages[params.notice]}
            </div>
          ) : null}

          {!configured ? (
            <div
              role="status"
              className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm leading-6 text-amber-950"
            >
              <p className="font-semibold">Authentication is not configured</p>
              <p className="mt-1 text-amber-900">
                Copy <code className="rounded bg-white px-1 py-0.5">.env.example</code> to{' '}
                <code className="rounded bg-white px-1 py-0.5">apps/web/.env.local</code>, then set{' '}
                <code className="rounded bg-white px-1 py-0.5">NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
                <code className="rounded bg-white px-1 py-0.5">NEXT_PUBLIC_SUPABASE_ANON_KEY</code>.
              </p>
            </div>
          ) : null}

          <div className={`mt-8 grid gap-5 ${configured ? '' : 'pointer-events-none opacity-50'}`}>
            <Card className="p-5 sm:p-6">
              <h2 className="text-base font-semibold text-slate-900">Sign in</h2>
              <form action={signInAction} className="mt-4 space-y-4">
                <div>
                  <FieldLabel htmlFor="signin-email">Email</FieldLabel>
                  <Input
                    id="signin-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="signin-password">Password</FieldLabel>
                  <Input
                    id="signin-password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    minLength={8}
                    maxLength={72}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={!configured}>
                  <LockKeyhole size={16} /> Continue
                </Button>
              </form>
            </Card>

            <Card className="p-5 sm:p-6">
              <h2 className="text-base font-semibold text-slate-900">Create an account</h2>
              <form action={signUpAction} className="mt-4 space-y-4">
                <div>
                  <FieldLabel htmlFor="signup-email">Email</FieldLabel>
                  <Input
                    id="signup-email"
                    name="email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="signup-password">Password</FieldLabel>
                  <Input
                    id="signup-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={8}
                    maxLength={72}
                  />
                </div>
                <Button type="submit" variant="secondary" className="w-full" disabled={!configured}>
                  <Mail size={16} /> Create account
                </Button>
              </form>
            </Card>
          </div>
          <p className="mt-6 text-xs leading-5 text-slate-500">
            Use a development Supabase project for local testing. Real account confirmation behavior
            depends on that project’s Auth settings.
          </p>
        </div>
      </section>

      <aside className="hidden flex-col justify-between bg-slate-950 p-12 text-white lg:flex xl:p-16">
        <div className="max-w-lg">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-teal-300">
            Meeting memory
          </p>
          <h2 className="mt-6 text-4xl font-semibold leading-tight tracking-tight xl:text-5xl">
            Important conversations deserve a longer life.
          </h2>
          <p className="mt-5 max-w-md text-base leading-7 text-slate-300">
            Organize meetings by workspace, company, and project. Structured conversation
            intelligence comes in later product phases.
          </p>
        </div>
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="h-px w-8 bg-slate-700" /> Private workspaces · Evidence-first by design
        </div>
      </aside>
    </main>
  );
}
