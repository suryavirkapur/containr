import { Navigate, Route } from '@solidjs/router';
import type { Component } from 'solid-js';
import { Shell } from './components/Shell';
import BucketDetail from './pages/BucketDetail';
import CreateConfigure from './pages/CreateConfigure';
import CreateFlow from './pages/CreateFlow';
import CreateRepo from './pages/CreateRepo';
import CreateTemplate from './pages/CreateTemplate';
import GithubCallback from './pages/GithubCallback';
import GithubInstallCallback from './pages/GithubInstallCallback';
import Login from './pages/Login';
import Register from './pages/Register';
import Settings from './pages/Settings';
import Storage from './pages/Storage';
import ServiceDetail from './pages/service-detail';
import Services from './pages/services';

const RedirectServices: Component = () => <Navigate href='/services' />;
const RedirectNew: Component = () => <Navigate href='/services/new' />;

const App: Component = () => (
  <>
    <Route path='/login' component={Login} />
    <Route path='/register' component={Register} />
    <Route path='/github/callback' component={GithubCallback} />
    <Route path='/github/install/callback' component={GithubInstallCallback} />
    <Route path='/' component={Shell}>
      <Route path='/' component={RedirectServices} />
      <Route path='/services' component={Services} />
      <Route path='/services/new' component={CreateFlow} />
      <Route path='/services/new/repo' component={CreateRepo} />
      <Route path='/services/new/configure' component={CreateConfigure} />
      <Route path='/services/new/template' component={CreateTemplate} />
      <Route path='/services/:id' component={ServiceDetail} />
      <Route path='/storage' component={Storage} />
      <Route path='/storage/:id' component={BucketDetail} />
      <Route path='/settings' component={Settings} />
      <Route path='/apps' component={RedirectServices} />
      <Route path='/projects' component={RedirectServices} />
      <Route path='/projects/new' component={RedirectNew} />
      <Route path='/apps/new' component={RedirectNew} />
      <Route path='/databases' component={RedirectServices} />
      <Route path='/databases/new' component={RedirectNew} />
      <Route path='/queues' component={RedirectServices} />
      <Route path='/queues/new' component={RedirectNew} />
    </Route>
  </>
);

export default App;
