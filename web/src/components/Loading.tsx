import { Component } from 'solid-js';

/**
 * loading spinner component
 */
const Loading: Component = () => {
    return (
        <div class="flex items-center justify-center min-h-screen">
            <div class="flex flex-col items-center gap-4">
                <div class="w-8 h-8 border-2 border-primary-500 border-t-transparent animate-spin"></div>
                <span class="text-gray-400">loading...</span>
            </div>
        </div>
    );
};

export default Loading;
