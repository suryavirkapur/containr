import { Component, JSX, splitProps } from 'solid-js';

type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: ButtonSize;
    isLoading?: boolean;
}

/// reusable button component
export const Button: Component<ButtonProps> = (props) => {
    const [local, others] = splitProps(props, [
        'variant',
        'size',
        'isLoading',
        'children',
        'class',
        'disabled',
    ]);

    const baseClass =
        'inline-flex items-center justify-center font-medium transition-colors'
        + ' focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed'
        + ' border cursor-pointer';

    const variants: Record<ButtonVariant, string> = {
        primary:
            'bg-white text-black border-white hover:bg-neutral-200',
        outline:
            'bg-transparent text-neutral-300 border-neutral-600'
            + ' hover:border-neutral-400 hover:text-white',
        ghost:
            'bg-transparent text-neutral-300 border-transparent'
            + ' hover:bg-neutral-800 hover:text-white',
        danger:
            'bg-red-600 text-white border-red-600'
            + ' hover:bg-red-700 hover:border-red-700',
    };

    const sizes: Record<ButtonSize, string> = {
        sm: 'h-8 px-3 text-xs',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
    };

    return (
        <button
            class={`
        ${baseClass}
        ${variants[local.variant || 'primary']}
        ${sizes[local.size || 'md']}
        ${local.class || ''}
      `}
            disabled={local.disabled || local.isLoading}
            {...others}
        >
            {local.isLoading ? (
                <>
                    <svg
                        class="animate-spin -ml-1 mr-2 h-4 w-4 text-current"
                        xmlns="http://www.w3.org/2000/svg"
                        fill="none"
                        viewBox="0 0 24 24"
                    >
                        <circle
                            class="opacity-25"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            stroke-width="4"
                        ></circle>
                        <path
                            class="opacity-75"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                    </svg>
                    loading...
                </>
            ) : (
                local.children
            )}
        </button>
    );
};
