import { Router, type IRouter } from "express";
import healthRouter from "./health";
import botRouter from "./bot";
import aiRouter from "./ai";
import { requireDashboardAuth } from "../middlewares/auth";

const router: IRouter = Router();

// Health checks intentionally reveal no bot state and remain public.
router.use(healthRouter);

// The dashboard uses this endpoint to validate the token before mounting
// components that poll the bot API or open the telemetry WebSocket.
router.post("/auth/verify", requireDashboardAuth, (_req, res) => {
  res.status(204).end();
});

// All bot status, inventory, logs and control routes fail closed behind auth.
router.use(requireDashboardAuth);
router.use(botRouter);
router.use(aiRouter);

export default router;
