import { Segment } from "@/types/segment";

type TranslationSegmentCardProps = {
  segment: Segment;
};

export function TranslationSegmentCard({ segment }: TranslationSegmentCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        segment.isQuestion
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-slate-800 bg-slate-900/60"
      }`}
    >
      <p className="text-sm font-medium text-slate-300">English</p>
      <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">{segment.english}</p>
      <p className="mt-3 text-sm font-medium text-slate-300">中文翻译</p>
      {segment.status === "translating" ? (
        <p className="mt-1 text-sm text-slate-400">GPT 翻译中…</p>
      ) : null}
      {segment.status === "done" ? (
        <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">{segment.chinese}</p>
      ) : null}
      {segment.status === "error" && segment.error ? (
        <p className="mt-1 text-sm text-orange-300">{segment.error}</p>
      ) : null}
    </div>
  );
}

type InterimTranslationCardProps = {
  interimTranscript: string;
  interimTranslation: string;
  isTranslatingInterim: boolean;
  interimIsQuestion: boolean;
};

export function InterimTranslationCard({
  interimTranscript,
  interimTranslation,
  isTranslatingInterim,
  interimIsQuestion,
}: InterimTranslationCardProps) {
  return (
    <div
      className={`rounded-lg border p-4 ${
        interimIsQuestion
          ? "border-blue-500/40 bg-blue-500/10"
          : "border-emerald-500/40 bg-emerald-500/10"
      } text-sm text-emerald-200`}
    >
      <p className="font-medium">识别中（临时结果）</p>
      <p className="mt-1 whitespace-pre-wrap">{interimTranscript}</p>
      <div className="mt-3 rounded border border-emerald-500/30 bg-emerald-500/5 p-3 text-slate-100">
        <p className="text-xs font-medium text-emerald-200">实时翻译</p>
        {isTranslatingInterim ? (
          <p className="mt-1 text-xs text-emerald-100/80">GPT 翻译中…</p>
        ) : (
          <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">
            {interimTranslation || "等待更多语音…"}
          </p>
        )}
      </div>
    </div>
  );
}

type QuestionAnswerCardProps = {
  segment: Segment;
};

export function QuestionAnswerCard({ segment }: QuestionAnswerCardProps) {
  return (
    <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-4">
      <p className="text-sm font-medium text-blue-300">问题</p>
      <p className="mt-1 text-sm text-slate-100 whitespace-pre-wrap">{segment.english}</p>

      <p className="mt-3 text-sm font-medium text-blue-300">AI 回答</p>
      {segment.answerStatus === "answering" ? (
        <p className="mt-1 text-sm text-slate-400">AI 思考中…</p>
      ) : null}
      {segment.answerStatus === "done" && segment.answer ? (
        <div className="mt-2 space-y-2">
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="text-xs font-medium text-blue-200 mb-1">English</p>
            <p className="text-sm text-slate-100 whitespace-pre-wrap">{segment.answer.english}</p>
          </div>
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="text-xs font-medium text-blue-200 mb-1">中文</p>
            <p className="text-sm text-slate-100 whitespace-pre-wrap">{segment.answer.chinese}</p>
          </div>
        </div>
      ) : null}
      {segment.answerStatus === "error" && segment.answerError ? (
        <p className="mt-1 text-sm text-orange-300">{segment.answerError}</p>
      ) : null}
    </div>
  );
}

type InterimAnswerCardProps = {
  interimTranscript: string;
  interimAnswer: Segment["answer"] | null;
  isAnsweringInterim: boolean;
};

export function InterimAnswerCard({
  interimTranscript,
  interimAnswer,
  isAnsweringInterim,
}: InterimAnswerCardProps) {
  return (
    <div className="rounded-lg border border-blue-500/40 bg-blue-500/10 p-4 text-sm">
      <p className="font-medium text-blue-300">问题（临时）</p>
      <p className="mt-1 text-slate-100 whitespace-pre-wrap">{interimTranscript}</p>

      <p className="mt-3 text-sm font-medium text-blue-300">AI 回答预览</p>
      {isAnsweringInterim ? (
        <p className="mt-1 text-sm text-slate-400">AI 思考中…</p>
      ) : interimAnswer ? (
        <div className="mt-2 space-y-2">
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="text-xs font-medium text-blue-200 mb-1">English</p>
            <p className="text-sm text-slate-100 whitespace-pre-wrap">{interimAnswer.english}</p>
          </div>
          <div className="rounded border border-blue-500/30 bg-blue-500/5 p-3">
            <p className="text-xs font-medium text-blue-200 mb-1">中文</p>
            <p className="text-sm text-slate-100 whitespace-pre-wrap">{interimAnswer.chinese}</p>
          </div>
        </div>
      ) : (
        <p className="mt-1 text-sm text-slate-400">等待更多语音…</p>
      )}
    </div>
  );
}
