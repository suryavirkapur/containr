import { useNavigate } from '@solidjs/router';
import { createSignal, onMount, Show } from 'solid-js';
import { finishGithubAppInstall } from '../api/settings';
import { Notice } from '../components/Plain';
import { PublicShell } from '../components/Shell';
import { describeError } from '../utils/format';

const TOKEN_KEY = 'containr_token';

const GithubInstallCallback = () => {
  const navigate = useNavigate();
  const [message, setMessage] = createSignal('processing github installation...');
  const [error, setError] = createSignal<string | null>(null);

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    const installationId = params.get('installation_id');
    const setupAction = params.get('setup_action');
    const token = localStorage.getItem(TOKEN_KEY);

    if (!token) {
      setError('missing auth token');
      return;
    }

    try {
      setMessage('saving github installation...');
      await finishGithubAppInstall(installationId, setupAction, token);
      navigate('/settings?github=installed', { replace: true });
    } catch (requestError) {
      setError(describeError(requestError));
    }
  });

  return (
    <PublicShell title='github installation' subtitle='Finalizing the GitHub App installation.'>
      <Show when={error()} fallback={<section class='panel'><p>{message()}</p></section>}>
        {(currentError) => <Notice tone='error'>{currentError()}</Notice>}
      </Show>
    </PublicShell>
  );
};

export default GithubInstallCallback;
