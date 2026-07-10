"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeServerEvent } from "@/types/realtime";

export type RealtimeTranscriptionOptions = {
  // 一轮说话定稿时触发。english 已 trim 非空；chinese 可能为空串（输出流缺失/超时兜底时）。
  onFinalSegment: (english: string, chinese: string) => void;
};

export type RealtimeTranscriptionApi = {
  isSupported: boolean;
  isListening: boolean;
  interimTranscript: string; // 流式英文（input_transcript delta 累积）
  interimTranslation: string; // 流式中文（output_transcript delta 累积）
  error: string | null; // 简体中文
  start: () => void;
  stop: () => void;
};

type Timer = ReturnType<typeof setTimeout>;

const REALTIME_TOKEN_ENDPOINT = "/api/realtime-token";
const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/translations/calls";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

// 单轮累积文本上限：防止不换气长说话把内存撑爆（超限保留尾部，即最新内容）。
const MAX_BUFFER_CHARS = 20000;
// input done 之后等待配对的 output done 的超时：避免翻译输出流缺失时永久卡住。
const PENDING_OUTPUT_TIMEOUT_MS = 3000;
// 孤立的 output done（迟迟等不到配对 input）的存活上限：超时直接丢弃，不参与任何配对，
// 避免被后续无关轮次的 input 误配（F1）。
const PENDING_ORPHAN_OUTPUT_TTL_MS = 10000;
// pendingInputs / pendingOutputs 队列容量上限兜底：正常情况下各自的超时机制会及时清空队列，
// 这里只是防御极端场景（定时器堆积、事件风暴）下内存无限增长。
const MAX_PENDING_QUEUE_LENGTH = 20;
// 已超时定稿的 input id“墓碑”集合上限：超出后淘汰最旧的记录。
const MAX_TIMED_OUT_ID_TOMBSTONES = 20;

const DEFAULT_TURN_KEY = "__default__";

// ---- 事件字段防御性读取 ----
// translations 会话事件的具体字段名文档未完全锁定，这里统一用“候选字段名依次尝试”的方式读取，
// 不依赖 TypeScript 的 switch 判别式收窄（联合类型里混了一个宽松的 { type: string } 兜底成员，
// 会污染窄化结果），全部走运行时安全读取。
function readEventText(event: RealtimeServerEvent, keys: readonly string[]): string {
  const record = event as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function readEventId(event: RealtimeServerEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const candidates = [record.item_id, record.turn_id, record.id];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return undefined;
}

function readEventErrorMessage(event: RealtimeServerEvent): string | undefined {
  const record = event as unknown as Record<string, unknown>;
  const err = record.error;
  if (err && typeof err === "object") {
    const message = (err as Record<string, unknown>).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

function capText(text: string): string {
  return text.length > MAX_BUFFER_CHARS ? text.slice(text.length - MAX_BUFFER_CHARS) : text;
}

function appendCapped(map: Map<string, string>, key: string, chunk: string) {
  if (!chunk) return;
  const previous = map.get(key) ?? "";
  map.set(key, capText(previous + chunk));
}

type PendingDone = {
  text: string;
  id?: string;
  timer?: Timer;
};

export function useRealtimeTranscription(
  options: RealtimeTranscriptionOptions
): RealtimeTranscriptionApi {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [interimTranslation, setInterimTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);

  // 用 ref 持有最新回调，避免回调身份变化触发连接重建。
  const onFinalSegmentRef = useRef(options.onFinalSegment);
  useEffect(() => {
    onFinalSegmentRef.current = options.onFinalSegment;
  }, [options.onFinalSegment]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  // 当前连接的事件监听器 + fetch 均挂在这个 controller 上；cleanup 时先 abort 再 close，
  // 避免我们自己触发的 close/statechange 事件被误判为“意外断开”从而再次排队重连，
  // 也用于 stop() 主动中止在途的 token/SDP fetch。
  const connectionAbortRef = useRef<AbortController | null>(null);

  // 代际守卫：每次 start()/重连尝试（对 connect() 的每一次调用）分配一个自增 generation id。
  // 每个 await 之后校验“本流程的 generation 是否仍是当前 generation”，不是则说明：
  // 要么用户已 stop()，要么已有更新的连接尝试取代了本流程——静默退出，只释放本流程
  // 自己持有、尚未对外可见的资源（例如刚拿到还没赋给 streamRef 的麦克风流）；
  // 已经挂到共享 ref 上的资源（pc/dc）由触发这次 generation 变更的一方（stop() 或
  // scheduleReconnect()）负责关闭，避免两处代码互相抢着 close 同一个/或误 close 新流程资源。
  const generationRef = useRef(0);

  // 用户是否期望保持连接：start() 置 true，stop() 或彻底放弃重连时置 false。
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<Timer | null>(null);

  // 按 item/turn id（缺失时用默认 key）累积 delta 文本，用于 UI 展示的 interim 状态。
  const inputDeltaMapRef = useRef<Map<string, string>>(new Map());
  const outputDeltaMapRef = useRef<Map<string, string>>(new Map());

  // 定稿配对队列：done 事件到达后入队，双方都有待配对项时按 id（若都带）或顺序（FIFO）配对。
  const pendingInputsRef = useRef<PendingDone[]>([]);
  const pendingOutputsRef = useRef<PendingDone[]>([]);

  // F1：input 因等不到配对 output 而超时/被挤出队列强制定稿后，记录其 id“墓碑”；
  // 之后同 id 的迟到 output 一律直接丢弃，不再落入下一轮的 FIFO 配对（防止错配级联）。
  const timedOutInputIdsRef = useRef<Set<string>>(new Set());

  // F6：input done 后英文文本已经从 inputDeltaMapRef 移出，但该轮尚未真正 finalize
  // （配对成功或超时）时，仍需要参与 interimTranscript 展示，避免中文还在流式时字幕先闪没。
  const pendingDisplayEnglishRef = useRef<Map<string, string>>(new Map());

  // F2：组件卸载后，任何仍在途的定时器回调都不应再触发 onFinalSegment（上层可能已经 abort 收尾）。
  const disposedRef = useRef(false);

  // F5：未建模事件类型只打一次日志，避免高频未知事件刷屏控制台。
  const seenUnknownEventTypesRef = useRef<Set<string>>(new Set());

  const connectRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (typeof window === "undefined") return;
    const supported =
      typeof navigator !== "undefined" &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === "function" &&
      typeof window.RTCPeerConnection === "function";
    setIsSupported(supported);
  }, []);

  const recomputeInterimTranscript = useCallback(() => {
    // F6：待定稿展示缓冲（本轮英文已 done 但尚未真正 finalize）排在前面，
    // 再拼接仍在流式的下一轮英文，避免中文还在流式时字幕先闪没。
    const pendingDisplay = Array.from(pendingDisplayEnglishRef.current.values());
    const live = Array.from(inputDeltaMapRef.current.values());
    const merged = [...pendingDisplay, ...live].join(" ").trim();
    setInterimTranscript(merged);
  }, []);

  const recomputeInterimTranslation = useCallback(() => {
    const merged = Array.from(outputDeltaMapRef.current.values()).join(" ").trim();
    setInterimTranslation(merged);
  }, []);

  // 清空所有轮次相关的缓冲/队列/定时器与两个 interim 状态。
  // 用于 start() 前的初始化、新连接建立（dc open）时丢弃上一次连接的残留状态、以及 stop()。
  const resetTurnState = useCallback(() => {
    inputDeltaMapRef.current.clear();
    outputDeltaMapRef.current.clear();
    for (const pending of pendingInputsRef.current) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    for (const pending of pendingOutputsRef.current) {
      if (pending.timer) clearTimeout(pending.timer);
    }
    pendingInputsRef.current = [];
    pendingOutputsRef.current = [];
    timedOutInputIdsRef.current.clear();
    pendingDisplayEnglishRef.current.clear();
    setInterimTranscript("");
    setInterimTranslation("");
  }, []);

  const finalizeSegment = useCallback((english: string, chinese: string) => {
    if (disposedRef.current) return; // F2：已卸载，绝不再触发上层回调（上层可能已 abort 收尾）
    const trimmedEnglish = english.trim();
    if (!trimmedEnglish) return; // 契约：english 已 trim 非空才回调
    onFinalSegmentRef.current(trimmedEnglish, chinese.trim());
  }, []);

  // F1：input 因超时或队列容量兜底被强制定稿时的统一出口——记墓碑、清 F6 展示缓冲、真正 finalize。
  // 墓碑集合有容量上限，超出淘汰最旧记录（Set 的插入顺序即淘汰顺序）。
  const finalizeInputAsTimedOut = useCallback(
    (entry: PendingDone) => {
      if (entry.id) {
        const tombstones = timedOutInputIdsRef.current;
        tombstones.delete(entry.id);
        tombstones.add(entry.id);
        if (tombstones.size > MAX_TIMED_OUT_ID_TOMBSTONES) {
          const oldest = tombstones.values().next().value;
          if (oldest !== undefined) tombstones.delete(oldest);
        }
      }
      if (pendingDisplayEnglishRef.current.delete(entry.id ?? DEFAULT_TURN_KEY)) {
        recomputeInterimTranscript();
      }
      finalizeSegment(entry.text, "");
    },
    [finalizeSegment, recomputeInterimTranscript]
  );

  // 尝试把 pendingInputs 与 pendingOutputs 中的待配对项两两配对并定稿，优先按 id 精确匹配；
  // 仅当队首 input 与队首 output 双方都没有 id 时才退化为顺序（FIFO）配对——任何一方带 id
  // 而找不到精确匹配，都继续等待，绝不把两个各自带不同（非空）id 的项按位置配对（F1-1）。
  const tryMatchAndFinalize = useCallback(() => {
    const inputs = pendingInputsRef.current;
    const outputs = pendingOutputsRef.current;

    while (inputs.length > 0 && outputs.length > 0) {
      let inputIdx = -1;
      let outputIdx = -1;

      for (let i = 0; i < inputs.length; i++) {
        const id = inputs[i].id;
        if (!id) continue;
        const j = outputs.findIndex((o) => o.id === id);
        if (j !== -1) {
          inputIdx = i;
          outputIdx = j;
          break;
        }
      }

      if (inputIdx === -1) {
        if (!inputs[0].id && !outputs[0].id) {
          // 双方队首都没有 id：可以安全地按位置（FIFO）配对。
          inputIdx = 0;
          outputIdx = 0;
        } else {
          // 队首至少一方带 id 但没能精确匹配：不做危险的位置配对，继续等待。
          break;
        }
      }

      const [inputEntry] = inputs.splice(inputIdx, 1);
      const [outputEntry] = outputs.splice(outputIdx, 1);
      if (inputEntry.timer) clearTimeout(inputEntry.timer);
      if (outputEntry.timer) clearTimeout(outputEntry.timer);
      if (pendingDisplayEnglishRef.current.delete(inputEntry.id ?? DEFAULT_TURN_KEY)) {
        recomputeInterimTranscript();
      }
      finalizeSegment(inputEntry.text, outputEntry.text);
    }
  }, [finalizeSegment, recomputeInterimTranscript]);

  const enqueuePendingInput = useCallback(
    (text: string, id?: string) => {
      const entry: PendingDone = { text, id };
      entry.timer = setTimeout(() => {
        const idx = pendingInputsRef.current.indexOf(entry);
        if (idx !== -1) {
          pendingInputsRef.current.splice(idx, 1);
          // 输出流迟迟不来：以 chinese="" 兜底触发，避免卡住（F1-2：同时记墓碑防止迟到 output 误配）。
          finalizeInputAsTimedOut(entry);
        }
      }, PENDING_OUTPUT_TIMEOUT_MS);
      pendingInputsRef.current.push(entry);
      if (pendingInputsRef.current.length > MAX_PENDING_QUEUE_LENGTH) {
        // F1-3 兜底：正常不会走到这里（超时定时器会及时清空），仅防御极端事件风暴。
        const [oldest] = pendingInputsRef.current.splice(0, 1);
        if (oldest.timer) clearTimeout(oldest.timer);
        finalizeInputAsTimedOut(oldest);
      }
      tryMatchAndFinalize();
    },
    [finalizeInputAsTimedOut, tryMatchAndFinalize]
  );

  const enqueuePendingOutput = useCallback(
    (text: string, id?: string) => {
      // F1-2：该 id 对应的 input 已经因超时（或容量兜底）强制定稿过，这是一条迟到的 output，
      // 直接丢弃，绝不能落入 FIFO 被配给下一轮 input。
      if (id && timedOutInputIdsRef.current.has(id)) {
        console.debug("[realtime] 丢弃迟到的 output（对应 input 已超时定稿）：", id);
        return;
      }

      const entry: PendingDone = { text, id };
      entry.timer = setTimeout(() => {
        // F1-3：长时间配不到对应 input 的孤立 output，直接丢弃（不定稿），避免污染后续轮次。
        const idx = pendingOutputsRef.current.indexOf(entry);
        if (idx !== -1) pendingOutputsRef.current.splice(idx, 1);
      }, PENDING_ORPHAN_OUTPUT_TTL_MS);
      pendingOutputsRef.current.push(entry);
      if (pendingOutputsRef.current.length > MAX_PENDING_QUEUE_LENGTH) {
        // F1-3 容量兜底：淘汰最旧的孤立 output。
        const [oldest] = pendingOutputsRef.current.splice(0, 1);
        if (oldest.timer) clearTimeout(oldest.timer);
      }
      tryMatchAndFinalize();
    },
    [tryMatchAndFinalize]
  );

  // 关闭当前 pc/dc（先摘除监听器/abort 在途 fetch，再 close，避免自触发的事件被当成意外断开）。
  // stopMic=true 时一并停止麦克风轨道，仅用于用户主动 stop / 卸载 / 权限被拒等终态场景。
  const cleanupConnection = useCallback((stopMic: boolean) => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (connectionAbortRef.current) {
      connectionAbortRef.current.abort();
      connectionAbortRef.current = null;
    }
    if (dcRef.current) {
      try {
        dcRef.current.close();
      } catch {
        // 幂等：可能已处于关闭状态。
      }
      dcRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.close();
      } catch {
        // 幂等：可能已处于关闭状态。
      }
      pcRef.current = null;
    }
    if (stopMic && streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) return;
    if (reconnectTimerRef.current) return; // 已有一次重连在排队，避免重复计数

    reconnectAttemptsRef.current += 1;
    if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
      cleanupConnection(false);
      shouldReconnectRef.current = false;
      setIsListening(false);
      setError("与实时翻译服务的连接多次失败，请检查网络后重新开始。");
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 1),
      RECONNECT_MAX_DELAY_MS
    );

    // F3：进入退避倒计时期间连接已死，UI 不应继续显示“监听中”；重连成功（dc open）时再恢复。
    setIsListening(false);
    cleanupConnection(false);

    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (!shouldReconnectRef.current) return; // 等待期间用户已点击停止
      connectRef.current();
    }, delay);
  }, [cleanupConnection]);

  const handleServerEvent = useCallback(
    (event: RealtimeServerEvent) => {
      switch (event.type) {
        case "session.input_transcript.delta": {
          const key = readEventId(event) ?? DEFAULT_TURN_KEY;
          appendCapped(inputDeltaMapRef.current, key, readEventText(event, ["delta", "text"]));
          recomputeInterimTranscript();
          break;
        }
        case "session.input_transcript.done": {
          const id = readEventId(event);
          const key = id ?? DEFAULT_TURN_KEY;
          let finalText = readEventText(event, ["transcript", "text"]);
          if (!finalText) finalText = inputDeltaMapRef.current.get(key) ?? "";
          if (!finalText) {
            console.debug("[realtime] input_transcript.done 未找到文本字段，原始事件：", event);
          }
          inputDeltaMapRef.current.delete(key);
          // F6：本轮英文尚未真正 finalize（配对成功或超时）前，移入待定稿展示缓冲继续参与
          // interimTranscript，避免中文仍在流式时字幕先闪没；finalize 时才真正清除（见配对/超时逻辑）。
          if (finalText) {
            pendingDisplayEnglishRef.current.set(key, capText(finalText));
          }
          recomputeInterimTranscript();
          enqueuePendingInput(capText(finalText), id);
          break;
        }
        case "session.output_transcript.delta": {
          const key = readEventId(event) ?? DEFAULT_TURN_KEY;
          appendCapped(outputDeltaMapRef.current, key, readEventText(event, ["delta", "text"]));
          recomputeInterimTranslation();
          break;
        }
        case "session.output_transcript.done": {
          const id = readEventId(event);
          const key = id ?? DEFAULT_TURN_KEY;
          let finalText = readEventText(event, ["transcript", "text"]);
          if (!finalText) finalText = outputDeltaMapRef.current.get(key) ?? "";
          outputDeltaMapRef.current.delete(key);
          recomputeInterimTranslation();
          enqueuePendingOutput(capText(finalText), id);
          break;
        }
        case "session.output_audio.delta": {
          // 中文语音 base64：本项目忽略，不播放。
          break;
        }
        case "error": {
          const message = readEventErrorMessage(event);
          setError(message ? `翻译服务返回异常：${message}` : "翻译服务返回未知异常。");
          setIsListening(false);
          // 服务端 error 后连接可能已不可用：拆掉当前连接并计入退避次数重连，
          // 不能只设文案让 UI 停在“显示监听中但会话已死”的状态。
          cleanupConnection(false);
          if (shouldReconnectRef.current) {
            scheduleReconnect();
          }
          break;
        }
        default: {
          // F5：未建模的事件类型。高频的 .delta 后缀事件完全静默；其余每种 type 只打一次，
          // 首次出现打完整事件体方便真机联调时校正字段名，避免刷屏。
          const unknownType = event.type;
          if (!unknownType.endsWith(".delta") && !seenUnknownEventTypesRef.current.has(unknownType)) {
            seenUnknownEventTypesRef.current.add(unknownType);
            console.debug("[realtime] 未知事件类型（同类型仅打印一次）：", unknownType, event);
          }
          break;
        }
      }
    },
    [
      recomputeInterimTranscript,
      recomputeInterimTranslation,
      enqueuePendingInput,
      enqueuePendingOutput,
      cleanupConnection,
      scheduleReconnect,
    ]
  );

  const connect = useCallback(async () => {
    generationRef.current += 1;
    const myGeneration = generationRef.current;
    const isStale = () => generationRef.current !== myGeneration;

    const controller = new AbortController();
    connectionAbortRef.current = controller;
    const { signal } = controller;

    // 1. 每次连接（含重连）前现签 token。
    let tokenValue: string;
    try {
      const tokenResponse = await fetch(REALTIME_TOKEN_ENDPOINT, { signal });
      const tokenPayload = await tokenResponse.json();
      if (!tokenResponse.ok || typeof tokenPayload?.value !== "string") {
        const message =
          typeof tokenPayload?.error === "string"
            ? tokenPayload.error
            : "获取翻译授权失败，请稍后重试。";
        throw new Error(message);
      }
      tokenValue = tokenPayload.value;
    } catch (err) {
      if (isStale() || signal.aborted) return;
      if (!shouldReconnectRef.current) return;
      const message =
        err instanceof Error ? err.message : "获取翻译授权失败，请稍后重试。";
      setError(message);
      scheduleReconnect();
      return;
    }

    if (isStale()) return;
    if (!shouldReconnectRef.current) return;

    // 2. 采音：已有麦克风轨道（重连场景）时直接复用，避免重复弹权限提示。
    let stream: MediaStream;
    if (streamRef.current) {
      stream = streamRef.current;
    } else {
      let newStream: MediaStream;
      try {
        newStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (err) {
        if (isStale()) return; // 本流程已过期，交由使其过期的一方处理状态
        const domError = err as { name?: string };
        const message =
          domError?.name === "NotAllowedError"
            ? "浏览器阻止了麦克风访问，请允许权限后重新启动。"
            : "无法访问麦克风，请检查设备后重试。";
        setError(message);
        shouldReconnectRef.current = false;
        setIsListening(false);
        return;
      }
      if (isStale()) {
        // 权限提示等待期间流程已被取代（如用户 stop 后又 start）：释放刚拿到的、
        // 尚未对外可见的麦克风流，不写入共享 streamRef，避免出现两路占用麦克风。
        newStream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = newStream;
      stream = newStream;
    }

    // 3. 建连：新建 RTCPeerConnection + 数据通道，通过 SDP 交换直连 OpenAI。
    try {
      const pc = new RTCPeerConnection();
      pcRef.current = pc;
      pc.addTrack(stream.getTracks()[0]);

      const dc = pc.createDataChannel("oai-events");
      dcRef.current = dc;

      dc.addEventListener(
        "message",
        (e) => {
          try {
            const parsed = JSON.parse(e.data) as RealtimeServerEvent;
            handleServerEvent(parsed);
          } catch {
            // 忽略无法解析的事件负载。
          }
        },
        { signal }
      );

      dc.addEventListener(
        "open",
        () => {
          if (isStale()) return;
          reconnectAttemptsRef.current = 0;
          setError(null);
          setIsListening(true);
          // 新会话建立：丢弃上一次连接可能残留的未定稿轮次状态。
          resetTurnState();
        },
        { signal }
      );

      dc.addEventListener(
        "close",
        () => {
          if (isStale()) return;
          if (shouldReconnectRef.current) {
            scheduleReconnect();
          }
        },
        { signal }
      );

      const handleUnexpectedDisconnect = () => {
        if (isStale()) return;
        const connState = pc.connectionState;
        const iceState = pc.iceConnectionState;
        const isDown =
          connState === "failed" ||
          connState === "disconnected" ||
          iceState === "failed" ||
          iceState === "disconnected";
        if (isDown && shouldReconnectRef.current) {
          scheduleReconnect();
        }
      };
      pc.addEventListener("connectionstatechange", handleUnexpectedDisconnect, {
        signal,
      });
      pc.addEventListener(
        "iceconnectionstatechange",
        handleUnexpectedDisconnect,
        { signal }
      );

      const offer = await pc.createOffer();
      if (isStale()) return;
      await pc.setLocalDescription(offer);
      if (isStale()) return;

      const sdpResponse = await fetch(REALTIME_CALLS_URL, {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${tokenValue}`,
          "Content-Type": "application/sdp",
        },
        signal,
      });

      if (isStale()) return;

      if (!sdpResponse.ok) {
        throw new Error("与 OpenAI Realtime 翻译服务建立连接失败。");
      }

      const answerSdp = await sdpResponse.text();
      if (isStale()) return;

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      if (isStale()) return;
    } catch (err) {
      if (isStale() || signal.aborted) return;
      const message =
        err instanceof Error ? err.message : "建立翻译连接失败，请稍后重试。";
      setError(message);
      scheduleReconnect();
    }
  }, [handleServerEvent, resetTurnState, scheduleReconnect]);

  useEffect(() => {
    connectRef.current = () => {
      void connect();
    };
  }, [connect]);

  const start = useCallback(() => {
    if (!isSupported) return;

    if (shouldReconnectRef.current) {
      if (reconnectTimerRef.current) {
        // 正处于退避重连倒计时：用户主动点击是最强意图信号——取消排队的重试、
        // 重置退避计数、立即发起新连接，而不是像之前那样空返回。
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
        reconnectAttemptsRef.current = 0;
        setError(null);
        connectRef.current();
      }
      // 否则：已在监听中或正在建连，忽略重复调用（幂等）。
      return;
    }

    setError(null);
    resetTurnState();
    reconnectAttemptsRef.current = 0;
    shouldReconnectRef.current = true;
    connectRef.current();
  }, [isSupported, resetTurnState]);

  const stop = useCallback(() => {
    shouldReconnectRef.current = false;
    reconnectAttemptsRef.current = 0;
    generationRef.current += 1; // 让在途的旧流程在下一个 await 检查点自行退出
    cleanupConnection(true);
    resetTurnState();
    setIsListening(false);
  }, [cleanupConnection, resetTurnState]);

  useEffect(() => {
    return () => {
      disposedRef.current = true; // F2：卸载后 finalizeSegment 绝不再触发 onFinalSegment
      shouldReconnectRef.current = false;
      generationRef.current += 1;
      cleanupConnection(true);
      resetTurnState(); // F2：清掉配对定时器，防止卸载后 3s 超时仍触发定稿逻辑
    };
  }, [cleanupConnection, resetTurnState]);

  return {
    isSupported,
    isListening,
    interimTranscript,
    interimTranslation,
    error,
    start,
    stop,
  };
}
