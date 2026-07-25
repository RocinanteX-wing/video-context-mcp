#!/usr/bin/env node

// Deterministic terminal replay for docs/demo.tape. This script does not call a
// model or MCP server; it presents a concise, source-grounded product demo.

const ESC = '\u001b[';
const color = {
  reset: `${ESC}0m`,
  cyan: `${ESC}38;2;137;220;235m`,
  blue: `${ESC}38;2;137;180;250m`,
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

await typeLines(
  [
    `${color.cyan}›${color.reset} Use video-context-mcp to investigate Coyle’s refund example.`,
    '  What does it reveal about the difference between Pydantic checks',
    '  and ontology checks? Give a concrete answer and cite the relevant',
    '  speech and on-screen timestamps.',
  ].map((value) => `${color.text}${value}${color.reset}`),
  7,
);

await sleep(1_400);
clear();
await typeLines(
  [
    `${color.mauve}•${color.reset} I’ll query the indexed video for Coyle’s refund example and use`,
    '  the matching transcript and slide evidence.',
  ].map((value) => `${color.text}${value}${color.reset}`),
  7,
);
await sleep(500);
line();
line(
  `${color.mauve}• Calling${color.reset} ${color.blue}video-context.search_videos${color.reset}`,
);
line(`    ${color.muted}video:${color.reset} Sir59K8ZDPU`);
line(`    ${color.muted}query:${color.reset} "Coyle refund Pydantic ontology validation"`);

await sleep(850);
line();
await type(
  `  └ ${color.peach}18:14${color.reset}  ${color.muted}speech ·${color.reset} Check types with Pydantic; results with ontology`,
  7,
);
line();
await sleep(650);
await type(
  `    ${color.peach}18:43${color.reset}  ${color.muted}screen ·${color.reset} “Pydantic in, ontology out”`,
  7,
);
line();
await sleep(650);
await type(
  `    ${color.peach}19:11${color.reset}  ${color.muted}speech ·${color.reset} “A second refund on the same order is a problem”`,
  7,
);
line();

await sleep(700);
line();
line(
  `${color.mauve}• Calling${color.reset} ${color.blue}video-context.get_transcript${color.reset}`,
);
await type(`    ${color.muted}range:${color.reset} 17:45–19:20`, 7);
line();
await sleep(1_100);

clear();
await typeLines(
  [
    `${color.mauve}•${color.reset} Coyle’s refund example shows why valid parameter types are not`,
    '  enough. A proposed second refund can have the expected types and',
    '  therefore pass Pydantic, while still violating the rule that the',
    '  same order should not be refunded again.',
    '',
  ].map((value) => `${color.text}${value}${color.reset}`),
  5,
);

await sleep(350);
line();
await typeLines(
  [
    '  The ontology checks the result against domain relationships and rules',
    '  before the agent changes anything. It therefore adds semantic',
    '  consistency, not just type validation.',
  ].map((value) => `${color.text}${value}${color.reset}`),
  5,
);

await sleep(500);
line();
await typeLines(
  [
    '  The Video Context MCP found the validation distinction at 18:14,',
    '  the supporting slide at 18:43, and the refund example at 19:11.',
  ].map((value) => `${color.muted}${value}${color.reset}`),
  5,
);

// Keep the answer visible through the end of the capture. VHS ends the capture
// while this process stays alive, so no shell prompt appears.
await sleep(60_000);
