import { Component, JSX } from 'solid-js';
import { A, useNavigate } from '@solidjs/router';
import { AuthProvider, useAuth } from '../context/AuthContext';

/**
 * main layout with navigation
 */
const Layout: Component<{ children?: JSX.Element }> = (props) => {
    return (
        <AuthProvider>
            <LayoutContent>{props.children}</LayoutContent>
        </AuthProvider>
    );
};

const LayoutContent: Component<{ children?: JSX.Element }> = (props) => {
    const { user, logout, isAuthenticated } = useAuth();
    const navigate = useNavigate();

    const handleLogout = () => {
        logout();
        navigate('/login');
    };

    return (
        <div class="min-h-screen flex flex-col">
            {/* header */}
            <header class="bg-gray-900 border-b border-gray-800">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div class="flex justify-between items-center h-16">
                        {/* logo */}
                        <A href="/" class="flex items-center gap-2">
                            <span class="text-xl font-bold text-primary-500">znskr</span>
                        </A>

                        {/* nav */}
                        <nav class="flex items-center gap-6">
                            <A
                                href="/"
                                class="text-gray-300 hover:text-white transition-colors"
                            >
                                apps
                            </A>
                            <A
                                href="/apps/new"
                                class="text-gray-300 hover:text-white transition-colors"
                            >
                                deploy
                            </A>
                        </nav>

                        {/* user menu */}
                        <div class="flex items-center gap-4">
                            {isAuthenticated() ? (
                                <>
                                    <span class="text-gray-400 text-sm">{user()?.email}</span>
                                    <button
                                        onClick={handleLogout}
                                        class="px-4 py-2 bg-gray-800 text-gray-300 hover:bg-gray-700 border border-gray-700 transition-colors"
                                    >
                                        logout
                                    </button>
                                </>
                            ) : (
                                <A
                                    href="/login"
                                    class="px-4 py-2 bg-primary-600 text-white hover:bg-primary-700 transition-colors"
                                >
                                    login
                                </A>
                            )}
                        </div>
                    </div>
                </div>
            </header>

            {/* main content */}
            <main class="flex-1">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
                    {props.children}
                </div>
            </main>

            {/* footer */}
            <footer class="bg-gray-900 border-t border-gray-800 py-4">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <p class="text-center text-gray-500 text-sm">
                        znskr — deploy containers with ease
                    </p>
                </div>
            </footer>
        </div>
    );
};

export default Layout;
