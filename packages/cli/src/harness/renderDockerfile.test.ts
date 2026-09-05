import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDockerfile } from './renderDockerfile';

test('renderDockerfile: harness images include git for repository inspection', () => {
  const dockerfile = renderDockerfile({
    label: 'Pi Coding Agent CLI harness.',
    npmPackage: '@earendil-works/pi-coding-agent',
  });

  assert.match(
    dockerfile,
    /^RUN apk add --no-cache git\s+&& npm install -g .*@earendil-works\/pi-coding-agent/m
  );
});