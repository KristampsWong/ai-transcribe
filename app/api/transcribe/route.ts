"use server";

import { NextRequest, NextResponse } from "next/server";

const OPENAI_TRANSCRIBE_URL = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // OpenAI upload limit (approx.)

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "缺少 OPENAI_API_KEY 环境变量，无法调用 GPT-4o 接口。" },
      { status: 500 }
    );
  }

  const formData = await req.formData();
  const audio = formData.get("audio");

  if (!audio || !(audio instanceof File)) {
    return NextResponse.json(
      { error: "未接收到有效的音频文件。" },
      { status: 400 }
    );
  }

  if (audio.size > MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      {
        error:
          "音频文件超过 25MB，建议分段录制会议内容后再上传以提高成功率。",
      },
      { status: 400 }
    );
  }

  try {
    const transcriptionForm = new FormData();
    transcriptionForm.append("model", "gpt-4o-transcribe");
    transcriptionForm.append("file", audio, audio.name || "recording.webm");
    transcriptionForm.append("response_format", "json");

    const transcriptionResponse = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: transcriptionForm,
    });

    const transcriptionData = await transcriptionResponse.json();

    if (!transcriptionResponse.ok) {
      const message =
        typeof transcriptionData.error?.message === "string"
          ? transcriptionData.error.message
          : "调用 GPT-4o 转写接口失败。";
      throw new Error(message);
    }

    const englishTranscript =
      typeof transcriptionData.text === "string"
        ? transcriptionData.text.trim()
        : "";

    if (!englishTranscript) {
      throw new Error("未从 GPT-4o 获取到有效的英文转写结果。");
    }

    const translationResponse = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "你是一个专业的同声传译助手。请将用户提供的英文转写结果翻译成自然流畅的简体中文，保持原意并保留段落换行。",
          },
          {
            role: "user",
            content: englishTranscript,
          },
        ],
      }),
    });

    const translationData = await translationResponse.json();

    if (!translationResponse.ok) {
      const message =
        typeof translationData.error?.message === "string"
          ? translationData.error.message
          : "调用 GPT 翻译接口失败。";
      throw new Error(message);
    }

    const chineseTranslation =
      translationData.choices?.[0]?.message?.content?.trim() ?? "";

    if (!chineseTranslation) {
      throw new Error("未能生成中文翻译结果。");
    }

    return NextResponse.json({
      englishTranscript,
      chineseTranslation,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "处理音频时发生未知错误，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
