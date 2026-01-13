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
        <div class="min-h-screen flex flex-col bg-white">
            {/* header */}
            <header class="border-b border-neutral-200">
                <div class="max-w-6xl mx-auto px-6">
                    <div class="flex justify-between items-center h-14">
                        {/* logo */}
                        <A href="/" class="flex items-center gap-2">
                            <span class="text-xl font-serif font-semibold text-black tracking-tight">znskr</span>
                        </A>

                        {/* nav */}
                        <nav class="flex items-center gap-8">
                            <A
                                href="/"
                                class="text-neutral-500 hover:text-black transition-colors text-sm"
                            >
                                apps
                            </A>
                            <A
                                href="/apps/new"
                                class="text-neutral-500 hover:text-black transition-colors text-sm"
                            >
                                deploy
                            </A>
                        </nav>

                        {/* user menu */}
                        <div class="flex items-center gap-4">
                            {isAuthenticated() ? (
                                <>
                                    <span class="text-neutral-500 text-sm">{user()?.email}</span>
                                    <button
                                        onClick={handleLogout}
                                        class="px-3 py-1.5 text-neutral-500 hover:text-black border border-neutral-300 hover:border-neutral-400 transition-colors text-sm"
                                    >
                                        logout
                                    </button>
                                </>
                            ) : (
                                <A
                                    href="/login"
                                    class="px-3 py-1.5 bg-black text-white hover:bg-neutral-800 transition-colors text-sm"
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
                <div class="max-w-6xl mx-auto px-6 py-10">
                    {props.children}
                </div>
            </main>

            {/* footer */}
            <footer class="border-t border-neutral-200 py-6">
                <div class="max-w-6xl mx-auto px-6">
                    <p class="text-center text-neutral-400 text-sm font-serif italic">
                        znskr — deploy containers with ease
                    </p>
                </div>
            </footer>
        </div>
    );
};

export default Layout;
