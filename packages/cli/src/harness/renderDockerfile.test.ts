import assert from 'node:assert';
import test from 'node:test';
import { renderDockerfile } from './renderDockerfile';

/** The valid outputs of the render — one `RUN skills add` per collection. */
const pi = {
  label: 'Pi Coding Agent CLI harness.',
  npmPackage: '@earendil-works/pi-coding-agent',
  npmFlags: ['--ignore-scripts'],
  skillCollections: ['mattpocock/skills', 'JuliusBrussee/caveman'],
  skillsAgent: 'pi',
};

test('renderDockerfile: renders the harness base (label, install, workdir)', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(dockerfile, /^FROM node:lts-alpine/);
  assert.match(dockerfile, /# Pi Coding Agent CLI harness\./);
  assert.match(
    dockerfile,
    /RUN apk add --no-cache git && npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/
  );
  assert.match(dockerfile, /WORKDIR \/workspace/);
});

test('renderDockerfile: honors flags and custom base image', () => {
  const dockerfile = renderDockerfile({
    label: 'Claude Code CLI harness.',
    npmPackage: '@anthropic-ai/claude-code',
    baseImage: 'node:22-alpine',
  });
  assert.match(dockerfile, /^FROM node:22-alpine/);
  assert.match(
    dockerfile,
    /RUN apk add --no-cache git && npm install -g @anthropic-ai\/claude-code/
  );
});

test('renderDockerfile: installs git so the skills CLI can clone at build time', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(
    dockerfile,
    /RUN apk add --no-cache git && npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/
  );
});

test('renderDockerfile: runs npx skills add per collection, agent-scoped', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(
    dockerfile,
    /RUN npx -y skills@latest add mattpocock\/skills -a pi -g -y --copy/
  );
  assert.match(
    dockerfile,
    /RUN npx -y skills@latest add JuliusBrussee\/caveman -a pi -g -y --copy/
  );
  // Each harness maps to the agent name its skills dir follows.
  const claude = renderDockerfile({
    label: 'Claude Code CLI harness.',
    npmPackage: '@anthropic-ai/claude-code',
    skillCollections: ['mattpocock/skills'],
    skillsAgent: 'claude-code',
  });
  assert.match(
    claude,
    /RUN npx -y skills@latest add mattpocock\/skills -a claude-code -g -y --copy/
  );
});

test('renderDockerfile: no skills when no collections or agent', () => {
  const dockerfile = renderDockerfile({
    label: 'Bare harness.',
    npmPackage: 'bare-cli',
  });
  assert.doesNotMatch(dockerfile, /npx -y skills@latest/);
  assert.doesNotMatch(dockerfile, /skillsBlock/);
  // Collections without an agent degrade gracefully (no install lines).
  const agentless = renderDockerfile({
    label: 'Bare harness.',
    npmPackage: 'bare-cli',
    skillCollections: ['mattpocock/skills'],
  });
  assert.doesNotMatch(agentless, /npx -y skills@latest/);
});
