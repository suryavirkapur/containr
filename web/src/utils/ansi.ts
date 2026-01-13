/**
 * custom ansi to html parser
 * handles basic ansi escape codes for terminal log display
 */

const ANSI_COLORS: Record<number, string> = {
    // standard colors
    30: '#1f2937', // black
    31: '#dc2626', // red
    32: '#16a34a', // green
    33: '#ca8a04', // yellow
    34: '#2563eb', // blue
    35: '#9333ea', // magenta
    36: '#0891b2', // cyan
    37: '#d1d5db', // white
    // bright colors
    90: '#6b7280', // bright black
    91: '#ef4444', // bright red
    92: '#22c55e', // bright green
    93: '#eab308', // bright yellow
    94: '#3b82f6', // bright blue
    95: '#a855f7', // bright magenta
    96: '#06b6d4', // bright cyan
    97: '#f3f4f6', // bright white
};

const ANSI_BG_COLORS: Record<number, string> = {
    40: '#1f2937',
    41: '#dc2626',
    42: '#16a34a',
    43: '#ca8a04',
    44: '#2563eb',
    45: '#9333ea',
    46: '#0891b2',
    47: '#d1d5db',
    100: '#6b7280',
    101: '#ef4444',
    102: '#22c55e',
    103: '#eab308',
    104: '#3b82f6',
    105: '#a855f7',
    106: '#06b6d4',
    107: '#f3f4f6',
};

interface Style {
    color?: string;
    bg?: string;
    bold?: boolean;
    dim?: boolean;
    italic?: boolean;
    underline?: boolean;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function styleToInline(style: Style): string {
    const parts: string[] = [];
    if (style.color) parts.push(`color:${style.color}`);
    if (style.bg) parts.push(`background-color:${style.bg}`);
    if (style.bold) parts.push('font-weight:bold');
    if (style.dim) parts.push('opacity:0.5');
    if (style.italic) parts.push('font-style:italic');
    if (style.underline) parts.push('text-decoration:underline');
    return parts.join(';');
}

/**
 * parses ansi escape codes and returns html string
 */
export function parseAnsi(text: string): string {
    // regex to match ansi escape sequences
    const ansiRegex = /\x1b\[([0-9;]*)m/g;
    
    let result = '';
    let lastIndex = 0;
    let currentStyle: Style = {};
    let match;

    while ((match = ansiRegex.exec(text)) !== null) {
        // add text before the escape sequence
        const beforeText = text.slice(lastIndex, match.index);
        if (beforeText) {
            const styleStr = styleToInline(currentStyle);
            if (styleStr) {
                result += `<span style="${styleStr}">${escapeHtml(beforeText)}</span>`;
            } else {
                result += escapeHtml(beforeText);
            }
        }

        // parse the codes
        const codes = match[1].split(';').map(Number).filter(n => !isNaN(n));
        
        for (const code of codes) {
            if (code === 0) {
                // reset
                currentStyle = {};
            } else if (code === 1) {
                currentStyle.bold = true;
            } else if (code === 2) {
                currentStyle.dim = true;
            } else if (code === 3) {
                currentStyle.italic = true;
            } else if (code === 4) {
                currentStyle.underline = true;
            } else if (code === 22) {
                currentStyle.bold = false;
                currentStyle.dim = false;
            } else if (code === 23) {
                currentStyle.italic = false;
            } else if (code === 24) {
                currentStyle.underline = false;
            } else if (code === 39) {
                currentStyle.color = undefined;
            } else if (code === 49) {
                currentStyle.bg = undefined;
            } else if (ANSI_COLORS[code]) {
                currentStyle.color = ANSI_COLORS[code];
            } else if (ANSI_BG_COLORS[code]) {
                currentStyle.bg = ANSI_BG_COLORS[code];
            }
        }

        lastIndex = ansiRegex.lastIndex;
    }

    // add remaining text
    const remainingText = text.slice(lastIndex);
    if (remainingText) {
        const styleStr = styleToInline(currentStyle);
        if (styleStr) {
            result += `<span style="${styleStr}">${escapeHtml(remainingText)}</span>`;
        } else {
            result += escapeHtml(remainingText);
        }
    }

    return result || escapeHtml(text);
}
