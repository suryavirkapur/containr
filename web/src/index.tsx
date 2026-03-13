/* @refresh reload */
import { Router } from '@solidjs/router';
import { render } from 'solid-js/web';
import App from './App';
import { AuthProvider } from './context/AuthContext';
import './index.css';

render(
  () => (
    <AuthProvider>
      <Router>
        <App />
      </Router>
    </AuthProvider>
  ),
  document.getElementById('root')!,
);
