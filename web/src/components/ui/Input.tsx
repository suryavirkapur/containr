import { Component, JSX, splitProps } from 'solid-js';

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
}

/**
 * reusable input component with sharp edges
 */
export const Input: Component<InputProps> = (props) => {
    const [local, others] = splitProps(props, [
        'label',
        'error',
        'class',
        'id',
    ]);

    const inputId = local.id || `input-${Math.random().toString(36).substring(2, 9)}`;

    return (
        <div class="w-full">
            {local.label && (
                <label
                    for={inputId}
                    class="block text-sm font-medium text-black mb-1.5"
                >
                    {local.label}
                </label>
            )}
            <input
                id={inputId}
                class={`
          flex w-full border bg-white px-3 py-2 text-sm text-black
          placeholder:text-neutral-400
          focus:outline-none focus:border-black focus:ring-1 focus:ring-black
          disabled:cursor-not-allowed disabled:opacity-50
          transition-colors
          ${local.error ? 'border-red-500 focus:border-red-500 focus:ring-red-500' : 'border-neutral-200'}
          ${local.class || ''}
        `}
                {...others}
            />
            {local.error && (
                <p class="mt-1 text-xs text-red-500">{local.error}</p>
            )}
        </div>
    );
};
