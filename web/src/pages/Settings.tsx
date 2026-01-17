import { Component, createResource, createSignal, Show } from 'solid-js';

/**
 * settings data from api
 */
interface Settings {
    base_domain: string;
    http_port: number;
    https_port: number;
    acme_email: string;
    acme_staging: boolean;
}

/**
 * fetches current settings from api
 */
const fetchSettings = async (): Promise<Settings> => {
    const token = localStorage.getItem('znskr_token');
    const res = await fetch('/api/settings', {
        headers: {
            Authorization: `Bearer ${token}`,
        },
    });

    if (!res.ok) {
        if (res.status === 401) {
            localStorage.removeItem('znskr_token');
            window.location.href = '/login';
        }
        throw new Error('failed to fetch settings');
    }

    return res.json();
};

/**
 * settings page for server configuration
 */
const Settings: Component = () => {
    const [settings, { refetch }] = createResource(fetchSettings);
    const [saving, setSaving] = createSignal(false);
    const [message, setMessage] = createSignal<{ type: 'success' | 'error'; text: string } | null>(null);

    // form values
    const [baseDomain, setBaseDomain] = createSignal('');
    const [acmeEmail, setAcmeEmail] = createSignal('');
    const [acmeStaging, setAcmeStaging] = createSignal(true);

    // initialize form when settings load
    const initForm = () => {
        const s = settings();
        if (s) {
            setBaseDomain(s.base_domain);
            setAcmeEmail(s.acme_email);
            setAcmeStaging(s.acme_staging);
        }
    };

    /**
     * saves settings to api
     */
    const handleSave = async (e: Event) => {
        e.preventDefault();
        setSaving(true);
        setMessage(null);

        try {
            const token = localStorage.getItem('znskr_token');
            const res = await fetch('/api/settings', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                body: JSON.stringify({
                    base_domain: baseDomain(),
                    acme_email: acmeEmail(),
                    acme_staging: acmeStaging(),
                }),
            });

            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'failed to save settings');
            }

            setMessage({ type: 'success', text: 'settings saved successfully' });
            refetch();
        } catch (err) {
            setMessage({ type: 'error', text: (err as Error).message });
        } finally {
            setSaving(false);
        }
    };

    return (
        <div>
            {/* header */}
            <div class="mb-10">
                <h1 class="text-2xl font-serif text-black">server settings</h1>
                <p class="text-neutral-500 mt-1 text-sm">configure your znskr instance</p>
            </div>

            {/* loading state */}
            <Show when={settings.loading}>
                <div class="border border-neutral-200 p-6 animate-pulse">
                    <div class="h-5 bg-neutral-100 w-1/4 mb-3"></div>
                    <div class="h-4 bg-neutral-50 w-1/2"></div>
                </div>
            </Show>

            {/* settings form */}
            <Show when={!settings.loading && settings()}>
                {(() => {
                    // initialize form values on first render
                    initForm();
                    return null;
                })()}

                {/* message */}
                <Show when={message()}>
                    <div
                        class={`mb-6 p-4 border ${message()?.type === 'success'
                                ? 'border-green-300 bg-green-50 text-green-800'
                                : 'border-red-300 bg-red-50 text-red-800'
                            }`}
                    >
                        {message()?.text}
                    </div>
                </Show>

                <form onSubmit={handleSave} class="space-y-8">
                    {/* proxy settings */}
                    <section class="border border-neutral-200 p-6">
                        <h2 class="text-lg font-serif text-black mb-6">domain settings</h2>

                        <div class="space-y-4">
                            <div>
                                <label class="block text-sm text-neutral-600 mb-2">
                                    base domain
                                </label>
                                <input
                                    type="text"
                                    value={baseDomain()}
                                    onInput={(e) => setBaseDomain(e.currentTarget.value)}
                                    placeholder="example.com"
                                    class="w-full px-4 py-2 border border-neutral-300 focus:border-black focus:outline-none text-sm"
                                />
                                <p class="text-xs text-neutral-400 mt-1">
                                    the domain where the dashboard will be accessible
                                </p>
                                <p class="text-xs text-neutral-400 mt-1">
                                    saving triggers automatic tls provisioning and http will be refused until ready
                                </p>
                            </div>

                            <div class="flex items-center gap-2 text-sm text-neutral-500">
                                <span>http port:</span>
                                <span class="font-mono">{settings()?.http_port}</span>
                                <span class="mx-2">|</span>
                                <span>https port:</span>
                                <span class="font-mono">{settings()?.https_port}</span>
                            </div>
                        </div>
                    </section>

                    {/* acme / ssl settings */}
                    <section class="border border-neutral-200 p-6">
                        <h2 class="text-lg font-serif text-black mb-6">ssl certificate</h2>

                        <div class="space-y-4">
                            <div>
                                <label class="block text-sm text-neutral-600 mb-2">
                                    acme email
                                </label>
                                <input
                                    type="email"
                                    value={acmeEmail()}
                                    onInput={(e) => setAcmeEmail(e.currentTarget.value)}
                                    placeholder="admin@example.com"
                                    class="w-full px-4 py-2 border border-neutral-300 focus:border-black focus:outline-none text-sm"
                                />
                                <p class="text-xs text-neutral-400 mt-1">
                                    email for let's encrypt certificate notifications
                                </p>
                            </div>

                            <div class="flex items-center gap-3">
                                <input
                                    type="checkbox"
                                    id="acme-staging"
                                    checked={acmeStaging()}
                                    onChange={(e) => setAcmeStaging(e.currentTarget.checked)}
                                    class="w-4 h-4"
                                />
                                <label for="acme-staging" class="text-sm text-neutral-600">
                                    use staging environment (for testing)
                                </label>
                            </div>

                            <div class="pt-4 border-t border-neutral-100">
                                <p class="text-xs text-neutral-400">
                                    certificates are issued automatically when you update the base domain
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* save button */}
                    <div class="flex justify-end">
                        <button
                            type="submit"
                            disabled={saving()}
                            class="px-6 py-2 bg-black text-white hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm"
                        >
                            {saving() ? 'saving...' : 'save settings'}
                        </button>
                    </div>
                </form>
            </Show>
        </div>
    );
};

export default Settings;
