import AnsiToHtml from 'ansi-to-html';

/**
 * converts ansi escape codes to html with inline styles
 */
const converter = new AnsiToHtml({
    fg: '#d1d5db',
    bg: '#000000',
    colors: {
        0: '#1f2937',
        1: '#ef4444',
        2: '#22c55e',
        3: '#eab308',
        4: '#3b82f6',
        5: '#a855f7',
        6: '#06b6d4',
        7: '#d1d5db',
        8: '#6b7280',
        9: '#f87171',
        10: '#4ade80',
        11: '#fde047',
        12: '#60a5fa',
        13: '#c084fc',
        14: '#22d3ee',
        15: '#f3f4f6',
    },
});

/**
 * parses ansi escape codes and returns html string
 */
export function parseAnsi(text: string): string {
    return converter.toHtml(text);
}
