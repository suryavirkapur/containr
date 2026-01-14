import { Component, JSX, splitProps } from 'solid-js';

type BadgeVariant = 'default' | 'outline' | 'secondary' | 'success' | 'warning' | 'error';

interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant;
}

/**
 * reusable badge component
 */
export const Badge: Component<BadgeProps> = (props) => {
    const [local, others] = splitProps(props, ['variant', 'class', 'children']);

    const variants: Record<BadgeVariant, string> = {
        default: 'bg-black text-white hover:bg-neutral-800',
        outline: 'text-black border border-neutral-200',
        secondary: 'bg-neutral-100 text-neutral-900 hover:bg-neutral-200',
        success: 'bg-green-100 text-green-800 border-green-200',
        warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
        error: 'bg-red-100 text-red-800 border-red-200',
    };

    return (
        <span
            class={`
        inline-flex items-center px-2.5 py-0.5 text-xs font-medium transition-colors border border-transparent
        ${variants[local.variant || 'default']}
        ${local.class || ''}
      `}
            {...others}
        >
            {local.children}
        </span>
    );
};
