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
    <PublicShell title='sign in' subtitle='Use the account created by the bootstrap admin.'>
      <Show when={error()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>

      <section class='panel'>
        <form class='form-stack' onSubmit={(event) => void submit(event)}>
          <label class='field'>
            <span>email</span>
            <input type='email' value={email()} onInput={(event) => setEmail(event.currentTarget.value)} />
          </label>
          <label class='field'>
            <span>password</span>
            <input type='password' value={password()} onInput={(event) => setPassword(event.currentTarget.value)} />
          </label>
          <div class='button-row'>
            <button type='submit' disabled={saving()}>{saving() ? 'signing in...' : 'sign in'}</button>
            <a href='/api/auth/github'>sign in with github</a>
          </div>
        </form>
      </section>

      <section class='panel'>
        <Show when={status()} fallback={<p class='muted'>Checking registration status...</p>}>
          {(current) => (
            current().registration_open ? (
              <p>Bootstrap registration is still open. <A href='/register'>Create the first admin user.</A></p>
            ) : (
              <p class='muted'>Public signup is closed. The bootstrap admin must create additional users.</p>
            )
          )}
        </Show>
      </section>
    </PublicShell>
  );
};

export default Login;
