import { Component, createResource, createSignal, Show } from "solid-js";
import { api, components } from "../api";
import { apiDelete, apiGet } from "../api/client";

type SettingsResponse = components["schemas"]["SettingsResponse"];

/**
 * github app status from api
 * TODO: add github app endpoints to schema and use typed client
 */
interface GithubAppStatus {
  configured: boolean;
  app: {
    app_id: number;
    app_name: string;
    html_url: string;
  } | null;
  installations: {
    id: number;
    account_login: string;
    account_type: string;
    repository_count: number | null;
  }[];
}

/**
 * fetches current settings from api
 */
const fetchSettings = async (): Promise<SettingsResponse> => {
  const { data, error } = await api.GET("/api/settings");
  if (error) throw new Error(error.error);
  return data;
};

/**
 * fetches github app status
 */
const fetchGithubApp = async (): Promise<GithubAppStatus> => {
  try {
    return await apiGet<GithubAppStatus>("/api/github/app");
  } catch {
    return { configured: false, app: null, installations: [] };
  }
};

/**
 * settings page for server configuration
 */
const Settings: Component = () => {
  const [settings, { refetch }] = createResource(fetchSettings);
  const [githubApp, { refetch: refetchGithub }] =
    createResource(fetchGithubApp);
  const [saving, setSaving] = createSignal(false);
  const [issuingCert, setIssuingCert] = createSignal(false);
  const [deletingApp, setDeletingApp] = createSignal(false);
  const [creatingApp, setCreatingApp] = createSignal(false);
  const [message, setMessage] = createSignal<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  // form values
  const [baseDomain, setBaseDomain] = createSignal("");
  const [acmeEmail, setAcmeEmail] = createSignal("");
  const [acmeStaging, setAcmeStaging] = createSignal(true);

  // github app delete handler
  const handleDeleteGithubApp = async () => {
    setDeletingApp(true);
    try {
      await apiDelete("/api/github/app");

      refetchGithub();
      setMessage({ type: "success", text: "github app deleted" });
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setDeletingApp(false);
    }
  };

  // start github app creation flow
  const startAppCreation = async () => {
    setCreatingApp(true);
    try {
      const manifest = await apiGet("/api/github/app/manifest");

      // create form and submit to github
      const form = document.createElement("form");
      form.method = "POST";
      form.action = "https://github.com/settings/apps/new";
      form.target = "_blank";

      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "manifest";
      input.value = JSON.stringify(manifest);

      form.appendChild(input);
      document.body.appendChild(form);
      form.submit();
      document.body.removeChild(form);
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setCreatingApp(false);
    }
  };

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
      const { error } = await api.PUT("/api/settings", {
        body: {
          base_domain: baseDomain(),
          acme_email: acmeEmail(),
          acme_staging: acmeStaging(),
        },
      });
      if (error) throw new Error(error.error);

      setMessage({ type: "success", text: "settings saved successfully" });
      refetch();
    } catch (err) {
      setMessage({ type: "error", text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      {/* header */}
      <div class="mb-10">
        <h1 class="text-2xl font-serif text-black">server settings</h1>
        <p class="text-neutral-500 mt-1 text-sm">
          configure your znskr instance
        </p>
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
            class={`mb-6 p-4 border ${
              message()?.type === "success"
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-red-300 bg-red-50 text-red-800"
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
                  saving triggers automatic tls provisioning and http will be
                  refused until ready
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

          {/* github integration */}
          <section class="border border-neutral-200 p-6">
            <h2 class="text-lg font-serif text-black mb-6">github app</h2>

            <Show when={githubApp.loading}>
              <div class="animate-pulse">
                <div class="h-4 bg-neutral-100 w-1/3"></div>
              </div>
            </Show>

            <Show when={!githubApp.loading}>
              {/* app configured */}
              <Show when={githubApp()?.configured}>
                <div class="space-y-4">
                  {/* app info */}
                  <div class="flex items-center justify-between">
                    <div class="flex items-center gap-3">
                      <div class="w-8 h-8 bg-neutral-900 flex items-center justify-center">
                        <svg
                          class="w-5 h-5 text-white"
                          fill="currentColor"
                          viewBox="0 0 24 24"
                        >
                          <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                        </svg>
                      </div>
                      <div>
                        <p class="text-sm text-black font-mono">
                          {githubApp()?.app?.app_name}
                        </p>
                        <a
                          href={githubApp()?.app?.html_url}
                          target="_blank"
                          class="text-xs text-neutral-500 hover:text-black"
                        >
                          view on github →
                        </a>
                      </div>
                    </div>
                    <button
                      onClick={handleDeleteGithubApp}
                      disabled={deletingApp()}
                      class="px-3 py-1.5 text-xs border border-red-300 text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      {deletingApp() ? "deleting..." : "delete app"}
                    </button>
                  </div>

                  {/* installations */}
                  <div class="border-t border-neutral-100 pt-4">
                    <div class="flex items-center justify-between mb-3">
                      <span class="text-sm text-neutral-600">
                        installations
                      </span>
                      <a
                        href={`${githubApp()?.app?.html_url}/installations/new`}
                        target="_blank"
                        class="px-3 py-1.5 text-xs bg-neutral-900 text-white hover:bg-neutral-800"
                      >
                        + install on repos
                      </a>
                    </div>

                    <Show when={githubApp()?.installations.length === 0}>
                      <p class="text-xs text-neutral-400">
                        no installations yet. install the app on your repos to
                        get started.
                      </p>
                    </Show>

                    <Show when={(githubApp()?.installations.length ?? 0) > 0}>
                      <div class="space-y-2">
                        {githubApp()?.installations.map((install) => (
                          <div class="flex items-center justify-between py-2 px-3 bg-neutral-50">
                            <div>
                              <span class="text-sm text-black font-mono">
                                {install.account_login}
                              </span>
                              <span class="text-xs text-neutral-400 ml-2">
                                ({install.account_type.toLowerCase()})
                              </span>
                            </div>
                            <span class="text-xs text-neutral-500">
                              {install.repository_count ?? "?"} repos
                            </span>
                          </div>
                        ))}
                      </div>
                    </Show>
                  </div>
                </div>
              </Show>

              {/* no app configured */}
              <Show when={!githubApp()?.configured}>
                <div class="flex items-center justify-between">
                  <div>
                    <p class="text-sm text-neutral-600">
                      create a github app to deploy private repositories
                    </p>
                    <p class="text-xs text-neutral-400 mt-1">
                      you'll create an app and install it on your repos
                    </p>
                  </div>
                  <button
                    onClick={startAppCreation}
                    disabled={creatingApp()}
                    class="px-4 py-2 text-sm bg-neutral-900 text-white hover:bg-neutral-800 disabled:opacity-50 flex items-center gap-2"
                  >
                    <svg
                      class="w-4 h-4"
                      fill="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                    {creatingApp() ? "creating..." : "create github app"}
                  </button>
                </div>
              </Show>
            </Show>
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

              <div class="pt-4 border-t border-neutral-100 flex items-center justify-between">
                <p class="text-xs text-neutral-400">
                  certificates are issued automatically when you update the base
                  domain
                </p>
                <button
                  type="button"
                  onClick={async () => {
                    setIssuingCert(true);
                    setMessage(null);
                    try {
                      const { data, error } = await api.POST(
                        "/api/settings/certificate",
                      );
                      if (error) throw new Error(error.error);
                      setMessage({ type: "success", text: data.message });
                    } catch (err) {
                      setMessage({
                        type: "error",
                        text: (err as Error).message,
                      });
                    } finally {
                      setIssuingCert(false);
                    }
                  }}
                  disabled={issuingCert() || !settings()?.base_domain}
                  class="px-4 py-2 text-xs border border-neutral-300 text-neutral-700 hover:text-black hover:border-black disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {issuingCert() ? "issuing..." : "reissue certificate"}
                </button>
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
              {saving() ? "saving..." : "save settings"}
            </button>
          </div>
        </form>
      </Show>
    </div>
  );
};

export default Settings;
