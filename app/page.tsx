"use client";

import { useEffect, useRef, useState } from "react";

type Segment = {
  id: string;
  english: string;
  chinese: string | null;
  status: "translating" | "done" | "error";
  error?: string;
};

type SpeechRecognitionExtended = SpeechRecognition & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onstart: (() => void) | null;
};

export default function Home() {
  const [isSupported, setIsSupported] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [interimTranscript, setInterimTranscript] = useState("");
  const [interimTranslation, setInterimTranslation] = useState("");
  const [isTranslatingInterim, setIsTranslatingInterim] = useState(false);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognitionExtended | null>(null);
  const shouldResumeRef = useRef(false);
  const scrollAnchorRef = useRef<HTMLDivElement | null>(null);
  const interimAbortRef = useRef<AbortController | null>(null);
  const interimTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastInterimTextRef = useRef("");
  const periodicRestartRef = useRef<NodeJS.Timeout | null>(null);

  const PERIODIC_RESTART_MS = 5 * 60 * 1000;

  useEffect(() => {
    if (typeof window === "undefined") return;

    const SpeechRecognitionConstructor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

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
          const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
          setSegments((prev) => [
            ...prev,
            {
              id,
              english: cleaned,
              chinese: null,
              status: "translating",
            },
          ]);
          translateSegment(id, cleaned);
        });
        setInterimTranscript("");
        setInterimTranslation("");
        setIsTranslatingInterim(false);
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
        } catch (err) {
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
  }, []);

  useEffect(() => {
    if (!interimTranscript) {
      if (interimTimerRef.current) {
        clearTimeout(interimTimerRef.current);
        interimTimerRef.current = null;
      }
      if (interimAbortRef.current) {
        interimAbortRef.current.abort();
        interimAbortRef.current = null;
      }
      setInterimTranslation("");
      setIsTranslatingInterim(false);
      lastInterimTextRef.current = "";
      return;
    }

    if (interimTranscript === lastInterimTextRef.current) return;

    if (interimTimerRef.current) {
      clearTimeout(interimTimerRef.current);
    }

    interimTimerRef.current = setTimeout(() => {
      if (interimAbortRef.current) {
        interimAbortRef.current.abort();
      }

      const controller = new AbortController();
      interimAbortRef.current = controller;
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
    }, 600);

    return () => {
      if (interimTimerRef.current) {
        clearTimeout(interimTimerRef.current);
        interimTimerRef.current = null;
      }
    };
  }, [interimTranscript]);

  useEffect(
    () => () => {
      if (interimTimerRef.current) {
        clearTimeout(interimTimerRef.current);
      }
      if (interimAbortRef.current) {
        interimAbortRef.current.abort();
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

  useEffect(() => {
    scrollAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [segments, interimTranscript, interimTranslation, isTranslatingInterim]);

  const translateSegment = async (id: string, english: string) => {
    setSegments((prev) =>
      prev.map((segment) =>
        segment.id === id
          ? { ...segment, status: "translating", error: undefined }
          : segment
      )
    );

    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: english }),
      });

      const payload = await response.json();

      if (!response.ok) {
        throw new Error(payload.error || "翻译失败，请稍后重试。");
      }

      setSegments((prev) =>
        prev.map((segment) =>
          segment.id === id
            ? {
                ...segment,
                status: "done",
                chinese: typeof payload.translation === "string" ? payload.translation : "",
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
  };

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
    setError(null);
  };

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            实时语音翻译助手
          </h1>
          <p className="text-slate-300">
            通过浏览器语音识别实时获取英文语音，并使用 GPT-4o 翻译成中文。
          </p>
        </header>

        {!isSupported ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            当前浏览器不支持 Web Speech API。请尝试使用最新版本的 Chrome 或 Edge。
          </div>
        ) : null}

        <section className="flex flex-wrap items-center gap-4">
          <button
            type="button"
            onClick={handleToggleListening}
            className={`rounded-full px-6 py-2 text-sm font-medium transition ${
              isListening
                ? "bg-rose-500 text-white hover:bg-rose-400"
                : "bg-emerald-500 text-white hover:bg-emerald-400"
            } disabled:cursor-not-allowed disabled:opacity-60`}
            disabled={!isSupported}
          >
            {isListening ? "停止监听" : "开始实时翻译"}
          </button>

          <button
            type="button"
            onClick={handleClear}
            className="rounded-full border border-slate-700 px-5 py-2 text-sm text-slate-200 transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={isListening || (segments.length === 0 && !interimTranscript && !error)}
          >
            清空记录
          </button>

          <span
            className={`text-sm font-medium ${
              isListening ? "text-emerald-400" : "text-slate-500"
            }`}
          >
            {isListening ? "监听中…" : "待命"}
          </span>
        </section>

        {error ? (
          <div className="rounded-lg border border-orange-500/40 bg-orange-500/10 px-4 py-3 text-sm text-orange-300">
            {error}
          </div>
        ) : null}

        <section className="space-y-4">
          <h2 className="text-lg font-semibold text-slate-200">实时转写 & 翻译</h2>
          <div className="space-y-4">
            {segments.length === 0 && !interimTranscript ? (
              <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-500">
                点击“开始实时翻译”，发言内容将实时转写为英文并翻译成中文。
              </div>
            ) : null}

            {segments.map((segment) => (
              <div
                key={segment.id}
                className="rounded-lg border border-slate-800 bg-slate-900/60 p-4"
              >
                <p className="text-sm font-medium text-slate-300">English</p>
                <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">
                  {segment.english}
                </p>
                <p className="mt-3 text-sm font-medium text-slate-300">中文翻译</p>
                {segment.status === "translating" ? (
                  <p className="mt-1 text-sm text-slate-400">GPT 翻译中…</p>
                ) : null}
                {segment.status === "done" ? (
                  <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">
                    {segment.chinese}
                  </p>
                ) : null}
                {segment.status === "error" && segment.error ? (
                  <p className="mt-1 text-sm text-orange-300">{segment.error}</p>
                ) : null}
              </div>
            ))}

            {interimTranscript ? (
              <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
                <p className="font-medium">识别中（临时结果）</p>
                <p className="mt-1 whitespace-pre-wrap">{interimTranscript}</p>
                <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-slate-100">
                  <p className="text-xs font-medium text-emerald-200">
                    实时翻译
                  </p>
                  {isTranslatingInterim ? (
                    <p className="mt-1 text-xs text-emerald-100/80">
                      GPT 翻译中…
                    </p>
                  ) : (
                    <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">
                      {interimTranslation || "等待更多语音…"}
                    </p>
                  )}
                </div>
              </div>
            ) : null}
            <div ref={scrollAnchorRef} />
          </div>
        </section>

        <section className="rounded-lg border border-slate-800 bg-slate-900/40 px-4 py-3 text-sm text-slate-400">
          <p>
            提示：SpeechRecognition 依赖浏览器和麦克风环境，背景噪音或说话者过多会降低准确率。GPT
            翻译会在检测到最终语句后触发，长时间会议建议定期整理记录。
          </p>
        </section>
      </div>
    </div>
  );
}
