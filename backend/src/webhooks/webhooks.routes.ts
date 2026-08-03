import { Router } from "express";
import {
  listWebhooks,
  saveWebhook,
  deleteWebhook,
  listDeliveries,
  rateLimitSummary,
  emit,
  WEBHOOK_EVENTS,
  WebhookError,
} from "./webhooks";

export const webhooksRouter = Router();

webhooksRouter.get("/", async (_req, res) => {
  res.json({
    webhooks: await listWebhooks(),
    events: WEBHOOK_EVENTS,
    deliveries: listDeliveries().slice(0, 50),
    rateLimits: rateLimitSummary(),
  });
});

webhooksRouter.post("/", async (req, res) => {
  try {
    res.status(201).json({ webhook: await saveWebhook(req.body ?? {}) });
  } catch (err) {
    res.status(err instanceof WebhookError ? 400 : 500).json({ error: (err as Error).message });
  }
});

webhooksRouter.delete("/:id", async (req, res) => {
  await deleteWebhook(req.params.id);
  res.json({ ok: true });
});

/** Sends one real request, so a misconfigured URL fails here and not at 3am. */
webhooksRouter.post("/:id/test", async (req, res) => {
  const hook = (await listWebhooks()).find((h) => h.id === req.params.id);
  if (!hook) {
    res.status(404).json({ error: "Nincs ilyen webhook." });
    return;
  }
  await emit(hook.events[0] ?? "server.started", "Teszt a dashboardból.", { test: true });
  res.json({ deliveries: listDeliveries(hook.id).slice(0, 5), rateLimits: rateLimitSummary() });
});
