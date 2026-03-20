import { createSignal, type JSX } from 'solid-js';
import { Navigate } from '@solidjs/router';
import { useAuth } from '../context/AuthContext';
import { Sidebar } from './Sidebar';
import { LoadingBlock } from './Plain';
import { ThemeContext } from '../context/ThemeContext';

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const { resolvedTheme, toggleTheme } = ThemeContext;

  if (!auth.ready()) {
    return (
      <main class='min-h-screen bg-background text-foreground flex items-center justify-center p-4'>
        <LoadingBlock message='Loading control panel...' />
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href='/login' />;
  }

  return (
    <div class='min-h-screen bg-background text-foreground'>
      <header class='fixed inset-x-0 top-0 z-50 border-b border-black/10 bg-[var(--header-bg)] text-[var(--header-fg)] shadow-sm'>
        <div class='flex h-16 items-center justify-between px-4 sm:px-6'>
          <div class='flex items-center gap-3'>
            <button
              type='button'
              onClick={() => setSidebarCollapsed(!sidebarCollapsed())}
              class='inline-flex h-9 w-9 items-center justify-center rounded-md border border-white/10 text-sm text-white transition-colors hover:bg-white/10 lg:hidden'
            >
              ☰
            </button>
            <img alt='containr logo' src='/icon.png' class='hidden h-10 w-10 rounded-md object-cover sm:block' onError={(event) => {
              event.currentTarget.style.display = 'none';
            }} />
            <div>
              <div class='text-xs font-semibold uppercase tracking-[0.14em] text-white/60'>containr</div>
              <div class='text-base font-semibold tracking-tight'>Services Control Panel</div>
            </div>
          </div>

          <div class='flex items-center gap-3 text-sm'>
            <a class='hidden text-white/70 transition-colors hover:text-white md:block' href='https://github.com/caprover/caprover' target='_blank' rel='noreferrer'>
              GitHub
            </a>
            <a class='hidden text-white/70 transition-colors hover:text-white md:block' href='https://caprover.com/docs/' target='_blank' rel='noreferrer'>
              Docs
            </a>
            <button
              type='button'
              onClick={toggleTheme}
              class='inline-flex h-9 items-center justify-center rounded-md border border-white/10 px-3 text-white/80 transition-colors hover:bg-white/10 hover:text-white'
            >
              {resolvedTheme() === 'dark' ? 'Light' : 'Dark'}
            </button>
            <button
              type='button'
              onClick={auth.logout}
              class='inline-flex h-9 items-center justify-center rounded-md border border-white/10 px-3 text-white/80 transition-colors hover:bg-white/10 hover:text-white'
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      <Sidebar
        collapsed={sidebarCollapsed()}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed())}
      />
      <main class={`pt-16 transition-all duration-200 ${sidebarCollapsed() ? 'lg:ml-20' : 'lg:ml-[200px]'}`}>
        <div class='mx-auto max-w-[1400px] p-4 sm:p-6 lg:p-8'>
          {props.children}
        </div>
      </main>
    </div>
  );
};

export const PublicShell = (props: { title: string; subtitle?: string; children?: JSX.Element }) => (
  <main class='min-h-screen bg-background text-foreground'>
    <div class='mx-auto flex min-h-screen max-w-3xl flex-col justify-center p-4 sm:p-6'>
      <header class='mb-8 text-center'>
        <div class='mb-2 text-sm font-semibold uppercase tracking-[0.12em] text-muted-foreground'>containr access</div>
        <h1 class='mb-2 text-4xl font-semibold tracking-tight'>{props.title}</h1>
        {props.subtitle && <p class='text-lg text-muted-foreground'>{props.subtitle}</p>}
      </header>
      <div class='rounded-lg border border-border bg-card p-6 text-card-foreground shadow-sm sm:p-8'>
        {props.children}
      </div>
    </div>
  </main>
);
