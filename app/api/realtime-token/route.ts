import { NextRequest, NextResponse } from "next/server";

const OPENAI_REALTIME_CLIENT_SECRETS_URL =
  "https://api.openai.com/v1/realtime/client_secrets";
// 纯转写会话模型：原生流式转写，delta 随音频到达即时下发（不像 gpt-4o-transcribe 要等 commit）。
// 已通过实测校验（2026-07-10）确认 client_secrets 接口接受该 body。
const REALTIME_TRANSCRIBE_MODEL = "gpt-realtime-whisper";

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
            type: "transcription",
            audio: {
              input: {
                noise_reduction: { type: "near_field" },
                transcription: { model: REALTIME_TRANSCRIBE_MODEL, language: "en" },
                // 转写会话不支持 VAD：turn_detection 必须省略或为 null，
                // 分段改由客户端静音检测 + 手动 input_audio_buffer.commit 完成。
                turn_detection: null,
              },
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
