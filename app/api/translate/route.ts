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

  const text = body.text.trim();

  let chatResponse: Response;
  try {
    chatResponse = await fetch(OPENAI_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        temperature: 0.2,
        stream: true,
        messages: [
          {
            role: "system",
            content:
              "你是一名实时会议翻译员，请把用户提供的英文句子翻译成自然流畅的简体中文，并保持语气和段落结构。",
          },
          { role: "user", content: text },
        ],
      }),
      signal: req.signal,
    });
  } catch (error) {
    // 请求尚未发出/连接阶段失败：还没有任何字节返回给前端，走 JSON 错误 + 非 2xx。
    const message =
      error instanceof Error ? error.message : "翻译时发生未知错误，请稍后重试。";
    return NextResponse.json({ error: message }, { status: 500 });
  }

  if (!chatResponse.ok || !chatResponse.body) {
    // 上游在开始流式输出之前就报错（如鉴权失败、参数错误）：此时还未向前端发出任何字节，
    // 仍可以安全地返回结构化 JSON 错误 + 非 2xx，前端据此走错误分支。
    let message = "调用 GPT 翻译接口失败。";
    try {
      const errorPayload = await chatResponse.json();
      if (typeof errorPayload?.error?.message === "string") {
        message = errorPayload.error.message;
      }
    } catch {
      // 上游未返回可解析的 JSON 错误体，使用默认文案。
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const upstreamBody = chatResponse.body;
  let upstreamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstreamBody.getReader();
      upstreamReader = reader;
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          // 最后一行可能是被截断的半条 SSE 数据，留到下一块继续拼接。
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;

            try {
              const parsed = JSON.parse(data);
              const delta = parsed?.choices?.[0]?.delta?.content;
              if (typeof delta === "string" && delta.length > 0) {
                controller.enqueue(encoder.encode(delta));
              }
            } catch {
              // 忽略无法解析的行，不影响后续增量。
            }
          }
        }
        controller.close();
      } catch (error) {
        // 已经开始向前端流式发送数据（HTTP 200 已落定），此时无法再退回 JSON 错误响应，
        // 只能终止流，前端读取 reader 时会抛错，据此走错误/中断分支。
        void upstreamReader?.cancel().catch(() => {});
        controller.error(
          error instanceof Error ? error : new Error("翻译流中断。")
        );
      }
    },
    cancel() {
      // 前端 abort 或客户端断开连接：取消底层 reader，尽快释放与 OpenAI 的连接。
      void upstreamReader?.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
