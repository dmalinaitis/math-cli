// One raw-mode stdin for the whole session.
//
// Toggling raw mode off and on between prompts breaks input on Windows: while cooked, libuv starts a
// line-mode console read that survives the switch back to raw, so keys are echoed by the console and
// only arrive (as one chunk) after Enter. So: enter raw mode once, keep reading, and route data to
// whichever handler is current.
type Handler = (data: Buffer) => void;

let handler: Handler | undefined;
let started = false;

export function startRawInput() {
  if (started || !process.stdin.isTTY) return;
  started = true;
  process.stdin.setRawMode(true);
  process.stdin.on("data", (d: Buffer) => handler?.(d));
  process.stdin.resume();
  process.on("exit", () => {
    process.stdin.pause();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
  });
  exitWithTerminal();
}

// Quit when the terminal goes away, so closed windows never leave node running in the background.
// SIGHUP: the window was closed normally. EOF / errors on stdin or stdout: the console host died.
function exitWithTerminal() {
  const quit = () => process.exit(0);
  process.on("SIGHUP", quit);
  process.stdin.on("end", quit);
  process.stdin.on("close", quit);
  process.stdin.on("error", quit);
  process.stdout.on("error", quit);
}

// Route input to `h` until the returned function is called. Input with no handler is dropped.
export function onInput(h: Handler): () => void {
  startRawInput();
  handler = h;
  return () => {
    if (handler === h) handler = undefined;
  };
}
