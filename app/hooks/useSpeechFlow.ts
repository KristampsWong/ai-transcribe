"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Segment } from "@/types/segment";

type SpeechRecognitionExtended = SpeechRecognition;
type Timer = ReturnType<typeof setTimeout>;

const INTERIM_DEBOUNCE_MS = 600;
const PERIODIC_RESTART_MS = 5 * 60 * 1000;

export function useSpeechFlow() {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [interimTranslation, setInterimTranslation] = useState("");
  const [isTranslatingInterim, setIsTranslatingInterim] = useState(false);
  const [interimAnswer, setInterimAnswer] = useState<{
    english: string;
    chinese: string;
  } | null>(null);
  const [isAnsweringInterim, setIsAnsweringInterim] = useState(false);
  const [interimIsQuestion, setInterimIsQuestion] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [customPrompt, setCustomPrompt] = useState(
    "You are a helpful AI assistant in a real-time meeting context. Answer questions concisely and naturally. Provide your answer in both English and Chinese (Simplified), separated by '---SEPARATOR---'. Format: English answer first, then the separator, then Chinese answer."
  );

  const recognitionRef = useRef<SpeechRecognitionExtended | null>(null);
  const shouldResumeRef = useRef(false);
  const interimTranslateAbortRef = useRef<AbortController | null>(null);
  const interimAnswerAbortRef = useRef<AbortController | null>(null);
  const interimTranslateTimerRef = useRef<Timer | null>(null);
  const interimAnswerTimerRef = useRef<Timer | null>(null);
  const lastInterimTextRef = useRef("");
  const periodicRestartRef = useRef<Timer | null>(null);
  const enqueueSegmentRef = useRef<((english: string) => void) | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    type SpeechRecognitionConstructor = new () => SpeechRecognition;

    const globalWindow = window as typeof window & {
      SpeechRecognition?: SpeechRecognitionConstructor;
      webkitSpeechRecognition?: SpeechRecognitionConstructor;
    };

    const SpeechRecognitionConstructor =
      globalWindow.SpeechRecognition ?? globalWindow.webkitSpeechRecognition;

    if (!SpeechRecognitionConstructor) {
      setIsSupported(false);
      return;
    }

    setIsSupported(true);

    const recognition: SpeechRecognitionExtended = new SpeechRecognitionConstructor();
    recognition.lang = "en-US";
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onstart = () => {
      setIsListening(true);
      setError(null);
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let interim = "";
      const finalSegments: string[] = [];

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalSegments.push(transcript);
        } else {
          interim += transcript;
        }
      }

      if (finalSegments.length > 0) {
        finalSegments.forEach((text) => {
          const cleaned = text.trim();
          if (!cleaned) return;
          enqueueSegmentRef.current?.(cleaned);
        });
        setInterimTranscript("");
        setInterimTranslation("");
        setIsTranslatingInterim(false);
        setInterimAnswer(null);
        setIsAnsweringInterim(false);
        setInterimIsQuestion(false);
        lastInterimTextRef.current = "";
      } else {
        setInterimTranscript(interim.trim());
      }
    };

    recognition.onerror = (event) => {
      const { error: errorType } = event;
      if (errorType === "aborted") return;

      const message =
        errorType === "not-allowed"
          ? "浏览器阻止了麦克风访问，请允许权限后重新启动。"
          : errorType === "no-speech"
            ? "未检测到语音输入，稍后请再试。"
            : "语音识别出现异常，请稍后再试。";
      setError(message);
      shouldResumeRef.current = false;
      recognition.stop();
    };

    recognition.onend = () => {
      if (shouldResumeRef.current) {
        try {
          recognition.start();
        } catch {
          setError("语音识别重启失败，请手动重新开始。");
          setIsListening(false);
        }
      } else {
        setIsListening(false);
      }
    };

    recognitionRef.current = recognition;

    return () => {
      shouldResumeRef.current = false;
      recognition.stop();
      recognitionRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!interimTranscript) {
      if (interimTranslateTimerRef.current) {
        clearTimeout(interimTranslateTimerRef.current);
        interimTranslateTimerRef.current = null;
      }
      if (interimTranslateAbortRef.current) {
        interimTranslateAbortRef.current.abort();
        interimTranslateAbortRef.current = null;
      }
      setInterimTranslation("");
      setIsTranslatingInterim(false);
      return;
    }

    if (interimTranscript === lastInterimTextRef.current) return;

    if (interimTranslateTimerRef.current) {
      clearTimeout(interimTranslateTimerRef.current);
    }

    interimTranslateTimerRef.current = setTimeout(() => {
      if (interimTranslateAbortRef.current) {
        interimTranslateAbortRef.current.abort();
      }

      const controller = new AbortController();
      interimTranslateAbortRef.current = controller;
      lastInterimTextRef.current = interimTranscript;
      setIsTranslatingInterim(true);

      fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: interimTranscript }),
        signal: controller.signal,
      })
        .then(async (res) => {
          const payload = await res.json();
          if (!res.ok) {
            throw new Error(payload.error || "翻译失败，请稍后重试。");
          }
          if (controller.signal.aborted) return;
          setInterimTranslation(
            typeof payload.translation === "string" ? payload.translation : ""
          );
          setIsTranslatingInterim(false);
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          setIsTranslatingInterim(false);
        });
    }, INTERIM_DEBOUNCE_MS);

    return () => {
      if (interimTranslateTimerRef.current) {
        clearTimeout(interimTranslateTimerRef.current);
        interimTranslateTimerRef.current = null;
      }
    };
  }, [interimTranscript]);

  useEffect(() => {
    if (!interimTranscript) {
      if (interimAnswerTimerRef.current) {
        clearTimeout(interimAnswerTimerRef.current);
        interimAnswerTimerRef.current = null;
      }
      if (interimAnswerAbortRef.current) {
        interimAnswerAbortRef.current.abort();
        interimAnswerAbortRef.current = null;
      }
      setInterimAnswer(null);
      setIsAnsweringInterim(false);
      setInterimIsQuestion(false);
      return;
    }

    if (interimAnswerTimerRef.current) {
      clearTimeout(interimAnswerTimerRef.current);
    }

    interimAnswerTimerRef.current = setTimeout(() => {
      if (interimAnswerAbortRef.current) {
        interimAnswerAbortRef.current.abort();
      }

      const controller = new AbortController();
      interimAnswerAbortRef.current = controller;
      setIsAnsweringInterim(true);

      const history = segments.map((seg) => ({
        english: seg.english,
        chinese: seg.chinese,
      }));

      fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: interimTranscript, history, customPrompt }),
        signal: controller.signal,
      })
        .then(async (res) => {
          const payload = await res.json();
          if (!res.ok) {
            throw new Error(payload.error || "AI回答失败。");
          }
          if (controller.signal.aborted) return;

          setInterimIsQuestion(payload.isQuestion || false);
          if (payload.isQuestion && payload.answer) {
            setInterimAnswer({
              english: payload.answer.english || "",
              chinese: payload.answer.chinese || "",
            });
          } else {
            setInterimAnswer(null);
          }
          setIsAnsweringInterim(false);
        })
        .catch((err) => {
          if (err.name === "AbortError") return;
          setIsAnsweringInterim(false);
        });
    }, INTERIM_DEBOUNCE_MS);

    return () => {
      if (interimAnswerTimerRef.current) {
        clearTimeout(interimAnswerTimerRef.current);
        interimAnswerTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interimTranscript, segments]);

  useEffect(
    () => () => {
      if (interimTranslateTimerRef.current) {
        clearTimeout(interimTranslateTimerRef.current);
      }
      if (interimAnswerTimerRef.current) {
        clearTimeout(interimAnswerTimerRef.current);
      }
      if (interimTranslateAbortRef.current) {
        interimTranslateAbortRef.current.abort();
      }
      if (interimAnswerAbortRef.current) {
        interimAnswerAbortRef.current.abort();
      }
      if (periodicRestartRef.current) {
        clearInterval(periodicRestartRef.current);
      }
    },
    []
  );

  useEffect(() => {
    if (!isListening || !recognitionRef.current) {
      if (periodicRestartRef.current) {
        clearInterval(periodicRestartRef.current);
        periodicRestartRef.current = null;
      }
      return;
    }

    periodicRestartRef.current = setInterval(() => {
      if (!recognitionRef.current) return;
      try {
        recognitionRef.current.stop();
      } catch {
        // Swallow errors; onend will attempt to restart when appropriate.
      }
    }, PERIODIC_RESTART_MS);

    return () => {
      if (periodicRestartRef.current) {
        clearInterval(periodicRestartRef.current);
        periodicRestartRef.current = null;
      }
    };
  }, [isListening]);

  const translateAndAnswerSegment = useCallback(
    async (id: string, english: string, history: Segment[]) => {
      setSegments((prev) =>
        prev.map((segment) =>
          segment.id === id
            ? {
                ...segment,
                status: "translating",
                answerStatus: "answering",
                error: undefined,
                answerError: undefined,
              }
            : segment
        )
      );

      const translatePromise = fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: english }),
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "翻译失败，请稍后重试。");
          }
          return typeof payload.translation === "string" ? payload.translation : "";
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "翻译出现未知错误。";
          throw new Error(message);
        });

      const answerHistory = history.map((seg) => ({
        english: seg.english,
        chinese: seg.chinese,
      }));

      const answerPromise = fetch("/api/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: english, history: answerHistory, customPrompt }),
      })
        .then(async (response) => {
          const payload = await response.json();
          if (!response.ok) {
            throw new Error(payload.error || "AI回答失败。");
          }
          return payload;
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : "AI回答出现未知错误。";
          throw new Error(message);
        });

      try {
        const translation = await translatePromise;
        setSegments((prev) =>
          prev.map((segment) =>
            segment.id === id
              ? {
                  ...segment,
                  status: "done",
                  chinese: translation,
                }
              : segment
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "翻译出现未知错误。";
        setSegments((prev) =>
          prev.map((segment) =>
            segment.id === id
              ? {
                  ...segment,
                  status: "error",
                  error: message,
                }
              : segment
          )
        );
      }

      try {
        const answerData = await answerPromise;
        setSegments((prev) =>
          prev.map((segment) =>
            segment.id === id
              ? {
                  ...segment,
                  isQuestion: answerData.isQuestion || false,
                  answer: answerData.answer || null,
                  answerStatus: "done",
                }
              : segment
          )
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "AI回答出现未知错误。";
        setSegments((prev) =>
          prev.map((segment) =>
            segment.id === id
              ? {
                  ...segment,
                  answerStatus: "error",
                  answerError: message,
                }
              : segment
          )
        );
      }
    },
    [customPrompt]
  );

  const enqueueSegment = useCallback(
    (english: string) => {
      const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      setSegments((prev) => {
        const next: Segment[] = [
          ...prev,
          {
            id,
            english,
            chinese: null,
            status: "translating",
            isQuestion: false,
            answer: null,
            answerStatus: "pending",
          },
        ];
        translateAndAnswerSegment(id, english, next);
        return next;
      });
    },
    [translateAndAnswerSegment]
  );

  useEffect(() => {
    enqueueSegmentRef.current = enqueueSegment;
  }, [enqueueSegment]);

  const handleToggleListening = () => {
    if (!isSupported || !recognitionRef.current) return;

    const recognition = recognitionRef.current;

    if (isListening) {
      shouldResumeRef.current = false;
      recognition.stop();
      return;
    }

    try {
      shouldResumeRef.current = true;
      recognition.start();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "无法启动语音识别，请稍后重试。";
      setError(message);
      shouldResumeRef.current = false;
    }
  };

  const handleClear = () => {
    if (isListening) return;
    setSegments([]);
    setInterimTranscript("");
    setInterimTranslation("");
    setIsTranslatingInterim(false);
    setInterimAnswer(null);
    setIsAnsweringInterim(false);
    setInterimIsQuestion(false);
    setError(null);
  };

  return {
    isSupported,
    isListening,
    interimTranscript,
    interimTranslation,
    isTranslatingInterim,
    interimAnswer,
    isAnsweringInterim,
    interimIsQuestion,
    segments,
    error,
    customPrompt,
    setCustomPrompt,
    handleToggleListening,
    handleClear,
  };
}
