import { useNavigate } from '@solidjs/router';
import { createSignal, onMount, Show } from 'solid-js';
import { finishGithubLogin } from '../api/auth';
import { finishGithubAppSetup } from '../api/settings';
import { Notice } from '../components/Plain';
import { PublicShell } from '../components/Shell';
import { describeError } from '../utils/format';

const TOKEN_KEY = 'containr_token';

const GithubCallback = () => {
  const navigate = useNavigate();
  const [message, setMessage] = createSignal('processing github callback...');
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const state = params.get('state');

    if (!code) {
      setError('missing github code');
      return;
    }

    try {
      if (state) {
        setMessage('finishing github sign-in...');
        const response = await finishGithubLogin(code, state);
        localStorage.setItem(TOKEN_KEY, response.token);
        window.location.replace('/services');
        return;
      }

      const token = localStorage.getItem(TOKEN_KEY);
      if (!token) {
        throw new Error('missing auth token');
      }

      setMessage('saving github app configuration...');
      await finishGithubAppSetup(code, token);
      navigate('/settings?github=created', { replace: true });
    } catch (requestError) {
      setError(describeError(requestError));
    }
  });

  return (
    <PublicShell title='GitHub Callback' subtitle='Completing the requested GitHub flow.'>
      <Show when={error()} fallback={<section class='rounded-xl border border-border bg-card p-6 text-card-foreground shadow-sm'><p class="text-sm font-medium">{message()}</p></section>}>
        {(currentError) => <Notice tone='error'>{currentError()}</Notice>}
      </Show>
    </PublicShell>
  );
};

export default GithubCallback;
