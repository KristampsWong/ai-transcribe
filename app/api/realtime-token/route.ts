import { NextRequest, NextResponse } from "next/server";

const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/translations/client_secrets";
// 翻译会话模型（2026-05 发布）：单会话同时流式输出英文转写 + 中文翻译。
const REALTIME_TRANSLATE_MODEL = "gpt-realtime-translate";
// 源语（英文）转写子模型。
const REALTIME_TRANSCRIBE_MODEL = "gpt-realtime-whisper";
// 目标翻译语言：中文。已通过实测校验（2026-07-09）确认 client_secrets 接口接受该代码。
const OUTPUT_LANGUAGE = "zh";

export async function GET(request: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "缺少 OPENAI_API_KEY 环境变量，无法签发 Realtime 临时密钥。" },
      { status: 500 }
    );
  }

  try {
    const clientSecretResponse = await fetch(
      OPENAI_REALTIME_CLIENT_SECRETS_URL,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session: {
            model: REALTIME_TRANSLATE_MODEL,
            audio: {
              input: {
                transcription: { model: REALTIME_TRANSCRIBE_MODEL },
                noise_reduction: { type: "near_field" },
              },
              output: { language: OUTPUT_LANGUAGE },
            },
          },
        }),
        signal: request.signal,
      }
    );

    const clientSecretData = await clientSecretResponse.json();

    if (!clientSecretResponse.ok) {
      const message =
        typeof clientSecretData.error?.message === "string"
          ? clientSecretData.error.message
          : "调用 OpenAI Realtime 临时密钥接口失败。";
      return NextResponse.json(
        { error: message },
        { status: clientSecretResponse.status }
      );
    }

    if (
      typeof clientSecretData.value !== "string" ||
      typeof clientSecretData.expires_at !== "number"
    ) {
      return NextResponse.json(
        { error: "未能获取到有效的 Realtime 临时密钥。" },
        { status: 500 }
      );
    }

    return NextResponse.json({
      value: clientSecretData.value,
      expires_at: clientSecretData.expires_at,
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "签发 Realtime 临时密钥时发生未知错误，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
