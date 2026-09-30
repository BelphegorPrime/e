// Pure helpers of the e2e tracer (scripts/e2e/e2e.mjs), split out so
// `npm run test:ui-assets` covers them without a container engine.

/** Env var names whose values never land in a trace file. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i;

/** `NAME=value` with the value masked when the name looks like a secret. */
export function redactEnvEntry(entry) {
  const eq = entry.indexOf('=');
  if (eq < 0) return entry;
  const name = entry.slice(0, eq);
  return SECRET_NAME.test(name) ? `${name}=***` : entry;
}

/** A `docker inspect` object with its secret env values masked. */
export function redactInspect(inspect) {
  if (!inspect?.Config?.Env) return inspect;
  return {
    ...inspect,
    Config: { ...inspect.Config, Env: inspect.Config.Env.map(redactEnvEntry) },
  };
}

/** Masks `-e NAME=value` pairs of secret names inside a logged command line. */
export function redactCommandLine(line) {
  return line.replace(
    /(\s-e\s+)([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g,
    (m, flag, name, value) =>
      SECRET_NAME.test(name) ? `${flag}${name}=***` : `${flag}${name}=${value}`
  );
}

/** A file-system friendly slug of a command line, for step directory names. */
export function stepSlug(argv) {
  const words = argv
    .filter(a => !a.startsWith('-'))
    .slice(0, 3)
    .join('-');
  return (
    words
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'e'
  );
}

/**
 * Folds `docker events --format '{{json .}}'` records into per-object
 * lifecycles: containers (name, image, created/started/died, exit code,
 * destroyed) and networks/volumes (created, destroyed).
 */
export function foldEvents(events) {
  const containers = new Map();
  const networks = new Map();
  const volumes = new Map();
  const images = [];
  for (const ev of events) {
    const type = ev.Type ?? ev.type;
    const action = (ev.Action ?? ev.status ?? '').split(':')[0];
    const id = ev.Actor?.ID ?? ev.id;
    const attrs = ev.Actor?.Attributes ?? {};
    const at = ev.timeNano
      ? Math.floor(ev.timeNano / 1e6)
      : (ev.time ?? 0) * 1000;
    if (type === 'container') {
      const c = containers.get(id) ?? {
        id,
        name: attrs.name,
        image: attrs.image,
        actions: [],
      };
      c.name ??= attrs.name;
      c.image ??= attrs.image;
      c.actions.push(action);
      if (action === 'create') c.createdAt = at;
      if (action === 'start') c.startedAt = at;
      if (action === 'die') {
        c.diedAt = at;
        c.exitCode = Number(attrs.exitCode);
      }
      if (action === 'destroy') c.destroyedAt = at;
      containers.set(id, c);
    } else if (type === 'network') {
      const name = attrs.name ?? id;
      const n = networks.get(name) ?? { name, actions: [] };
      n.actions.push(action);
      if (action === 'create') n.created = true;
      if (action === 'destroy') n.destroyed = true;
      networks.set(name, n);
    } else if (type === 'volume') {
      const name = id;
      const v = volumes.get(name) ?? { name, actions: [] };
      v.actions.push(action);
      if (action === 'create') v.created = true;
      if (action === 'destroy') v.destroyed = true;
      volumes.set(name, v);
    } else if (type === 'image' && action === 'tag') {
      images.push(attrs.name ?? id);
    }
  }
  return {
    containers: [...containers.values()],
    networks: [...networks.values()],
    volumes: [...volumes.values()],
    images,
  };
}

/** Objects a step created and did not remove again. */
export function findLeaks(folded, stillExists = () => true) {
  return {
    containers: folded.containers
      .filter(c => c.createdAt !== undefined && c.destroyedAt === undefined)
      .filter(c => stillExists('container', c.id))
      .map(c => ({ name: c.name, id: c.id, running: c.diedAt === undefined })),
    networks: folded.networks
      .filter(n => n.created && !n.destroyed)
      .filter(n => stillExists('network', n.name))
      .map(n => n.name),
    volumes: folded.volumes
      .filter(v => v.created && !v.destroyed)
      .filter(v => stillExists('volume', v.name))
      .map(v => v.name),
  };
}

/**
 * What an upstream reply said, from the proxy's captured body: OpenAI
 * chat-completions, Responses API or Anthropic messages, as JSON or SSE,
 * folded into tool calls and text.
 */
export function describeUpstreamReply(raw) {
  if (!raw) return '(no reply captured)';
  const payloads = raw.includes('data:')
    ? raw
        .split('\n')
        .filter(l => l.startsWith('data:'))
        .map(l => l.slice(5).trim())
        .filter(l => l && l !== '[DONE]')
    : [raw];
  let text = '';
  const calls = new Map();
  for (const p of payloads) {
    let obj;
    try {
      obj = JSON.parse(p);
    } catch {
      continue;
    }
    // Responses API: completed items carry the whole call or message.
    if (obj.type === 'response.output_item.done') {
      const item = obj.item ?? {};
      if (item.type === 'function_call')
        calls.set(item.id ?? calls.size, {
          name: item.name,
          args: item.arguments ?? '',
        });
      if (item.type === 'message')
        text += (item.content ?? []).map(c => c.text ?? '').join('');
      continue;
    }
    // Anthropic messages: tool_use blocks and text/json deltas.
    if (
      obj.type === 'content_block_start' &&
      obj.content_block?.type === 'tool_use'
    ) {
      calls.set(`a${obj.index}`, { name: obj.content_block.name, args: '' });
      continue;
    }
    if (obj.type === 'content_block_delta') {
      if (obj.delta?.type === 'text_delta') text += obj.delta.text;
      if (obj.delta?.type === 'input_json_delta') {
        const c = calls.get(`a${obj.index}`);
        if (c) c.args += obj.delta.partial_json;
      }
      continue;
    }
    for (const choice of obj.choices ?? []) {
      const part = choice.delta ?? choice.message ?? {};
      if (typeof part.content === 'string') text += part.content;
      for (const tc of part.tool_calls ?? []) {
        const key = tc.index ?? tc.id ?? calls.size;
        const c = calls.get(key) ?? { name: '', args: '' };
        c.name += tc.function?.name ?? '';
        c.args += tc.function?.arguments ?? '';
        calls.set(key, c);
      }
    }
  }
  const parts = [...calls.values()].map(c => `${c.name}(${c.args})`);
  if (text.trim())
    parts.push(`text: ${JSON.stringify(text.trim()).slice(0, 80)}`);
  return parts.join(', ') || '(unparsed reply)';
}

/** Summarizes the stub model's JSONL log: one line per served request. */
export function summarizeModelLog(entries) {
  const requests = entries.filter(e => e.dir === 'req' && e.seq !== undefined);
  const replies = new Map(
    entries
      .filter(e => e.dir === 'res' && e.seq !== undefined)
      .map(e => [e.seq, e])
  );
  return requests.map(r => {
    const body = r.body ?? {};
    const tools = (body.tools ?? []).map(
      t => t.function?.name ?? t.name ?? t.type
    );
    const serves = r.serves;
    const served = serves
      ? serves.tools
        ? serves.tools
            .map(t => `${t.tool}(${JSON.stringify(t.args ?? {})})`)
            .join(', ')
        : serves.tool
          ? `${serves.tool}(${JSON.stringify(serves.args ?? {})})`
          : `text: ${JSON.stringify(serves.text ?? '').slice(0, 80)}`
      : r.upstream
        ? `upstream ${replies.get(r.seq)?.status ?? '?'}: ${describeUpstreamReply(replies.get(r.seq)?.raw)}`
        : '?';
    return {
      seq: r.seq,
      path: r.path,
      model: body.model,
      messages: (body.messages ?? body.input ?? []).length,
      tools,
      served,
    };
  });
}

/** Lines of `e`'s output worth surfacing in a summary. */
export function interestingLines(text) {
  const out = { commands: [], warnings: [], errors: [], successes: [] };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/^\[[^\]]*\] \[(out|err|tty)\] /, '');
    if (/^\s*> (docker|podman|nerdctl|finch|git) /.test(line))
      out.commands.push(redactCommandLine(line.trim()));
    else if (/\b(error|failed|fatal)\b/i.test(line))
      out.errors.push(line.trim());
    else if (/\b(warn|warning|could not)\b/i.test(line))
      out.warnings.push(line.trim());
    else if (/^\s*(✓|Created|Pushed|Merged|Run branch|Branch)/.test(line))
      out.successes.push(line.trim());
  }
  return out;
}

/** The last `n` non-empty lines of a combined log, build noise dropped. */
export function tailLines(text, n = 15) {
  return text
    .split('\n')
    .filter(l => l.trim() && !/\] \[(out|err)\] (#\d+ |\s*$)/.test(l))
    .slice(-n);
}

/** Renders a step's summary.md from the collected facts. */
export function renderSummary(s) {
  const lines = [];
  const dur = ms => `${(ms / 1000).toFixed(1)}s`;
  lines.push(`# Step ${s.step}: \`e ${s.argv.join(' ')}\``, '');
  lines.push(`- cwd: \`${s.cwd}\``);
  lines.push(
    `- exit: **${s.exit.code ?? 'none'}**${s.exit.signal ? ` (signal ${s.exit.signal})` : ''}${s.exit.timedOut ? ' TIMED OUT' : ''}`
  );
  lines.push(`- duration: ${dur(s.durationMs)}`);
  lines.push(`- model: ${s.model}`, '');

  if (s.tui) {
    lines.push(
      `## TUI (keys script ${s.tui.failed ? 'FAILED' : 'played'})`,
      ''
    );
    for (const st of s.tui.steps) {
      const what = ['wait', 'send', 'key', 'sleep', 'snapshot', 'exit']
        .filter(k => st[k] !== undefined)
        .map(k => `${k}=${JSON.stringify(st[k])}`)
        .join(' ');
      lines.push(
        `${st.step}. ${st.ok ? 'ok' : 'FAILED'} @${st.at?.toFixed(1)}s ${what}${st.error ? ` - ${st.error}` : ''}${st.file ? ` (tui/${st.file})` : ''}`
      );
    }
    const screen = s.tui.final.split('\n').slice(-40);
    lines.push(
      '',
      'Final screen (tui/final.txt):',
      '',
      '```',
      ...screen,
      '```',
      ''
    );
  }

  lines.push('## Engine commands e ran (full argv: commands.txt)', '');
  if (s.lines.commands.length === 0) lines.push('(none logged)');
  for (const c of s.lines.commands)
    lines.push(`- \`${c.length > 300 ? `${c.slice(0, 300)} ...` : c}\``);
  lines.push('');

  if (s.lines.errors.length || s.lines.warnings.length) {
    lines.push('## Errors and warnings in output', '');
    for (const e of s.lines.errors) lines.push(`- ERROR: ${e}`);
    for (const w of s.lines.warnings) lines.push(`- warn: ${w}`);
    lines.push('');
  }

  // Containers that only showed up through health checks or execs predate
  // the step (the user's local stack): not part of what the step did.
  const own = s.folded.containers.filter(
    c => c.createdAt !== undefined || c.startedAt !== undefined
  );
  if (s.tail?.length) {
    lines.push('## Last output lines', '', '```', ...s.tail, '```', '');
  }

  lines.push('## Containers', '');
  if (own.length === 0) lines.push('(none)');
  else {
    lines.push(
      '| name | image | exit | ran | removed | log |',
      '|---|---|---|---|---|---|'
    );
    for (const c of own) {
      const ran =
        c.startedAt && c.diedAt
          ? dur(c.diedAt - c.startedAt)
          : c.startedAt
            ? 'running'
            : '-';
      lines.push(
        `| ${c.name} | ${c.image} | ${c.exitCode ?? '-'} | ${ran} | ${c.destroyedAt ? 'yes' : 'no'} | containers/${c.name}.log |`
      );
    }
  }
  lines.push('');
  if (s.folded.networks.length) {
    lines.push('## Networks', '');
    for (const n of s.folded.networks)
      lines.push(`- ${n.name}: ${n.actions.join(' -> ')}`);
    lines.push('');
  }
  if (s.folded.images.length) {
    lines.push('## Images tagged', '');
    for (const i of s.folded.images) lines.push(`- ${i}`);
    lines.push('');
  }

  lines.push('## Model requests', '');
  if (s.modelSummary.length === 0)
    lines.push('(none - the harness never reached the model)');
  for (const r of s.modelSummary)
    lines.push(
      `${r.seq}. ${r.path} model=${r.model} msgs=${r.messages} tools=[${r.tools.join(',')}] -> ${r.served}`
    );
  lines.push('');

  lines.push('## Git after the step', '', '```', s.git.graph.trim(), '```', '');
  if (s.git.newBranches.length) {
    lines.push('New branches:', '');
    for (const b of s.git.newBranches)
      lines.push(
        `- \`${b.name}\`: ${b.stat.trim().split('\n').pop() ?? ''} (git/diffs/${b.file})`
      );
    lines.push('');
  }
  lines.push(
    'Remote (origin) refs:',
    '',
    '```',
    s.git.remote.trim() || '(none)',
    '```',
    ''
  );

  const leaks = s.leaks;
  const leaked =
    leaks.containers.length +
    leaks.networks.length +
    leaks.volumes.length +
    leaks.worktrees.length +
    (leaks.scratch?.length ?? 0);
  lines.push('## Leaks', '');
  if (!leaked) lines.push('none');
  for (const c of leaks.containers)
    lines.push(`- container ${c.name} (${c.running ? 'running' : 'stopped'})`);
  for (const n of leaks.networks) lines.push(`- network ${n}`);
  for (const v of leaks.volumes) lines.push(`- volume ${v}`);
  for (const w of leaks.worktrees) lines.push(`- worktree ${w}`);
  for (const w of leaks.kept ?? [])
    lines.push(
      `- (not a leak) worktree ${w}: kept by e for its uncommitted work, as announced`
    );
  for (const d of leaks.scratch ?? [])
    lines.push(`- scratch dir ${d} (rendered secrets left on disk)`);
  lines.push('');
  lines.push(
    '## Files',
    '',
    '- combined.log: stdout+stderr interleaved, timestamped (TUI: [tty], escapes stripped)',
    '- tui/: keys script journal, screen snapshots, final.txt; tty.raw: the raw pty stream',
    '- stdout.log / stderr.log: raw streams',
    '- docker-events.jsonl: every engine event during the step',
    '- containers/: inspect (secrets masked) and logs per container',
    '- model.jsonl: every model request and reply, in full',
    '- git/: graph, branches, worktrees, remote, per-branch diffs',
    '- store/: listing of the store and copies of its run records (sessions = harness transcripts)',
    '- spool/: broker spools mirrored live (sibling requests, status, child e logs)',
    ''
  );
  return lines.join('\n');
}
