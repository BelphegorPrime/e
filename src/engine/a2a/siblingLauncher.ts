/**
 * **Which kind of sibling a request becomes.** A Sibling run is normally a
 * child `e spawn` process, but a request naming a Remote agent has no image
 * to build and no container to start - the host answers it in-process over
 * A2A instead (ADR-0015). The fork is one decision and it lives here rather
 * than in the spawn executor, whose subject is images and containers.
 *
 * It sits in `a2a/` and not in `runs/` on purpose: `runs/` owns the child
 * process and must not learn about the A2A client, while `a2a/` already
 * depends on `runs/` for the handle both kinds return. That keeps the
 * dependency one-way - `spawn` over `a2a` over `runs`.
 */

import { spawnChildProcess, type ChildLauncher } from '../runs/childRun.js';
import { findAgent, isRemoteAgent } from '../../core/agent/index.js';
import { remoteSiblingProcess } from './remoteSibling.js';
import { A2aClient } from './client.js';

/**
 * The production sibling launcher (ADR-0013, ADR-0015): a request for a
 * harness agent becomes a child `e spawn` process; one for a Remote agent
 * (`transport: "a2a"` in its `agent.json`) is answered in-process by the A2A
 * client, its headers' `${VAR}` references resolved from the store env. An
 * unknown agent is left to the child process, whose error lands in the log -
 * one place reports "no such agent", rather than two that could word it
 * differently.
 */
export function productionSiblingLauncher(
  root: string | undefined,
  storeEnv: Record<string, string>
): ChildLauncher {
  return launch => {
    let agent;
    try {
      agent = findAgent(launch.request.agent, root);
    } catch {
      agent = undefined;
    }
    if (agent && isRemoteAgent(agent)) {
      return remoteSiblingProcess({
        agent,
        request: launch.request,
        spoolDir: launch.spoolDir,
        storeEnv,
        client: new A2aClient(),
      });
    }
    return spawnChildProcess(launch);
  };
}
