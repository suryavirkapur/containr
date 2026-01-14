import { Component, JSX, splitProps } from 'solid-js';

interface CardProps extends JSX.HTMLAttributes<HTMLDivElement> {
    variant?: 'default' | 'hover';
}

/**
 * reusable card component
 */
export const Card: Component<CardProps> = (props) => {
    const [local, others] = splitProps(props, ['variant', 'class', 'children']);

    const variants = {
        default: 'bg-white border border-neutral-200',
        hover: 'bg-white border border-neutral-200 hover:border-black transition-colors cursor-pointer group',
    };

    return (
        <div
            class={`
        ${variants[local.variant || 'default']}
        ${local.class || ''}
      `}
            {...others}
        >
            {local.children}
        </div>
    );
};

export const CardHeader: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => {
    return (
        <div
            class={`p-6 border-b border-neutral-200 ${props.class || ''}`}
            {...props}
        />
    );
};

export const CardTitle: Component<JSX.HTMLAttributes<HTMLHeadingElement>> = (props) => {
    return (
        <h3
            class={`text-lg font-serif font-medium text-black ${props.class || ''}`}
            {...props}
        />
    );
};

export const CardDescription: Component<JSX.HTMLAttributes<HTMLParagraphElement>> = (props) => {
    return (
        <p
            class={`text-sm text-neutral-500 mt-1 ${props.class || ''}`}
            {...props}
        />
    );
};

export const CardContent: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => {
    return (
        <div class={`p-6 ${props.class || ''}`} {...props} />
    );
};

export const CardFooter: Component<JSX.HTMLAttributes<HTMLDivElement>> = (props) => {
    return (
        <div
            class={`p-6 border-t border-neutral-200 flex items-center ${props.class || ''}`}
            {...props}
        />
    );
};
