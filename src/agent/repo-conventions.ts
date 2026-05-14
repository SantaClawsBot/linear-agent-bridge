import fs from "node:fs";
import path from "node:path";

export const REPO_CONVENTION_FILES = ["AGENTS.md", "CLAUDE.md"];
const MAX_CONVENTION_BYTES = 4000;

/**
 * Try to read repo convention files (AGENTS.md, CLAUDE.md) from the repo dir.
 * Returns the first one found, capped at MAX_CONVENTION_BYTES.
 */
export function readRepoConventions(repoDir: string): string | null {
  if (!repoDir) return null;
  for (const filename of REPO_CONVENTION_FILES) {
    const filePath = path.join(repoDir, filename);
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.statSync(filePath);
      if (stat.size > MAX_CONVENTION_BYTES) {
        const buf = Buffer.alloc(MAX_CONVENTION_BYTES);
        const fd = fs.openSync(filePath, "r");
        fs.readSync(fd, buf, 0, MAX_CONVENTION_BYTES, 0);
        fs.closeSync(fd);
        return buf.toString("utf-8").replace(/\n[^]*$/, "\n\n... (truncated)");
      }
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (content) return content;
    } catch {
      // File not readable — skip silently
    }
  }
  return null;
}

const CONVENTIONAL_COMMIT_RE =
  /conventional\s+commit|semantic\s+(commit|pr|title)|feat\(.*?\):|fix\(.*?\):/i;

const PR_TITLE_EXAMPLE_RE = /[`'"]?(feat|fix|docs|chore|refactor|test|build|ci|perf|style|revert)(\([^)]*?\))?:[^\n`'"]+/g;

/**
 * Detect whether the repo conventions specify conventional commit / semantic PR titles.
 */
export function usesConventionalCommits(repoDir: string): boolean {
  const conventions = readRepoConventions(repoDir);
  if (!conventions) return false;
  return CONVENTIONAL_COMMIT_RE.test(conventions);
}

/**
 * Extract example conventional commit prefixes from the conventions file
 * (e.g. "feat(graph):", "fix(api):", "docs:").
 */
export function extractScopes(repoDir: string): string[] {
  const conventions = readRepoConventions(repoDir);
  if (!conventions) return [];
  const scopes: string[] = [];
  let match: RegExpExecArray | null;
  PR_TITLE_EXAMPLE_RE.lastIndex = 0;
  while ((match = PR_TITLE_EXAMPLE_RE.exec(conventions)) !== null) {
    const prefix = match[1]; // e.g. "feat"
    const scope = match[2]; // e.g. "(graph)" or undefined
    scopes.push(scope ? `${prefix}${scope}` : prefix);
  }
  return [...new Set(scopes)];
}

/**
 * Format an issue title into conventional commit style.
 *
 * Lowercases the issue title and converts to imperative mood as a best-effort
 * heuristic. Prepends a conventional type prefix.
 *
 * Returns null if the repo doesn't use conventional commits.
 */
export function formatConventionalTitle(
  issueIdentifier: string,
  issueTitle: string,
  repoDir: string,
): string | null {
  if (!usesConventionalCommits(repoDir)) return null;

  // Normalize: lowercase, strip trailing period, imperative-ish
  let description = issueTitle
    .trim()
    .replace(/\.$/, "")
    .toLowerCase();

  // Lowercase first letter of description (it already is, but be safe)
  description = description.charAt(0).toLowerCase() + description.slice(1);

  // Don't double-prefix if the title already looks conventional
  if (/^(feat|fix|docs|chore|refactor|test|build|ci|perf|style|revert)(\(|:)/.test(description)) {
    return `${issueIdentifier} ${description}`;
  }

  // Heuristic: detect type from the issue title
  const type = inferType(description);

  return `${issueIdentifier} ${type}: ${description}`;
}

function inferType(title: string): string {
  const t = title.toLowerCase();
  if (/\b(fix|bug|error|crash|broken|issue|wrong|incorrect|handle|repair)\b/.test(t)) return "fix";
  if (/\b(add|create|implement|support|introduce|new|build)\b/.test(t)) return "feat";
  if (/\b(doc|document|readme|guide|tutorial|comment)\b/.test(t)) return "docs";
  if (/\b(test|spec|coverage)\b/.test(t)) return "test";
  if (/\b(refactor|clean|restructure|simplify|rename|move)\b/.test(t)) return "refactor";
  if (/\b(ci|deploy|pipeline|workflow|build)\b/.test(t)) return "ci";
  if (/\b(perf|speed|optim|fast|slow|memory)\b/.test(t)) return "perf";
  if (/\b(chore|bump|update dep|upgrade|maintenance|housekeep)\b/.test(t)) return "chore";
  return "feat";
}
