import { Component, JSX, splitProps } from 'solid-js';

type BadgeVariant =
    | 'default'
    | 'outline'
    | 'secondary'
    | 'success'
    | 'warning'
    | 'error';

interface BadgeProps extends JSX.HTMLAttributes<HTMLSpanElement> {
    variant?: BadgeVariant;
}

/// reusable badge component
export const Badge: Component<BadgeProps> = (props) => {
    const [local, others] = splitProps(props, [
        'variant',
        'class',
        'children',
    ]);

    const variants: Record<BadgeVariant, string> = {
        default: 'bg-neutral-700 text-neutral-200',
        outline: 'text-neutral-300 border border-neutral-600',
        secondary: 'bg-neutral-800 text-neutral-300',
        success:
            'bg-emerald-900/50 text-emerald-400 border border-emerald-700/50',
        warning:
            'bg-yellow-900/50 text-yellow-400 border border-yellow-700/50',
        error: 'bg-red-900/50 text-red-400 border border-red-700/50',
    };

    return (
        <span
            class={`
        inline-flex items-center px-2.5 py-0.5 text-xs font-medium
        transition-colors border border-transparent
        ${variants[local.variant || 'default']}
        ${local.class || ''}
      `}
            {...others}
        >
            {local.children}
        </span>
    );
};
