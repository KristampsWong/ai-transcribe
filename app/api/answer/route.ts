"use server";

import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    return NextResponse.json(
      { error: "服务器配置错误：缺少 OpenAI API Key。" },
      { status: 500 }
    );
  }

  let body: {
    text: string;
    history?: Array<{ english: string; chinese: string | null }>;
    customPrompt?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "请求体格式错误，需要 JSON 格式。" },
      { status: 400 }
    );
  }

  const {
    text,
    history = [],
    customPrompt = "You are a helpful AI assistant in a real-time meeting context. Answer questions concisely and naturally. Provide your answer in both English and Chinese (Simplified), separated by '---SEPARATOR---'. Format: English answer first, then the separator, then Chinese answer."
  } = body;

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    return NextResponse.json(
      { error: "请提供有效的文本内容。" },
      { status: 400 }
    );
  }

  try {
    // Step 1: Detect if the text is a question
    const detectionResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "You are a question detector. Analyze the given text and determine if it is a question that expects an answer. Respond with only 'true' or 'false'.",
          },
          {
            role: "user",
            content: text,
          },
        ],
        temperature: 0.1,
        max_tokens: 10,
      }),
    });

    if (!detectionResponse.ok) {
      const errorData = await detectionResponse.json();
      throw new Error(errorData.error?.message || "问题检测失败。");
    }

    const detectionData = await detectionResponse.json();
    const isQuestion =
      detectionData.choices?.[0]?.message?.content?.trim().toLowerCase() === "true";

    if (!isQuestion) {
      return NextResponse.json({ isQuestion: false });
    }

    // Step 2: Generate answer in both English and Chinese
    const contextMessages = history
      .slice(-5) // Last 5 exchanges for context
      .map((item) => ({
        role: "user" as const,
        content: `Previous: ${item.english}${item.chinese ? ` (${item.chinese})` : ""}`,
      }));

    const answerResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content: customPrompt,
          },
          ...contextMessages,
          {
            role: "user",
            content: `Question: ${text}\n\nPlease provide a helpful answer in both English and Chinese (Simplified), separated by '---SEPARATOR---'.`,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      }),
    });

    if (!answerResponse.ok) {
      const errorData = await answerResponse.json();
      throw new Error(errorData.error?.message || "AI 回答生成失败。");
    }

    const answerData = await answerResponse.json();
    const fullAnswer = answerData.choices?.[0]?.message?.content?.trim() || "";

    const [english, chinese] = fullAnswer.split("---SEPARATOR---").map((s: string) => s.trim());

    if (!english || !chinese) {
      // Fallback: if separator not found, use the full answer for both
      return NextResponse.json({
        isQuestion: true,
        answer: {
          english: fullAnswer,
          chinese: fullAnswer,
        },
      });
    }

    return NextResponse.json({
      isQuestion: true,
      answer: {
        english,
        chinese,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "AI 处理时发生未知错误。";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
