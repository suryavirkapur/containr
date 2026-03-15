import { A, useNavigate } from '@solidjs/router';
import { createResource, createSignal, Show } from 'solid-js';
import { getRegistrationStatus } from '../api/auth';
import { Notice } from '../components/Plain';
import { PublicShell } from '../components/Shell';
import { useAuth } from '../context/AuthContext';
import { describeError } from '../utils/format';

const Register = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const [status] = createResource(getRegistrationStatus);
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [confirmPassword, setConfirmPassword] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (password() !== confirmPassword()) {
      setError('passwords do not match');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      await auth.register(email().trim(), password());
      navigate('/services');
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PublicShell title='Bootstrap Admin Account' subtitle='This page only works before the first user exists.'>
      <Show when={error()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>
      <Show when={status()} fallback={<section class='rounded-xl border border-border bg-card p-6'><p class="text-muted-foreground">Checking registration status...</p></section>}>
        {(current) => (
          current().registration_open ? (
            <section class='rounded-xl border border-border bg-card text-card-foreground shadow-sm p-6'>
              <form class='flex flex-col gap-4' onSubmit={(event) => void submit(event)}>
                <label class='flex flex-col gap-2'>
                  <span class='text-sm font-medium leading-none'>Email</span>
                  <input 
                    type='email' 
                    class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={email()} 
                    onInput={(event) => setEmail(event.currentTarget.value)} 
                  />
                </label>
                <label class='flex flex-col gap-2'>
                  <span class='text-sm font-medium leading-none'>Password</span>
                  <input 
                    type='password' 
                    class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={password()} 
                    onInput={(event) => setPassword(event.currentTarget.value)} 
                  />
                </label>
                <label class='flex flex-col gap-2'>
                  <span class='text-sm font-medium leading-none'>Confirm Password</span>
                  <input 
                    type='password' 
                    class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    value={confirmPassword()} 
                    onInput={(event) => setConfirmPassword(event.currentTarget.value)} 
                  />
                </label>
                <div class='flex flex-wrap items-center gap-4 mt-2'>
                  <button 
                    type='submit' 
                    disabled={saving()}
                    class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50 w-full sm:w-auto"
                  >
                    {saving() ? 'Creating...' : 'Create First User'}
                  </button>
                  <a 
                    href='/api/auth/github'
                    class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 w-full sm:w-auto"
                  >
                    Use GitHub Instead
                  </a>
                </div>
              </form>
            </section>
          ) : (
            <section class='rounded-xl border border-dashed border-border bg-card p-6 text-center flex flex-col items-center gap-2'>
              <p class="font-medium">Public registration is closed.</p>
              <p class='text-sm text-muted-foreground'>Sign in with an account created by the bootstrap admin.</p>
              <A 
                href='/login'
                class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 mt-2"
              >
                Back to Login
              </A>
            </section>
          )
        )}
      </Show>
    </PublicShell>
  );
};

export default Register;
