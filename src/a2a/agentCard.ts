/**
 * `e` as an A2A agent: the **agent card** (ADR-0015) an external orchestrator
 * reads at `/.well-known/agent-card.json` to learn what `e serve` does and
 * how to call it. Pure: the Store's agents in, the card out. Each harness
 * agent is one **skill**; a `message/send` names the skill it wants in the
 * message's `metadata.agent` (or `metadata.skillId`), and the task it opens
 * is one `e spawn` run whose artifact is the branch and PR/MR.
 */

import {
  A2A_PROTOCOL_VERSION,
  type WireAgentCard,
  type WireAgentSkill,
} from './wire.js';

/** What the card says about one selectable agent. */
export interface AgentCardAgent {
  name: string;
  harness: string;
  model: string | null;
  default: boolean;
}

export interface AgentCardInput {
  /** The JSON-RPC endpoint URL (`http://<host>:<port>/a2a`). */
  url: string;
  /** `e`'s version. */
  version: string;
  /** The Store's harness agents (remote A2A agents are not offered; that would be proxying). */
  agents: readonly AgentCardAgent[];
  /** True when the endpoint requires `Authorization: Bearer <E_A2A_TOKEN>`. */
  bearer: boolean;
  /** The repository the runs land in, for the description. */
  repository?: string;
}

/** The skill id and name are the agent's name; the description tells a caller what a task does. */
export function agentSkill(agent: AgentCardAgent): WireAgentSkill {
  const model = agent.model ? `, model ${agent.model}` : '';
  return {
    id: agent.name,
    name: agent.name,
    description:
      `Run the "${agent.name}" coding agent (${agent.harness} harness${model}) on this repository. ` +
      `Send the whole task as text: goal, scope, acceptance criteria, constraints. ` +
      `Name this skill in the message's metadata.agent. The task completes with the run branch, ` +
      `whether it was pushed, and the pull/merge request URL as a data part.`,
    tags: [
      'coding',
      'git',
      agent.harness,
      ...(agent.default ? ['default'] : []),
    ],
    examples: [
      `Add input validation to the signup form and cover it with tests (metadata.agent: "${agent.name}")`,
    ],
    inputModes: ['text/plain'],
    outputModes: ['text/plain', 'application/json'],
  };
}

export function renderAgentCard(input: AgentCardInput): WireAgentCard {
  const where = input.repository ? ` in ${input.repository}` : '';
  const card: WireAgentCard = {
    name: 'e',
    description:
      `e runs coding-agent harnesses (pi, Claude Code, Codex, opencode) in isolated containers, one git worktree per run${where}. ` +
      `Each skill is a Store agent; a task is one run whose result is a git branch and a pull/merge request. ` +
      `Tasks accept no follow-up input: put everything into the first message. ` +
      `SendMessage always returns at once with the submitted task (a run takes minutes): poll GetTask, or use SendStreamingMessage.`,
    version: input.version,
    supportedInterfaces: [
      {
        url: input.url,
        protocolBinding: 'JSONRPC',
        protocolVersion: A2A_PROTOCOL_VERSION,
      },
    ],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      extendedAgentCard: false,
    },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: input.agents.map(agentSkill),
    documentationUrl: 'https://github.com/BelphegorPrime/e',
  };
  if (input.bearer) {
    // A2A 1.0 (proto JSON) shapes, the ones the reference SDK's card
    // resolver reads; the 0.x `{ type: 'http' }` / `security` forms are not.
    card.securitySchemes = {
      bearer: {
        httpAuthSecurityScheme: {
          scheme: 'bearer',
          description: 'The E_A2A_TOKEN of the e serve process',
        },
      },
    };
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
  }
  return card;
}
