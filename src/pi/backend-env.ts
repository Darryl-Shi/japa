// Pi's ExecutionEnv on top of any Backend. Pi's built-in tools (bash, read, write, edit) touch files and processes
// only through this, so the agent works on the backend as if it were its own machine — no sandbox tool in between.
// Every file operation is built on exec (POSIX shell + GNU coreutils), so a provider only has to run commands;
// its optional fast file paths are used when present.
import { posix } from "node:path";
import type { Context } from "@earendil-works/chord";
import {
	err,
	ExecutionError,
	type ExecutionEnv,
	FileError,
	type FileErrorCode,
	type FileInfo,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import { type Backend, shellQuote as q } from "../core/backend.ts";

/** Bytes per command when files move through exec: as base64 this stays under Linux's 128KB single-argument limit. */
const CHUNK_BYTES = 64 * 1024;

function fileErrorCode(output: string): FileErrorCode {
	if (/No such file or directory|cannot stat|not found/i.test(output)) return "not_found";
	if (/Permission denied|Operation not permitted/i.test(output)) return "permission_denied";
	if (/Is a directory/i.test(output)) return "is_directory";
	if (/Not a directory/i.test(output)) return "not_directory";
	return "unknown";
}

export class BackendExecutionEnv implements ExecutionEnv {
	readonly id: string;
	cwd: string;
	private readonly backend: Backend;

	constructor(backend: Backend, cwd?: string) {
		this.backend = backend;
		this.id = backend.id;
		this.cwd = cwd ?? backend.home;
	}

	/** Run a helper command and capture its output. */
	private async run(command: string, context: Context): Promise<{ exitCode: number; output: string }> {
		let output = "";
		const { exitCode } = await this.backend.exec(command, { cwd: this.cwd, onOutput: (chunk) => (output += chunk), signal: context.abortSignal });
		return { exitCode, output };
	}

	/** Run a file operation; a failure becomes a FileError for `path`. */
	private async fileOp(command: string, path: string, context: Context): Promise<Result<string, FileError>> {
		try {
			const { exitCode, output } = await this.run(command, context);
			if (exitCode === 0) return ok(output);
			return err(new FileError(fileErrorCode(output), output.trim() || `exit ${exitCode}`, path));
		} catch (error) {
			if (context.abortSignal?.aborted) return err(new FileError("aborted", "Aborted", path));
			return err(new FileError("unknown", error instanceof Error ? error.message : String(error), path));
		}
	}

	private resolve(path: string): string {
		return posix.isAbsolute(path) ? posix.normalize(path) : posix.join(this.cwd, path);
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(this.resolve(path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(posix.join(...parts));
	}

	async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
		const absolute = this.resolve(path);
		if (this.backend.readFile !== undefined) {
			try {
				return ok(await this.backend.readFile(absolute, context.abortSignal));
			} catch {
				// Fall through to exec: the fast path may not reach every path.
			}
		}
		const result = await this.fileOp(`test -d ${q(absolute)} && { echo "Is a directory" >&2; exit 1; }; base64 -w0 -- ${q(absolute)}`, absolute, context);
		return result.ok ? ok(new Uint8Array(Buffer.from(result.value.trim(), "base64"))) : result;
	}

	async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
		const bytes = await this.readBinaryFile(path, context);
		return bytes.ok ? ok(new TextDecoder().decode(bytes.value)) : bytes;
	}

	async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines: TextLine[] = [];
		for (let start = 0; start < text.value.length; ) {
			const end = text.value.indexOf("\n", start);
			if (end === -1) {
				lines.push({ text: text.value.slice(start), terminated: false });
				break;
			}
			lines.push({ text: text.value.slice(start, end), terminated: true });
			start = end + 1;
		}
		let next = 0;
		return ok({ readLine: async () => ok(lines[next++]), close: async () => {} });
	}

	async readTextLines(path: string, options: { maxLines?: number } | undefined, context: Context): Promise<Result<string[], FileError>> {
		const text = await this.readTextFile(path, context);
		if (!text.ok) return text;
		const lines = text.value.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
	}

	private async put(path: string, data: Uint8Array, append: boolean, context: Context): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		if (!append && this.backend.writeFile !== undefined) {
			// The fast path is expected to create parent directories too.
			try {
				await this.backend.writeFile(absolute, data, context.abortSignal);
				return ok(undefined);
			} catch {
				// Fall through to exec.
			}
		}
		for (let start = 0; start < data.length || start === 0; start += CHUNK_BYTES) {
			const chunk = Buffer.from(data.subarray(start, start + CHUNK_BYTES)).toString("base64");
			const redirect = append || start > 0 ? ">>" : ">";
			// Like Pi's local environment, writing creates missing parent directories.
			const parent = start === 0 ? `mkdir -p -- ${q(posix.dirname(absolute))} && ` : "";
			const result = await this.fileOp(`${parent}printf %s ${q(chunk)} | base64 -d ${redirect} ${q(absolute)}`, absolute, context);
			if (!result.ok) return result;
			if (data.length === 0) break;
		}
		return ok(undefined);
	}

	writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.put(path, typeof content === "string" ? new TextEncoder().encode(content) : content, false, context);
	}

	appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
		return this.put(path, typeof content === "string" ? new TextEncoder().encode(content) : content, true, context);
	}

	async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`truncate -s ${Math.max(0, Math.floor(size))} -- ${q(absolute)}`, absolute, context);
		return result.ok ? ok(undefined) : result;
	}

	async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`sync -- ${q(absolute)}`, absolute, context);
		return result.ok ? ok(undefined) : result;
	}

	async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
		const source = this.resolve(sourcePath);
		const result = await this.fileOp(`mv -f -- ${q(source)} ${q(this.resolve(destinationPath))}`, source, context);
		return result.ok ? ok(undefined) : result;
	}

	private parseInfo(line: string, path: string): FileInfo {
		const [kind = "", size = "0", mtime = "0"] = line.split("\t");
		return {
			name: posix.basename(path),
			path,
			kind: kind === "d" ? "directory" : kind === "l" ? "symlink" : "file",
			size: Number(size),
			mtimeMs: Math.round(Number(mtime) * 1000),
		};
	}

	async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`find ${q(absolute)} -maxdepth 0 -printf '%y\\t%s\\t%T@\\n'`, absolute, context);
		return result.ok ? ok(this.parseInfo(result.value.trim(), absolute)) : result;
	}

	async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`test -d ${q(absolute)} || { test -e ${q(absolute)} && echo "Not a directory" >&2 || echo "No such file or directory" >&2; exit 1; }; find ${q(absolute)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\0'`, absolute, context);
		if (!result.ok) return result;
		return ok(
			result.value
				.split("\0")
				.filter((record) => record !== "")
				.map((record) => {
					const [kind, size, mtime, ...name] = record.split("\t");
					return this.parseInfo(`${kind}\t${size}\t${mtime}`, posix.join(absolute, name.join("\t")));
				}),
		);
	}

	async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`realpath -e -- ${q(absolute)}`, absolute, context);
		return result.ok ? ok(result.value.trim()) : result;
	}

	async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`test -e ${q(absolute)} -o -L ${q(absolute)} && echo yes || echo no`, absolute, context);
		return result.ok ? ok(result.value.trim() === "yes") : result;
	}

	async createDir(path: string, options: { recursive?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const result = await this.fileOp(`mkdir ${options?.recursive === true ? "-p " : ""}-- ${q(absolute)}`, absolute, context);
		return result.ok ? ok(undefined) : result;
	}

	async remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, context: Context): Promise<Result<void, FileError>> {
		const absolute = this.resolve(path);
		const flags = `${options?.recursive === true ? "r" : ""}${options?.force === true ? "f" : ""}`;
		// Like Pi's local environment: without `recursive`, a directory is not removed, even an empty one.
		const command = `rm ${flags === "" ? "" : `-${flags} `}-- ${q(absolute)}`;
		const result = await this.fileOp(command, absolute, context);
		return result.ok ? ok(undefined) : result;
	}

	async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
		const result = await this.fileOp(`mktemp -d -t ${q(`${prefix ?? "tmp-"}XXXXXXXX`)}`, "/tmp", context);
		return result.ok ? ok(result.value.trim()) : result;
	}

	async createTempFile(options: { prefix?: string; suffix?: string } | undefined, context: Context): Promise<Result<string, FileError>> {
		const suffix = options?.suffix === undefined ? "" : ` --suffix=${q(options.suffix)}`;
		const result = await this.fileOp(`mktemp${suffix} -t ${q(`${options?.prefix ?? "tmp-"}XXXXXXXX`)}`, "/tmp", context);
		return result.ok ? ok(result.value.trim()) : result;
	}

	async cleanup(): Promise<void> {}

	async exec(command: string, options: ShellExecOptions | undefined, context: Context): Promise<Result<ShellExecResult, ExecutionError>> {
		const spill = options?.spill;
		const retained: string[] = [];
		let bytes = 0;
		let lines = 0;
		let spilling = false;
		const onOutput = (chunk: string) => {
			try {
				options?.onOutput?.(chunk, context);
			} catch {}
			if (spill === undefined) return;
			retained.push(chunk);
			bytes += Buffer.byteLength(chunk);
			lines += chunk.split("\n").length - 1;
			if (bytes > spill.afterBytes || lines + 1 > spill.afterLines) spilling = true;
		};
		const writeSpill = async () => {
			if (!spilling) return undefined;
			const file = await this.createTempFile({ prefix: "output-", suffix: ".log" }, context);
			if (!file.ok) return undefined;
			return (await this.writeFile(file.value, retained.join(""), context)).ok ? file.value : undefined;
		};
		try {
			const result = await this.backend.exec(command, {
				cwd: options?.cwd ?? this.cwd,
				...(options?.env === undefined ? {} : { env: options.env }),
				...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout * 1000 }),
				onOutput,
				signal: context.abortSignal,
			});
			const spillPath = await writeSpill();
			if (result.timedOut === true) {
				const error = new ExecutionError("timeout", `Command timed out after ${options?.timeout} seconds`);
				if (spillPath !== undefined) error.spillPath = spillPath;
				return err(error);
			}
			return ok({ exitCode: result.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
		} catch (error) {
			if (context.abortSignal?.aborted) return err(new ExecutionError("aborted", "Command aborted"));
			return err(new ExecutionError("unknown", error instanceof Error ? error.message : String(error)));
		}
	}
}
