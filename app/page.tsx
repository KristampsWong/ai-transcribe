"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
    scrollToBottom(translationListRef.current);
  }, [segments, interimTranscript, interimTranslation, isTranslatingInterim]);

  useEffect(() => {
    scrollToBottom(qaListRef.current);
  }, [segments, interimAnswer, isAnsweringInterim, interimIsQuestion]);

  return (
    <div className="min-h-screen bg-slate-950 px-6 py-12 text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            实时语音翻译 & AI 助手
          </h1>
          <p className="text-slate-300">
            通过浏览器语音识别实时获取英文语音，并使用 GPT-4o 翻译成中文。AI 会自动检测问题并给出回答。
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

        <section className="space-y-2">
          <label htmlFor="customPrompt" className="text-sm font-medium text-slate-200">
            自定义 AI 回答 Prompt
          </label>
          <textarea
            id="customPrompt"
            value={customPrompt}
            onChange={(e) => setCustomPrompt(e.target.value)}
            className="w-full rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-100 placeholder-slate-500 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="输入自定义 AI 回答的 system prompt..."
            rows={4}
            disabled={isListening}
          />
          <p className="text-xs text-slate-400">
            提示：请确保 prompt 中包含要求 AI 使用 &apos;---SEPARATOR---&apos; 分隔中英文回答的说明。
          </p>
        </section>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="space-y-4">
            <h2 className="text-lg font-semibold text-slate-200">实时转写 & 翻译</h2>
            <div
              ref={translationListRef}
              className="space-y-4 max-h-[600px] overflow-y-auto pr-2 no-scrollbar"
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
              className="space-y-4 max-h-[600px] overflow-y-auto pr-2 no-scrollbar"
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
    </div>
  );
}
