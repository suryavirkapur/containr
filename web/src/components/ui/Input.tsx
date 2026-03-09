import { Component, JSX, splitProps } from 'solid-js';

interface InputProps extends JSX.InputHTMLAttributes<HTMLInputElement> {
    label?: string;
    error?: string;
}

/// reusable input component
export const Input: Component<InputProps> = (props) => {
    const [local, others] = splitProps(props, [
        'label',
        'error',
        'class',
        'id',
    ]);

    const inputId =
        local.id || `input-${Math.random().toString(36).substring(2, 9)}`;

    return (
        <div class="w-full">
            {local.label && (
                <label
                    for={inputId}
                    class="block text-sm font-medium text-neutral-200 mb-1.5"
                >
                    {local.label}
                </label>
            )}
            <input
                id={inputId}
                class={`
          flex w-full border bg-[#12121a] px-3 py-2 text-sm text-neutral-200
          placeholder:text-neutral-500
          focus:outline-none focus:border-purple-500
          focus:ring-1 focus:ring-purple-500
          disabled:cursor-not-allowed disabled:opacity-50
          transition-colors
          ${local.error
                        ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                        : 'border-neutral-700'
                    }
          ${local.class || ''}
        `}
                {...others}
            />
            {local.error && (
                <p class="mt-1 text-xs text-red-400">{local.error}</p>
            )}
        </div>
    );
};
