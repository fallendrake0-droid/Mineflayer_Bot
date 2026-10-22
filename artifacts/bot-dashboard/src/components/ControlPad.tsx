import React, { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { sendBotControl, type BotControlRequest } from "@workspace/api-client-react";
import { useBot } from "@/lib/bot-context";
import {
  Gamepad2,
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ArrowBigUp,
  Rabbit,
  Turtle,
  RotateCcw,
  RotateCw,
  Eye,
} from "lucide-react";

type MoveKey = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";
const MOVE_KEYS: MoveKey[] = ["forward", "back", "left", "right", "jump", "sprint", "sneak"];

const KEY_MAP: Record<string, MoveKey> = {
  w: "forward",
  s: "back",
  a: "left",
  d: "right",
  " ": "jump",
  shift: "sneak",
  e: "sprint",
};

/**
 * Manual remote-control pad. Hold the on-screen buttons (or focus the pad
 * and use WASD / Space / Shift / E, arrows to look). State is re-sent on a
 * heartbeat so the server's dead-man's switch doesn't trip while held.
 */
export function ControlPad() {
  const { status } = useBot();
  const connected = Boolean(status?.connected);
  const [pressed, setPressed] = useState<Set<MoveKey>>(new Set());
  const pressedRef = useRef<Set<MoveKey>>(new Set());
  const padRef = useRef<HTMLDivElement>(null);
  const lookIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const sendState = useCallback(() => {
    const payload: BotControlRequest = {};
    for (const k of MOVE_KEYS) payload[k] = pressedRef.current.has(k);
    sendBotControl(payload).catch(() => {
      // bot disconnected mid-press; server-side states are cleared anyway
    });
  }, []);

  const setKey = useCallback(
    (key: MoveKey, down: boolean) => {
      const next = new Set(pressedRef.current);
      if (down) next.add(key);
      else next.delete(key);
      pressedRef.current = next;
      setPressed(next);
      sendState();
    },
    [sendState],
  );

  const releaseAll = useCallback(() => {
    if (pressedRef.current.size === 0) return;
    pressedRef.current = new Set();
    setPressed(new Set());
    sendState();
  }, [sendState]);

  // Heartbeat while anything is held.
  useEffect(() => {
    if (pressed.size === 0) return;
    const t = setInterval(sendState, 700);
    return () => clearInterval(t);
  }, [pressed, sendState]);

  // Safety: release everything when the pad loses focus / unmounts.
  useEffect(
    () => () => {
      releaseAll();
      if (lookIntervalRef.current) {
        clearInterval(lookIntervalRef.current);
        lookIntervalRef.current = null;
      }
    },
    [releaseAll],
  );

  const startLook = (yawDelta: number, pitchDelta: number) => {
    const send = () => sendBotControl({ yawDelta, pitchDelta }).catch(() => {});
    send();
    if (lookIntervalRef.current) clearInterval(lookIntervalRef.current);
    lookIntervalRef.current = setInterval(send, 110);
  };
  const stopLook = () => {
    if (lookIntervalRef.current) {
      clearInterval(lookIntervalRef.current);
      lookIntervalRef.current = null;
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.repeat) return;
    const key = e.key.toLowerCase();
    if (key.startsWith("arrow")) {
      e.preventDefault();
      if (key === "arrowleft") startLook(0.28, 0);
      if (key === "arrowright") startLook(-0.28, 0);
      if (key === "arrowup") startLook(0, -0.18);
      if (key === "arrowdown") startLook(0, 0.18);
      return;
    }
    const mapped = KEY_MAP[key] ?? KEY_MAP[e.key];
    if (mapped) {
      e.preventDefault();
      setKey(mapped, true);
    }
  };
  const onKeyUp = (e: React.KeyboardEvent) => {
    const key = e.key.toLowerCase();
    if (key.startsWith("arrow")) {
      stopLook();
      return;
    }
    const mapped = KEY_MAP[key] ?? KEY_MAP[e.key];
    if (mapped) setKey(mapped, false);
  };

  const padBtn = (
    key: MoveKey,
    label: React.ReactNode,
    extra = "",
  ) => (
    <Button
      type="button"
      variant={pressed.has(key) ? "default" : "outline"}
      className={`font-mono h-10 select-none touch-none ${
        pressed.has(key) ? "" : "border-primary/30 hover:bg-primary/10"
      } ${extra}`}
      disabled={!connected}
      onPointerDown={(e) => {
        e.preventDefault();
        padRef.current?.focus();
        setKey(key, true);
      }}
      onPointerUp={() => setKey(key, false)}
      onPointerLeave={() => setKey(key, false)}
      onPointerCancel={() => setKey(key, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </Button>
  );

  const lookBtn = (yawDelta: number, pitchDelta: number, label: React.ReactNode, title: string) => (
    <Button
      type="button"
      variant="outline"
      className="font-mono h-8 w-8 p-0 select-none touch-none border-primary/30 hover:bg-primary/10"
      disabled={!connected}
      title={title}
      onPointerDown={(e) => {
        e.preventDefault();
        padRef.current?.focus();
        startLook(yawDelta, pitchDelta);
      }}
      onPointerUp={stopLook}
      onPointerLeave={stopLook}
      onPointerCancel={stopLook}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </Button>
  );

  return (
    <Card className="border-primary/20 bg-black shadow-lg shadow-primary/5">
      <CardHeader className="pb-2 border-b border-primary/10">
        <CardTitle className="font-mono text-primary text-sm flex items-center gap-2">
          <Gamepad2 className="w-4 h-4" /> MANUAL CONTROL
          {pressed.size > 0 && (
            <span className="text-[10px] text-primary animate-pulse">DRIVING…</span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4">
        <div
          ref={padRef}
          tabIndex={0}
          role="application"
          aria-label="Manual bot control pad. Focus and use W A S D keys."
          className="outline-none focus:ring-1 focus:ring-primary/50 rounded p-1"
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => {
            releaseAll();
            stopLook();
          }}
        >
          <div className="flex gap-4 justify-between">
            {/* Movement cluster */}
            <div className="grid grid-cols-3 gap-1.5 w-[132px]">
              <span />
              {padBtn("forward", <ChevronUp className="w-5 h-5" />)}
              <span />
              {padBtn("left", <ChevronLeft className="w-5 h-5" />)}
              {padBtn("back", <ChevronDown className="w-5 h-5" />)}
              {padBtn("right", <ChevronRight className="w-5 h-5" />)}
            </div>

            {/* Look cluster */}
            <div className="flex flex-col items-center gap-1.5">
              <div className="grid grid-cols-3 gap-1.5">
                <span />
                {lookBtn(0, -0.18, <ChevronUp className="w-4 h-4" />, "Look up")}
                <span />
                {lookBtn(0.28, 0, <RotateCcw className="w-4 h-4" />, "Look left")}
                <span className="flex items-center justify-center">
                  <Eye className="w-4 h-4 text-muted-foreground" />
                </span>
                {lookBtn(-0.28, 0, <RotateCw className="w-4 h-4" />, "Look right")}
                <span />
                {lookBtn(0, 0.18, <ChevronDown className="w-4 h-4" />, "Look down")}
                <span />
              </div>
              <span className="font-mono text-[9px] text-muted-foreground tracking-widest">LOOK</span>
            </div>
          </div>

          <div className="grid grid-cols-3 gap-1.5 mt-2">
            {padBtn("jump", (
              <span className="flex items-center gap-1 text-[11px]">
                <ArrowBigUp className="w-4 h-4" /> JUMP
              </span>
            ))}
            {padBtn("sprint", (
              <span className="flex items-center gap-1 text-[11px]">
                <Rabbit className="w-4 h-4" /> SPRINT
              </span>
            ))}
            {padBtn("sneak", (
              <span className="flex items-center gap-1 text-[11px]">
                <Turtle className="w-4 h-4" /> SNEAK
              </span>
            ))}
          </div>
        </div>
        <p className="font-mono text-[10px] text-muted-foreground mt-3 leading-relaxed">
          Click the pad, then drive with <span className="text-foreground">W A S D</span>,{" "}
          <span className="text-foreground">Space</span> jump,{" "}
          <span className="text-foreground">Shift</span> sneak,{" "}
          <span className="text-foreground">E</span> sprint,{" "}
          <span className="text-foreground">←→↑↓</span> look. Taking manual
          control stops the current task.
        </p>
      </CardContent>
    </Card>
  );
}
