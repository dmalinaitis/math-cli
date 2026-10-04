// Current terminal width in columns, read live from the console. process.stdout.columns is only
// refreshed on 'resize' events, which can arrive late (e.g. WezTerm adjusting the size for DPI just
// after the program starts), and a stale width makes lines overflow and wrap mid-word.
export function termCols(): number {
  try {
    const [cols] = process.stdout.getWindowSize();
    if (cols > 0) return cols;
  } catch {
    // not a TTY
  }
  return process.stdout.columns || 100;
}
