/**
 * The dsh `read` tool: hash-anchored reads (`HASH│content` rows) that shadow
 * the built-in `read` on the agent's own scope layer. Every shown row is
 * recorded as served, so a later `edit` can verify the model was actually
 * shown the lines it targets.
 * @module dsh-better-edit/tool-read
 */

import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { normalizeRequest as normReq, assertReadRequest, pathSchema } from "./contract.js";

import { readAndServe, type ReadRecord } from "./read-and-serve.js";
import { READ_DESCRIPTION } from "./prompts.js";
import { normalizeEncoding } from "./encoding.js";

import type { FileIO } from "./fs-bridge.js";
import { renderTextWarning } from "./render-text-warning.js";
import { execCwd, execSessionKey } from "./workspace-context.js";
import { withWorkspace } from "./workspace-context.js";
type AnnotatedReadResult = { text: string; warning?: string };
type RecordsReadResult = {
  format: "records";
  rows: ReadRecord[];
  total_lines: number;
  next_offset?: number;
  warning?: string;
  diagnostics?: string[];
};
const READ_OUTPUT_SCHEMA = {
  oneOf: [
    {
      type: "object",
      properties: {
        text: { type: "string", required: true },
        warning: { type: "string" },
      },
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        format: { type: "string", enum: ["records"], required: true },
        rows: {
          type: "array",
          required: true,
          items: { type: "object", properties: { line: { type: "number", required: true }, hash: { type: "string", required: true }, content: { type: "string", required: true } }, additionalProperties: false },
        },
        total_lines: { type: "number", required: true },
        next_offset: { type: "number" },
        warning: { type: "string" },
        diagnostics: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  ],
} as const;

type ReadResult = AnnotatedReadResult | RecordsReadResult;
type ReadOutputValue = {
  text?: string;
  format?: "records";
  rows?: ReadRecord[];
  total_lines?: number;
  next_offset?: number;
  warning?: string;
  diagnostics?: string[];
};

function renderReadResult(_args: unknown, value: unknown) {
  const v = value as ReadOutputValue;
  if (v.format === "records") {
    const { warning, ...payload } = v;
    const blocks: Array<{ type: "text"; text: string }> = [
      { type: "text", text: JSON.stringify(payload) },
    ];
    if (warning) blocks.push({ type: "text", text: warning });
    return blocks;
  }
  // Annotated (and bare-string) values go through the shared render seam so
  // `read` and `str_replace_editor` view stay parity-equal (report #7).
  return renderTextWarning(value as { text: string; warning?: string } | string);
}

const READ_OUTPUT = { schema: READ_OUTPUT_SCHEMA, render: renderReadResult };
/**
 * Register the hash-anchored `read` tool on the calling agent's scope.
 * @param _rootCtx - host context.
 * @param agentCtx - the agent's scoped context (own scope layer).
 * @param io - the filesystem bridge.
 * @returns the exact disposer that unregisters the tool.
 */
export function buildReadTool(io: FileIO) {
  return defineTool({
    name: "read",
    description: READ_DESCRIPTION,
    parameters: {
      path: pathSchema,
      offset: {
        type: "number",
        description: "Line number to start reading from (1-indexed)",
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read",
      },
      encoding: {
        type: "string",
        description:
          "Text encoding for Reopen with Encoding (e.g. gbk, shift_jis, windows-1251). Case-insensitive.",
      },
      format: {
        type: "string",
        enum: ["annotated", "records"],
        description: "Canonical output format for programmatic consumers.",
      },
    },
    output: READ_OUTPUT,
    async execute(args, exec): Promise<ReadResult> {
      return withWorkspace(execCwd(exec), async () => {
        const cwd = execCwd(exec);
        const sessionKey = execSessionKey(exec);
        const signal = exec.signal;

        const encoding = (args as Record<string, unknown>).encoding as string | undefined;
        if (encoding !== undefined) {
          const norm = normalizeEncoding(String(encoding));
          if (!norm)
            throw new Error(
              `[E_BAD_ENCODING] Unknown encoding: ${String(encoding)}. Supported: utf8, gbk, big5, shift_jis, euc-kr, windows-1251, iso-8859-1`,
            );
        }
        const canonical = normReq(args);
        assertReadRequest(canonical);
        const rawPath = canonical.path;

        const { text, absolutePath, warning, diagnostics, records, totalLines, nextOffset } = await readAndServe(
          io,
          rawPath,
          cwd,
          {
            sessionKey,
            signal,
            offset: canonical.offset,
            limit: canonical.limit,
            encoding: encoding as string | undefined,
          },
        );
        // Record the present observation with the fs policy gate so later
        // built-in write/edit calls see this file as observed at the
        // version the model just read (a no-op when no policy listens).
        await io.emitObserved(absolutePath, exec, signal);

        if (canonical.format === "records") {
          return {
            format: "records",
            rows: records,
            total_lines: totalLines,
            ...(nextOffset === undefined ? {} : { next_offset: nextOffset }),
            ...(warning === undefined ? {} : { warning }),
            ...(diagnostics === undefined ? {} : { diagnostics }),
          };
        }
        return warning ? { text, warning } : { text };
      });
    },
  });
}

/**
 * Register the hashline tool on the calling agent’s scope (own layer).
 */
export function registerReadTool(_rootCtx: Context, agentCtx: Context, io: FileIO): () => void {
  return agentCtx.tools.register(buildReadTool(io));
}
