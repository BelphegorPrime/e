import assert from 'node:assert';
import test from 'node:test';
import { renderDockerfile } from './renderDockerfile.js';

/** The valid outputs of the render - one `RUN skills add` per collection. */
const pi = {
  label: 'Pi Coding Agent CLI harness.',
  npmPackage: '@earendil-works/pi-coding-agent',
  npmFlags: ['--ignore-scripts'],
  setupSteps: ['pi install npm:pi-mcp-adapter', 'pi install npm:pi-web-access'],
  skillCollections: ['mattpocock/skills', 'JuliusBrussee/caveman'],
  skillsAgent: 'pi',
};

test('renderDockerfile: renders the harness base (label, install, setup steps, skills, workdir)', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(dockerfile, /^FROM node:lts-alpine/);
  assert.match(dockerfile, /# Pi Coding Agent CLI harness\./);
  assert.match(
    dockerfile,
    /RUN apk add --no-cache git && npm install -g --ignore-scripts @earendil-works\/pi-coding-agent/
  );
  assert.match(dockerfile, /^RUN pi install npm:pi-mcp-adapter$/m);
  assert.match(dockerfile, /^RUN pi install npm:pi-web-access$/m);
  assert.match(dockerfile, /WORKDIR \/workspace/);
});

test('renderDockerfile: runs the container as the non-root node user by default', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(dockerfile, /^USER node$/m);
  // USER is the last instruction, so the whole build runs as root and only the
  // runtime process drops privileges.
  const userIdx = dockerfile.lastIndexOf('USER node');
  assert.ok(userIdx > dockerfile.lastIndexOf('COPY'));
  assert.ok(userIdx > dockerfile.lastIndexOf('WORKDIR'));
});

test('renderDockerfile: gives the non-root runtime user a writable home', () => {
  const dockerfile = renderDockerfile(pi);
  assert.match(dockerfile, /^ENV HOME=\/home\/node$/m);
  // HOME is set before the skills install RUN, so `npx skills add -g` (which
  // resolves `~` from HOME) lands under the same home the runtime user reads.
  const homeIdx = dockerfile.indexOf('ENV HOME=/home/node');
  const skillsIdx = dockerfile.indexOf('npx -y skills@latest');
  assert.ok(homeIdx !== -1 && skillsIdx !== -1 && homeIdx < skillsIdx);
});

test('renderDockerfile: no USER or HOME relocation when the harness needs root', () => {
  const dockerfile = renderDockerfile({
    label: 'Root-needing harness.',
    npmPackage: 'bare-cli',
    runtimeUser: 'root',
  });
  assert.doesNotMatch(dockerfile, /USER/);
  assert.doesNotMatch(dockerfile, /ENV HOME=/);
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
