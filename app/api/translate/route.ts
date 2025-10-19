"use server";

import { NextRequest, NextResponse } from "next/server";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";

export async function POST(req: NextRequest) {
  if (!process.env.OPENAI_API_KEY) {
    return NextResponse.json(
      { error: "缺少 OPENAI_API_KEY 环境变量，无法完成翻译调用。" },
      { status: 500 }
    );
  }

  let body: { text?: unknown };

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "请求体需要是 JSON 格式。" },
      { status: 400 }
    );
  }

  if (typeof body.text !== "string" || body.text.trim().length === 0) {
    return NextResponse.json(
      { error: "缺少待翻译的英文内容。" },
      { status: 400 }
    );
  }

  try {
    const chatResponse = await fetch(OPENAI_CHAT_URL, {
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
              "你是一名实时会议翻译员，请把用户提供的英文句子翻译成自然流畅的简体中文，并保持语气和段落结构。",
          },
          { role: "user", content: body.text.trim() },
        ],
      }),
    });

    const translationData = await chatResponse.json();

    if (!chatResponse.ok) {
      const message =
        typeof translationData.error?.message === "string"
          ? translationData.error.message
          : "调用 GPT 翻译接口失败。";
      throw new Error(message);
    }

    const translation =
      translationData.choices?.[0]?.message?.content?.trim() ?? "";

    if (!translation) {
      throw new Error("未能生成有效的翻译结果。");
    }

    return NextResponse.json({ translation });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "翻译时发生未知错误，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
