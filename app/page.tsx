"use client";

import { useEffect, useRef, useState } from "react";

import {
  InterimAnswerCard,
  InterimTranslationCard,
  QuestionAnswerCard,
  TranslationSegmentCard,
} from "./components/TranslationCards";
import { useSpeechFlow } from "./hooks/useSpeechFlow";

const scrollToBottom = (node: HTMLDivElement | null) => {
  if (!node) return;
  const scroll = () => node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  requestAnimationFrame(scroll);
  setTimeout(scroll, 0);
};

// 与 useSpeechFlow 中的默认值保持一致，仅用于 UI 层判断是否已自定义 prompt。
const DEFAULT_CUSTOM_PROMPT =
  "You are a helpful AI assistant in a real-time meeting context. Answer questions concisely and naturally. Provide your answer in both English and Chinese (Simplified), separated by '---SEPARATOR---'. Format: English answer first, then the separator, then Chinese answer.";

export default function Home() {
  const {
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
  } = useSpeechFlow();

  const translationListRef = useRef<HTMLDivElement | null>(null);
  const qaListRef = useRef<HTMLDivElement | null>(null);

  const [isPromptDialogOpen, setIsPromptDialogOpen] = useState(false);
  const isCustomPromptModified = customPrompt !== DEFAULT_CUSTOM_PROMPT;

  useEffect(() => {
    scrollToBottom(translationListRef.current);
  }, [segments, interimTranscript, interimTranslation, isTranslatingInterim]);

  useEffect(() => {
    scrollToBottom(qaListRef.current);
  }, [segments, interimAnswer, isAnsweringInterim, interimIsQuestion]);

  useEffect(() => {
    if (!isPromptDialogOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsPromptDialogOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isPromptDialogOpen]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            实时语音翻译 & AI 助手
          </h1>
          <p className="text-slate-300">
            通过 OpenAI 实时转写获取英文语音，并使用 GPT 翻译成中文。AI 会自动检测问题并给出回答。
          </p>
        </header>

        {!isSupported ? (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            当前浏览器不支持麦克风/WebRTC。请尝试使用最新版本的 Chrome 或 Edge。
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

          <button
            type="button"
            onClick={() => setIsPromptDialogOpen(true)}
            className="relative rounded-full border border-slate-700 px-5 py-2 text-sm text-slate-200 transition hover:bg-slate-800"
          >
            自定义 Prompt
            {isCustomPromptModified ? (
              <span
                className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-emerald-400"
                aria-label="已自定义"
                title="已自定义"
              />
            ) : null}
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

        <div className="flex flex-col gap-6">
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-200">实时转写 & 翻译</h2>
            <div
              ref={translationListRef}
              className="space-y-4 max-h-[60vh] overflow-y-auto pr-2 no-scrollbar"
            >
              {segments.length === 0 && !interimTranscript ? (
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-500">
                  点击&quot;开始实时翻译&quot;，发言内容将实时转写为英文并翻译成中文。
                </div>
              ) : null}

              {segments.map((segment) => (
                <TranslationSegmentCard key={segment.id} segment={segment} />
              ))}

              {interimTranscript ? (
                <InterimTranslationCard
                  interimTranscript={interimTranscript}
                  interimTranslation={interimTranslation}
                  isTranslatingInterim={isTranslatingInterim}
                  interimIsQuestion={interimIsQuestion}
                />
              ) : null}
            </div>
          </section>

          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-200">AI 问答</h2>
            <div
              ref={qaListRef}
              className="space-y-4 max-h-[40vh] overflow-y-auto pr-2 no-scrollbar"
            >
              {segments.length === 0 && !interimTranscript ? (
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm text-slate-500">
                  AI 会自动检测问题并给出中英文双语回答。
                </div>
              ) : null}

              {segments.map((segment) =>
                segment.isQuestion ? (
                  <QuestionAnswerCard key={segment.id} segment={segment} />
                ) : null
              )}

              {interimTranscript && interimIsQuestion ? (
                <InterimAnswerCard
                  interimTranscript={interimTranscript}
                  interimAnswer={interimAnswer}
                  isAnsweringInterim={isAnsweringInterim}
                />
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {isPromptDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
          onClick={() => setIsPromptDialogOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="customPromptDialogTitle"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg rounded-lg border border-slate-700 bg-slate-900 p-6 shadow-xl"
          >
            <div className="flex items-center justify-between">
              <h2 id="customPromptDialogTitle" className="text-lg font-semibold text-slate-100">
                自定义 AI 回答 Prompt
              </h2>
              <button
                type="button"
                onClick={() => setIsPromptDialogOpen(false)}
                aria-label="关闭"
                className="rounded-full p-1 text-slate-400 transition hover:bg-slate-800 hover:text-slate-100"
              >
                ×
              </button>
            </div>

            <div className="mt-4 space-y-2">
              <label htmlFor="customPrompt" className="text-sm font-medium text-slate-200">
                Prompt 内容
              </label>
              <textarea
                id="customPrompt"
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                placeholder="输入自定义 AI 回答的 system prompt..."
                rows={6}
                disabled={isListening}
              />
              <p className="text-xs text-slate-400">
                提示：请确保 prompt 中包含要求 AI 使用 &apos;---SEPARATOR---&apos; 分隔中英文回答的说明。
              </p>
            </div>

            <div className="mt-6 flex justify-end">
              <button
                type="button"
                onClick={() => setIsPromptDialogOpen(false)}
                className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-medium text-white transition hover:bg-emerald-400"
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
