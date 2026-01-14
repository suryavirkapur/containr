import { Route } from '@solidjs/router';
import { Component, lazy, Suspense } from 'solid-js';
import Layout from './components/Layout';
import Loading from './components/Loading';

const Login = lazy(() => import('./pages/Login'));
const Register = lazy(() => import('./pages/Register'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const AppDetail = lazy(() => import('./pages/AppDetail'));
const NewApp = lazy(() => import('./pages/NewApp'));
const Settings = lazy(() => import('./pages/Settings'));
const Databases = lazy(() => import('./pages/Databases'));
const Storage = lazy(() => import('./pages/Storage'));

const App: Component = () => {
    return (
        <Suspense fallback={<Loading />}>
            <Route path="/login" component={Login} />
            <Route path="/register" component={Register} />
            <Route path="/" component={Layout}>
                <Route path="/" component={Dashboard} />
                <Route path="/apps/new" component={NewApp} />
                <Route path="/apps/:id" component={AppDetail} />
                <Route path="/databases" component={Databases} />
                <Route path="/storage" component={Storage} />
                <Route path="/settings" component={Settings} />
            </Route>
        </Suspense>
    );
};

export default App;


