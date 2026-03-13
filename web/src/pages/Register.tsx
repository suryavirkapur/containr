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
    <PublicShell title='bootstrap admin account' subtitle='This page only works before the first user exists.'>
      <Show when={error()}>{(message) => <Notice tone='error'>{message()}</Notice>}</Show>
      <Show when={status()} fallback={<section class='panel'><p>Checking registration status...</p></section>}>
        {(current) => (
          current().registration_open ? (
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
                <label class='field'>
                  <span>confirm password</span>
                  <input type='password' value={confirmPassword()} onInput={(event) => setConfirmPassword(event.currentTarget.value)} />
                </label>
                <div class='button-row'>
                  <button type='submit' disabled={saving()}>{saving() ? 'creating...' : 'create first user'}</button>
                  <a href='/api/auth/github'>use github instead</a>
                </div>
              </form>
            </section>
          ) : (
            <section class='panel'>
              <p>Public registration is closed.</p>
              <p class='muted'>Sign in with an account created by the bootstrap admin.</p>
              <p><A href='/login'>back to login</A></p>
            </section>
          )
        )}
      </Show>
    </PublicShell>
  );
};

export default Register;
