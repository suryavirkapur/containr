import { A, Navigate, useLocation } from '@solidjs/router';
import { type JSX, Show } from 'solid-js';
import { useAuth } from '../context/AuthContext';

const links = [
  { href: '/services', label: 'services' },
  { href: '/storage', label: 'storage' },
  { href: '/settings', label: 'settings' },
];

export const Shell = (props: { children?: JSX.Element }) => {
  const auth = useAuth();
  const location = useLocation();

  if (!auth.ready()) {
    return (
      <main class='shell'>
        <div class='panel'><p>Loading control panel...</p></div>
      </main>
    );
  }

  if (!auth.isAuthenticated()) {
    return <Navigate href='/login' />;
  }

  return (
    <main class='shell'>
      <header class='panel shell-header'>
        <div>
          <div class='muted'>containr control panel</div>
          <h1>containr</h1>
          <p class='muted'>Plain interface. Tables, forms, logs. No decoration.</p>
        </div>
        <div class='account-box'>
          <div><strong>{auth.user()?.email}</strong></div>
          <div class='muted'>{auth.user()?.is_admin ? 'bootstrap admin' : 'standard user'}</div>
          <button type='button' onClick={auth.logout}>log out</button>
        </div>
      </header>

      <nav class='panel nav-strip'>
        {links.map((link) => (
          <A href={link.href} class={location.pathname.startsWith(link.href) ? 'nav-link is-current' : 'nav-link'}>
            {link.label}
          </A>
        ))}
        <span class='spacer' />
        <A href='/services/new' class='nav-link'>new service</A>
      </nav>

      {props.children}
    </main>
  );
};

export const PublicShell = (props: { title: string; subtitle?: string; children?: JSX.Element }) => (
  <main class='shell shell-narrow'>
    <header class='panel'>
      <div class='muted'>containr access</div>
      <h1>{props.title}</h1>
      <Show when={props.subtitle}><p class='muted'>{props.subtitle}</p></Show>
    </header>
    {props.children}
  </main>
);
