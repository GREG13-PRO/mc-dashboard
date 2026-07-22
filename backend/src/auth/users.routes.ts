import { Router } from "express";
import { userStore } from "./user-store";
import { userToPublic } from "./auth.middleware";
import type { UserInput } from "../types";

export const usersRouter = Router();

usersRouter.get("/", (_req, res) => {
  res.json({ users: userStore.list().map(userToPublic) });
});

usersRouter.post("/", (req, res) => {
  const input = req.body as UserInput;
  if (!input?.username || !input?.password) {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  try {
    const user = userStore.create(input);
    res.status(201).json({ user: userToPublic(user) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

usersRouter.put("/:id", (req, res) => {
  try {
    const user = userStore.update(req.params.id, req.body as Partial<UserInput>);
    res.json({ user: userToPublic(user) });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

usersRouter.delete("/:id", (req, res) => {
  if (req.params.id === req.user?.id) {
    res.status(400).json({ error: "Cannot delete your own account while logged in as it" });
    return;
  }
  try {
    userStore.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});
