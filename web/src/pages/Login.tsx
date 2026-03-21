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
    <PublicShell title="Sign In" subtitle="Enter your credentials below.">
      <Show when={error()}>
        {(message) => <Notice tone="error">{message()}</Notice>}
      </Show>

      <form class="flex flex-col gap-4 mt-4" onSubmit={(e) => void submit(e)}>
        <label class="cr-field">
          <span class="cr-label">Email</span>
          <input
            type="email"
            class="cr-input"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
          />
        </label>
        <label class="cr-field">
          <span class="cr-label">Password</span>
          <input
            type="password"
            class="cr-input"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
        </label>
        <div class="flex flex-col gap-2 pt-2">
          <button
            type="submit"
            disabled={saving()}
            class="cr-btn cr-btn-primary w-full"
          >
            {saving() ? 'Signing in...' : 'Sign In'}
          </button>
          <a href="/api/auth/github" class="cr-btn cr-btn-secondary w-full">
            Sign In with GitHub
          </a>
        </div>
      </form>

      <Show
        when={status()}
        fallback={
          <p class="text-xs text-muted-foreground mt-4">
            Checking registration status...
          </p>
        }
      >
        {(current) => (
          <p class="text-xs text-muted-foreground mt-4">
            {current().registration_open ? (
              <>
                Bootstrap registration open.{' '}
                <A href="/register" class="underline text-foreground">
                  Create first admin.
                </A>
              </>
            ) : (
              'Public signup is closed.'
            )}
          </p>
        )}
      </Show>
    </PublicShell>
  );
};

export default Login;
