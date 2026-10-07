import { Container, Editor, matchesKey, ProcessTerminal, Text, TuiMainScreen } from "@earendil-works/pi-tui";
import { connect } from "./client.ts";
import { applyEvents, fromSnapshot, type Line, type Transcript } from "./transcript.ts";

const plain = (s: string) => s;
const editorTheme = {
  borderColor: plain,
  selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain },
};
const prefix: Record<Line["kind"], string> = { user: "› ", assistant: "", tool: "", info: "! " };

/** Interactive chat with the daemon in `home`; resolves when the user quits with Ctrl+C. */
export async function runChat(home: string): Promise<void> {
  const client = await connect(home);
  const tui = new TuiMainScreen(new ProcessTerminal());
  const history = new Container();
  const status = new Text("", 1, 0);
  const editor = new Editor(tui, editorTheme);
  tui.addChild(history);
  tui.addChild(status);
  tui.addChild(editor);
  tui.setFocus(editor);

  let t: Transcript = { lines: [], streaming: "", busy: false };
  const render = () => {
    history.clear();
    for (const line of t.lines) history.addChild(new Text(prefix[line.kind] + line.text, 1, 0));
    if (t.streaming !== "") history.addChild(new Text(t.streaming, 1, 0));
    status.setText(t.busy ? "thinking…" : "");
    tui.requestRender();
  };
  client.onMessage((m) => {
    if (m.type === "snapshot") t = fromSnapshot(m.snapshot);
    if (m.type === "events") t = applyEvents(t, m.events);
    if (m.type === "error") t = { ...t, lines: [...t.lines, { kind: "info", text: m.message }] };
    render();
  });
  editor.onSubmit = (text) => {
    if (text !== "") client.send({ type: "submit", text, mode: t.busy ? "steer" : "followUp" });
  };

  let quitting = false;
  tui.addInputListener((data) => {
    if (matchesKey(data, "escape") && t.busy) client.send({ type: "abort" });
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
