import { Component } from "solid-js";

/**
 * loading spinner component
 */
const Loading: Component = () => {
  return (
    <div class="flex items-center justify-center min-h-screen bg-white">
      <div class="flex flex-col items-center gap-4">
        <div class="w-6 h-6 border border-black border-t-transparent animate-spin"></div>
        <span class="text-neutral-500 text-sm">loading...</span>
      </div>
    </div>
  );
};

export default Loading;
