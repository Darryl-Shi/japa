// `japa webui users <add|passwd|remove|list>`: the web UI's users, in `<home>/webui/users.json`. Works on the home
// directly, daemon or not; the running daemon reads the file again on its next request.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  hashPassword,
  nameProblem,
  newStamp,
  normalName,
  parseUsers,
  passwordProblem,
  usersFile,
  writeUsers,
  type WebuiUser,
} from "../../extensions/webui/users.ts";
import { ensureWorkspace } from "../kernel/workspace.ts";
import { Cancelled, clackPrompter } from "./prompt.ts";

export const WEBUI_USAGE = `Usage: japa webui users <command>

Commands:
  add <name> [--password-stdin]     Create a web UI user; asks for the password twice
  passwd <name> [--password-stdin]  Set a user's password; signs that user out everywhere
  remove <name>                     Delete a user; signs that user out everywhere
  list                              List the users

--password-stdin reads the password from the first line of standard input, without confirmation.`;

/** A message for the user; the command exits 1 with it. */
export class UsageError extends Error {}

export type UsersIO = {
  /** Whether standard input is a terminal (to prompt on). */
  isTTY: boolean;
  /** Standard input's text, read whole. */
  readStdin(): Promise<string>;
  /** Masked input; "" for just Enter. */
  askSecret(question: string): Promise<string>;
  log(text: string): void;
};

export function processIO(): UsersIO {
  return {
    isTTY: process.stdin.isTTY === true,
    readStdin: async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin as AsyncIterable<Buffer>) chunks.push(chunk);
      return Buffer.concat(chunks).toString("utf8");
    },
    askSecret: async (question) => {
      try {
        return await clackPrompter().secret(question);
      } catch (error) {
        if (error instanceof Cancelled) throw new UsageError("Cancelled.");
        throw error;
      }
    },
    log: (text) => console.log(text),
  };
}

/** The users as the file holds them; refuses (rather than overwrite) a file it can't parse. */
function load(home: string): WebuiUser[] {
  const file = usersFile(home);
  if (!existsSync(file)) return [];
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new UsageError(`Can't read ${file}: ${(error as Error).message}`);
  }
  const result = parseUsers(text);
  if (!result.ok) throw new UsageError(`Can't read ${file}: ${result.error}. Fix or remove it; it was left as it is.`);
  return result.users;
}

/** The new password: stdin's first line with `--password-stdin`, else asked twice on the terminal. */
async function newPassword(io: UsersIO, fromStdin: boolean, command: string): Promise<string> {
  let password: string;
  if (fromStdin) {
    password = (await io.readStdin()).split(/\r?\n/)[0] ?? "";
  } else {
    if (!io.isTTY) {
      throw new UsageError(
        `japa webui users ${command} needs a terminal to ask for the password; ` +
          "or pipe it in with --password-stdin (e.g. echo '<password>' | japa webui users " +
          `${command} <name> --password-stdin)`,
      );
    }
    password = await io.askSecret("Password");
    const problem = passwordProblem(password);
    if (problem !== undefined) throw new UsageError(problem);
    const again = await io.askSecret("Password again");
    if (again !== password) throw new UsageError("The passwords don't match; nothing was changed.");
  }
  const problem = passwordProblem(password);
  if (problem !== undefined) throw new UsageError(problem);
  return password;
}

/** The name argument, lower-cased; a UsageError if it's missing or invalid. */
function nameArg(raw: string | undefined, command: string): string {
  if (raw === undefined || raw.startsWith("--")) throw new UsageError(`Usage: japa webui users ${command} <name>`);
  const problem = nameProblem(raw);
  if (problem !== undefined) throw new UsageError(problem);
  return normalName(raw)!;
}

/** `japa webui <args>`. */
export async function webuiCommand(home: string, args: string[], io: UsersIO = processIO()): Promise<void> {
  const [group, command, ...rest] = args;
  if (group !== "users" || command === undefined) throw new UsageError(WEBUI_USAGE);
  const flags = rest.filter((a) => a.startsWith("--"));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const allowed = command === "add" || command === "passwd" ? ["--password-stdin"] : [];
  const unknown = flags.find((f) => !allowed.includes(f));
  if (unknown !== undefined) throw new UsageError(`Unknown option ${unknown}\n\n${WEBUI_USAGE}`);
  const fromStdin = flags.includes("--password-stdin");
  const extra = positional.slice(command === "list" ? 0 : 1);
  if (extra.length > 0) throw new UsageError(`Unexpected argument "${extra[0]}"\n\n${WEBUI_USAGE}`);

  switch (command) {
    case "list": {
      const users = load(home);
      if (users.length === 0) {
        io.log("no web UI users\nAdd one with: japa webui users add <name>");
        return;
      }
      for (const u of users) io.log(`${u.name}  created ${u.createdAt}`);
      return;
    }
    case "add": {
      const name = nameArg(positional[0], command);
      if (load(home).some((u) => u.name === name)) throw new UsageError(`There is already a web UI user "${name}".`);
      const password = await newPassword(io, fromStdin, command);
      const hash = await hashPassword(password);
      // Read again: the prompt may have taken a while.
      const users = load(home);
      if (users.some((u) => u.name === name)) throw new UsageError(`There is already a web UI user "${name}".`);
      prepare(home);
      writeUsers(home, [...users, { name, createdAt: new Date().toISOString(), password: hash, stamp: newStamp() }]);
      io.log(`Added web UI user "${name}". Sign in to the web UI with that name and password.`);
      return;
    }
    case "passwd": {
      const name = nameArg(positional[0], command);
      if (!load(home).some((u) => u.name === name)) throw new UsageError(`There is no web UI user "${name}".`);
      const password = await newPassword(io, fromStdin, command);
      const hash = await hashPassword(password);
      const users = load(home);
      if (!users.some((u) => u.name === name)) throw new UsageError(`There is no web UI user "${name}".`);
      prepare(home);
      writeUsers(home, users.map((u) => (u.name === name ? { ...u, password: hash, stamp: newStamp() } : u)));
      io.log(`Changed the password of "${name}"; their web UI sessions have ended.`);
      return;
    }
    case "remove": {
      const name = nameArg(positional[0], command);
      const users = load(home);
      if (!users.some((u) => u.name === name)) throw new UsageError(`There is no web UI user "${name}".`);
      prepare(home);
      writeUsers(home, users.filter((u) => u.name !== name));
      io.log(`Removed web UI user "${name}"; their web UI sessions have ended.`);
      return;
    }
    default:
      throw new UsageError(`Unknown command "${command}"\n\n${WEBUI_USAGE}`);
  }
}

/** Before writing: the home's `.gitignore` ignores `webui/`, so the file never reaches git or a job's clone. */
function prepare(home: string): void {
  mkdirSync(home, { recursive: true });
  ensureWorkspace(home);
}
