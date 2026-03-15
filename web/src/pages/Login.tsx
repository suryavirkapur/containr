import { A, useNavigate } from '@solidjs/router';
import { createResource, createSignal, Show } from 'solid-js';
import { getRegistrationStatus } from '../api/auth';
import { Notice } from '../components/Plain';
import { PublicShell } from '../components/Shell';
import { useAuth } from '../context/AuthContext';
import { describeError } from '../utils/format';

const Login = () => {
  const auth = useAuth();
  const navigate = useNavigate();
  const [status] = createResource(getRegistrationStatus);
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [saving, setSaving] = createSignal(false);

  const submit = async (event: Event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await auth.login(email().trim(), password());
      navigate('/services');
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <PublicShell title='Sign In' subtitle='Use the account created by the bootstrap admin.'>
      <Show when={error()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>

      <section class='rounded-xl border border-border bg-card text-card-foreground shadow-sm p-6 mb-6'>
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
          <div class='flex flex-wrap items-center gap-4 mt-2'>
            <button 
              type='submit' 
              disabled={saving()}
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors bg-primary text-primary-foreground hover:bg-primary/90 shadow-sm h-9 px-4 py-2 disabled:opacity-50 w-full sm:w-auto"
            >
              {saving() ? 'Signing In...' : 'Sign In'}
            </button>
            <a 
              href='/api/auth/github'
              class="inline-flex items-center justify-center rounded-md text-sm font-medium transition-colors border border-input bg-background hover:bg-accent hover:text-accent-foreground shadow-sm h-9 px-4 py-2 w-full sm:w-auto"
            >
              Sign In with GitHub
            </a>
          </div>
        </form>
      </section>

      <section class='rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm'>
        <Show when={status()} fallback={<p class='text-muted-foreground'>Checking registration status...</p>}>
          {(current) => (
            current().registration_open ? (
              <p>Bootstrap registration is still open. <A href='/register' class="font-medium underline underline-offset-4">Create the first admin user.</A></p>
            ) : (
              <p class='text-muted-foreground'>Public signup is closed. The bootstrap admin must create additional users.</p>
            )
          )}
        </Show>
      </section>
    </PublicShell>
  );
};

export default Login;
