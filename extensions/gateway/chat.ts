import { Container, Editor, Input, matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { board, type Job, type SecretRequest } from "../../src/sdk.ts";
import { connect } from "./client.ts";
import { applyEvents, type Line, type Transcript } from "./transcript.ts";

const plain = (s: string) => s;
const editorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
const prefix: Record<Line["kind"], string> = { user: "› ", assistant: "", tool: "", info: "! " };

/** An `Input` that shows each typed character as `•`. */
class MaskedInput extends Input {
  override render(width: number): string[] {
    const value = this.getValue();
    this.setValue("•".repeat(value.length)); // same length: the cursor stays put
    const lines = super.render(width);
    this.setValue(value);
    return lines;
  }
}

/** Interactive chat with the daemon in `home`; resolves when the user quits with Ctrl+C. */
export async function runChat(home: string): Promise<void> {
  const client = await connect(home);
  const tui = new TuiMainScreen(new ProcessTerminal());
  const history = new Container();
  const jobBoard = new Text("", 1, 0);
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, editorTheme);
  tui.addChild(history);
  tui.addChild(jobBoard);
  tui.addChild(status);
  tui.addChild(editor);
  tui.setFocus(editor);

  let t: Transcript = { lines: [], streaming: "", busy: false };
  let jobs: Job[] = [];
  let secrets: SecretRequest[] = [];
  let dismissed = false; // Esc hides the secret prompt until the requests change
  let prompt: { id: string; input: Input } | undefined;
  // While a secret is requested, a masked input for the first request replaces the editor.
  const showPrompt = () => {
    const request = dismissed ? undefined : secrets[0];
    if (request?.id === prompt?.id) return;
    tui.removeChild(prompt?.input ?? editor);
    prompt = undefined;
    if (request === undefined) {
      tui.addChild(editor);
      tui.setFocus(editor);
      return;
    }
    const input = new MaskedInput({ prompt: `${request.why} — enter ${request.name} (hidden): ` });
    input.onSubmit = (value) => client.send({ type: "secret", requestId: request.id, value });
    input.onEscape = () => {
      dismissed = true;
      showPrompt();
      tui.requestRender();
    };
    prompt = { id: request.id, input };
    tui.addChild(input);
    tui.setFocus(input);
  };
  const render = () => {
    history.clear();
    for (const line of t.lines) history.addChild(new Text(prefix[line.kind] + line.text, 1, 0));
    if (t.streaming !== "") history.addChild(new Text(t.streaming, 1, 0));
    jobBoard.setText(board(Object.fromEntries(jobs.map((j) => [j.id, j]))) ?? "");
    status.setText(t.busy ? "thinking…" : "");
    tui.requestRender();
  };
  client.onMessage((m) => {
    if (m.type === "events") t = applyEvents(t, m.events);
    if (m.type === "jobs") jobs = m.jobs;
    if (m.type === "secrets") {
      secrets = m.pending;
      dismissed = false;
      showPrompt();
    }
    if (m.type === "error") t = { ...t, lines: [...t.lines, { kind: "info", text: m.message }] };
    render();
  });
  editor.onSubmit = (text) => {
    if (text !== "") client.send({ type: "submit", text, mode: t.busy ? "steer" : "followUp" });
  };

  let quitting = false;
  tui.addInputListener((data) => {
    if (matchesKey(data, "escape") && t.busy && prompt === undefined) client.send({ type: "abort" });
    if (!matchesKey(data, "ctrl+c")) return undefined;
    quitting = true;
    client.close();
    return { consume: true };
  });

  client.send({ type: "attach" });
  tui.start();
  return new Promise((resolve, reject) => {
    client.onClose(() => {
      tui.stop();
      if (quitting) resolve();
      else reject(new Error("Lost connection to the japa daemon"));
    });
  });
}
