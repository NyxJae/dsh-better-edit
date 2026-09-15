import { describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { editToolSchema } from "../../src/contract.js";
import { EDIT_DESCRIPTION, READ_DESCRIPTION } from "../../src/prompts.js";
import { buildEditTool } from "../../src/tool-edit.js";
import { localIO } from "../../src/fs-bridge.js";
import { initHasher } from "../../src/hashline/index.js";
import { FsSandboxController } from "../../src/sandbox.js";
import { buildReadTool } from "../../src/tool-read.js";
import { extractHash, makeExec, withTempFile } from "../support/fixtures.js";

type RecordsResult = {
  format: "records";
  rows: Array<{ line: number; hash: string; content: string }>;
  total_lines: number;
  next_offset?: number;
  warning?: string;
  diagnostics?: string[];
};

type ReadOutputSchema = {
  oneOf: Array<{
    required?: string[];
    properties: {
      text?: unknown;
      rows?: { items: { required?: string[] } };
    };
  }>;
};

type StructuredResult = {
  format: "structured";
  classification: "applied" | "noop";
  metrics: {
    edits_attempted: number;
    edits_noop: number;
    warnings: number;
    changed_lines?: { first: number; last: number };
    added_lines?: number;
    removed_lines?: number;
  };
  fresh_rows: Array<{ line: number; hash: string; content: string }>;
};

function makeSandbox(): FsSandboxController {
  return new FsSandboxController({ fs: { sandboxMode: undefined }, get: () => undefined } as never);
}

describe("local PTC structured read/edit", () => {
  it("returns ordered records with absolute lines and pagination metadata", async () => {
    await initHasher();
    await withTempFile("records.txt", "alpha\n\ncharlie\n", async ({ cwd }) => {
      const tool = buildReadTool(localIO());
      const exec = makeExec(cwd, "records-session")({ path: "records.txt" });

      const annotated = (await tool.execute({ path: "records.txt" }, exec)) as {
        text: string;
        format?: string;
      };
      expect(annotated.text).toContain("│alpha");
      expect(annotated.format).toBeUndefined();

      const firstPage = (await tool.execute({ path: "records.txt", offset: 1, limit: 1, format: "records" }, exec)) as RecordsResult;
      expect(firstPage.next_offset).toBe(2);

      const records = (await tool.execute(
        { path: "records.txt", offset: 2, limit: 2, format: "records" },
        exec,
      )) as RecordsResult;
      expect(records).toMatchObject({ format: "records", total_lines: 3 });
      expect(records.next_offset).toBeUndefined();
      expect(records.rows.map((row) => ({ line: row.line, content: row.content }))).toEqual([
        { line: 2, content: "" },
        { line: 3, content: "charlie" },
      ]);
      expect(records.rows.every((row) => /^[A-Za-z0-9]{3}$/.test(row.hash))).toBe(true);
    });
  });

  it("keeps the empty-file insertion anchor in records mode", async () => {
    await initHasher();
    await withTempFile("empty.txt", "", async ({ cwd }) => {
      const tool = buildReadTool(localIO());
      const exec = makeExec(cwd, "empty-records")({ path: "empty.txt", format: "records" });
      const records = (await tool.execute(
        { path: "empty.txt", format: "records" },
        exec,
      )) as RecordsResult;

      expect(records.total_lines).toBe(0);
      expect(records.rows).toHaveLength(1);
      expect(records.rows[0]).toMatchObject({ line: 1, hash: expect.any(String), content: "" });
    });
  });

  it("returns structured edit metrics and only the minimal fresh-row window", async () => {
    await initHasher();
    await withTempFile("edit.txt", "a\nb\nc\nd\n", async ({ cwd, path }) => {
      const io = localIO();
      const readTool = buildReadTool(io);
      const editTool = buildEditTool(io, makeSandbox());
      const exec = makeExec(cwd, "structured-edit")({ path: "edit.txt" });
      const served = (await readTool.execute({ path: "edit.txt" }, exec)) as { text: string };
      const line = served.text.split("\n").find((row) => row.endsWith("│b"))!;
      const hash = extractHash(line);

      const result = (await editTool.execute(
        {
          path: "edit.txt",
          edits: [[hash, hash, "beta"]],
          result_format: "structured",
        },
        exec,
      )) as StructuredResult;

      expect(result.format).toBe("structured");
      expect(result.classification).toBe("applied");
      expect(result.metrics).toMatchObject({
        edits_attempted: 1,
        edits_noop: 0,
        classification: "applied",
      });
      expect(result.fresh_rows.map((row) => row.content)).toEqual(["a", "beta", "c"]);
      expect(result.fresh_rows.length).toBeLessThan(4);
      expect(await readFile(path, "utf-8")).toBe("a\nbeta\nc\nd\n");
    });
  });

  it("keeps textual edit output when structured mode is omitted", async () => {
    await initHasher();
    await withTempFile("text-edit.txt", "one\ntwo\n", async ({ cwd }) => {
      const harness = buildReadTool(localIO());
      const editTool = buildEditTool(localIO(), makeSandbox());
      const exec = makeExec(cwd, "text-edit")({ path: "text-edit.txt" });
      const served = (await harness.execute({ path: "text-edit.txt" }, exec)) as { text: string };
      const hash = extractHash(served.text.split("\n").find((row) => row.endsWith("│two"))!);

      const result = await editTool.execute(
        { path: "text-edit.txt", edits: [[hash, hash, "TWO"]] },
        exec,
      );
      expect(typeof result).toBe("string");
      expect(result).toContain("Successfully edited");
    });
  });

  it("preserves annotated mode and exposes records diagnostics", async () => {
    await initHasher();
    const huge = "x".repeat(300000);
    await withTempFile("diagnostics.txt", "short\n" + huge + "\nend\n", async ({ cwd }) => {
      const tool = buildReadTool(localIO());
      const exec = makeExec(cwd, "diagnostics")({ path: "diagnostics.txt" });
      const annotated = (await tool.execute({ path: "diagnostics.txt", format: "annotated" }, exec)) as { text: string };
      expect(annotated.text).toContain("│short");
      const oversized = (await tool.execute({ path: "diagnostics.txt", offset: 2, limit: 1, format: "records" }, exec)) as RecordsResult;
      expect(oversized.rows).toEqual([]);
      expect(oversized.diagnostics?.some((message) => message.includes("content not shown"))).toBe(true);
      const eof = (await tool.execute({ path: "diagnostics.txt", offset: 99, format: "records" }, exec)) as RecordsResult;
      expect(eof.rows).toEqual([]);
      expect(eof.diagnostics?.some((message) => message.includes("beyond end of file"))).toBe(true);
    });
  });

  it("exposes UTF-8 rewrite diagnostics separately from records", async () => {
    await initHasher();
    await withTempFile("invalid-utf8.txt", "placeholder\n", async ({ cwd, path }) => {
      await writeFile(path, Buffer.from([0x66, 0x6f, 0xff, 0x0a]));
      const tool = buildReadTool(localIO());
      const exec = makeExec(cwd, "utf8-records")({ path: "invalid-utf8.txt" });
      const records = (await tool.execute({ path: "invalid-utf8.txt", format: "records" }, exec)) as RecordsResult;
      expect(records.diagnostics?.some((message) => message.includes("Non-UTF-8 bytes shown"))).toBe(true);
    });
  });

  it("supports structured noop and chained insert-delete edits", async () => {
    await initHasher();
    await withTempFile("chain.txt", "a\nb\nc\n", async ({ cwd, path }) => {
      const io = localIO();
      const readTool = buildReadTool(io);
      const editTool = buildEditTool(io, makeSandbox());
      const exec = makeExec(cwd, "chain-edit")({ path: "chain.txt" });
      const served = (await readTool.execute({ path: "chain.txt" }, exec)) as { text: string };
      const hash = extractHash(served.text.split("\n").find((row) => row.endsWith("│b"))!);
      const noop = (await editTool.execute({ path: "chain.txt", edits: [[hash, hash, "b"]], result_format: "structured" }, exec)) as StructuredResult;
      expect(noop.classification).toBe("noop");
      expect(noop.fresh_rows).toEqual([]);
      const inserted = (await editTool.execute({ path: "chain.txt", edits: [[hash, hash, "b\ninserted"]], result_format: "structured" }, exec)) as StructuredResult;
      expect(inserted.classification).toBe("applied");
      const insertedRow = inserted.fresh_rows.find((row) => row.content === "inserted");
      expect(insertedRow).toBeDefined();
      const removed = (await editTool.execute({ path: "chain.txt", edits: [[insertedRow!.hash, insertedRow!.hash, ""]], result_format: "structured" }, exec)) as StructuredResult;
      expect(removed.classification).toBe("applied");
      expect(await readFile(path, "utf-8")).toBe("a\nb\nc\n");
    });
  });

  it("publishes strict output schemas and guidance for programmatic consumers", () => {
    const readTool = buildReadTool(localIO());
    const readSchema = (readTool.output as unknown as { schema: ReadOutputSchema }).schema;
    expect(readSchema.oneOf).toHaveLength(2);
    expect(readSchema.oneOf[0].required).toEqual(["text"]);
    expect(readSchema.oneOf[1].required).toEqual(expect.arrayContaining(["format", "rows", "total_lines"]));
    expect(readSchema.oneOf[1].properties.rows.items.required).toEqual(expect.arrayContaining(["line", "hash", "content"]));
    expect(editToolSchema.properties.result_format.enum).toEqual(["text", "structured"]);
    expect(READ_DESCRIPTION).toContain("format=records");
    expect(EDIT_DESCRIPTION).toContain("result_format=structured");
  });
});
