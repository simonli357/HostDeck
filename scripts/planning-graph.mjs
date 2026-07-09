const TASK_ID_PATTERN = "(?:FND|DAT|INT|IFC|FE|REL)-V1-\\d+";
const REQUIREMENT_ID_PATTERN = "(?:FR|NFR|IR|DR|PR|SFR)-\\d{3}";

const TASK_ID = new RegExp(`^${TASK_ID_PATTERN}$`);
const REQUIREMENT_ID = new RegExp(`^${REQUIREMENT_ID_PATTERN}$`);
const BLOCK_ID = /^BLK-V1-\d{2}$/;
const TASK_STATUSES = new Set(["ready", "todo", "blocked", "in_progress", "done", "deferred"]);

function stripTicks(value) {
  return value.startsWith("`") && value.endsWith("`") ? value.slice(1, -1) : value;
}

function splitMarkdownRow(line) {
  const source = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells = [];
  let cell = "";
  let inCode = false;
  let escaped = false;

  for (const character of source) {
    if (escaped) {
      cell += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      cell += character;
      escaped = true;
      continue;
    }
    if (character === "`") {
      inCode = !inCode;
      cell += character;
      continue;
    }
    if (character === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
      continue;
    }
    cell += character;
  }

  cells.push(cell.trim());
  return cells;
}

function isSeparatorRow(line) {
  if (!line.trim().startsWith("|")) {
    return false;
  }
  const cells = splitMarkdownRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function parseMarkdownTables(text, source = "document") {
  const lines = text.split(/\r?\n/);
  const tables = [];

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].trim().startsWith("|") || !isSeparatorRow(lines[index + 1])) {
      continue;
    }

    const headers = splitMarkdownRow(lines[index]);
    const rows = [];
    let rowIndex = index + 2;
    while (rowIndex < lines.length && lines[rowIndex].trim().startsWith("|")) {
      if (!isSeparatorRow(lines[rowIndex])) {
        const cells = splitMarkdownRow(lines[rowIndex]);
        if (cells.length !== headers.length) {
          throw new Error(
            `${source}:${rowIndex + 1} has ${cells.length} cells; expected ${headers.length}`
          );
        }
        rows.push({ cells, line: rowIndex + 1 });
      }
      rowIndex += 1;
    }

    tables.push({ headers, rows, source, line: index + 1 });
    index = rowIndex - 1;
  }

  return tables;
}

function expandRange(start, end, pattern) {
  if (!pattern.test(start) || !pattern.test(end)) {
    return [];
  }
  const startMatch = /^(.*-)(\d+)$/.exec(start);
  const endMatch = /^(.*-)(\d+)$/.exec(end);
  if (!startMatch || !endMatch || startMatch[1] !== endMatch[1]) {
    return [];
  }
  const first = Number(startMatch[2]);
  const last = Number(endMatch[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first > last || last - first > 999) {
    return [];
  }
  const width = Math.max(startMatch[2].length, endMatch[2].length);
  return Array.from({ length: last - first + 1 }, (_, offset) => {
    return `${startMatch[1]}${String(first + offset).padStart(width, "0")}`;
  });
}

function extractIdsAndRanges(text, pattern, validator) {
  const ids = new Set();
  const rangePattern = new RegExp(`\`(${pattern})\`\\s+to\\s+\`(${pattern})\``, "g");
  for (const match of text.matchAll(rangePattern)) {
    for (const id of expandRange(match[1], match[2], validator)) {
      ids.add(id);
    }
  }

  const idPattern = new RegExp(`\`(${pattern})\``, "g");
  for (const match of text.matchAll(idPattern)) {
    ids.add(match[1]);
  }
  return [...ids];
}

export function extractTaskIds(text) {
  return extractIdsAndRanges(text, TASK_ID_PATTERN, TASK_ID);
}

export function extractRequirementIds(text) {
  const ids = new Set(extractIdsAndRanges(text, REQUIREMENT_ID_PATTERN, REQUIREMENT_ID));
  const rangePattern = new RegExp(
    `\\b(${REQUIREMENT_ID_PATTERN})\\s+to\\s+(${REQUIREMENT_ID_PATTERN})\\b`,
    "g"
  );
  for (const match of text.matchAll(rangePattern)) {
    for (const id of expandRange(match[1], match[2], REQUIREMENT_ID)) ids.add(id);
  }
  const idPattern = new RegExp(`\\b(${REQUIREMENT_ID_PATTERN})\\b`, "g");
  for (const match of text.matchAll(idPattern)) ids.add(match[1]);
  return [...ids];
}

function extractBlockIds(text) {
  const ids = new Set();
  for (const match of text.matchAll(/`(BLK-V1-\d{2})`/g)) {
    ids.add(match[1]);
  }
  return [...ids];
}

function normalizedHeaders(table) {
  return table.headers.map((header) => header.toLowerCase());
}

function hasHeaders(table, expected) {
  const actual = normalizedHeaders(table);
  return expected.length === actual.length && expected.every((header, index) => header === actual[index]);
}

export function parseTaskDocuments(documents) {
  const tasks = new Map();
  const errors = [];
  const expectedHeaders = [
    "id",
    "status",
    "refs",
    "requires",
    "blocked by",
    "blocks",
    "description",
    "success criteria",
    "validation / evidence"
  ];

  for (const document of documents) {
    for (const table of parseMarkdownTables(document.text, document.source)) {
      if (!hasHeaders(table, expectedHeaders)) {
        continue;
      }
      for (const row of table.rows) {
        const rawId = stripTicks(row.cells[0]);
        if (!TASK_ID.test(rawId)) {
          errors.push(`${document.source}:${row.line} has invalid task id ${row.cells[0]}`);
          continue;
        }
        if (tasks.has(rawId)) {
          const prior = tasks.get(rawId);
          errors.push(
            `${document.source}:${row.line} duplicates ${rawId} from ${prior.source}:${prior.line}`
          );
          continue;
        }

        tasks.set(rawId, {
          id: rawId,
          status: row.cells[1],
          refs: row.cells[2],
          requires: row.cells[3],
          blockedBy: row.cells[4],
          blocks: row.cells[5],
          description: row.cells[6],
          successCriteria: row.cells[7],
          evidence: row.cells[8],
          source: document.source,
          line: row.line
        });
      }
    }
  }

  return { tasks, errors };
}

export function parseRequirementsDocument(text, source = "requirements") {
  const requirements = new Set();
  const traces = [];
  const errors = [];

  for (const table of parseMarkdownTables(text, source)) {
    if (hasHeaders(table, ["id", "requirement", "priority", "validation"])) {
      for (const row of table.rows) {
        const id = stripTicks(row.cells[0]);
        if (!REQUIREMENT_ID.test(id)) {
          errors.push(`${source}:${row.line} has invalid requirement id ${row.cells[0]}`);
          continue;
        }
        if (requirements.has(id)) {
          errors.push(`${source}:${row.line} duplicates requirement ${id}`);
        }
        requirements.add(id);
      }
    }

    if (hasHeaders(table, ["requirement", "block refs", "task refs", "evidence route"])) {
      for (const row of table.rows) {
        const requirementIds = extractRequirementIds(row.cells[0]);
        const taskIds = extractTaskIds(row.cells[2]);
        if (requirementIds.length === 0) {
          errors.push(`${source}:${row.line} trace row has no requirement id`);
        }
        if (taskIds.length === 0) {
          errors.push(`${source}:${row.line} trace row has no task id`);
        }
        if (extractBlockIds(row.cells[1]).length === 0) {
          errors.push(`${source}:${row.line} trace row has no block id`);
        }
        if (row.cells[3].trim().length === 0) {
          errors.push(`${source}:${row.line} trace row has no evidence route`);
        }
        traces.push({
          requirementIds,
          taskIds,
          blockIds: extractBlockIds(row.cells[1]),
          source,
          line: row.line
        });
      }
    }
  }

  return { requirements, traces, errors };
}

export function parseQueueDocument(text, source = "queue") {
  const entries = [];
  const errors = [];

  for (const table of parseMarkdownTables(text, source)) {
    if (!hasHeaders(table, ["order", "task", "status", "blocked by", "why next"])) {
      continue;
    }
    for (const row of table.rows) {
      const ids = extractTaskIds(row.cells[1]);
      if (ids.length !== 1) {
        errors.push(`${source}:${row.line} queue row must contain exactly one task id`);
        continue;
      }
      entries.push({
        order: row.cells[0],
        id: ids[0],
        status: row.cells[2],
        blockedBy: row.cells[3],
        whyNext: row.cells[4],
        source,
        line: row.line
      });
    }
  }

  if (entries.length === 0) {
    errors.push(`${source} has no Current Next Queue task table`);
  }
  return { entries, errors };
}

function externalBlockerText(value) {
  let remainder = value;
  remainder = remainder.replace(
    new RegExp(`\`${TASK_ID_PATTERN}\`(?:\\s+to\\s+\`${TASK_ID_PATTERN}\`)?`, "g"),
    ""
  );
  remainder = remainder.replace(/[,:;]/g, " ").replace(/\band\b/gi, " ").trim();
  return remainder === "" || remainder.toLowerCase() === "none" ? "" : remainder;
}

function findCycles(tasks, dependencies) {
  const state = new Map();
  const stack = [];
  const cycles = [];

  function visit(id) {
    const current = state.get(id) ?? 0;
    if (current === 2) return;
    if (current === 1) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (tasks.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(id, 2);
  }

  for (const id of tasks.keys()) visit(id);
  return cycles;
}

export function validatePlanning({ tasks, requirements, traces, queue, blockIds }) {
  const errors = [];
  const dependencies = new Map();

  for (const task of tasks.values()) {
    const location = `${task.source}:${task.line}`;
    if (!TASK_STATUSES.has(task.status)) {
      errors.push(`${location} ${task.id} has invalid status ${task.status}`);
    }
    for (const [label, value] of [
      ["Refs", task.refs],
      ["Requires", task.requires],
      ["Blocked by", task.blockedBy],
      ["Blocks", task.blocks],
      ["Description", task.description],
      ["Success criteria", task.successCriteria],
      ["Validation / evidence", task.evidence]
    ]) {
      if (value.trim().length === 0) errors.push(`${location} ${task.id} has empty ${label}`);
    }

    const refs = extractBlockIds(task.refs);
    if (refs.length === 0) {
      errors.push(`${location} ${task.id} has no block reference`);
    }
    for (const blockId of refs) {
      if (!blockIds.has(blockId)) errors.push(`${location} ${task.id} references unknown ${blockId}`);
    }
    for (const requirementId of extractRequirementIds(task.refs)) {
      if (!requirements.has(requirementId)) {
        errors.push(`${location} ${task.id} references unknown requirement ${requirementId}`);
      }
    }

    const deps = extractTaskIds(task.blockedBy);
    dependencies.set(task.id, deps);
    for (const dependency of deps) {
      if (!tasks.has(dependency)) {
        errors.push(`${location} ${task.id} depends on unknown task ${dependency}`);
      }
      if (dependency === task.id) {
        errors.push(`${location} ${task.id} depends on itself`);
      }
    }
    for (const blockedTask of extractTaskIds(task.blocks)) {
      if (!tasks.has(blockedTask)) {
        errors.push(`${location} ${task.id} blocks unknown task ${blockedTask}`);
      }
    }

    const external = externalBlockerText(task.blockedBy);
    if (["ready", "in_progress"].includes(task.status)) {
      if (external) errors.push(`${location} ${task.id} is ${task.status} with external blocker: ${external}`);
      for (const dependency of deps) {
        if (tasks.get(dependency)?.status !== "done") {
          errors.push(`${location} ${task.id} is ${task.status} before ${dependency} is done`);
        }
      }
    }
    if (task.status === "done") {
      for (const dependency of deps) {
        if (tasks.get(dependency)?.status !== "done") {
          errors.push(`${location} done task ${task.id} has unfinished dependency ${dependency}`);
        }
      }
      if (!/artifacts\//.test(task.evidence) && !/evidence retained/i.test(task.evidence)) {
        errors.push(`${location} done task ${task.id} has no artifact/evidence-retained reference`);
      }
    }
    if (task.status === "todo") {
      const hasUnfinishedDependency = deps.some(
        (dependency) => tasks.has(dependency) && tasks.get(dependency)?.status !== "done"
      );
      if (!hasUnfinishedDependency && !external) {
        errors.push(`${location} todo task ${task.id} has no unfinished dependency; mark it ready`);
      }
    }
    if (task.status === "blocked" && deps.length === 0 && !external) {
      errors.push(`${location} blocked task ${task.id} has no blocker`);
    }
    if (!new Set(["done", "deferred"]).has(task.status)) {
      for (const dependency of deps) {
        if (tasks.get(dependency)?.status === "deferred") {
          errors.push(`${location} active task ${task.id} depends on deferred task ${dependency}`);
        }
      }
    }
  }

  for (const cycle of findCycles(tasks, dependencies)) {
    errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  const coveredRequirements = new Set();
  for (const trace of traces) {
    for (const requirement of trace.requirementIds) {
      if (!requirements.has(requirement)) {
        errors.push(`${trace.source}:${trace.line} traces unknown requirement ${requirement}`);
      }
      coveredRequirements.add(requirement);
    }
    for (const taskId of trace.taskIds) {
      if (!tasks.has(taskId)) errors.push(`${trace.source}:${trace.line} traces unknown task ${taskId}`);
    }
    for (const blockId of trace.blockIds) {
      if (!blockIds.has(blockId)) errors.push(`${trace.source}:${trace.line} traces unknown block ${blockId}`);
    }
  }
  for (const requirement of requirements) {
    if (!coveredRequirements.has(requirement)) errors.push(`requirement ${requirement} has no trace row`);
  }

  const queueIds = new Set();
  let inProgress = 0;
  for (const entry of queue) {
    const location = `${entry.source}:${entry.line}`;
    const task = tasks.get(entry.id);
    if (!task) {
      errors.push(`${location} queue references unknown task ${entry.id}`);
      continue;
    }
    if (queueIds.has(entry.id)) errors.push(`${location} queue duplicates ${entry.id}`);
    queueIds.add(entry.id);
    if (entry.status !== task.status) {
      errors.push(`${location} queue status ${entry.status} disagrees with ${entry.id} status ${task.status}`);
    }
    if (["ready", "in_progress"].includes(entry.status) && entry.blockedBy.trim() !== "none") {
      errors.push(`${location} current ${entry.status} task ${entry.id} must show no queue blocker`);
    }
    if (entry.status === "blocked" && entry.blockedBy.trim() === "none") {
      errors.push(`${location} blocked queue task ${entry.id} must name its blocker`);
    }
    if (!new Set(["ready", "in_progress", "blocked"]).has(entry.status)) {
      errors.push(`${location} queue contains non-current status ${entry.status} for ${entry.id}`);
    }
    if (entry.status === "in_progress") inProgress += 1;
  }
  if (inProgress > 1) errors.push(`queue has ${inProgress} in-progress tasks; expected at most one`);

  for (const task of tasks.values()) {
    if (["ready", "in_progress"].includes(task.status) && !queueIds.has(task.id)) {
      errors.push(`${task.id} is ${task.status} but missing from Current Next Queue`);
    }
  }

  return { errors, dependencies };
}

export function buildPlanningModel({ taskDocuments, requirementsText, queueText, blockIds }) {
  const parsedTasks = parseTaskDocuments(taskDocuments);
  const parsedRequirements = parseRequirementsDocument(requirementsText);
  const parsedQueue = parseQueueDocument(queueText);
  const validation = validatePlanning({
    tasks: parsedTasks.tasks,
    requirements: parsedRequirements.requirements,
    traces: parsedRequirements.traces,
    queue: parsedQueue.entries,
    blockIds
  });

  return {
    tasks: parsedTasks.tasks,
    requirements: parsedRequirements.requirements,
    traces: parsedRequirements.traces,
    queue: parsedQueue.entries,
    dependencies: validation.dependencies,
    errors: [
      ...parsedTasks.errors,
      ...parsedRequirements.errors,
      ...parsedQueue.errors,
      ...validation.errors
    ]
  };
}

export const planningPatterns = { TASK_ID, REQUIREMENT_ID, BLOCK_ID };
