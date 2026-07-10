"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Segment } from "@/types/segment";

import { useRealtimeTranscription } from "./useRealtimeTranscription";

const MAX_SEGMENTS = 200;

type HistoryEntry = {
  id: string;
  english: string;
  chinese: string;
};

type AnswerResponsePayload = {
  isQuestion?: boolean;
  answer?: { english: string; chinese: string } | null;
  error?: string;
};

export function useSpeechFlow() {
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState(
    "You are a helpful AI assistant in a real-time meeting context. Answer questions concisely and naturally. Provide your answer in both English and Chinese (Simplified), separated by '---SEPARATOR---'. Format: English answer first, then the separator, then Chinese answer."
  );

  // 本地“监听意图”标记：在 isListening 真正翻转前拦截重复点击，避免 start/stop 交错。
  const listenIntentRef = useRef(false);

  // final 链路里的异步回填读取最新 customPrompt，避免把它塞进 onFinalSegment 的依赖数组。
  const customPromptRef = useRef(customPrompt);
  useEffect(() => {
    customPromptRef.current = customPrompt;
  }, [customPrompt]);

  // 同步维护的历史记录：onFinalSegment 内同步 push，不依赖 setSegments 的异步生效时机。
  // 传给 /api/answer 的 history 从这里 slice(-5)（在 push 当前轮之前取，天然不含当前句）。
  const historyRef = useRef<HistoryEntry[]>([]);

  // F4：与 segments 状态同节奏裁剪的 id 列表（同步维护，不依赖 setSegments 的异步生效时机）。
  // 用于在裁掉最旧 segment 时，识别被裁掉的 id 并 abort 其在途请求，避免网络卡住时 controller 泄漏。
  const segmentIdsRef = useRef<string[]>([]);

  // 每个 segment 的在途 translate/answer 请求的 AbortController；handleClear/卸载时统一 abort 并清空，
  // 回填前逐一检查 controller.signal.aborted，防止陈旧请求在 segment 被裁剪/清空后仍写回状态。
  const abortMapRef = useRef<Map<string, AbortController[]>>(new Map());

  const addAbortController = useCallback((id: string, controller: AbortController) => {
    const list = abortMapRef.current.get(id);
    if (list) {
      list.push(controller);
    } else {
      abortMapRef.current.set(id, [controller]);
    }
  }, []);

  const removeAbortController = useCallback((id: string, controller: AbortController) => {
    const list = abortMapRef.current.get(id);
    if (!list) return;
    const idx = list.indexOf(controller);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) abortMapRef.current.delete(id);
  }, []);

  const abortAllPending = useCallback(() => {
    for (const controllers of abortMapRef.current.values()) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
    abortMapRef.current.clear();
  }, []);

  const updateHistoryChinese = useCallback((id: string, chinese: string) => {
    const entry = historyRef.current.find((item) => item.id === id);
    if (entry) entry.chinese = chinese;
  }, []);

  // 主翻译路径：每个 final segment 调用一次 SSE 流式 /api/translate，逐块累积中文并回填。
  // 中文全部来自这里——realtime 层不再提供任何中文，onFinalSegment 只给英文。
  const fetchTranslateStream = useCallback(
    (id: string, english: string) => {
      const controller = new AbortController();
      addAbortController(id, controller);

      void (async () => {
        try {
          const response = await fetch("/api/translate", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: english }),
            signal: controller.signal,
          });

          if (!response.ok) {
            let message = "翻译失败，请稍后重试。";
            try {
              const payload = await response.json();
              if (typeof payload?.error === "string") message = payload.error;
            } catch {
              // 上游未返回可解析的 JSON 错误体，使用默认文案。
            }
            throw new Error(message);
          }

          if (!response.body) {
            throw new Error("翻译响应缺少数据流。");
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let accumulated = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (controller.signal.aborted) return; // abort 后不再回填

            const chunk = decoder.decode(value, { stream: true });
            if (!chunk) continue;

            // 累积拼接：每次都用完整的累积文本覆盖 chinese 字段，而不是只写入最新的一块。
            accumulated += chunk;
            const nextChinese = accumulated;
            setSegments((prev) =>
              prev.map((segment) =>
                segment.id === id ? { ...segment, chinese: nextChinese } : segment
              )
            );
          }

          if (controller.signal.aborted) return;

          updateHistoryChinese(id, accumulated);
          setSegments((prev) =>
            prev.map((segment) =>
              segment.id === id ? { ...segment, status: "done", chinese: accumulated } : segment
            )
          );
        } catch (err) {
          if (controller.signal.aborted) return; // abort 触发的 reader 异常静默吞掉
          const message = err instanceof Error ? err.message : "翻译出现未知错误。";
          setSegments((prev) =>
            prev.map((segment) =>
              segment.id === id ? { ...segment, status: "error", error: message } : segment
            )
          );
        } finally {
          removeAbortController(id, controller);
        }
      })();
    },
    [addAbortController, removeAbortController, updateHistoryChinese]
  );

  // 判断是否问题并生成双语回答；与兜底翻译并行、互不等待。
  const fetchAnswer = useCallback(
    (id: string, english: string, history: Array<{ english: string; chinese: string }>) => {
      const controller = new AbortController();
      addAbortController(id, controller);

      void fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: english, history, customPrompt: customPromptRef.current }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload: AnswerResponsePayload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "AI回答失败。");
          }
          return payload;
        })
        .then((payload) => {
          if (controller.signal.aborted) return;
          setSegments((prev) =>
            prev.map((segment) =>
              segment.id === id
                ? {
                    ...segment,
                    isQuestion: payload.isQuestion || false,
                    answer: payload.answer || null,
                    answerStatus: "done",
                  }
                : segment
            )
          );
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : "AI回答出现未知错误。";
          setSegments((prev) =>
            prev.map((segment) =>
              segment.id === id
                ? { ...segment, answerStatus: "error", answerError: message }
                : segment
            )
          );
        })
        .finally(() => {
          removeAbortController(id, controller);
        });
    },
    [addAbortController, removeAbortController]
  );

  // 定稿句回调：底层只给英文（realtime 层不再产出任何中文）。先同步追加一个
  // status:"translating"、chinese:"" 的 segment，再并行发起一次流式翻译 + 一次问答判断请求。
  const onFinalSegment = useCallback(
    (english: string) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

      // 历史快照必须在把本轮写入 historyRef 之前取，天然不包含当前这一句。
      const answerHistory = historyRef.current.slice(-5).map((item) => ({
        english: item.english,
        chinese: item.chinese,
      }));

      historyRef.current.push({ id, english, chinese: "" });
      if (historyRef.current.length > MAX_SEGMENTS) {
        historyRef.current = historyRef.current.slice(historyRef.current.length - MAX_SEGMENTS);
      }

      const segment: Segment = {
        id,
        english,
        chinese: "",
        status: "translating",
        isQuestion: false,
        answer: null,
        answerStatus: "answering",
      };

      // 纯 updater：只做数组拼接与超限裁剪，不发起任何网络请求、不读写任何 ref。
      setSegments((prev) => {
        const next = [...prev, segment];
        return next.length > MAX_SEGMENTS ? next.slice(next.length - MAX_SEGMENTS) : next;
      });

      // F4：updater 之外维护同节奏裁剪的 id 列表；被裁掉的旧 segment 若仍有在途请求，
      // 一并 abort 并从 abortMapRef 移除，避免网络卡住时 controller 永久泄漏。
      segmentIdsRef.current.push(id);
      if (segmentIdsRef.current.length > MAX_SEGMENTS) {
        const overflow = segmentIdsRef.current.length - MAX_SEGMENTS;
        const evictedIds = segmentIdsRef.current.slice(0, overflow);
        segmentIdsRef.current = segmentIdsRef.current.slice(overflow);
        for (const evictedId of evictedIds) {
          const controllers = abortMapRef.current.get(evictedId);
          if (!controllers) continue;
          for (const controller of controllers) controller.abort();
          abortMapRef.current.delete(evictedId);
        }
      }

      fetchTranslateStream(id, english);
      fetchAnswer(id, english, answerHistory);
    },
    [fetchTranslateStream, fetchAnswer]
  );

  const {
    isSupported,
    isListening,
    interimTranscript,
    error: realtimeError,
    start,
    stop,
  } = useRealtimeTranscription({ onFinalSegment });

  // 底层不再提供任何中文流式预览：interim 卡片只展示流式英文，中文在句子定稿后
  // 立刻在 segment 卡片里逐块流式冒出（这是设计意图，而非缺失功能）。
  const interimTranslation = "";
  const isTranslatingInterim = false;

  // 与转写层的错误状态保持镜像，同时允许 handleClear/handleToggleListening 在不监听时本地清除展示。
  useEffect(() => {
    setError(realtimeError);
  }, [realtimeError]);

  // isListening 真正翻转（或转写层出现新错误导致的隐式失败）时，让意图标记与实际状态对齐，
  // 避免“连接失败但意图仍为 true”导致后续点击被误判为重复请求而失效。
  useEffect(() => {
    if (!isListening) {
      listenIntentRef.current = false;
    }
  }, [isListening, realtimeError]);

  // 组件卸载时取消所有在途的 translate/answer 请求。
  useEffect(() => () => abortAllPending(), [abortAllPending]);

  const handleToggleListening = useCallback(() => {
    if (!isSupported) return;

    if (isListening) {
      if (!listenIntentRef.current) return; // 已在停止中，忽略重复点击
      listenIntentRef.current = false;
      stop();
      return;
    }

    if (listenIntentRef.current) return; // 已在连接中，忽略重复点击
    listenIntentRef.current = true;
    setError(null);
    start();
  }, [isSupported, isListening, start, stop]);

  const handleClear = useCallback(() => {
    if (isListening) return;

    abortAllPending();
    historyRef.current = [];
    segmentIdsRef.current = [];
    setSegments([]);
    setError(null);
  }, [isListening, abortAllPending]);

  return {
    isSupported,
    isListening,
    interimTranscript,
    interimTranslation,
    isTranslatingInterim,
    interimAnswer: null,
    isAnsweringInterim: false,
    interimIsQuestion: false,
    segments,
    error,
    customPrompt,
    setCustomPrompt,
    handleToggleListening,
    handleClear,
  };
}
