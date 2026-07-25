#!/usr/bin/env node

// Deterministic terminal replay for docs/demo.tape. This script does not call a
// model or MCP server; it presents a concise, source-grounded product demo.

const ESC = '\u001b[';
const color = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  cyan: `${ESC}38;2;137;220;235m`,
  blue: `${ESC}38;2;137;180;250m`,
  green: `${ESC}38;2;166;227;161m`,
  mauve: `${ESC}38;2;203;166;247m`,
  peach: `${ESC}38;2;250;179;135m`,
  text: `${ESC}38;2;205;214;244m`,
  muted: `${ESC}38;2;147;153;178m`,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const write = (value = '') => process.stdout.write(value);
const line = (value = '') => write(`${value}\n`);

async function type(value, delay = 5) {
  for (const character of value) {
    write(character);
    await sleep(delay);
  }
}

async function typeLines(lines, delay = 5) {
  for (const value of lines) {
    await type(value, delay);
    line();
  }
}

function clear() {
  write(`${ESC}?25l${ESC}2J${ESC}H`);
}

await sleep(250);
clear();

line(`${color.bold}${color.cyan}❯ User${color.reset}`);
await typeLines(
  [
    'Using Coyle’s refund example, identify an output from run_tool()',
    'that could pass Pydantic validation but fail the ontology output',
    'check. Why can’t Pydantic detect the problem, and what additional',
    'guarantee does the ontology provide?',
  ].map((value) => `${color.text}${value}${color.reset}`),
  5,
);

await sleep(900);
clear();
await type(
  `${color.bold}${color.mauve}● Assistant${color.reset}  Searching the indexed video for Coyle’s refund example…`,
  5,
);
line();
await sleep(500);
line();
line(`${color.blue}video-context.search_videos${color.reset}`);
line(`  ${color.muted}video:${color.reset} Sir59K8ZDPU`);
line(`  ${color.muted}query:${color.reset} "Pydantic ontology refund example"`);

await sleep(850);
line();
line(`${color.green}✓ 2 relevant moments${color.reset}`);
await sleep(350);
await type(`${color.peach}18:43${color.reset}  “Pydantic in, ontology out”`, 7);
line();
await sleep(650);
await type(
  `${color.peach}19:11${color.reset}  “A second refund on the same order is a problem”`,
  7,
);
line();

await sleep(700);
line();
line(`${color.blue}video-context.get_transcript${color.reset}`);
await type(`  ${color.muted}range:${color.reset} 18:43–19:20`, 7);
line();
await sleep(900);

clear();
line(
  `${color.bold}${color.green}━━━ GROUNDED ANSWER ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${color.reset}`,
);
line();
await type(`${color.bold}A possible output is:${color.reset}`, 6);
line();
line();

await type(
  `${color.mauve}run_tool()${color.reset} → ${color.green}second refund on the same order${color.reset}`,
  7,
);
line();

line();
await typeLines(
  [
    'This can pass Pydantic if the refund parameters have the',
    'expected types. Pydantic validates those types; it does not',
    'know that another refund already exists for the same order.',
  ].map((value) => `${color.text}${value}${color.reset}`),
  4,
);

await sleep(350);
line();
await typeLines(
  [
    'The ontology checks the result against domain relationships',
    'and rules. It can reject the second refund, providing semantic',
    'consistency beyond valid data types.',
  ].map((value) => `${color.text}${value}${color.reset}`),
  4,
);

await sleep(500);
line();
line(`${color.green}✓ Answer grounded in video evidence at 18:43 and 19:11.${color.reset}`);

// Keep the answer visible through the end of the capture. VHS ends the capture
// while this process stays alive, so no shell prompt appears.
await sleep(60_000);
