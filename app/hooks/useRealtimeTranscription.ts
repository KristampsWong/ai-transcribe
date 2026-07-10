"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { RealtimeServerEvent } from "@/types/realtime";

export type RealtimeTranscriptionOptions = {
  // 一段语音 commit 后转写定稿时触发。english 已 trim 非空。
  onFinalSegment: (englishText: string) => void;
};

export type RealtimeTranscriptionApi = {
  isSupported: boolean;
  isListening: boolean;
  interimTranscript: string; // 流式英文（转写 delta 累积）
  error: string | null; // 简体中文
  start: () => void;
  stop: () => void;
};

type Timer = ReturnType<typeof setTimeout>;

const REALTIME_TOKEN_ENDPOINT = "/api/realtime-token";
const REALTIME_CALLS_URL = "https://api.openai.com/v1/realtime/calls";

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8000;

// 单轮累积文本上限：防止不换气长说话把内存撑爆（超限保留尾部，即最新内容）。
const MAX_BUFFER_CHARS = 20000;

const DEFAULT_TURN_KEY = "__default__";

// ---- 客户端静音检测 + 手动分段 ----
// gpt-realtime-whisper 转写会话不支持 VAD（turn_detection 恒为 null），分段职责转移到客户端：
// 用 AnalyserNode 周期性采样麦克风 RMS 音量，判定“说话中 -> 静音持续一段时间”后
// 主动通过数据通道发 input_audio_buffer.commit，让服务端把当前缓冲定稿并清空。
const SPEECH_THRESHOLD = 0.02; // RMS 音量阈值：高于此值视为“说话中”
const SILENCE_COMMIT_MS = 700; // 说话中检测到静音连续超过该时长即手动 commit 分段
const MAX_UTTERANCE_MS = 15000; // 单句持续说话超过该上限也强制 commit，防止一句永不定稿
const SILENCE_SAMPLE_INTERVAL_MS = 80; // 静音检测采样间隔
const ANALYSER_FFT_SIZE = 512; // 足够小，兼顾 80ms 采样节奏下的实时性与开销

// ---- 事件字段防御性读取 ----
// 转写会话事件的具体字段名文档未完全锁定，这里统一用“候选字段名依次尝试”的方式读取，
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
  const candidates = [record.item_id, record.id];
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

export function useRealtimeTranscription(
  options: RealtimeTranscriptionOptions
): RealtimeTranscriptionApi {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
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

  // 按 item id（缺失时用默认 key）累积转写 delta 文本，用于 UI 展示的 interim 状态。
  const inputDeltaMapRef = useRef<Map<string, string>>(new Map());

  // 静音检测相关状态。
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const silenceIntervalRef = useRef<Timer | null>(null);
  const silenceSampleBufferRef = useRef<Float32Array<ArrayBuffer> | null>(null);
  const hasSpeechSinceCommitRef = useRef(false); // 自上次 commit 以来是否检测到过“说话中”
  const belowThresholdSinceRef = useRef<number | null>(null); // 本轮静音连续开始的时间戳
  const speechStartRef = useRef<number | null>(null); // 本轮说话开始的时间戳（用于 MAX_UTTERANCE_MS）

  // 组件卸载后，任何仍在途的异步回调都不应再触发 onFinalSegment（上层可能已经 abort 收尾）。
  const disposedRef = useRef(false);

  // 未建模事件类型只打一次日志，避免高频未知事件刷屏控制台。
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
    const merged = Array.from(inputDeltaMapRef.current.values()).join(" ").trim();
    setInterimTranscript(merged);
  }, []);

  // 清空转写相关的缓冲与 interim 状态。
  // 用于 start() 前的初始化、新连接建立（dc open）时丢弃上一次连接的残留状态、以及 stop()。
  const resetTurnState = useCallback(() => {
    inputDeltaMapRef.current.clear();
    setInterimTranscript("");
  }, []);

  const finalizeSegment = useCallback((english: string) => {
    if (disposedRef.current) return; // 已卸载，绝不再触发上层回调（上层可能已 abort 收尾）
    const trimmedEnglish = english.trim();
    if (!trimmedEnglish) return; // 契约：english 已 trim 非空才回调
    onFinalSegmentRef.current(trimmedEnglish);
  }, []);

  // 通过数据通道发送 input_audio_buffer.commit，让服务端把当前缓冲定稿并清空。
  // 两道防线：hasSpeechSinceCommitRef 为 false（自上次 commit 以来还没检测到说话）时绝不发送，
  // 避免空缓冲 commit 报错；dc 未 open 时也不发送。发送后立即重置说话状态，等待下一句。
  const attemptCommit = useCallback(() => {
    if (!hasSpeechSinceCommitRef.current) return;
    const dc = dcRef.current;
    if (!dc || dc.readyState !== "open") return;
    try {
      dc.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    } catch {
      // dc 可能在发送瞬间关闭，忽略；下一句说话仍会重新走一遍状态机。
    }
    hasSpeechSinceCommitRef.current = false;
    belowThresholdSinceRef.current = null;
    speechStartRef.current = null;
  }, []);

  // 静音检测状态机：每 SILENCE_SAMPLE_INTERVAL_MS 采样一次麦克风 RMS 音量。
  // RMS > 阈值：记为“说话中”；说话中且 RMS 持续低于阈值达 SILENCE_COMMIT_MS：手动 commit；
  // 说话持续超过 MAX_UTTERANCE_MS：强制 commit，防止一句永不定稿。
  const sampleSilenceDetection = useCallback(() => {
    const analyser = analyserRef.current;
    const buffer = silenceSampleBufferRef.current;
    if (!analyser || !buffer) return;

    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      sumSquares += buffer[i] * buffer[i];
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    const now = Date.now();

    if (rms > SPEECH_THRESHOLD) {
      belowThresholdSinceRef.current = null;
      if (!hasSpeechSinceCommitRef.current) {
        speechStartRef.current = now;
      }
      hasSpeechSinceCommitRef.current = true;
    } else if (hasSpeechSinceCommitRef.current) {
      if (belowThresholdSinceRef.current === null) {
        belowThresholdSinceRef.current = now;
      } else if (now - belowThresholdSinceRef.current >= SILENCE_COMMIT_MS) {
        attemptCommit();
        return; // 本 tick 已处理完毕，无需再检查 MAX_UTTERANCE_MS。
      }
    }

    if (
      hasSpeechSinceCommitRef.current &&
      speechStartRef.current !== null &&
      now - speechStartRef.current >= MAX_UTTERANCE_MS
    ) {
      attemptCommit();
    }
  }, [attemptCommit]);

  // 连接建立后调用：在麦克风 MediaStream 上挂 AudioContext + AnalyserNode，启动采样定时器。
  // 初始化失败（如浏览器不支持 AudioContext）不应阻断转写主链路，静默降级即可——
  // 后果仅是失去自动分段能力，转写本身仍然正常工作。
  const setupSilenceDetection = useCallback(
    (stream: MediaStream) => {
      try {
        if (typeof window === "undefined" || !window.AudioContext) return;
        const audioContext = new window.AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = ANALYSER_FFT_SIZE;
        source.connect(analyser);

        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        silenceSampleBufferRef.current = new Float32Array(analyser.fftSize);
        hasSpeechSinceCommitRef.current = false;
        belowThresholdSinceRef.current = null;
        speechStartRef.current = null;

        silenceIntervalRef.current = setInterval(
          sampleSilenceDetection,
          SILENCE_SAMPLE_INTERVAL_MS
        );
      } catch {
        // 静默降级，见上方注释。
      }
    },
    [sampleSilenceDetection]
  );

  // 停止采样定时器并关闭 AudioContext（close() 返回 Promise，吞掉异常——
  // 可能已处于关闭中或已关闭）。重置所有静音检测状态，供下一次连接重新初始化。
  const teardownSilenceDetection = useCallback(() => {
    if (silenceIntervalRef.current) {
      clearInterval(silenceIntervalRef.current);
      silenceIntervalRef.current = null;
    }
    analyserRef.current = null;
    silenceSampleBufferRef.current = null;
    hasSpeechSinceCommitRef.current = false;
    belowThresholdSinceRef.current = null;
    speechStartRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx && ctx.state !== "closed") {
      ctx.close().catch(() => {
        // 忽略：可能已在关闭中或已关闭。
      });
    }
  }, []);

  // 关闭当前 pc/dc（先摘除监听器/abort 在途 fetch，再 close，避免自触发的事件被当成意外断开）。
  // stopMic=true 时一并停止麦克风轨道，仅用于用户主动 stop / 卸载 / 权限被拒等终态场景。
  const cleanupConnection = useCallback(
    (stopMic: boolean) => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (connectionAbortRef.current) {
        connectionAbortRef.current.abort();
        connectionAbortRef.current = null;
      }
      // 停止时若最后一句未攒够静音间隔，该句会被放弃（监听器已随连接拆除）。
      teardownSilenceDetection();
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
    },
    [teardownSilenceDetection]
  );

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current) return;
    if (reconnectTimerRef.current) return; // 已有一次重连在排队，避免重复计数

    reconnectAttemptsRef.current += 1;
    if (reconnectAttemptsRef.current > MAX_RECONNECT_ATTEMPTS) {
      cleanupConnection(false);
      shouldReconnectRef.current = false;
      setIsListening(false);
      setError("与实时转写服务的连接多次失败，请检查网络后重新开始。");
      return;
    }

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** (reconnectAttemptsRef.current - 1),
      RECONNECT_MAX_DELAY_MS
    );

    // 进入退避倒计时期间连接已死，UI 不应继续显示“监听中”；重连成功（dc open）时再恢复。
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
        case "conversation.item.input_audio_transcription.delta": {
          const key = readEventId(event) ?? DEFAULT_TURN_KEY;
          appendCapped(inputDeltaMapRef.current, key, readEventText(event, ["delta", "text"]));
          recomputeInterimTranscript();
          break;
        }
        case "conversation.item.input_audio_transcription.completed": {
          const id = readEventId(event);
          const key = id ?? DEFAULT_TURN_KEY;
          let finalText = readEventText(event, ["transcript", "text"]);
          if (!finalText) finalText = inputDeltaMapRef.current.get(key) ?? "";
          if (!finalText) {
            console.debug(
              "[realtime] input_audio_transcription.completed 未找到文本字段，原始事件：",
              event
            );
          }
          inputDeltaMapRef.current.delete(key);
          recomputeInterimTranscript();
          finalizeSegment(capText(finalText));
          break;
        }
        case "error": {
          const message = readEventErrorMessage(event);
          setError(message ? `转写服务返回异常：${message}` : "转写服务返回未知异常。");
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
          // 未建模的事件类型（如 session.created、input_audio_buffer.committed 等）。
          // 高频的 .delta 后缀事件完全静默；其余每种 type 只打一次，
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
    [recomputeInterimTranscript, finalizeSegment, cleanupConnection, scheduleReconnect]
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
            : "获取转写授权失败，请稍后重试。";
        throw new Error(message);
      }
      tokenValue = tokenPayload.value;
    } catch (err) {
      if (isStale() || signal.aborted) return;
      if (!shouldReconnectRef.current) return;
      const message =
        err instanceof Error ? err.message : "获取转写授权失败，请稍后重试。";
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
      // 转写会话没有下行音频，用 sendonly 单向 transceiver 语义更明确（同时仍挂上本地音轨）。
      pc.addTransceiver(stream.getTracks()[0], { direction: "sendonly" });

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
          // 新会话建立：丢弃上一次连接可能残留的未定稿轮次状态，重新初始化静音检测。
          resetTurnState();
          teardownSilenceDetection();
          setupSilenceDetection(stream);
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
        throw new Error("与 OpenAI Realtime 转写服务建立连接失败。");
      }

      const answerSdp = await sdpResponse.text();
      if (isStale()) return;

      await pc.setRemoteDescription({ type: "answer", sdp: answerSdp });
      if (isStale()) return;
    } catch (err) {
      if (isStale() || signal.aborted) return;
      const message =
        err instanceof Error ? err.message : "建立转写连接失败，请稍后重试。";
      setError(message);
      scheduleReconnect();
    }
  }, [
    handleServerEvent,
    resetTurnState,
    scheduleReconnect,
    setupSilenceDetection,
    teardownSilenceDetection,
  ]);

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

  // StrictMode 下开发环境会“挂载 -> 卸载 -> 再挂载”，disposedRef 只应反映“当前这次挂载
  // 是否已卸载”：每次挂载都需在此复位为 false，否则第二次挂载后仍残留上一次卸载置的
  // true，导致 finalizeSegment 永远早退、整条链路在开发态静默失效。
  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      shouldReconnectRef.current = false;
      generationRef.current += 1;
      cleanupConnection(true);
      resetTurnState();
    };
  }, [cleanupConnection, resetTurnState]);

  return {
    isSupported,
    isListening,
    interimTranscript,
    error,
    start,
    stop,
  };
}
