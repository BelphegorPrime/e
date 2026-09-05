/**
 * Skill Tool Extension
 *
 * Registers a `skill` tool that lets the agent load skills on its own.
 * The agent calls it with a skill name, and the extension finds that skill
 * in the standard skill locations and returns its SKILL.md content.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { homedir } from "node:os";

const SKILL_MD = "SKILL.md";

interface SkillLocation {
  name: string;
  description: string;
  path: string;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Scan a directory for SKILL.md files: root files and nested skill dirs. */
async function scanDir(dir: string): Promise<SkillLocation[]> {
  const skills: SkillLocation[] = [];
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return skills;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let s;
    try {
      s = await stat(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      const skillMd = join(full, SKILL_MD);
      if (await pathExists(skillMd)) {
        await addSkill(skills, skillMd, entry);
      }
    } else if (entry === SKILL_MD) {
      // Root-level SKILL.md — use parent dir name as skill name
      await addSkill(skills, full, dirname(dir).split(/[\\/]/).pop() ?? "skill");
    }
  }
  return skills;
}

/** Extract a YAML scalar value for key (handles plain values and folded/literal block scalars). */
function yamlScalar(fm: string, key: string): string {
  const lines = fm.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx === -1) return "";
  const inline = lines[idx].slice(key.length + 1).trim();
  if (inline && inline !== ">" && inline !== "|") return inline;
  // Block scalar: collect following indented lines
  const parts: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l || !/^\s+\S/.test(l)) break;
    parts.push(l.trim());
  }
  return inline === "|" ? parts.join("\n") : parts.join(" ");
}

async function addSkill(skills: SkillLocation[], skillMd: string, fallbackName: string): Promise<void> {
  try {
    const content = await readFile(skillMd, "utf8");
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    const fm = frontmatter?.[1] ?? "";
    const name = yamlScalar(fm, "name") || fallbackName;
    const description = yamlScalar(fm, "description");
    if (!name || !description) return;
    skills.push({ name, description, path: skillMd });
  } catch {
    // skip unreadable skills
  }
}

export default function skillToolExtension(pi: ExtensionAPI) {
  /** Root directories to scan for skills. */
  function skillRoots(cwd: string): string[] {
    const home = homedir();
    const roots = new Set<string>([
      resolve(cwd, ".agents", "skills"),
      resolve(cwd, ".pi", "skills"),
      join(home, ".pi", "agent", "skills"),
      join(home, ".agents", "skills"),
    ]);
    return [...roots];
  }

  async function discover(cwd: string): Promise<SkillLocation[]> {
    const results: SkillLocation[] = [];
    for (const root of skillRoots(cwd)) {
      results.push(...(await scanDir(root)));
    }
    // Deduplicate by name, first wins
    const seen = new Set<string>();
    return results.filter((s) => {
      if (seen.has(s.name)) return false;
      seen.add(s.name);
      return true;
    });
  }

  /** Find a skill by exact name. */
  async function findSkill(name: string, cwd: string): Promise<SkillLocation | undefined> {
    const wanted = name.toLowerCase();
    const skills = await discover(cwd);
    return skills.find((s) => s.name.toLowerCase() === wanted);
  }

  pi.registerTool({
    name: "skill",
    label: "Skill",
    description:
      "Load a skill by name and return its full SKILL.md content. Skills are on-demand capability packages " +
      "with specialized workflows and instructions. When the active tools or context lack a needed capability, " +
      "look up available skills first with action=list, then load the matching one with action=load.",
    promptSnippet: "Look up and load skills on demand",
    promptGuidelines: [
      "Use skill when a task matches a skill description and the skill content is not already loaded.",
      "Use skill with action=list to see available skills when uncertain which skill a task needs.",
      "Skill references (e.g. 'grilling', 'tdd') that appear in user input usually name real skills; load them before following their instructions.",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("list"),
          Type.Literal("load"),
        ],
        { description: "list = show available skills; load = return a skill's full SKILL.md" },
      ),
      name: Type.Optional(
        Type.String({ description: "Skill name to load (required when action is load)" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "list") {
        const skills = await discover(ctx.cwd);
        if (skills.length === 0) {
          return {
            content: [{ type: "text", text: "No skills found in standard locations." }],
            details: { skills: [] },
          };
        }
        const lines = skills
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((s) => `- ${s.name}: ${s.description}`);
        const text = `Available skills:\n${lines.join("\n")}\n\nLoad one with skill action=load name=<name>.`;
        return {
          content: [{ type: "text", text }],
          details: { skills: skills.map((s) => ({ name: s.name, description: s.description })) },
        };
      }

      if (params.action === "load") {
        const name = params.name?.trim();
        if (!name) {
          throw new Error("skill load requires a 'name' parameter");
        }
        const skill = await findSkill(name, ctx.cwd);
        if (!skill) {
          const skills = await discover(ctx.cwd);
          const known = skills.map((s) => s.name).sort();
          const hint =
            known.length > 0
              ? `Available skills: ${known.join(", ")}`
              : "No skills found in standard locations.";
          throw new Error(`Skill not found: ${name}. ${hint}`);
        }
        const content = await readFile(skill.path, "utf8");
        const header = `# Skill: ${skill.name}\n\nPath: ${skill.path}\n\nUse relative paths from the skill directory:\n${dirname(skill.path)}\n\n`;
        return {
          content: [{ type: "text", text: header + content }],
          details: { name: skill.name, path: skill.path, description: skill.description },
        };
      }

      throw new Error(`Unknown action: ${JSON.stringify(params.action)}`);
    },
  });
}