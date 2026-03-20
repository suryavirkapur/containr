/* @refresh reload */
import { Router } from '@solidjs/router';
import { render } from 'solid-js/web';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import { AppStoreProvider } from './context/AppStore';
import './index.css';

render(
  () => (
    <AuthProvider>
      <AppStoreProvider>
        <Router>
          <App />
        </Router>
      </AppStoreProvider>
    </AuthProvider>
  ),
  document.getElementById('root')!,
);
