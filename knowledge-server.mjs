#!/usr/bin/env node
// =============================================================================
// MCP Knowledge Server — searches docs/knowledge/ via semantic routing
// Zero dependencies. Implements MCP JSON-RPC 2.0 over stdio.
//
// Tool: docs_search(query) → Gemini selects relevant files by default
// Tool: docs_reindex(parallel) → rebuilds .semantic-index.json via build-index.sh
// =============================================================================

import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import { homedir } from 'os';

// Resolve default project root at startup (used when caller doesn't specify):
// --project /path, or CLAUDE_PROJECT_DIR, or cwd of the server process.
// Per-call override via tool argument `projectPath` takes precedence.
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectArgIdx = process.argv.indexOf('--project');
const DEFAULT_PROJECT_DIR = (projectArgIdx !== -1 && process.argv[projectArgIdx + 1])
  ? process.argv[projectArgIdx + 1]
  : process.env.CLAUDE_PROJECT_DIR || process.cwd();

const DEFAULT_ROUTER_PROVIDER = (process.env.KNOWLEDGE_ROUTER_PROVIDER || 'gemini').toLowerCase();
const DEFAULT_GEMINI_MODEL = process.env.KNOWLEDGE_GEMINI_MODEL || 'gemini-3.5-flash';
const DEFAULT_CLAUDE_MODEL = process.env.KNOWLEDGE_CLAUDE_MODEL || 'haiku';

// Global cross-project docs (docs-projects/): merged into EVERY docs_search
// regardless of which project the search runs from. Entries get the
// `docs-global/` path prefix so the router/agent can tell them apart and we
// can resolve fullPath back to the global dir. Index there is maintained by
// hand (.semantic-index.json next to the files) — no build-index.sh.
const GLOBAL_DOCS_DIR = process.env.KNOWLEDGE_GLOBAL_DIR
  || join(homedir(), 'Global-Templates', '🧩 Code-Patterns', 'docs-projects');
const GLOBAL_PREFIX = 'docs-global/';

// Per-project index cache: { projectDir → entries[] }
const indexCache = new Map();

// Global docs index — loaded fresh on each call (tiny file, hand-edited;
// no restart needed after adding a pattern). Paths get GLOBAL_PREFIX.
function loadGlobalIndex() {
  const indexPath = join(GLOBAL_DOCS_DIR, '.semantic-index.json');
  try {
    const entries = JSON.parse(readFileSync(indexPath, 'utf8'));
    return entries.map(e => ({ ...e, path: GLOBAL_PREFIX + e.path }));
  } catch {
    return []; // global index is optional — absence must never break project search
  }
}

function loadIndex(projectDir) {
  if (indexCache.has(projectDir)) return indexCache.get(projectDir);
  const indexPath = join(projectDir, '.semantic-index.json');
  try {
    const entries = JSON.parse(readFileSync(indexPath, 'utf8'));
    indexCache.set(projectDir, entries);
    process.stderr.write(`[knowledge-server] Loaded ${entries.length} entries from ${indexPath}\n`);
    return entries;
  } catch (e) {
    process.stderr.write(`[knowledge-server] Cannot load index at ${indexPath}: ${e.message}\n`);
    return null;
  }
}

// Resolve an index-relative path to an absolute file path, mapping
// docs-global/* entries to GLOBAL_DOCS_DIR instead of the project dir.
function resolveEntryFullPath(relPath, projectDir) {
  if (relPath.startsWith(GLOBAL_PREFIX)) {
    return join(GLOBAL_DOCS_DIR, relPath.slice(GLOBAL_PREFIX.length));
  }
  return join(projectDir, relPath);
}

function resolveProjectDir(args) {
  // Priority: explicit arg → CLAUDE_PROJECT_DIR (refreshed per call) → startup default
  const startDir = args?.projectPath || process.env.CLAUDE_PROJECT_DIR || DEFAULT_PROJECT_DIR;
  return findProjectRoot(startDir) || startDir;
}

function isDirectory(filePath) {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function walkUpDirs(startPath) {
  const dirs = [];
  let dir = isDirectory(startPath) ? startPath : dirname(startPath);

  while (dir) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return dirs;
}

function findProjectRoot(startPath) {
  for (const dir of walkUpDirs(startPath)) {
    if (existsSync(join(dir, '.semantic-index.json')) || existsSync(join(dir, 'scripts', 'ai', 'build-index.sh'))) {
      return dir;
    }
  }
  return null;
}

function parseEnvFileValue(filePath, key) {
  try {
    const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
      const eqIdx = normalized.indexOf('=');
      if (eqIdx === -1) continue;

      const name = normalized.slice(0, eqIdx).trim();
      if (name !== key) continue;

      let value = normalized.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '');
      }
      return value;
    }
  } catch {
    return '';
  }
  return '';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function getGeminiApiKey(projectDir) {
  if (process.env.GEMINI_API_KEY) {
    return { key: process.env.GEMINI_API_KEY, source: 'process.env.GEMINI_API_KEY' };
  }

  const candidates = unique([
    process.env.KNOWLEDGE_GEMINI_ENV,
    ...walkUpDirs(projectDir).map(dir => join(dir, '.env')),
    ...walkUpDirs(DEFAULT_PROJECT_DIR).map(dir => join(dir, '.env')),
    join(homedir(), '.noted-terminal', '.env'),
  ]);

  for (const filePath of candidates) {
    const key = parseEnvFileValue(filePath, 'GEMINI_API_KEY');
    if (key) return { key, source: filePath };
  }

  return { key: '', source: '', checked: candidates };
}

function normalizeProvider(provider) {
  const value = String(provider || DEFAULT_ROUTER_PROVIDER || 'gemini').toLowerCase();
  if (value === 'claude' || value === 'haiku' || value === 'anthropic') return 'claude';
  if (value === 'gemini' || value === 'google') return 'gemini';
  return value;
}

function defaultModelForProvider(provider) {
  return provider === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_GEMINI_MODEL;
}

function truncateText(value, max = 500) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function compactErrorMessage(error, max = 500) {
  return truncateText(String(error?.message || error || '').replace(/\s+/g, ' ').trim(), max);
}

function parseRouterFilePaths(stdout) {
  let filePaths = [];
  try {
    filePaths = JSON.parse(stdout.trim());
  } catch {
    const matches = stdout.match(/"[^"]+\.md"/g);
    if (matches) filePaths = matches.map(m => m.replace(/"/g, ''));
  }
  return Array.isArray(filePaths) ? filePaths : [];
}

function extractGeminiText(raw) {
  const parts = raw?.candidates?.[0]?.content?.parts || [];
  const visibleText = parts
    .filter(part => typeof part.text === 'string' && !part.thought)
    .map(part => part.text)
    .join('');
  if (visibleText) return visibleText;
  const lastText = [...parts].reverse().find(part => typeof part.text === 'string')?.text;
  return lastText || '';
}

async function routeViaGemini(userMsg, projectDir, model) {
  if (typeof fetch !== 'function') {
    throw new Error('Node fetch() is unavailable; run the MCP server with Node 18+ or use provider="claude"');
  }

  const keyInfo = getGeminiApiKey(projectDir);
  if (!keyInfo.key) {
    throw new Error(`GEMINI_API_KEY not configured. Checked: ${(keyInfo.checked || []).join(', ')}`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(keyInfo.key)}`;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: userMsg }] }],
        systemInstruction: { parts: [{ text: ROUTER_PROMPT }] },
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
        },
      }),
    });

    const rawText = await response.text();
    let raw = null;
    try {
      raw = JSON.parse(rawText);
    } catch {
      throw new Error(`Gemini returned non-JSON HTTP response: ${rawText.slice(0, 300)}`);
    }

    if (!response.ok || raw?.error) {
      throw new Error(`Gemini API error (${response.status}): ${raw?.error?.message || rawText.slice(0, 300)}`);
    }

    const text = extractGeminiText(raw);
    if (!text) throw new Error(`Gemini returned no text. Raw: ${rawText.slice(0, 300)}`);
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function routeViaClaude(userMsg, projectDir, model) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const child = execFile('claude', [
      '-p',
      '--model', model,
      '--system-prompt', ROUTER_PROMPT,
      '--no-session-persistence'
    ], {
      cwd: projectDir,
      env,
      timeout: 60000,
      maxBuffer: 5 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });

    child.stdin.write(userMsg);
    child.stdin.end();
  });
}

// Eager-load default index so the client can see what's available immediately
loadIndex(DEFAULT_PROJECT_DIR);

// ---------------------------------------------------------------------------
// Semantic Router
// ---------------------------------------------------------------------------

const ROUTER_PROMPT = `You are a Semantic Router for a software project.
Task: select ALL files from the index that are ACTUALLY needed to solve the developer request. No limit on count — if the request touches 10 topics, return 10 files.

INDEX SCOPE — files come from FOUR locations, all equally important:
- docs/knowledge/ — fact-*.md (how subsystems work) and fix-*.md (bugs and scars)
- docs/methodology/ — переносимый-дизайн.md / design.md (UX philosophy), сценарии-багов.md / design-bugs.md (UI bug catalog), мобильный-дизайн.md / design-mobile.md, сценарии-использования.md (user-flow scenarios), bug-цепочки.md (cross-feature graph), диагностика.md (diagnostic principles)
- docs/product/ — marketing, legal, pricing, landing copy
- docs-global/ — GLOBAL cross-project UX patterns and recipes (shared across ALL projects: tooltip/popover/modal scenarios, component inspector setup, drag-and-drop models). Select them by symptoms exactly like project files — when the request designs or fixes a UI element class covered there, the global file is the canonical pattern and the project file is its local implementation. Return BOTH when both match.

Methodology files are NOT optional — they answer "WHY did we choose this behavior" and "what UI principles apply here". Without them Claude reinvents already-discussed solutions and repeats fixed bugs.

ACTIVATION RULES BY REQUEST TYPE:

A) NEW FEATURE IMPLEMENTATION ("implement", "add UI for", "build new screen/panel"):
   → MUST include docs/methodology/переносимый-дизайн.md (or design.md) if it exists
   → MUST include docs/methodology/сценарии-багов.md (or design-bugs.md) if it exists — to avoid catalog of typical UI bugs
   → MUST include docs/methodology/сценарии-использования.md if it exists — to know existing user-flows
   → PLUS docs-global/* entries whose symptoms match the UI element class being built (tooltip/popover/modal/DnD/inspector etc.)
   → PLUS fact-*/fix-* from the related subsystem area

B) BUG FIX ("fix", "broken", "not working", "stale", symptom-described request):
   → fix-*.md matching the symptom
   → fact-*.md of the same subsystem
   → docs/methodology/сценарии-багов.md (or design-bugs.md) for known UI-bug classes

C) FEATURE MODIFICATION ("change behavior of X", "extend Y"):
   → fact-X.md + neighboring fact-*/fix-* in the same feature area
   → docs/methodology/bug-цепочки.md if it exists — cross-feature regression map

D) MARKETING / LEGAL / PRODUCT COPY ("write landing", "update pricing", "legal text"):
   → docs/product/* ONLY. Do NOT pull knowledge/ files

E) DOC/TEST/TOOLING WORKFLOW ("how do I test", "deploy script"):
   → docs/methodology/диагностика.md if it exists
   → relevant fact-*

SELECTION ALGORITHM:

STEP 1 — Identify request type (A-E above).

STEP 2 — Identify the SYMPTOM or topic:
What exactly is needed? UI not updating? Data empty? New feature? Marketing copy?

STEP 3 — Apply activation rules for the request type — methodology files come FIRST when applicable.

STEP 4 — Think about ROOT CAUSE, not keywords:
Do NOT grab a file by word overlap! Think about the CAUSE.

STEP 5 — Check the "symptoms" field in each index entry:
Every entry has a "symptoms" array with descriptions of WHEN that file is needed.
Compare the request against ALL symptoms. This is the PRIMARY matching mechanism for knowledge/.

STEP 6 — Check cross-domain bridges:
a) Zustand silent mutation — "not updating", "stale" → fix-zustand-silent-mutation.md
b) Sync marker timing — paste/command "hangs", "lost" → fix-stale-sync-markers.md
c) Paste path routing — paste "breaks", "duplicates" → fact-terminal-core.md
d) CSS visibility chain — terminal "garbage", "not redrawn" → fact-terminal-rendering.md
e) JSONL chain — Timeline/export "wrong", "skips" → fact-backtrace-jsonl.md
f) React useEffect + IPC — button "disappears" after tab create → fact-terminal-core.md
g) Vite escaping — escape sequences "broken" after build → fix-environment.md

STEP 7 — Scan implicit tags across ALL entries.

RULES:
- Select as many files as needed to cover ALL aspects of the request. No upper limit.
- Do NOT artificially limit to 2-5 files. If the query covers multiple topics, include files for EACH topic.
- For new-feature / feature-modification requests — ALWAYS pull methodology files alongside subsystem facts. Skipping methodology = Claude reinvents UI patterns and repeats fixed bugs.
- Marketing/legal queries — ONLY product/ files, NEVER knowledge/.

Respond ONLY with a valid JSON array of paths. No markdown, no explanations.
Example: ["docs/methodology/переносимый-дизайн.md", "docs/knowledge/fact-terminal-core.md", "docs/knowledge/fix-zustand-silent-mutation.md"]`;

async function searchKnowledge(query, projectDir, options = {}) {
  if (!query || !query.trim()) {
    return { found: 0, message: 'Empty query', files: [], projectDir };
  }

  const projectIndex = loadIndex(projectDir);
  if (!projectIndex) {
    return {
      found: 0,
      projectDir,
      error: `No .semantic-index.json found at ${join(projectDir, '.semantic-index.json')}`,
      hint: 'Run `bash scripts/ai/build-index.sh` in this project, or pass projectPath to a project that has an index.',
      files: []
    };
  }

  // Merge global cross-project patterns (docs-global/*) into every search.
  const globalIndex = loadGlobalIndex();
  const index = globalIndex.length ? [...projectIndex, ...globalIndex] : projectIndex;

  const provider = normalizeProvider(options.provider);
  const model = options.model || defaultModelForProvider(provider);
  const indexCompact = JSON.stringify(index);
  const userMsg = `Developer request: ${query}\n\nAvailable index:\n${indexCompact}`;

  async function attempt(attemptProvider, attemptModel) {
    const providerLabel = attemptProvider === 'claude' ? 'Claude' : 'Gemini';
    process.stderr.write(`[knowledge-server] [${projectDir}] Routing query via ${providerLabel}/${attemptModel}: "${query.slice(0, 80)}..."\n`);

    let stdout = '';
    if (attemptProvider === 'claude') {
      stdout = await routeViaClaude(userMsg, projectDir, attemptModel);
    } else if (attemptProvider === 'gemini') {
      stdout = await routeViaGemini(userMsg, projectDir, attemptModel);
    } else {
      return { ok: false, result: { found: 0, projectDir, provider: attemptProvider, model: attemptModel, error: `Unsupported docs_search provider: ${attemptProvider}`, files: [] } };
    }

    const filePaths = parseRouterFilePaths(stdout);
    if (filePaths.length === 0) {
      process.stderr.write(`[knowledge-server] ${providerLabel} returned no files. Raw: ${stdout.slice(0, 200)}\n`);
      return {
        ok: false,
        result: {
          found: 0,
          projectDir,
          provider: attemptProvider,
          model: attemptModel,
          message: `${providerLabel} returned no matching files`,
          raw: stdout.slice(0, 300),
          files: []
        }
      };
    }

    const files = filePaths.map(relPath => {
      const entry = index.find(e => e.path === relPath);
      return {
        path: relPath,
        fullPath: resolveEntryFullPath(relPath, projectDir),
        symptoms: entry?.symptoms || []
      };
    });

    process.stderr.write(`[knowledge-server] ${providerLabel} selected ${files.length} files: ${filePaths.map(p => p.split('/').pop()).join(', ')}\n`);
    return {
      ok: true,
      result: {
        found: files.length,
        projectDir,
        provider: attemptProvider,
        model: attemptModel,
        query,
        instruction: 'Use the Read tool to read these files (use the absolute fullPath) before proceeding.',
        files
      }
    };
  }

  let primary;
  try {
    primary = await attempt(provider, model);
  } catch (error) {
    const providerLabel = provider === 'claude' ? 'Claude' : 'Gemini';
    const message = compactErrorMessage(error);
    process.stderr.write(`[knowledge-server] ${providerLabel} error: ${message}\n`);
    if (error.stderr) process.stderr.write(`[knowledge-server] ${providerLabel} stderr: ${String(error.stderr).slice(0, 500)}\n`);
    primary = {
      ok: false,
      result: {
        found: 0,
        projectDir,
        provider,
        model,
        error: message,
        stderr: truncateText(error.stderr, 300),
        files: []
      }
    };
  }

  if (primary.ok || provider !== 'claude') {
    return primary.result;
  }

  const fallbackProvider = 'gemini';
  const fallbackModel = options.fallbackModel || process.env.KNOWLEDGE_FALLBACK_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  process.stderr.write(`[knowledge-server] Claude failed or returned no files; falling back to Gemini/${fallbackModel}\n`);

  try {
    const fallback = await attempt(fallbackProvider, fallbackModel);
    if (fallback.ok) {
      fallback.result.fallbackFrom = {
        provider,
        model,
        error: primary.result.error,
        message: primary.result.message,
        raw: primary.result.raw
      };
    }
    return fallback.result;
  } catch (error) {
    const message = compactErrorMessage(error);
    process.stderr.write(`[knowledge-server] Gemini fallback error: ${message}\n`);
    if (error.stderr) process.stderr.write(`[knowledge-server] Gemini fallback stderr: ${String(error.stderr).slice(0, 500)}\n`);
    return {
      found: 0,
      projectDir,
      provider: fallbackProvider,
      model: fallbackModel,
      error: message,
      stderr: truncateText(error.stderr, 300),
      fallbackFrom: {
        provider,
        model,
        error: primary.result.error,
        message: primary.result.message,
        raw: primary.result.raw
      },
      files: []
    };
  }
}

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

function parseIndexerErrorCount(stdout) {
  const matches = [...String(stdout || '').matchAll(/err:\s*(\d+)/g)];
  if (!matches.length) return 0;
  return Number(matches[matches.length - 1][1] || 0);
}

function runReindexAttempt(parallel, projectDir, provider, model) {
  return new Promise((resolve) => {
    const script = join(projectDir, 'scripts', 'ai', 'build-index.sh');
    const env = { ...process.env };
    const args = [script, '--parallel', String(parallel)];

    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    if (provider === 'gemini') {
      const keyInfo = getGeminiApiKey(projectDir);
      if (!keyInfo.key) {
        resolve({
          success: false,
          projectDir,
          provider,
          model,
          error: `GEMINI_API_KEY not configured. Checked: ${(keyInfo.checked || []).join(', ')}`
        });
        return;
      }

      let scriptText = '';
      try {
        scriptText = readFileSync(script, 'utf8');
      } catch (e) {
        resolve({ success: false, projectDir, provider, model, error: `Cannot read ${script}: ${e.message}` });
        return;
      }

      if (!scriptText.includes('--gemini-write')) {
        resolve({
          success: false,
          projectDir,
          provider,
          model,
          error: `${script} does not support --gemini-write yet; update the project indexer before using Gemini reindex`
        });
        return;
      }

      env.GEMINI_API_KEY = keyInfo.key;
      env.GEMINI_MODEL = model;
      args.push('--gemini-write');
    } else if (provider !== 'claude') {
      resolve({ success: false, projectDir, provider, model, error: `Unsupported docs_reindex provider: ${provider}` });
      return;
    }

    process.stderr.write(`[knowledge-server] [${projectDir}] Reindexing via ${provider}/${model} with --parallel ${parallel}...\n`);

    execFile('bash', args, {
      cwd: projectDir,
      env,
      timeout: 10 * 60 * 1000,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = compactErrorMessage(error);
        process.stderr.write(`[knowledge-server] Reindex error: ${message}\n`);
        resolve({ success: false, projectDir, provider, model, error: message, stdout: stdout?.slice(-2000), stderr: stderr?.slice(-2000) });
        return;
      }

      const lines = stdout.trim().split('\n');
      const summary = lines.slice(-15).join('\n');
      const errorCount = parseIndexerErrorCount(stdout);
      if (errorCount > 0) {
        process.stderr.write(`[knowledge-server] Reindex via ${provider}/${model} completed with ${errorCount} indexing errors\n`);
        resolve({
          success: false,
          projectDir,
          provider,
          model,
          error: `${provider} reindex completed with ${errorCount} indexing errors`,
          stdout: stdout?.slice(-2000),
          stderr: stderr?.slice(-2000),
          summary
        });
        return;
      }

      // Invalidate cache and reload
      indexCache.delete(projectDir);
      const reloaded = loadIndex(projectDir);

      resolve({ success: true, projectDir, provider, model, summary, entries: reloaded?.length ?? 0 });
    });
  });
}

async function reindex(parallel, projectDir, options = {}) {
  const provider = normalizeProvider(options.provider || process.env.KNOWLEDGE_INDEX_PROVIDER || DEFAULT_ROUTER_PROVIDER);
  const model = options.model || defaultModelForProvider(provider);
  const primary = await runReindexAttempt(parallel, projectDir, provider, model);

  if (primary.success || provider !== 'claude') {
    return primary;
  }

  const fallbackProvider = 'gemini';
  const fallbackModel = options.fallbackModel || process.env.KNOWLEDGE_FALLBACK_GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  process.stderr.write(`[knowledge-server] Claude reindex failed; falling back to Gemini/${fallbackModel}\n`);

  const fallback = await runReindexAttempt(parallel, projectDir, fallbackProvider, fallbackModel);
  fallback.fallbackFrom = {
    provider,
    model,
    error: primary.error,
    stdout: primary.stdout,
    stderr: primary.stderr,
    summary: primary.summary
  };
  return fallback;
}

// ---------------------------------------------------------------------------
// MCP Protocol (JSON-RPC 2.0 over stdio, newline-delimited)
// ---------------------------------------------------------------------------

const TOOL_DEF = {
  name: 'docs_search',
  description:
    'Search project knowledge base (docs/knowledge/) for architecture docs, known bugs, workarounds, and subsystem behavior. ' +
    'Uses Gemini 3.5 by default. Claude/Haiku is still available via provider="claude". ' +
    'Use BEFORE modifying complex subsystems or when debugging unfamiliar issues. ' +
    'Query should describe what you need to know in English. ' +
    'By default searches the current project (CLAUDE_PROJECT_DIR or cwd). ' +
    'Pass `projectPath` to search a different project — e.g. when comparing patterns across repos.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'What you need to know — describe the problem, symptom, or subsystem'
      },
      projectPath: {
        type: 'string',
        description: 'Optional absolute path to a project root with .semantic-index.json. Defaults to current project.'
      },
      provider: {
        type: 'string',
        enum: ['gemini', 'claude'],
        description: 'Router provider. Defaults to gemini/gemini-3.5-flash. Use claude for Haiku explicitly.'
      },
      model: {
        type: 'string',
        description: 'Provider model name. Defaults: haiku for Claude, gemini-3.5-flash for Gemini.'
      },
      fallbackModel: {
        type: 'string',
        description: 'Gemini model for Claude fallback. Defaults to gemini-3.5-flash.'
      }
    },
    required: ['query']
  }
};

const REINDEX_DEF = {
  name: 'docs_reindex',
  description:
    'Rebuild the semantic index (.semantic-index.json) by running build-index.sh. ' +
    'Uses Gemini 3.5 by default. Claude/Haiku is still available via provider="claude". ' +
    'Run after adding or significantly changing knowledge files. Takes 2-5 minutes. ' +
    'Operates on the current project by default; pass `projectPath` to reindex a different one.',
  inputSchema: {
    type: 'object',
    properties: {
      parallel: {
        type: 'number',
        description: 'Number of parallel indexer workers (default: 5)'
      },
      projectPath: {
        type: 'string',
        description: 'Optional absolute path to project root. Defaults to current project.'
      },
      provider: {
        type: 'string',
        enum: ['gemini', 'claude'],
        description: 'Indexer provider. Defaults to gemini/gemini-3.5-flash. Use claude for Haiku explicitly.'
      },
      model: {
        type: 'string',
        description: 'Provider model name. Defaults: haiku for Claude, gemini-3.5-flash for Gemini.'
      },
      fallbackModel: {
        type: 'string',
        description: 'Gemini model for Claude fallback. Defaults to gemini-3.5-flash.'
      }
    }
  }
};

function handleMessage(msg) {
  const { method, params, id } = msg;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'knowledge-server', version: '2.0.0' }
      }
    };
  }

  if (method === 'notifications/initialized' || method?.startsWith('notifications/')) {
    return null;
  }

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: [TOOL_DEF, REINDEX_DEF] } };
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params;

    if (name === 'docs_search') {
      const projectDir = resolveProjectDir(args);
      searchKnowledge(args.query, projectDir, args || {}).then((result) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }) + '\n');
      });
      return '__async__';
    }

    if (name === 'docs_reindex') {
      const projectDir = resolveProjectDir(args);
      reindex(args.parallel || 5, projectDir, args || {}).then((result) => {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
        }) + '\n');
      });
      return '__async__';
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
        isError: true
      }
    };
  }

  if (id !== undefined) {
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }

  return null;
}

// Stdio transport
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    const response = handleMessage(msg);
    if (response !== null && response !== '__async__') {
      process.stdout.write(JSON.stringify(response) + '\n');
    }
  } catch (e) {
    process.stderr.write(`[knowledge-server] Parse error: ${e.message}\n`);
  }
});

process.stderr.write(`[knowledge-server] Started. DEFAULT_PROJECT_DIR=${DEFAULT_PROJECT_DIR}\n`);
