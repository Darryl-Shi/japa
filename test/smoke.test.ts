import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";

test("pi-durable answers with the faux provider", async () => {
  const faux = fauxProvider({ provider: "faux" });
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage([fauxText("Paris")])]);
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, ctx);
  const root = await harness.root(ctx, { agent: { model: { provider: "faux", modelId: faux.getModel().id } } });
  const settled = await (await root.submit({ type: "input", content: "Capital of France?" }, ctx)).wait(ctx);
  expect(settled.status).toBe("done");
  await harness.close(ctx);
});
